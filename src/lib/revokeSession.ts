import { getRuntimeSettings } from "./buildConfig";
import { discoverOidcIssuer, validateOidcEndpoint } from "./core";
import type { PendingRevocation } from "./session";
import {
  clearPendingRevocation,
  clearSessionIfCurrent,
  isSessionToken,
  loadSession,
  replacePendingRevocation,
  saveSessionIfCurrent,
  savePendingRevocation,
  SESSION_CLEANUP_PENDING_ERROR,
  SESSION_CLEANUP_PERSISTENCE_ERROR,
} from "./session";
import { sanitizeDiagnosticError, sanitizeDiagnosticText } from "./errorDetails";

const SESSION_REVOKE_TIMEOUT_MS = 10_000;

export type SessionRevocationTarget = PendingRevocation;

export type SessionRevocationFailure = "failed" | "timed-out";

export async function revokeOrRemember(
  requestedTarget: SessionRevocationTarget,
  signal?: AbortSignal,
  primaryError?: unknown,
): Promise<Error | null> {
  let target = requestedTarget;
  const failure = (message: string, causes: unknown[]): Error => {
    const filtered = causes
      .filter((cause): cause is unknown => cause !== undefined)
      .map((cause) => sanitizeDiagnosticError(cause));
    if (filtered.length === 1) return new Error(message, { cause: filtered[0] });
    return new Error(
      message,
      {
        cause: new AggregateError(filtered, "session revocation and cleanup failed", {
          cause: filtered[0],
        }),
      },
    );
  };

  try {
    if (!target.oidcClientId) {
      const session = loadSession();
      if (session?.homeserver === target.homeserver && session.accessToken === target.accessToken) {
        target = {
          ...target,
          oidcIssuer: session.oidcIssuer,
          refreshToken: session.refreshToken,
          oidcClientId: session.oidcClientId,
        };
      }
    }
    await revokeOidcSession(target, undefined, signal, async (refreshed) => {
      const previous = target;
      target = refreshed;
      if (!replacePendingRevocation(previous, refreshed)) {
        throw new Error(SESSION_CLEANUP_PERSISTENCE_ERROR);
      }
      const session = loadSession();
      if (
        session && session.homeserver === previous.homeserver &&
        session.oidcIssuer === previous.oidcIssuer &&
        session.oidcClientId === previous.oidcClientId &&
        session.accessToken === previous.accessToken &&
        session.refreshToken === previous.refreshToken
      ) {
        saveSessionIfCurrent({
          ...session,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? session.refreshToken,
        }, session);
      }
    });
    const session = loadSession();
    if (
      session && session.homeserver === target.homeserver &&
      session.oidcIssuer === target.oidcIssuer &&
      session.oidcClientId === target.oidcClientId &&
      session.accessToken === target.accessToken &&
      session.refreshToken === target.refreshToken
    ) {
      clearSessionIfCurrent(session);
    }
    clearPendingRevocation(target);
    clearPendingRevocation(requestedTarget);
    return null;
  } catch (error) {
    let recorded = false;
    let persistenceError: unknown;
    try {
      recorded = savePendingRevocation(target);
    } catch (saveError) {
      persistenceError = saveError;
    }
    return failure(
      recorded && primaryError instanceof Error
        ? primaryError.message
        : recorded
          ? SESSION_CLEANUP_PENDING_ERROR
          : SESSION_CLEANUP_PERSISTENCE_ERROR,
      [
        primaryError,
        error,
        persistenceError,
        ...(recorded ? [] : [new Error(SESSION_CLEANUP_PERSISTENCE_ERROR)]),
      ],
    );
  }
}

export class SessionRevocationError extends Error {
  readonly reason: SessionRevocationFailure;

  constructor(reason: SessionRevocationFailure, options?: ErrorOptions) {
    super(reason === "timed-out" ? "Session revocation timed out" : "Session revocation failed", options);
    this.name = "SessionRevocationError";
    this.reason = reason;
  }
}

function assertRevocationHomeserver(homeserver: string): void {
  let runtimeHomeserver: URL;
  let sessionHomeserver: URL;
  try {
    runtimeHomeserver = new URL(getRuntimeSettings().homeserver);
    sessionHomeserver = new URL(homeserver);
  } catch {
    throw new SessionRevocationError("failed");
  }

  // Never send a token to a host selected by session data. The persisted session must
  // still match the immutable runtime binding before this request is made.
  if (sessionHomeserver.toString() !== runtimeHomeserver.toString()) {
    throw new SessionRevocationError("failed");
  }
}

function cancelResponseBody(response: Response): void {
  // The HTTP result owns logout success. Disposing an unused body must not delay or
  // reverse confirmed revocation, including when the underlying stream has failed.
  void Promise.resolve().then(() => response.body?.cancel()).catch(() => undefined);
}

function responseStatus(response: Response): string {
  return `HTTP ${response.status}${response.statusText ? ` ${sanitizeDiagnosticText(response.statusText)}` : ""}`;
}

function responseFailureFromText(response: Response, body: string): Error {
  return new Error(
    `${responseStatus(response)}: ${body === "" ? "(empty response body)" : sanitizeDiagnosticText(body)}`,
  );
}

type ResponseBodyRead =
  | { ok: true; text: string }
  | { ok: false; error: Error };

async function readResponseBody(response: Response): Promise<ResponseBodyRead> {
  try {
    return { ok: true, text: await response.text() };
  } catch (error) {
    cancelResponseBody(response);
    const cause = sanitizeDiagnosticError(error);
    return {
      ok: false,
      error: new Error(`${responseStatus(response)}: response body could not be read`, { cause }),
    };
  }
}

async function readResponseFailure(response: Response): Promise<Error> {
  const body = await readResponseBody(response);
  return body.ok ? responseFailureFromText(response, body.text) : body.error;
}

function responseFailureFromRead(response: Response, body: ResponseBodyRead): Error {
  return body.ok ? responseFailureFromText(response, body.text) : body.error;
}

function isUnknownMatrixAccessToken(text: string): boolean {
  try {
    const body = JSON.parse(text) as unknown;
    return Boolean(body) && typeof body === "object" &&
      (body as { errcode?: unknown }).errcode === "M_UNKNOWN_TOKEN";
  } catch {
    return false;
  }
}

function isInvalidGrant(text: string): boolean {
  try {
    const body = JSON.parse(text) as unknown;
    return Boolean(body) && typeof body === "object" &&
      (body as { error?: unknown }).error === "invalid_grant";
  } catch {
    return false;
  }
}

function refreshedRevocationTarget(
  target: SessionRevocationTarget,
  text: string,
): SessionRevocationTarget {
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error("OIDC token refresh response was invalid", { cause: error });
  }
  if (!body || typeof body !== "object") {
    throw new Error("OIDC token refresh response was invalid");
  }
  const tokens = body as { access_token?: unknown; refresh_token?: unknown };
  const accessToken = tokens.access_token;
  const refreshToken = tokens.refresh_token ?? target.refreshToken;
  if (!isSessionToken(accessToken) || !isSessionToken(refreshToken)) {
    throw new Error("OIDC token refresh response contained invalid credentials");
  }
  return { ...target, accessToken, refreshToken };
}

/** Revoke the native OAuth grant, including when its access token has expired. */
export async function revokeOidcSession(
  target: SessionRevocationTarget,
  fetchImpl: typeof fetch = fetch,
  externalSignal?: AbortSignal,
  onRefreshed?: (target: SessionRevocationTarget) => void | Promise<void>,
): Promise<void> {
  if (!isSessionToken(target.accessToken)) {
    throw new SessionRevocationError("failed");
  }

  assertRevocationHomeserver(target.homeserver);
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new SessionRevocationError("timed-out"));
    }, SESSION_REVOKE_TIMEOUT_MS);
  });
  let rejectExternal!: (reason: SessionRevocationError) => void;
  const externalAbort = new Promise<never>((_, reject) => {
    rejectExternal = reject;
  });
  const abortFromCaller = (): void => {
    controller.abort(externalSignal?.reason);
    rejectExternal(new SessionRevocationError(
      "failed",
      externalSignal?.reason === undefined
        ? undefined
        : { cause: sanitizeDiagnosticError(externalSignal.reason) },
    ));
  };
  if (externalSignal?.aborted) abortFromCaller();
  else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const request = Promise.resolve().then(async () => {
    controller.signal.throwIfAborted();
    const metadata = await discoverOidcIssuer(getRuntimeSettings().homeserver, controller.signal);
    controller.signal.throwIfAborted();
    const expectedIssuer = validateOidcEndpoint(target.oidcIssuer ?? `${target.homeserver.replace(/\/+$/u, "")}/`, "OIDC issuer");
    if (validateOidcEndpoint(metadata.issuer, "OIDC issuer") !== expectedIssuer) {
      throw new Error("OIDC issuer changed; session revocation was not attempted");
    }
    if (metadata.revocation_endpoint === undefined) {
      const base = new URL(target.homeserver);
      if (!base.pathname.endsWith("/")) base.pathname += "/";
      const endpoint = validateOidcEndpoint(
        new URL("_matrix/client/v3/logout", base).toString(),
        "logout endpoint",
      );
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${target.accessToken}` },
        credentials: "omit",
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.redirected || response.url !== endpoint) {
        throw new SessionRevocationError("failed", {
          cause: await readResponseFailure(response),
        });
      }
      if (response.status === 200 || response.status === 204) {
        cancelResponseBody(response);
        return;
      }
      const matrixFailure = await readResponseBody(response);
      if (
        response.status !== 401 || !matrixFailure.ok ||
        !isUnknownMatrixAccessToken(matrixFailure.text)
      ) {
        throw new SessionRevocationError("failed", {
          cause: responseFailureFromRead(response, matrixFailure),
        });
      }
      if (!isSessionToken(target.refreshToken) || !isSessionToken(target.oidcClientId)) {
        throw new SessionRevocationError("failed", {
          cause: responseFailureFromRead(response, matrixFailure),
        });
      }
      const tokenEndpoint = validateOidcEndpoint(metadata.token_endpoint, "OIDC token endpoint");
      const refreshResponse = await fetchImpl(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: target.refreshToken,
          client_id: target.oidcClientId,
        }),
        credentials: "omit",
        redirect: "manual",
        signal: controller.signal,
      });
      if (refreshResponse.redirected || refreshResponse.url !== tokenEndpoint) {
        throw new SessionRevocationError("failed", {
          cause: await readResponseFailure(refreshResponse),
        });
      }
      const refreshBody = await readResponseBody(refreshResponse);
      if (
        refreshResponse.status === 400 && refreshBody.ok &&
        isInvalidGrant(refreshBody.text)
      ) {
        return;
      }
      if (refreshResponse.status !== 200 || !refreshBody.ok) {
        throw new SessionRevocationError("failed", {
          cause: responseFailureFromRead(refreshResponse, refreshBody),
        });
      }
      const refreshed = refreshedRevocationTarget(target, refreshBody.text);
      await onRefreshed?.(refreshed);
      const retry = await fetchImpl(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${refreshed.accessToken}` },
        credentials: "omit",
        redirect: "manual",
        signal: controller.signal,
      });
      if (
        retry.redirected || retry.url !== endpoint ||
        (retry.status !== 200 && retry.status !== 204)
      ) {
        throw new SessionRevocationError("failed", {
          cause: await readResponseFailure(retry),
        });
      }
      cancelResponseBody(retry);
      return;
    }

    const endpoint = validateOidcEndpoint(metadata.revocation_endpoint, "OIDC revocation endpoint");
    if (target.refreshToken !== undefined && !isSessionToken(target.refreshToken)) {
      throw new SessionRevocationError("failed", {
        cause: new Error("The stored OAuth refresh token is invalid."),
      });
    }
    if (!isSessionToken(target.oidcClientId)) {
      throw new SessionRevocationError("failed", {
        cause: new Error(`The original OAuth client ID is unavailable. Open ${target.oidcIssuer ?? `${target.homeserver}/`} and end this session in account settings. Then close this tab and open Storage in a new tab.`),
      });
    }
    const clientId = target.oidcClientId;
    const body = new URLSearchParams({
      token: target.refreshToken ?? target.accessToken,
      token_type_hint: target.refreshToken ? "refresh_token" : "access_token",
      client_id: clientId,
    });
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      credentials: "omit",
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.redirected || response.url !== endpoint || response.status !== 200) {
      throw new SessionRevocationError("failed", {
        cause: await readResponseFailure(response),
      });
    }
    cancelResponseBody(response);
  });
  try {
    await Promise.race([request, timeout, externalAbort]);
  } catch (error) {
    if (error instanceof SessionRevocationError) throw error;
    throw new SessionRevocationError(timedOut ? "timed-out" : "failed", {
      cause: sanitizeDiagnosticError(error),
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
}

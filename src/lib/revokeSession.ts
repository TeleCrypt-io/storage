import { assertRuntimeOidcEndpoint, getRuntimeSettings, runtimeOidcIssuer } from "./buildConfig";
import { discoverOidcIssuer } from "./core";
import type { PendingRevocation } from "./session";
import {
  clearPendingRevocation,
  isSessionToken,
  loadSession,
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
        target = { ...target, refreshToken: session.refreshToken, oidcClientId: session.oidcClientId };
      }
    }
    await revokeOidcSession(target, undefined, signal);
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

/** Revoke the native OAuth grant, including when its access token has expired. */
export async function revokeOidcSession(
  target: SessionRevocationTarget,
  fetchImpl: typeof fetch = fetch,
  externalSignal?: AbortSignal,
): Promise<void> {
  if (
    !isSessionToken(target.accessToken) ||
    (target.refreshToken !== undefined && !isSessionToken(target.refreshToken))
  ) {
    throw new SessionRevocationError("failed");
  }

  if (!isSessionToken(target.oidcClientId)) {
    throw new SessionRevocationError("failed", {
      cause: new Error(`The original OAuth client ID is unavailable. Open ${runtimeOidcIssuer()} and end this session in account settings. Then close this tab and open Storage in a new tab.`),
    });
  }
  const clientId = target.oidcClientId;
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
    if (metadata.issuer !== runtimeOidcIssuer()) {
      throw new Error("OIDC issuer does not match the configured environment");
    }
    const endpoint = assertRuntimeOidcEndpoint(metadata.revocation_endpoint, "OIDC revocation endpoint");
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

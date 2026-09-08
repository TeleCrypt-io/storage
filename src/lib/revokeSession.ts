import { getRuntimeSettings } from "./buildConfig";
import {
  clearPendingRevocation,
  isSessionToken,
  savePendingRevocation,
  SESSION_CLEANUP_PENDING_ERROR,
  SESSION_CLEANUP_PERSISTENCE_ERROR,
} from "./session";
import { sanitizeDiagnosticError, sanitizeDiagnosticText } from "./errorDetails";

const SESSION_REVOKE_TIMEOUT_MS = 10_000;
const RESPONSE_CLEANUP_TIMEOUT_MS = 5_000;

export type SessionRevocationTarget = {
  homeserver: string;
  accessToken: string;
};

export type SessionRevocationFailure = "failed" | "timed-out";

export async function revokeOrRemember(
  target: SessionRevocationTarget,
  signal?: AbortSignal,
  primaryError?: unknown,
): Promise<Error | null> {
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
    await revokeMatrixSession(target, undefined, signal);
    if (clearPendingRevocation(target)) return null;
    return failure(primaryError instanceof Error ? primaryError.message : SESSION_CLEANUP_PERSISTENCE_ERROR, [
      primaryError,
      new Error(SESSION_CLEANUP_PERSISTENCE_ERROR),
    ]);
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

function logoutEndpoint(homeserver: string): string {
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
  return new URL("/_matrix/client/v3/logout", runtimeHomeserver).toString();
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  const cancellation = Promise.resolve().then(() => response.body!.cancel());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        reject(new Error("session revocation response cleanup timed out"));
      },
      RESPONSE_CLEANUP_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([cancellation, deadline]);
  } catch (error) {
    throw new SessionRevocationError("failed", { cause: sanitizeDiagnosticError(error) });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readResponseFailure(response: Response): Promise<Error> {
  const status = `HTTP ${response.status}${response.statusText ? ` ${sanitizeDiagnosticText(response.statusText)}` : ""}`;
  try {
    const body = await response.text();
    return new Error(`${status}: ${body === "" ? "(empty response body)" : sanitizeDiagnosticText(body)}`);
  } catch (error) {
    const failures: unknown[] = [sanitizeDiagnosticError(error)];
    try {
      await cancelResponseBody(response);
    } catch (cleanupError) {
      failures.push(sanitizeDiagnosticError(cleanupError));
    }
    return new Error(`${status}: response body could not be read`, {
      cause: failures.length === 1
        ? failures[0]
        : new AggregateError(failures, "response body read and cleanup failed", { cause: failures[0] }),
    });
  }
}

/**
 * Revokes the Matrix access token without sending a request body. Failed
 * responses retain their complete redacted status and body as the cause of a
 * stable revocation error so the UI can surface the actual backend failure.
 */
export async function revokeMatrixSession(
  target: SessionRevocationTarget,
  fetchImpl: typeof fetch = fetch,
  externalSignal?: AbortSignal,
): Promise<void> {
  if (!isSessionToken(target.accessToken)) {
    throw new SessionRevocationError("failed");
  }

  const endpoint = logoutEndpoint(target.homeserver);
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
  const request = Promise.resolve().then(() =>
    fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${target.accessToken}` },
      credentials: "omit",
      redirect: "manual",
      signal: controller.signal,
    }),
  );
  try {
    const response = await Promise.race([request, timeout, externalAbort]);
    if (response.redirected || response.url !== endpoint) {
      const failure = new SessionRevocationError("failed", {
        cause: await readResponseFailure(response),
      });
      throw failure;
    }
    // Matrix returns 401/M_UNKNOWN_TOKEN when this device token was already
    // invalidated (for example, the first logout succeeded but its response was
    // lost). That is a definitive least-privilege outcome, so retry is
    // idempotent without reading or trusting the response body.
    if (response.status !== 200 && response.status !== 204 && response.status !== 401) {
      const failure = new SessionRevocationError("failed", {
        cause: await readResponseFailure(response),
      });
      throw failure;
    }
    await cancelResponseBody(response);
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

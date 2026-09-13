/**
 * OIDC/MAS login for the web UI: authorization-code + PKCE. Thin browser
 * adapter over the shared `src/core/oidc.ts` protocol calls (discovery, DCR,
 * PKCE URL building, token exchange).
 *
 * PKCE code_verifier + state are persisted by the published storage SDK in
 * window.sessionStorage; the transient state is cleared when a transaction
 * ends. This module persists the
 * non-secret DCR client_id in localStorage keyed by issuer, so repeat logins
 * against the same homeserver don't re-register a new client every time. The
 * Matrix device id is tab-scoped in sessionStorage with the session tokens.
 */
import {
  discoverOidcIssuer,
  registerClient,
  beginAuthorizationCodeFlow,
  completeAuthorizationCodeFlow,
  extractDeviceIdFromScope,
  whoAmI,
} from "./core";
import type { Session } from "./session";
import {
  clearOidcTransientState,
  clearSession,
  assertSessionStorageWritable,
  loadPendingRevocations,
  loadOidcLoginIntent,
  loadSession,
  saveOidcLoginIntent,
  savePendingRevocation,
  isRuntimeMatrixDeviceId,
  isRuntimeMatrixUserId,
  SESSION_CLEANUP_PERSISTENCE_ERROR,
  SESSION_CLEANUP_PENDING_ERROR,
  SESSION_PERSISTENCE_ERROR,
  SESSION_STORAGE_UNAVAILABLE,
} from "./session";
import { assertRuntimeOidcEndpoint, getRuntimeSettings, runtimeOidcIssuer } from "./buildConfig";
import {
  classifyOidcCallback,
  readOidcCallbackParams,
  scrubOidcCallbackParams,
} from "./oidcCallback";
import { revokeOrRemember } from "./revokeSession";
import { sanitizeDiagnosticError } from "./errorDetails";

const CLIENT_ID_PREFIX = "telecrypt-io-ui:oidc-client:";
const DEVICE_ID_PREFIX = "telecrypt-io-ui:device:";

const SAFE_CALLBACK_MESSAGES = new Set([
  "Sign-in failed",
  "Sign-in was cancelled",
  "OIDC callback homeserver does not match the configured environment",
  "OIDC callback issuer does not match the configured environment",
  "OIDC callback client identity could not be verified",
  "OIDC device identity could not be verified",
  "OIDC Matrix identity could not be verified",
  "completeOidcLoginFromCallback: granted scope did not include a device_id",
  SESSION_CLEANUP_PENDING_ERROR,
  SESSION_CLEANUP_PERSISTENCE_ERROR,
  SESSION_PERSISTENCE_ERROR,
  SESSION_STORAGE_UNAVAILABLE,
  "Browser persistent storage is unavailable",
]);

function publicFailure(message: string, failures: readonly unknown[]): Error {
  const causes = failures.filter((failure) => failure !== undefined);
  if (causes.length === 0) return new Error(message);
  if (causes.length === 1) return new Error(message, { cause: causes[0] });
  return new AggregateError(causes, message, { cause: causes[0] });
}

function safeCallbackFailure(error: unknown): Error {
  const message = error instanceof Error && SAFE_CALLBACK_MESSAGES.has(error.message)
    ? error.message
    : "Sign-in failed";
  return publicFailure(message, [sanitizeDiagnosticError(error)]);
}

function clearTransientOrThrow(primary: Error): never {
  try {
    clearOidcTransientState();
  } catch (error) {
    throw publicFailure(primary.message, [primary, error]);
  }
  throw primary;
}

function clearSessionOrThrow(primary: Error): never {
  try {
    clearSession();
  } catch (error) {
    throw publicFailure(primary.message, [primary, error]);
  }
  throw primary;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Sign-in is no longer active", "AbortError");
}

function redirectUri(): string {
  return window.location.origin + "/";
}

function isRuntimeHomeserver(candidate: string, runtime: string): boolean {
  try {
    return new URL(candidate).href === new URL(runtime).href;
  } catch {
    return false;
  }
}

function persistentStore(): Storage {
  try {
    return window.localStorage;
  } catch (error) {
    throw new Error("Browser persistent storage is unavailable", { cause: error });
  }
}

function loadCachedClientId(issuer: string): string | null {
  let cached: string | null;
  try {
    cached = persistentStore().getItem(CLIENT_ID_PREFIX + issuer);
  } catch (error) {
    throw new Error("Browser persistent storage is unavailable", { cause: error });
  }
  return cached;
}

function cacheClientId(issuer: string, clientId: string): void {
  try {
    const store = persistentStore();
    const key = CLIENT_ID_PREFIX + issuer;
    store.setItem(key, clientId);
  } catch (error) {
    throw new Error("Browser persistent storage is unavailable", { cause: error });
  }
}

/**
 * Returns this tab's stable Matrix device id for the given issuer, creating
 * and persisting one on first use. Session state is intentionally tab-scoped,
 * so a separate tab also gets a separate device and login transaction.
 */
function loadOrCreateDeviceId(issuer: string): string {
  const key = DEVICE_ID_PREFIX + issuer;
  try {
    const store = window.sessionStorage;
    const existing = store.getItem(key);
    if (existing && /^[0-9A-F]{10}$/.test(existing)) return existing;
    const bytes = new Uint8Array(5);
    crypto.getRandomValues(bytes);
    const deviceId = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
    store.setItem(key, deviceId);
    return deviceId;
  } catch (error) {
    throw new Error("Browser session storage is unavailable", { cause: error });
  }
}

async function cleanPendingRevocations(
  clearMatchingSession: boolean,
  signal?: AbortSignal,
): Promise<void> {
  for (const pending of loadPendingRevocations()) {
    throwIfAborted(signal);
    const cleanupError = await revokeOrRemember(pending, signal);
    if (cleanupError) throw cleanupError;
    try {
      throwIfAborted(signal);
      if (clearMatchingSession && loadSession()?.accessToken === pending.accessToken) {
        clearSession();
      }
    } catch (error) {
      // revokeOrRemember removes the pending marker after remote revocation.
      // Restore it if any dependent local cleanup fails so a stale matching
      // session is never left without its retry record.
      let restored = false;
      try {
        restored = savePendingRevocation(pending);
      } catch (persistenceError) {
        throw publicFailure(SESSION_CLEANUP_PERSISTENCE_ERROR, [error, persistenceError]);
      }
      if (restored) throw error;
      throw publicFailure(SESSION_CLEANUP_PERSISTENCE_ERROR, [
        error,
        new Error(SESSION_CLEANUP_PERSISTENCE_ERROR),
      ]);
    }
  }
}

/**
 * Starts the OIDC login flow: discovery → DCR (cached) → PKCE authorization
 * URL → redirect. Never returns normally on success (navigates away);
 * throws before redirecting if discovery/DCR fail.
 */
export async function beginOidcLogin(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  assertSessionStorageWritable();
  clearOidcTransientState();
  await cleanPendingRevocations(true, signal);
  let existingSession = loadSession();
  while (existingSession) {
    throwIfAborted(signal);
    const cleanupError = await revokeOrRemember(existingSession, signal);
    if (cleanupError) throw cleanupError;
    throwIfAborted(signal);
    const rotatedSession = loadSession();
    if (
      !rotatedSession ||
      (rotatedSession.accessToken === existingSession.accessToken &&
        rotatedSession.refreshToken === existingSession.refreshToken)
    ) {
      existingSession = null;
    } else {
      existingSession = rotatedSession;
    }
  }
  clearSession();
  throwIfAborted(signal);
  const { homeserver } = getRuntimeSettings();
  const oidcIssuer = runtimeOidcIssuer();
  const authMetadata = await discoverOidcIssuer(homeserver, signal);
  if (authMetadata.issuer !== oidcIssuer) {
    throw new Error("OIDC issuer does not match the configured environment");
  }
  assertRuntimeOidcEndpoint(authMetadata.authorization_endpoint, "OIDC authorization endpoint");
  assertRuntimeOidcEndpoint(
    authMetadata.token_endpoint,
    "OIDC token endpoint",
  );
  assertRuntimeOidcEndpoint(
    authMetadata.registration_endpoint,
    "OIDC registration endpoint",
  );

  let clientId = loadCachedClientId(authMetadata.issuer);
  if (!clientId || clientId.trim() === "") {
    clientId = await registerClient(
      authMetadata,
      {
        clientName: "TeleCrypt.io Storage (Web)",
        clientUri: redirectUri(),
        applicationType: "web",
        redirectUris: [redirectUri()],
        contacts: undefined,
        tosUri: undefined,
        policyUri: undefined,
      },
      signal,
    );
    throwIfAborted(signal);
    cacheClientId(authMetadata.issuer, clientId);
  }

  throwIfAborted(signal);
  const url = await beginAuthorizationCodeFlow({
    authMetadata,
    clientId,
    homeserverUrl: homeserver,
    redirectUri: redirectUri(),
    deviceId: loadOrCreateDeviceId(authMetadata.issuer),
    signal,
  });
  throwIfAborted(signal);
  const redirect = new URL(url);
  const states = redirect.searchParams.getAll("state");
  if (states.length !== 1 || !states[0] || !saveOidcLoginIntent({ state: states[0] })) {
    clearTransientOrThrow(new Error(SESSION_PERSISTENCE_ERROR));
  }
  throwIfAborted(signal);
  window.location.href = redirect.toString();
}

/**
 * Completes the authorization-code exchange from the current URL's
 * query or fragment response parameters, confirms identity via `/whoami`, and
 * clears the response from the address bar (so a reload doesn't try to replay
 * the one-time code). Returns a validated `Session` for the active tab.
 */
export async function completeOidcLoginFromCallback(signal?: AbortSignal): Promise<Session> {
  throwIfAborted(signal);
  const callbackKind = classifyOidcCallback(window.location);
  const params = readOidcCallbackParams(window.location);
  const code = params.get("code");
  const state = params.get("state");
  const callbackError = params.get("error");
  const callbackIssuer = params.get("iss");

  // Remove all OAuth response fields before any asynchronous exchange. A failed exchange,
  // denial, or reload must never leave a one-time code, state, or provider error in history.
  scrubOidcCallbackParams(window.location);

  if (callbackKind !== "success" && callbackKind !== "error") {
    clearTransientOrThrow(new Error("Sign-in callback was malformed"));
  }
  assertSessionStorageWritable();
  const intent = loadOidcLoginIntent();
  if (!intent || !state || state !== intent.state) {
    clearTransientOrThrow(new Error("Sign-in callback state could not be verified"));
  }
  if (callbackIssuer !== null && callbackIssuer !== runtimeOidcIssuer()) {
    clearTransientOrThrow(new Error("Sign-in callback issuer could not be verified"));
  }

  try {
    await cleanPendingRevocations(false, signal);
  } catch (error) {
    clearTransientOrThrow(safeCallbackFailure(error));
  }

  if (callbackError) {
    clearSessionOrThrow(
      new Error(callbackError === "access_denied" ? "Sign-in was cancelled" : "Sign-in failed"),
    );
  }
  if (!code || !state) {
    clearSessionOrThrow(new Error("Sign-in failed"));
  }

  let completed: Awaited<ReturnType<typeof completeAuthorizationCodeFlow>>;
  try {
    completed = await completeAuthorizationCodeFlow(
      code,
      state,
      signal,
    );
  } catch (error) {
    clearSessionOrThrow(safeCallbackFailure(error));
  }
  const { tokenResponse, oidcClientSettings, homeserverUrl } = completed;
  const accessToken = tokenResponse.access_token;
  const { homeserver, serverName } = getRuntimeSettings();
  const homeserverIsRuntime = isRuntimeHomeserver(homeserverUrl, homeserver);

  try {
    throwIfAborted(signal);
    clearSession();
    const oidcIssuer = runtimeOidcIssuer();
    if (!homeserverIsRuntime) {
      throw new Error("OIDC callback homeserver does not match the configured environment");
    }
    if (oidcClientSettings.issuer !== oidcIssuer) {
      throw new Error("OIDC callback issuer does not match the configured environment");
    }
    const expectedClientId = loadCachedClientId(oidcIssuer);
    if (!expectedClientId || oidcClientSettings.clientId !== expectedClientId) {
      throw new Error("OIDC callback client identity could not be verified");
    }

    const refreshToken = tokenResponse.refresh_token;
    if (!refreshToken) throw new Error("Sign-in failed");
    const deviceId = extractDeviceIdFromScope(tokenResponse.scope ?? "");
    if (!deviceId) {
      throw new Error("completeOidcLoginFromCallback: granted scope did not include a device_id");
    }

    const who = await whoAmI(homeserver, accessToken, serverName, signal);
    if (who.deviceId !== deviceId) {
      throw new Error("OIDC device identity could not be verified");
    }
    if (!isRuntimeMatrixUserId(who.userId) || !isRuntimeMatrixDeviceId(who.deviceId)) {
      throw new Error("OIDC Matrix identity could not be verified");
    }

    if (loadPendingRevocations().length !== 0) throw new Error(SESSION_CLEANUP_PENDING_ERROR);
    return {
      homeserver,
      userId: who.userId,
      deviceId,
      accessToken,
      refreshToken,
      oidcClientId: oidcClientSettings.clientId,
    };
  } catch (error) {
    // The authorization server has already issued a bearer token. Revoke it before
    // reporting a callback validation failure; if that request is uncertain, retain
    // only a tab-scoped retry record so the next sign-in attempt can retry revocation.
    const primary = safeCallbackFailure(error);
    if (homeserverIsRuntime) {
      const target = { homeserver, accessToken };
      const cleanupError = await revokeOrRemember(target, signal, primary);
      if (cleanupError) throw cleanupError;
    }
    throw primary;
  }
}

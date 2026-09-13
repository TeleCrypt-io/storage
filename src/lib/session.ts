import { getRuntimeSettings } from "./buildConfig";

/**
 * Session persistence: homeserver/user/device/tokens in tab-scoped sessionStorage.
 * The crypto store persists on its own via the browser's native IndexedDB (see
 * TeleCryptIOStorage.create, called with its default persistentCryptoStore: true).
 */
export interface Session {
  homeserver: string;
  userId: string;
  deviceId: string;
  accessToken: string;
  /** OIDC/MAS authorization-code + PKCE session fields. */
  refreshToken: string;
  oidcClientId: string;
}

function sessionsEqual(a: Session, b: Session): boolean {
  return (
    a.homeserver === b.homeserver &&
    a.userId === b.userId &&
    a.deviceId === b.deviceId &&
    a.accessToken === b.accessToken &&
    a.refreshToken === b.refreshToken &&
    a.oidcClientId === b.oidcClientId
  );
}

export const SESSION_STORAGE_KEY = "telecrypt-io-ui:session";
export const PENDING_REVOCATION_STORAGE_KEY = "telecrypt-io-ui:pending-revocation";
export const SESSION_PERSISTENCE_ERROR = "Session persistence failed";
export const SESSION_STORAGE_UNAVAILABLE = "Browser session storage is unavailable";
export const SESSION_CLEANUP_PENDING_ERROR = "Session cleanup is pending";
export const SESSION_CLEANUP_PERSISTENCE_ERROR = "Session cleanup could not be persisted";
export const OIDC_LOGIN_INTENT_STORAGE_KEY = "telecrypt-io-ui:oidc-login-intent";
export const MAX_MATRIX_ID_BYTES = 255;
const OIDC_STATE_STORAGE_PREFIXES = ["mx_oidc_", "telecrypt:oauth2:pkce:v1:"];

export interface OidcLoginIntent {
  state: string;
}

export interface PendingRevocation {
  homeserver: string;
  accessToken: string;
}

// A storage denial must not make an issued bearer token disappear without a retry path. This
// volatile fallback is tab-scoped and is cleared as soon as remote revocation is confirmed.
let volatilePendingRevocations: PendingRevocation[] = [];

function sessionStore(): Storage {
  try {
    return window.sessionStorage;
  } catch (error) {
    throw new Error(SESSION_STORAGE_UNAVAILABLE, { cause: error });
  }
}

export function assertSessionStorageWritable(): void {
  try {
    const store = sessionStore();
    const probe = "telecrypt-io-ui:session-probe";
    store.setItem(probe, "1");
    store.removeItem(probe);
  } catch (error) {
    throw new Error(SESSION_STORAGE_UNAVAILABLE, { cause: error });
  }
}

function clearInvalidSession(): void {
  try {
    sessionStore().removeItem(SESSION_STORAGE_KEY);
  } catch (error) {
    throw new Error(SESSION_PERSISTENCE_ERROR, { cause: error });
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isOpaqueString(value: unknown): value is string {
  return isNonEmptyString(value) && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

export function isSessionToken(value: unknown): value is string {
  return isOpaqueString(value);
}

function isMatrixUserId(value: string, expectedServerName: string): boolean {
  if (utf8ByteLength(value) > MAX_MATRIX_ID_BYTES || !value.startsWith("@")) return false;
  const separator = value.indexOf(":", 1);
  const serverNamePattern = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?$/u;
  return (
    separator > 1 &&
    separator < value.length - 1 &&
    /^[A-Za-z0-9._=+\-/]+$/u.test(value.slice(1, separator)) &&
    serverNamePattern.test(value.slice(separator + 1)) &&
    value.slice(separator + 1).toLowerCase() === expectedServerName.toLowerCase()
  );
}

export function isRuntimeMatrixUserId(value: unknown): value is string {
  const { serverName } = getRuntimeSettings();
  return typeof value === "string" && isMatrixUserId(value, serverName);
}

export function isRuntimeMatrixDeviceId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._~-]+$/u.test(value);
}

function matchesRuntimeHomeserver(value: string): boolean {
  const runtimeHomeserver = new URL(getRuntimeSettings().homeserver);
  try {
    return new URL(value).toString() === runtimeHomeserver.toString();
  } catch {
    return false;
  }
}

function failInvalidSession(cause: unknown, clearInvalid: boolean): never {
  if (clearInvalid) {
    try {
      clearInvalidSession();
    } catch (cleanupError) {
      throw new AggregateError(
        [cause, cleanupError],
        "stored session is invalid and cleanup failed",
        { cause },
      );
    }
  }
  throw cause;
}

function parseSession(raw: string | null, clearInvalid: boolean): Session | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return failInvalidSession(error, clearInvalid);
  }
  if (typeof parsed !== "object" || parsed === null) {
    return failInvalidSession(new Error("Stored session is invalid"), clearInvalid);
  }
  const session = parsed as Partial<Session>;
  const { homeserver, serverName } = getRuntimeSettings();
  if (
    isNonEmptyString(session.homeserver) &&
    typeof session.userId === "string" &&
    isMatrixUserId(session.userId, serverName) &&
    isRuntimeMatrixDeviceId(session.deviceId) &&
    isSessionToken(session.accessToken) &&
    isSessionToken(session.refreshToken) &&
    isOpaqueString(session.oidcClientId) &&
    session.homeserver === homeserver
  ) {
    return session as Session;
  }
  return failInvalidSession(new Error("Stored session is invalid"), clearInvalid);
}

export function loadSession(): Session | null {
  const store = sessionStore();
  let raw: string | null;
  try {
    raw = store.getItem(SESSION_STORAGE_KEY);
  } catch (error) {
    throw new Error(SESSION_STORAGE_UNAVAILABLE, { cause: error });
  }
  return parseSession(raw, true);
}

/**
 * Persists only if this tab still holds the expected session. A null expected
 * value means the caller requires there to be no session yet.
 */
export function saveSessionIfCurrent(session: Session, expected: Session | null): boolean {
  try {
    const store = sessionStore();
    const current = parseSession(store.getItem(SESSION_STORAGE_KEY), false);
    if (expected === null ? current !== null : !current || !sessionsEqual(current, expected)) {
      return false;
    }
    const { homeserver } = getRuntimeSettings();
    if (
      session.homeserver !== homeserver ||
      !isRuntimeMatrixUserId(session.userId) ||
      !isRuntimeMatrixDeviceId(session.deviceId) ||
      !isSessionToken(session.accessToken) ||
      !isSessionToken(session.refreshToken) ||
      !isOpaqueString(session.oidcClientId)
    ) {
      return false;
    }
    store.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    return true;
  } catch (error) {
    throw new Error(SESSION_PERSISTENCE_ERROR, { cause: error });
  }
}

export function clearSession(): void {
  try {
    const store = sessionStore();
    store.removeItem(SESSION_STORAGE_KEY);
    clearOidcTransientStateFromStore(store);
  } catch (error) {
    throw new Error(SESSION_PERSISTENCE_ERROR, { cause: error });
  }
}

function clearOidcTransientStateFromStore(store: Storage): void {
  for (let index = store.length - 1; index >= 0; index -= 1) {
    const key = store.key(index);
    if (key && OIDC_STATE_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      store.removeItem(key);
    }
  }
  store.removeItem(OIDC_LOGIN_INTENT_STORAGE_KEY);
}

/** Clear only one-time OIDC state, preserving any live authenticated session. */
export function clearOidcTransientState(): void {
  try {
    const store = sessionStore();
    clearOidcTransientStateFromStore(store);
  } catch (error) {
    throw new Error(SESSION_PERSISTENCE_ERROR, { cause: error });
  }
}

function isPendingRevocation(value: unknown): value is PendingRevocation {
  if (typeof value !== "object" || value === null) return false;
  const parsed = value as Partial<PendingRevocation>;
  return (
    isNonEmptyString(parsed.homeserver) &&
    isSessionToken(parsed.accessToken) &&
    matchesRuntimeHomeserver(parsed.homeserver)
  );
}

function sameRevocation(a: PendingRevocation, b: PendingRevocation): boolean {
  return a.homeserver === b.homeserver && a.accessToken === b.accessToken;
}

export function loadPendingRevocations(): PendingRevocation[] {
  const store = sessionStore();
  let raw: string | null;
  try {
    raw = store.getItem(PENDING_REVOCATION_STORAGE_KEY);
  } catch (error) {
    throw new Error(SESSION_CLEANUP_PERSISTENCE_ERROR, { cause: error });
  }
  let parsed: unknown;
  if (raw === null) {
    parsed = [];
  } else {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(SESSION_CLEANUP_PERSISTENCE_ERROR, { cause: error });
    }
  }
  if (!Array.isArray(parsed)) {
    throw new Error(SESSION_CLEANUP_PERSISTENCE_ERROR, {
      cause: new Error("Stored pending revocation state is invalid"),
    });
  }
  const candidates = parsed;
  if (!candidates.every(isPendingRevocation)) {
    throw new Error(SESSION_CLEANUP_PERSISTENCE_ERROR, {
      cause: new Error("Stored pending revocation state is invalid"),
    });
  }
  const pending = candidates.filter(
    (target, index, all) => all.findIndex((candidate) => sameRevocation(candidate, target)) === index,
  );
  const combined = [...pending, ...volatilePendingRevocations].filter(
    (target, index, all) =>
      all.findIndex((candidate) => sameRevocation(candidate, target)) === index,
  );
  volatilePendingRevocations = combined;
  return [...combined];
}

export function savePendingRevocation(target: PendingRevocation): boolean {
  if (!isPendingRevocation(target)) return false;
  try {
    const pending = loadPendingRevocations();
    if (!pending.some((candidate) => sameRevocation(candidate, target))) pending.push(target);
    volatilePendingRevocations = pending;
    const store = sessionStore();
    const serialized = JSON.stringify(pending);
    store.setItem(PENDING_REVOCATION_STORAGE_KEY, serialized);
    return true;
  } catch (error) {
    if (!volatilePendingRevocations.some((candidate) => sameRevocation(candidate, target))) {
      volatilePendingRevocations = [...volatilePendingRevocations, target];
    }
    throw new Error(SESSION_CLEANUP_PERSISTENCE_ERROR, { cause: error });
  }
}

export function clearPendingRevocation(target?: PendingRevocation): void {
  try {
    const store = sessionStore();
    const remaining = target
      ? loadPendingRevocations().filter((candidate) => !sameRevocation(candidate, target))
      : [];
    if (remaining.length === 0) {
      store.removeItem(PENDING_REVOCATION_STORAGE_KEY);
    } else {
      const serialized = JSON.stringify(remaining);
      store.setItem(PENDING_REVOCATION_STORAGE_KEY, serialized);
    }
    volatilePendingRevocations = remaining;
  } catch (error) {
    throw new Error(SESSION_CLEANUP_PERSISTENCE_ERROR, { cause: error });
  }
}

export function saveOidcLoginIntent(intent: OidcLoginIntent): boolean {
  try {
    const store = sessionStore();
    if (!isNonEmptyString(intent.state)) {
      return false;
    }
    const serialized = JSON.stringify(intent);
    store.setItem(OIDC_LOGIN_INTENT_STORAGE_KEY, serialized);
    return true;
  } catch (error) {
    throw new Error(SESSION_PERSISTENCE_ERROR, { cause: error });
  }
}

export function loadOidcLoginIntent(): OidcLoginIntent | null {
  const store = sessionStore();
  let raw: string | null;
  try {
    raw = store.getItem(OIDC_LOGIN_INTENT_STORAGE_KEY);
  } catch (error) {
    throw new Error(SESSION_STORAGE_UNAVAILABLE, { cause: error });
  }
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Stored OIDC login intent is invalid");
  }
  const intent = parsed as Partial<OidcLoginIntent>;
  if (
    isNonEmptyString(intent.state)
  ) {
    return { state: intent.state };
  }
  throw new Error("Stored OIDC login intent is invalid");
}

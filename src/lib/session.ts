import {
  MAX_MATRIX_IDENTIFIER_BYTES,
  validateCanonicalMatrixUserId,
  validateMatrixDeviceId,
  validateOidcEndpoint,
} from "./core";
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
  oidcIssuer: string;
  refreshToken: string;
  oidcClientId: string;
}

export function sameSessionIdentity(a: Session, b: Session): boolean {
  return a.homeserver === b.homeserver && a.userId === b.userId &&
    a.deviceId === b.deviceId && a.oidcIssuer === b.oidcIssuer && a.oidcClientId === b.oidcClientId;
}

function sessionsEqual(a: Session, b: Session): boolean {
  return (
    sameSessionIdentity(a, b) &&
    a.accessToken === b.accessToken &&
    a.refreshToken === b.refreshToken
  );
}

export const SESSION_STORAGE_KEY = "telecrypt-io-ui:session";
export const PENDING_REVOCATION_STORAGE_KEY = "telecrypt-io-ui:pending-revocation";
export const SESSION_PERSISTENCE_ERROR = "Session persistence failed";
export const SESSION_STORAGE_UNAVAILABLE = "Browser session storage is unavailable";
export const SESSION_CLEANUP_PENDING_ERROR = "Session cleanup is pending";
export const SESSION_CLEANUP_PERSISTENCE_ERROR = "Session cleanup could not be persisted";
export const OIDC_LOGIN_INTENT_STORAGE_KEY = "telecrypt-io-ui:oidc-login-intent";
export const MAX_MATRIX_ID_BYTES = MAX_MATRIX_IDENTIFIER_BYTES;
const OIDC_STATE_STORAGE_PREFIXES = ["mx_oidc_", "telecrypt:oauth2:pkce:v1:"];

export interface OidcLoginIntent {
  state: string;
}

export interface PendingRevocation {
  homeserver: string;
  /** Missing only for sessions created before separate auth issuers were supported. */
  oidcIssuer?: string;
  accessToken: string;
  refreshToken?: string;
  oidcClientId?: string;
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

function isOpaqueString(value: unknown): value is string {
  return isNonEmptyString(value) && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

export function isSessionToken(value: unknown): value is string {
  return isOpaqueString(value);
}

function isOidcBinding(value: unknown): value is string {
  if (!isOpaqueString(value)) return false;
  try {
    validateOidcEndpoint(value, "OIDC endpoint");
    return true;
  } catch {
    return false;
  }
}

function legacyOidcIssuer(): string {
  return `${getRuntimeSettings().homeserver.replace(/\/+$/u, "")}/`;
}

function isMatrixUserId(value: unknown, expectedServerName: string): value is string {
  try {
    validateCanonicalMatrixUserId(value, expectedServerName);
    return true;
  } catch {
    return false;
  }
}

export function isRuntimeMatrixUserId(value: unknown): value is string {
  const { serverName } = getRuntimeSettings();
  return isMatrixUserId(value, serverName);
}

export function isRuntimeMatrixDeviceId(value: unknown): value is string {
  try {
    validateMatrixDeviceId(value);
    return true;
  } catch {
    return false;
  }
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
  const oidcIssuer = session.oidcIssuer ?? legacyOidcIssuer();
  if (
    isNonEmptyString(session.homeserver) &&
    typeof session.userId === "string" &&
    isMatrixUserId(session.userId, serverName) &&
    isRuntimeMatrixDeviceId(session.deviceId) &&
    isSessionToken(session.accessToken) &&
    isSessionToken(session.refreshToken) &&
    isOpaqueString(session.oidcClientId) &&
    isOidcBinding(oidcIssuer) &&
    session.homeserver === homeserver
  ) {
    return { ...session, oidcIssuer } as Session;
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
      !isOidcBinding(session.oidcIssuer) ||
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

/** Clear only the session that a completed remote operation actually revoked. */
export function clearSessionIfCurrent(expected: Session): boolean {
  try {
    const store = sessionStore();
    const current = parseSession(store.getItem(SESSION_STORAGE_KEY), false);
    if (!current || !sessionsEqual(current, expected)) return false;
    store.removeItem(SESSION_STORAGE_KEY);
    return true;
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
    (parsed.oidcIssuer === undefined || isOidcBinding(parsed.oidcIssuer)) &&
    isSessionToken(parsed.accessToken) &&
    (parsed.refreshToken === undefined || isSessionToken(parsed.refreshToken)) &&
    (parsed.oidcClientId === undefined || isOpaqueString(parsed.oidcClientId)) &&
    matchesRuntimeHomeserver(parsed.homeserver)
  );
}

function sameRevocation(a: PendingRevocation, b: PendingRevocation): boolean {
  return a.homeserver === b.homeserver && a.accessToken === b.accessToken &&
    (a.oidcIssuer ?? legacyOidcIssuer()) === (b.oidcIssuer ?? legacyOidcIssuer()) &&
    a.refreshToken === b.refreshToken && a.oidcClientId === b.oidcClientId;
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
  const pending = candidates.map((target) => ({
    ...target,
    oidcIssuer: target.oidcIssuer ?? legacyOidcIssuer(),
  })).filter(
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
  target = { ...target, oidcIssuer: target.oidcIssuer ?? legacyOidcIssuer() };
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

/** Replace stale credentials with refreshed credentials before retrying logout. */
export function replacePendingRevocation(
  previous: PendingRevocation,
  next: PendingRevocation,
): boolean {
  next = { ...next, oidcIssuer: next.oidcIssuer ?? legacyOidcIssuer() };
  if (!isPendingRevocation(next)) return false;
  let replacement: PendingRevocation[] = [];
  try {
    replacement = loadPendingRevocations().filter(
      (candidate) => !sameRevocation(candidate, previous) && !sameRevocation(candidate, next),
    );
    replacement.push(next);
    volatilePendingRevocations = replacement;
    sessionStore().setItem(PENDING_REVOCATION_STORAGE_KEY, JSON.stringify(replacement));
    return true;
  } catch (error) {
    volatilePendingRevocations = [
      ...volatilePendingRevocations.filter(
        (candidate) => !sameRevocation(candidate, previous) && !sameRevocation(candidate, next),
      ),
      next,
    ];
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

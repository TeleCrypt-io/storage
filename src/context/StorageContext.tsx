import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { TeleCryptIOStorage } from "@telecrypt-io/storage";
import { assertRuntimeOidcEndpoint, getRuntimeSettings, runtimeOidcIssuer } from "../lib/buildConfig";
import {
  clearOidcTransientState,
  clearSession,
  loadPendingRevocations,
  loadSession,
  loadOidcLoginIntent,
  savePendingRevocation,
  saveSessionIfCurrent,
  isSessionToken,
  SESSION_CLEANUP_PENDING_ERROR,
  SESSION_CLEANUP_PERSISTENCE_ERROR,
  MAX_SESSION_IDENTITY_BYTES,
  SESSION_PERSISTENCE_ERROR,
  type Session,
} from "../lib/session";
import { formatOperationError } from "../lib/formatOperationError";
import { sanitizeDiagnosticError } from "../lib/errorDetails";
import {
  classifyOidcCallback,
  readOidcCallbackParams,
  scrubOidcCallbackParams,
} from "../lib/oidcCallback";
import { revokeOrRemember } from "../lib/revokeSession";
import { withAccountSignal } from "../lib/accountOperation";

export type ConnectionStatus = "signed-out" | "connecting" | "ready" | "error";

export interface ConnectLogEntry {
  at: number;
  message: string;
}

/** First-time WASM + IndexedDB init on GitHub Pages can take 30–60s. */
const UI_INIT_TIMEOUT_MS = 90_000;
const UI_SYNC_TIMEOUT_MS = 45_000;
/** Hard ceiling for the whole connect() call — never leave users on infinite Connecting. */
const UI_CONNECT_TIMEOUT_MS = 120_000;
/** One hard ceiling for discovery, authorization-code exchange, and callback validation. */
const UI_OIDC_TIMEOUT_MS = 120_000;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

interface StorageContextValue {
  status: ConnectionStatus;
  session: Session | null;
  storage: TeleCryptIOStorage | null;
  /** Aborted immediately when this account/client is replaced or logged out. */
  accountSignal: AbortSignal | null;
  error: string | null;
  /** Live status lines while connecting (empty when not connecting). */
  connectLog: ConnectLogEntry[];
  /** Starts the OIDC/MAS login redirect — does not return on success
   * (navigates away). Sets `status`/`error` if discovery/DCR fail before
   * the redirect. */
  loginWithOidc: () => Promise<void>;
  logout: () => Promise<void>;
  logoutPending: boolean;
}

const StorageContext = createContext<StorageContextValue | null>(null);

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  onExpire?: () => void,
): { promise: Promise<T>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel!: () => void;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      onExpire?.();
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
    cancel = () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      onExpire?.();
      reject(new Error(`${label} cancelled`));
    };
  });
  const timed = Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  });
  return { promise: timed, cancel };
}

function stopClient(client: TeleCryptIOStorage | null): unknown | undefined {
  if (!client) return undefined;
  try {
    client.getClient().stopClient();
    return undefined;
  } catch (error) {
    return error;
  }
}

function preserveFailure(primary: unknown | undefined, cleanup: unknown | undefined): unknown | undefined {
  if (primary === undefined) return cleanup;
  if (cleanup === undefined) return primary;
  return new AggregateError([primary, cleanup], "operation and client cleanup failed", { cause: primary });
}

export function StorageProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ConnectionStatus>("signed-out");
  const [session, setSession] = useState<Session | null>(null);
  const [storage, setStorage] = useState<TeleCryptIOStorage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectLog, setConnectLog] = useState<ConnectLogEntry[]>([]);
  const [logoutPending, setLogoutPending] = useState(false);
  const [accountSignal, setAccountSignal] = useState<AbortSignal | null>(null);
  // Dedupes concurrent connect() calls for the same access token and guards
  // against building a second MatrixClient from a re-render racing auto-connect.
  const connectInflightRef = useRef<{ token: string; promise: Promise<void> } | null>(null);
  const connectGenRef = useRef(0);
  const connectStartedAtRef = useRef<number | null>(null);
  const storageRef = useRef<TeleCryptIOStorage | null>(null);
  const connectCleanupRef = useRef<(() => void) | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const logoutInflightRef = useRef<{
    generation: number;
    accessToken: string;
    controller: AbortController;
    promise: Promise<void>;
  } | null>(null);
  const accountAbortRef = useRef<AbortController | null>(null);
  const oidcAbortRef = useRef<AbortController | null>(null);
  storageRef.current = storage;
  sessionRef.current = session;

  const appendLog = useCallback((message: string) => {
    setConnectLog((prev) => [...prev, { at: Date.now(), message }]);
  }, []);

  const appendOrReplaceDownloadLog = useCallback((message: string) => {
    setConnectLog((prev) => {
      const last = prev[prev.length - 1];
      if (last?.message.startsWith("Downloading encryption engine")) {
        return [...prev.slice(0, -1), { at: Date.now(), message }];
      }
      return [...prev, { at: Date.now(), message }];
    });
  }, []);

  const beginConnecting = useCallback((firstMessage: string) => {
    connectStartedAtRef.current = Date.now();
    setStatus("connecting");
    setError(null);
    setConnectLog([{ at: Date.now(), message: firstMessage }]);
  }, []);

  const connect = useCallback(
    async (s: Session) => {
      const inflight = connectInflightRef.current;
      if (inflight?.token === s.accessToken) {
        return inflight.promise;
      }

      const gen = ++connectGenRef.current;
      connectCleanupRef.current?.();
      connectCleanupRef.current = null;
      const abortController = new AbortController();
      let cancelTimeout: (() => void) | null = null;
      const cleanup = () => {
        abortController.abort();
      };
      const cancelOperation = () => {
        cleanup();
        cancelTimeout?.();
      };
      connectCleanupRef.current = cancelOperation;

      const run = (async () => {
        // Keep the latest persisted token set for this client. OAuth providers may rotate the
        // refresh token on one response and omit it on a later response; falling back to the
        // session captured at connect() time would then resurrect an invalid, pre-rotation token.
        let currentSession = s;
        // Keep an existing log (e.g. an OIDC callback already
        // started connecting) instead of wiping it when connect() runs.
        const log = (message: string) => {
          if (gen === connectGenRef.current) appendLog(message);
        };
        const logDownload = (message: string) => {
          if (gen === connectGenRef.current) appendOrReplaceDownloadLog(message);
        };
        let client: TeleCryptIOStorage | null = null;
        if (connectStartedAtRef.current == null) {
          beginConnecting(`Restoring session for ${s.userId}…`);
        } else {
          log(`Opening encrypted session for ${s.userId}…`);
        }
        try {
          const bootstrapOpts = {
            syncTimeoutMs: UI_SYNC_TIMEOUT_MS,
            initTimeoutMs: UI_INIT_TIMEOUT_MS,
            signal: abortController.signal,
            onProgress: (message: string) => {
              if (gen !== connectGenRef.current) return;
              if (message.startsWith("Downloading encryption engine")) {
                logDownload(message);
              } else {
                log(message);
              }
            },
          };
          try {
            log("Discovering authentication server…");
            // Crypto and the Matrix SDK are intentionally fetched only when a
            // session is being opened, not on the public sign-in screen.
            const core = await import("../lib/core");
            const { homeserver, serverName } = getRuntimeSettings();
            const authMetadata = await core.discoverOidcIssuer(homeserver, abortController.signal);
            if (
              typeof authMetadata.issuer !== "string" ||
              utf8ByteLength(authMetadata.issuer) > MAX_SESSION_IDENTITY_BYTES ||
              authMetadata.issuer !== runtimeOidcIssuer()
            ) {
              throw new Error("Authentication issuer changed; log in again");
            }
            if (
              typeof authMetadata.token_endpoint !== "string" ||
              utf8ByteLength(authMetadata.token_endpoint) > MAX_SESSION_IDENTITY_BYTES
            ) {
              throw new Error("OIDC token endpoint is invalid or too large");
            }
            assertRuntimeOidcEndpoint(
              authMetadata.token_endpoint,
              "OIDC token endpoint",
            );
            log(`Auth issuer: ${authMetadata.issuer}`);
            const tokenRefreshFunction = core.buildTokenRefreshFunction(
              authMetadata,
              s.oidcClientId,
              async (tokens) => {
                const accessTokenIsSafe = isSessionToken(tokens.accessToken);
                const refreshTokenIsSafe =
                  tokens.refreshToken === undefined || isSessionToken(tokens.refreshToken);
                if (!accessTokenIsSafe || !refreshTokenIsSafe) {
                  throw new Error("OIDC token response is invalid");
                }
                if (gen !== connectGenRef.current) {
                  throw new Error("Session is no longer active");
                }
                const previousSession = currentSession;
                const nextSession = {
                  ...currentSession,
                  accessToken: tokens.accessToken,
                  refreshToken: tokens.refreshToken ?? currentSession.refreshToken,
                };
                if (!saveSessionIfCurrent(nextSession, previousSession)) {
                  throw new Error("Session is no longer active");
                }
                currentSession = nextSession;
                if (gen === connectGenRef.current) {
                  sessionRef.current = currentSession;
                  setSession(currentSession);
                }
              },
              s.deviceId,
            );
            const guardedTokenRefreshFunction = async (
              refreshToken: string,
              refreshSignal?: AbortSignal,
            ) => {
              if (
                !isSessionToken(refreshToken)
              ) {
                throw new Error("OIDC refresh token is invalid or too large");
              }
              if (gen !== connectGenRef.current) throw new Error("Session is no longer active");
              // `abortController` belongs to the one-time bootstrap. It is closed as soon as
              // the client is ready, so reusing it would make every later refresh fail as
              // cancelled. Matrix supplies a per-refresh signal when it needs cancellation;
              // otherwise the SDK owns its bounded request timeout.
              return tokenRefreshFunction(refreshToken, refreshSignal);
            };
            log("Building encrypted client (OIDC session)…");
            const createFromOidc = core.TeleCryptIOStorage.createFromOidc as unknown as (
              options: Parameters<typeof core.TeleCryptIOStorage.createFromOidc>[0] & { serverName: string },
            ) => Promise<TeleCryptIOStorage>;
            client = await createFromOidc({
              baseUrl: homeserver,
              serverName,
              userId: s.userId,
              accessToken: s.accessToken,
              deviceId: s.deviceId,
              refreshToken: s.refreshToken,
              tokenRefreshFunction: guardedTokenRefreshFunction,
              ...bootstrapOpts,
            });
          } finally {
            cleanup();
            if (connectCleanupRef.current === cancelOperation) connectCleanupRef.current = null;
          }
          if (!client) throw new Error("Encrypted client was not created");
          if (gen !== connectGenRef.current) {
            const cleanupError = stopClient(client);
            if (cleanupError) appendLog(`Failed: ${formatOperationError(cleanupError)}`);
            return;
          }
          log("Connected.");
          accountAbortRef.current?.abort();
          const accountAbortController = new AbortController();
          accountAbortRef.current = accountAbortController;
          setAccountSignal(accountAbortController.signal);
          setStorage(client);
          sessionRef.current = currentSession;
          setSession(currentSession);
          setStatus("ready");
        } catch (err) {
          const failure = preserveFailure(err, stopClient(client));
          if (gen !== connectGenRef.current) {
            if (failure !== err) appendLog(`Failed: ${formatOperationError(failure)}`);
            return;
          }
          const msg = formatOperationError(failure);
          appendLog(`Failed: ${msg}`);
          setError(msg);
          setStatus("error");
        }
      })();

      const timedControl = withTimeout(run, UI_CONNECT_TIMEOUT_MS, "Connection");
      cancelTimeout = timedControl.cancel;
      const timed = timedControl.promise.catch((err) => {
        if (gen !== connectGenRef.current) return;
        // Invalidate this generation and abort the SDK bootstrap signal.
        connectGenRef.current += 1;
        cancelOperation();
        if (connectCleanupRef.current === cancelOperation) connectCleanupRef.current = null;
        connectStartedAtRef.current = null;
        const msg = formatOperationError(err);
        appendLog(`Failed: ${msg}`);
        setError(msg);
        setStatus("error");
      });

      connectInflightRef.current = { token: s.accessToken, promise: timed };
      try {
        await timed;
      } finally {
        if (connectInflightRef.current?.promise === timed) {
          connectInflightRef.current = null;
        }
      }
    },
    [appendLog, appendOrReplaceDownloadLog, beginConnecting],
  );

  const invalidateActiveConnection = useCallback((): unknown | undefined => {
    connectGenRef.current += 1;
    connectCleanupRef.current?.();
    connectCleanupRef.current = null;
    const currentStorage = storageRef.current;
    storageRef.current = null;
    const cleanupError = stopClient(currentStorage);
    connectInflightRef.current = null;
    connectStartedAtRef.current = null;
    accountAbortRef.current?.abort();
    accountAbortRef.current = null;
    setAccountSignal(null);
    oidcAbortRef.current?.abort();
    oidcAbortRef.current = null;
    logoutInflightRef.current?.controller.abort();
    logoutInflightRef.current = null;
    sessionRef.current = null;
    setStorage(null);
    setSession(null);
    setConnectLog([]);
    return cleanupError;
  }, []);

  const resetConnection = useCallback((clearPersistedSession: boolean, primary?: unknown) => {
    const cleanupError = invalidateActiveConnection();
    const activeFailure = preserveFailure(primary, cleanupError);
    const persistedSessionCleared = !clearPersistedSession || clearSession();
    const persistenceError = persistedSessionCleared ? undefined : new Error(SESSION_PERSISTENCE_ERROR);
    const failure = preserveFailure(activeFailure, persistenceError);
    setStatus(failure ? "error" : "signed-out");
    setError(failure ? formatOperationError(failure) : null);
  }, [invalidateActiveConnection]);

  useEffect(() => {
    return () => {
      connectGenRef.current += 1;
      connectCleanupRef.current?.();
      connectCleanupRef.current = null;
      const currentStorage = storageRef.current;
      storageRef.current = null;
      const cleanupError = stopClient(currentStorage);
      accountAbortRef.current?.abort();
      accountAbortRef.current = null;
      oidcAbortRef.current?.abort();
      oidcAbortRef.current = null;
      connectInflightRef.current = null;
      sessionRef.current = null;
      logoutInflightRef.current?.controller.abort();
      logoutInflightRef.current = null;
      // Finish cancellation before surfacing the stop failure to React.
      if (cleanupError) throw cleanupError;
    };
  }, []);

  useEffect(() => {
    const restoreExistingSession = () => {
      let pendingCleanup: number;
      try {
        pendingCleanup = loadPendingRevocations().length;
      } catch (error) {
        setError(formatOperationError(error));
        setStatus("error");
        return;
      }
      if (pendingCleanup !== 0) {
        setError(formatOperationError(new Error(SESSION_CLEANUP_PENDING_ERROR)));
        setStatus("error");
        return;
      }
      let existing: Session | null;
      try {
        existing = loadSession();
      } catch (error) {
        setError(formatOperationError(error));
        setStatus("error");
        return;
      }
      if (existing) {
        if (storageRef.current && sessionRef.current) setStatus("ready");
        else void connect(existing);
      } else {
        setStatus("signed-out");
      }
    };
    const callbackKind = classifyOidcCallback(window.location);
    if (callbackKind === "malformed") {
      scrubOidcCallbackParams(window.location);
      // A malformed/spurious callback must not clear a live session, but it must
      // not leave an old one-time PKCE transaction available for replay either.
      try {
        clearOidcTransientState();
      } catch (error) {
        setError(formatOperationError(error));
        setStatus("error");
        return;
      }
      restoreExistingSession();
      return;
    }
    if (callbackKind === "success" || callbackKind === "error") {
      const callbackParams = readOidcCallbackParams(window.location);
      const callbackState = callbackParams.get("state");
      let callbackIntent: ReturnType<typeof loadOidcLoginIntent>;
      try {
        callbackIntent = loadOidcLoginIntent();
      } catch (error) {
        scrubOidcCallbackParams(window.location);
        let failure: unknown = error;
        try {
          clearOidcTransientState();
        } catch (cleanupError) {
          failure = preserveFailure(error, cleanupError);
        }
        setError(formatOperationError(failure));
        setStatus("error");
        return;
      }
      if (!callbackIntent || !callbackState || callbackState !== callbackIntent.state) {
        scrubOidcCallbackParams(window.location);
        try {
          clearOidcTransientState();
        } catch (error) {
          setError(formatOperationError(error));
          setStatus("error");
          return;
        }
        restoreExistingSession();
        return;
      }
      const connectionCleanupError = invalidateActiveConnection();
      if (connectionCleanupError) {
        setError(formatOperationError(connectionCleanupError));
        setStatus("error");
        return;
      }
      const callbackGeneration = connectGenRef.current;
      const callbackAbortController = new AbortController();
      oidcAbortRef.current = callbackAbortController;
      beginConnecting("Completing sign-in…");
      void import("../lib/oidcAuth")
        .then(({ completeOidcLoginFromCallback }) =>
          withTimeout(
            withAccountSignal(callbackAbortController.signal, () =>
              completeOidcLoginFromCallback(callbackAbortController.signal),
            ),
            UI_OIDC_TIMEOUT_MS,
            "Sign-in callback",
            () => callbackAbortController.abort(),
          ).promise,
        )
        .then(async (s) => {
          if (callbackGeneration !== connectGenRef.current) {
            const cleanupError = await revokeOrRemember(s, callbackAbortController.signal);
            if (cleanupError) appendLog(`Failed: ${formatOperationError(cleanupError)}`);
            return;
          }
          appendLog(`Signed in as ${s.userId}`);
          let saved = false;
          let saveError: unknown;
          try {
            saved = saveSessionIfCurrent(s, null);
          } catch (error) {
            saveError = error;
            saved = false;
          }
          if (!saved) {
            const primary = saveError === undefined
              ? new Error(SESSION_PERSISTENCE_ERROR)
              : new Error(SESSION_PERSISTENCE_ERROR, { cause: sanitizeDiagnosticError(saveError) });
            const cleanupError = await revokeOrRemember(
              s,
              callbackAbortController.signal,
              primary,
            );
            if (callbackGeneration !== connectGenRef.current) {
              if (cleanupError) appendLog(`Failed: ${formatOperationError(cleanupError)}`);
              return;
            }
            resetConnection(false, cleanupError ?? primary);
            return;
          }
          return connect(s);
        })
        .catch((err) => {
          if (callbackGeneration !== connectGenRef.current) return;
          const msg = formatOperationError(err);
          appendLog(`Failed: ${msg}`);
          setError(msg);
          setStatus("error");
        })
        .finally(() => {
          if (oidcAbortRef.current === callbackAbortController) oidcAbortRef.current = null;
        });
      return;
    }
    restoreExistingSession();
    // Intentionally run once on mount only; loginWithOidc() drives
    // subsequent connections explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beginConnecting, connect, invalidateActiveConnection]);

  const loginWithOidc = useCallback(
    async () => {
      const connectionCleanupError = invalidateActiveConnection();
      if (connectionCleanupError) {
        const msg = formatOperationError(connectionCleanupError);
        appendLog(`Failed: ${msg}`);
        setError(msg);
        setStatus("error");
        return;
      }
      setLogoutPending(false);
      beginConnecting("Redirecting to sign-in…");
      const loginAbortController = new AbortController();
      oidcAbortRef.current = loginAbortController;
      try {
        const begin = import("../lib/oidcAuth");
        await withTimeout(
          withAccountSignal(loginAbortController.signal, async () =>
            (await begin).beginOidcLogin(loginAbortController.signal),
          ),
          UI_OIDC_TIMEOUT_MS,
          "OIDC sign-in",
          () => loginAbortController.abort(),
        ).promise; // navigates away on success
      } catch (err) {
        const msg = formatOperationError(err);
        appendLog(`Failed: ${msg}`);
        // The client was stopped before cleanup began. Keep the persisted session or pending
        // revocation record for the next retry, but never present a possibly revoked client as
        // live after a replacement-login failure.
        resetConnection(false, err);
      } finally {
        if (oidcAbortRef.current === loginAbortController) oidcAbortRef.current = null;
      }
    },
    [appendLog, beginConnecting, invalidateActiveConnection, resetConnection],
  );

  const logout = useCallback(async () => {
    const inflight = logoutInflightRef.current;
    if (inflight && inflight.generation === connectGenRef.current) {
      return inflight.promise;
    }
    const target = sessionRef.current;
    if (!target) {
      resetConnection(true);
      return;
    }

    const connectionCleanupError = invalidateActiveConnection();
    if (connectionCleanupError) {
      const msg = formatOperationError(connectionCleanupError);
      setError(msg);
      setStatus("error");
      return;
    }
    const generation = connectGenRef.current;
    const logoutController = new AbortController();
    setLogoutPending(true);
    setError(null);
    const operation = (async () => {
      let current = target;
      try {
        for (;;) {
          const cleanupError = await revokeOrRemember(current, logoutController.signal);
          if (cleanupError) throw cleanupError;
          // A new login or connection may have started while the network request was in flight.
          // Never inspect or revoke that newer session as if it were a rotated token from logout.
          if (generation !== connectGenRef.current) return;
          const latest = loadSession();
          if (
            !latest ||
            (latest.accessToken === current.accessToken && latest.refreshToken === current.refreshToken)
          ) {
            resetConnection(true);
            setLogoutPending(false);
            return;
          }
          current = latest;
        }
      } catch (err) {
        let recorded = false;
        let persistenceError: unknown;
        try {
          recorded = savePendingRevocation(current);
        } catch (saveError) {
          persistenceError = saveError;
        }
        if (generation === connectGenRef.current) {
          resetConnection(
            false,
            recorded
              ? err
              : preserveFailure(
                err,
                persistenceError ?? new Error(SESSION_CLEANUP_PERSISTENCE_ERROR),
              ),
          );
          setLogoutPending(false);
        }
        return;
      } finally {
        if (generation === connectGenRef.current) setLogoutPending(false);
      }
    })();
    logoutInflightRef.current = {
      generation,
      accessToken: target.accessToken,
      controller: logoutController,
      promise: operation,
    };
    try {
      await operation;
    } finally {
      if (logoutInflightRef.current?.promise === operation) logoutInflightRef.current = null;
    }
  }, [invalidateActiveConnection, resetConnection]);

  return (
    <StorageContext.Provider
      value={{
        status,
        session,
        storage,
        accountSignal,
        error,
        connectLog,
        loginWithOidc,
        logout,
        logoutPending,
      }}
    >
      {children}
    </StorageContext.Provider>
  );
}

// The provider and its paired hook intentionally share this module's private context.
// oxlint-disable-next-line react/only-export-components
export function useStorage(): StorageContextValue {
  const ctx = useContext(StorageContext);
  if (!ctx) throw new Error("useStorage() must be used within a StorageProvider");
  return ctx;
}

import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import "./App.css";
import { StorageProvider, useStorage } from "./context/StorageContext";
import { LoginScreen } from "./components/LoginScreen";
import { BrandMark } from "./components/BrandMark";
import { formatElapsed } from "./lib/formatElapsed";

const FileManager = lazy(async () => ({ default: (await import("./components/FileManager")).FileManager }));
const RecoveryPanel = lazy(async () => ({
  default: (await import("./components/RecoveryPanel")).RecoveryPanel,
}));

type View = "vaults" | "recovery";

function ConnectingScreen() {
  const { error, connectLog } = useStorage();
  const [now, setNow] = useState(() => Date.now());
  const startedAt = connectLog[0]?.at ?? now;

  // oxlint-disable react/set-state-in-effect
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="centered connecting-screen">
      <p data-testid="connecting">Connecting…</p>
      <p className="muted connecting-hint">
        First login may take up to a minute while encryption initializes.
      </p>
      <p className="muted connecting-elapsed" data-testid="connect-elapsed">
        Elapsed {formatElapsed(now - startedAt)}
      </p>

      <ol className="connect-log tc-surface" data-testid="connect-log" aria-live="polite">
        {connectLog.map((entry, i) => {
          const isLatest = i === connectLog.length - 1;
          const relative = formatElapsed(entry.at - startedAt);
          return (
            <li key={`${entry.at}-${i}`} className={isLatest ? "latest" : undefined}>
              <span className="connect-log-time">{relative}</span>
              <span className="connect-log-msg">{entry.message}</span>
            </li>
          );
        })}
      </ol>

      {error && (
        <p className="error" data-testid="connect-error">
          {error}
        </p>
      )}
    </div>
  );
}

function Shell() {
  const { status, session, storage, error, logout, logoutPending } = useStorage();
  const [readyStorage, setReadyStorage] = useState<typeof storage>(null);
  const keySafeReady = storage !== null && readyStorage === storage;
  const onReadinessChange = useCallback((ready: boolean) => {
    setReadyStorage(ready ? storage : null);
  }, [storage]);
  const [view, setView] = useState<View>("vaults");

  if (status === "signed-out" || status === "error") {
    return <LoginScreen />;
  }

  if (status === "connecting") {
    return <ConnectingScreen />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <BrandMark />
          <span>TeleCrypt Storage</span>
        </span>
        <span className="user muted" data-testid="current-user">
          {session?.userId}
        </span>
        <nav>
          <button
            type="button"
            className={view === "vaults" ? "active" : ""}
            onClick={() => setView("vaults")}
            data-testid="nav-vaults"
            disabled={!keySafeReady}
          >
            Files
          </button>
          <button
            type="button"
            className={view === "recovery" ? "active" : ""}
            onClick={() => setView("recovery")}
            data-testid="nav-key-safe"
          >
            Decryption Key Safe
          </button>
        </nav>
        <button
          type="button"
          className="link"
          onClick={() => void logout()}
          disabled={logoutPending}
          data-testid="logout"
        >
          {logoutPending ? "Logging out…" : "Log out"}
        </button>
      </header>
      <main className="app-main">
        {error && (
          <p className="error" data-testid="shell-error">
            {error}
          </p>
        )}
        <Suspense fallback={<p className="muted">Loading encrypted storage…</p>}>
          <div className="recovery-wrap" hidden={keySafeReady && view === "vaults"}>
            <RecoveryPanel hidden={keySafeReady && view === "vaults"} onReadinessChange={onReadinessChange} />
          </div>
          {keySafeReady && view === "vaults" && (
            <FileManager />
          )}
        </Suspense>
      </main>
    </div>
  );
}

function App() {
  return (
    <StorageProvider>
      <Shell />
    </StorageProvider>
  );
}

export default App;

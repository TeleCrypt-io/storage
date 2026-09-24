import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useStorage } from "../context/StorageContext";
import type { TeleCryptIOStorage } from "../lib/core";
import { formatOperationError } from "../lib/formatOperationError";
import { withAccountSignal } from "../lib/accountOperation";

type SafeStatus = Awaited<ReturnType<TeleCryptIOStorage["keySafe"]["getStatus"]>>;
const SAFE_OPERATION_TIMEOUT_MS = 30_000;
const KEY_LOSS_WARNING = "Save this Recovery Key somewhere safe. If you lose this key and access to all your signed-in devices, your files may become permanently unreadable. Resetting your account password will not restore access.";

function withSafeDeadline<T>(
  accountSignal: AbortSignal | null,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(accountSignal?.reason);
  if (accountSignal?.aborted) abort();
  else accountSignal?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new DOMException("Decryption Key Safe operation timed out. Check its status before retrying.", "TimeoutError");
      controller.abort(error);
      reject(error);
    }, SAFE_OPERATION_TIMEOUT_MS);
  });
  return Promise.race([
    withAccountSignal(controller.signal, () => operation(controller.signal)),
    timeout,
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    accountSignal?.removeEventListener("abort", abort);
  });
}

/** Stays mounted while Files is open so readiness has one account-scoped owner. */
export function RecoveryPanel({
  hidden = false,
  onReadinessChange,
}: {
  hidden?: boolean;
  onReadinessChange: (ready: boolean) => void;
}) {
  const { storage, accountSignal } = useStorage();
  const [safeStatus, setSafeStatus] = useState<SafeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoreKeyInput, setRestoreKeyInput] = useState("");
  const [copied, setCopied] = useState(false);
  const identityRef = useRef(storage);
  const generationRef = useRef(0);
  const mutationInFlightRef = useRef(false);
  // oxlint-disable-next-line react/refs
  identityRef.current = storage;

  function isCurrent(expectedStorage: typeof storage, generation: number): boolean {
    return !(accountSignal?.aborted ?? false) &&
      generationRef.current === generation && identityRef.current === expectedStorage;
  }

  const refreshStatus = useCallback(async () => {
    if (!storage) return;
    const generation = generationRef.current;
    try {
      const status = await withSafeDeadline(accountSignal, (signal) => storage.keySafe.getStatus(signal));
      if (!isCurrent(storage, generation)) return;
      if (status.state === "ready") {
        await withSafeDeadline(accountSignal, (signal) => storage.startSync(signal));
        if (!isCurrent(storage, generation)) return;
      }
      setSafeStatus(status);
      setError(null);
      onReadinessChange(status.state === "ready");
    } catch (err) {
      if (!isCurrent(storage, generation)) return;
      setSafeStatus(null);
      setError(formatOperationError(err));
      onReadinessChange(false);
    }
    // isCurrent is the account-scoped guard for this request.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [accountSignal, storage, onReadinessChange]);

  useEffect(() => {
    generationRef.current += 1;
    mutationInFlightRef.current = false;
    // oxlint-disable-next-line react/set-state-in-effect
    setSafeStatus(null);
    setError(null);
    setBusy(false);
    setRestoreKeyInput("");
    setCopied(false);
    onReadinessChange(false);
    void refreshStatus();
    return () => { generationRef.current += 1; };
  }, [refreshStatus, onReadinessChange]);

  async function mutate(operation: (signal: AbortSignal) => Promise<unknown>) {
    const expectedStorage = storage;
    const generation = generationRef.current;
    if (!expectedStorage || !isCurrent(expectedStorage, generation) || mutationInFlightRef.current) return;
    mutationInFlightRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await withSafeDeadline(accountSignal, operation);
      if (isCurrent(expectedStorage, generation)) await refreshStatus();
    } catch (err) {
      if (isCurrent(expectedStorage, generation)) {
        // A timed-out request may have changed remote state. Read it before offering another setup.
        setSafeStatus(null);
        setError(formatOperationError(err));
        onReadinessChange(false);
      }
    } finally {
      if (generationRef.current === generation) mutationInFlightRef.current = false;
      if (isCurrent(expectedStorage, generation)) setBusy(false);
    }
  }

  async function restore(event: FormEvent) {
    event.preventDefault();
    const key = restoreKeyInput.trim();
    try {
      await mutate((signal) => storage!.keySafe.restore(key, signal));
    } finally {
      if (identityRef.current === storage) setRestoreKeyInput("");
    }
  }

  const recoveryKey = safeStatus?.state === "confirmation-required" ? safeStatus.recoveryKey : undefined;

  async function copyKey() {
    if (!recoveryKey) return;
    const generation = generationRef.current;
    try {
      await navigator.clipboard.writeText(recoveryKey);
      if (isCurrent(storage, generation)) { setCopied(true); setError(null); }
    } catch (err) {
      if (isCurrent(storage, generation)) setError(formatOperationError(err));
    }
  }

  function saveKey() {
    if (!recoveryKey) return;
    let url: string | undefined;
    try {
      url = URL.createObjectURL(new Blob([`${recoveryKey}\n`], { type: "text/plain;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "decryption-key-safe.txt";
      link.click();
      setError(null);
    } catch (err) {
      setError(formatOperationError(err));
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }

  return (
    <div className="panel" hidden={hidden} data-testid="key-safe-panel">
      <h2>Decryption Key Safe</h2>
      {!safeStatus && !error && <p className="muted" data-testid="key-safe-loading">Checking Decryption Key Safe…</p>}
      {!safeStatus && error && (
        <button className="btn" disabled={busy} onClick={() => void refreshStatus()} data-testid="key-safe-retry">
          Check Decryption Key Safe status
        </button>
      )}
      {safeStatus?.state === "setup-required" && (
        <div data-testid="key-safe-setup-required">
          <p>Set up your Decryption Key Safe before using Storage. It stores encrypted copies of the keys needed to read your files.</p>
          <p>{KEY_LOSS_WARNING}</p>
          <button className="btn btn-primary" disabled={busy} onClick={() => void mutate((signal) => storage!.keySafe.setup(signal))} data-testid="setup-key-safe">
            {busy ? "Setting up…" : "Set up the Decryption Key Safe"}
          </button>
        </div>
      )}
      {recoveryKey && (
        <div className="warning" data-testid="key-safe-key-display">
          <p>{KEY_LOSS_WARNING}</p>
          <code data-testid="key-safe-recovery-key">{recoveryKey}</code>
          <p>Keep it outside this browser, in a password manager or another safe place you can access after losing this device.</p>
          <button className="btn" type="button" onClick={() => void copyKey()} data-testid="copy-key-safe-key">{copied ? "Copied" : "Copy key"}</button>{" "}
          <button className="btn" type="button" onClick={saveKey} data-testid="save-key-safe-key">Save key</button>{" "}
          <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void mutate((signal) => storage!.keySafe.confirmSaved(signal))} data-testid="confirm-saved-key">
            {busy ? "Completing setup…" : "I've saved my key"}
          </button>
        </div>
      )}
      {safeStatus?.state === "restore-required" && (
        <form className="restore-form" onSubmit={(event) => void restore(event)} data-testid="key-safe-restore-required">
          <p>Your account already has a Decryption Key Safe. Enter your saved Recovery Key to set up this login and restore access to your files.</p>
          <label htmlFor="restore-key-input">Recovery Key</label>
          <textarea className="tc-field" id="restore-key-input" rows={4} value={restoreKeyInput} onChange={(event) => setRestoreKeyInput(event.target.value)} data-testid="restore-key-input" />
          <button className="btn btn-primary" type="submit" disabled={busy || !restoreKeyInput.trim()} data-testid="restore-key-submit">{busy ? "Restoring…" : "Restore access"}</button>
        </form>
      )}
      {safeStatus?.state === "ready" && <p data-testid="key-safe-ready">Your Decryption Key Safe is ready.</p>}
      {error && <p className="error" data-testid="key-safe-error">{error}</p>}
    </div>
  );
}

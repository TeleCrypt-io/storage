import { MutationPartialError, StorageError, type TeleCryptIOStorage } from "@telecrypt-io/storage";

interface Target { treeId: string; fileId?: string }
interface PendingBackup {
  key: string;
  targets: Map<string, Target>;
  writes: Set<Promise<unknown>>;
  closing: boolean;
  beforeUnload: (event: BeforeUnloadEvent) => void;
}
const pending = new WeakMap<TeleCryptIOStorage, PendingBackup>();
const targetKey = (target: Target) => JSON.stringify([target.treeId, target.fileId]);

function state(storage: TeleCryptIOStorage): PendingBackup {
  const existing = pending.get(storage);
  if (existing) return existing;
  const client = storage.getClient();
  const key = `telecrypt-io-ui:pending-key-backups:${JSON.stringify([
    client.getHomeserverUrl(), client.getUserId(), client.getDeviceId(),
  ])}`;
  const targets: Target[] = JSON.parse(sessionStorage.getItem(key) ?? "[]");
  const value: PendingBackup = {
    key, targets: new Map(targets.map((target) => [targetKey(target), target])),
    writes: new Set(), closing: false,
    beforeUnload(event) {
      if (value.targets.size || value.writes.size) {
        event.preventDefault();
        event.returnValue = "";
      }
    },
  };
  pending.set(storage, value);
  window.addEventListener("beforeunload", value.beforeUnload);
  return value;
}

export function startBackupTracking(storage: TeleCryptIOStorage): void {
  state(storage);
}

function persist(value: PendingBackup) {
  if (value.targets.size) sessionStorage.setItem(value.key, JSON.stringify([...value.targets.values()]));
  else sessionStorage.removeItem(value.key);
}

async function settle(storage: TeleCryptIOStorage, value: PendingBackup, target: Target) {
  const result = await storage.waitForKeyBackup(target.treeId, target.fileId);
  if (result !== "backed_up" && result !== "deleted") {
    throw new StorageError("key backup target has not settled");
  }
  if (value.targets.get(targetKey(target)) === target) value.targets.delete(targetKey(target));
  persist(value);
}

/** Keep the committed result separate from backup failure; never repeat the write. */
export function backedUp<Args extends unknown[], Result extends { id: string }>(
  operation: (storage: TeleCryptIOStorage, ...args: Args) => Promise<Result>,
  label: string,
  fileTree?: (args: Args) => string,
) {
  return (storage: TeleCryptIOStorage, ...args: Args): Promise<Result> => {
    const value = state(storage);
    if (value.closing) return Promise.reject(new StorageError("Logout is finishing pending changes"));
    const write = (async () => {
      let result: Result;
      try {
        result = await operation(storage, ...args);
      } catch (error) {
        if (!(error instanceof MutationPartialError) || error.backupTargets.length === 0) throw error;
        const targets = error.backupTargets.map((target) => ({ ...target }));
        for (const target of targets) value.targets.set(targetKey(target), target);
        persist(value);
        try {
          for (const target of targets) await settle(storage, value, target);
        } catch (cause) {
          throw new MutationPartialError(
            error.operation,
            error.completedIds,
            "The encrypted change was accepted but its key backup is still pending. Keep this tab open and retry logging out when the connection recovers. Do not repeat the change or upload.",
            {
              cause: new AggregateError([error, cause], "partial change and key backup are incomplete"),
              treeId: error.treeId,
              backupTargets: targets,
            },
          );
        }
        throw error;
      }
      const target = fileTree ? { treeId: fileTree(args), fileId: result.id } : { treeId: result.id };
      value.targets.set(targetKey(target), target);
      try {
        persist(value);
        await settle(storage, value, target);
      } catch (cause) {
        throw new MutationPartialError(
          `${label} key backup`, [result.id],
          "Saved, but its decryption keys are not backed up yet. Keep this tab open and retry logging out " +
          "when the connection recovers. Do not repeat the change or upload the file again.",
          { cause, treeId: target.treeId, backupTargets: [target] },
        );
      }
      return result;
    })();
    value.writes.add(write);
    void write.finally(() => value.writes.delete(write)).catch(() => undefined);
    return write;
  };
}

/** Finish live writes before stopping crypto or revoking this device's session. */
export async function settleKeyBackupBeforeLogout(storage: TeleCryptIOStorage): Promise<void> {
  const value = state(storage);
  value.closing = true;
  try {
    await Promise.allSettled([...value.writes]);
    // A restored browser session can expose Log out before its first room
    // sync has populated the local store needed by backup verification.
    if (value.targets.size) await storage.startSync();
    for (const target of value.targets.values()) await settle(storage, value, target);
  } catch (cause) {
    value.closing = false;
    throw new StorageError(
      "Decryption keys are not backed up yet. Keep this tab open and retry logging out when the connection recovers.",
      { cause },
    );
  }
}

export function forgetDeletedBackup(storage: TeleCryptIOStorage, treeId: string, fileId?: string): void {
  const value = state(storage);
  value.targets.delete(targetKey({ treeId, fileId }));
  persist(value);
}

export function stopBackupTracking(storage: TeleCryptIOStorage): void {
  const value = pending.get(storage);
  if (value) window.removeEventListener("beforeunload", value.beforeUnload);
  pending.delete(storage);
}

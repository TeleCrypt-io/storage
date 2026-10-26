import { afterEach, describe, expect, it, vi } from "vitest";
import { MutationPartialError, type TeleCryptIOStorage } from "@telecrypt-io/storage";
import { backedUp, settleKeyBackupBeforeLogout, startBackupTracking, stopBackupTracking } from "./keyBackup";

const clients: TeleCryptIOStorage[] = [];
function fixture(deviceId = "DEVICE") {
  const waitForKeyBackup = vi.fn().mockResolvedValue("backed_up");
  const storage = {
    getClient: () => ({ getHomeserverUrl: () => "https://matrix.example.test", getUserId: () => "@alice:example.test", getDeviceId: () => deviceId }),
    waitForKeyBackup,
    startSync: vi.fn().mockResolvedValue(undefined),
  } as unknown as TeleCryptIOStorage;
  clients.push(storage);
  return { storage, waitForKeyBackup };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => {
  for (const storage of clients.splice(0)) stopBackupTracking(storage);
  sessionStorage.clear();
});

describe("browser write and logout backup settlement", () => {
  it("does not report a write complete until backup finishes", async () => {
    const { storage, waitForKeyBackup } = fixture();
    const backup = deferred<"backed_up" | "deleted">();
    waitForKeyBackup.mockReturnValue(backup.promise);
    const operation = vi.fn().mockResolvedValue({ id: "$file" });
    let finished = false;
    const result = backedUp(operation, "file upload", () => "!vault")(storage).then(() => { finished = true; });
    await vi.waitFor(() => expect(waitForKeyBackup).toHaveBeenCalledWith("!vault", "$file"));
    expect(finished).toBe(false);
    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
    backup.resolve("backed_up");
    await result;
    const safeToLeave = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(safeToLeave);
    expect(safeToLeave.defaultPrevented).toBe(false);
  });

  it("retains a committed write across reload and retries backup without repeating it", async () => {
    const { storage, waitForKeyBackup } = fixture();
    waitForKeyBackup.mockRejectedValue(new Error("backup unavailable"));
    const operation = vi.fn().mockResolvedValue({ id: "$file" });
    await expect(backedUp(operation, "file upload", () => "!vault")(storage)).rejects.toMatchObject({
      operation: "file upload key backup", completedIds: ["$file"],
    });
    stopBackupTracking(storage);
    const reloaded = fixture();
    startBackupTracking(reloaded.storage);
    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
    reloaded.waitForKeyBackup.mockRejectedValueOnce(new Error("still unavailable"));
    await expect(settleKeyBackupBeforeLogout(reloaded.storage)).rejects.toThrow("Keep this tab open");
    await settleKeyBackupBeforeLogout(reloaded.storage);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(reloaded.waitForKeyBackup).toHaveBeenCalledTimes(2);
    expect(sessionStorage.length).toBe(0);
  });

  it("waits for an in-flight write and prevents another write during logout", async () => {
    const { storage, waitForKeyBackup } = fixture();
    const mutation = deferred<{ id: string }>();
    const operation = vi.fn().mockReturnValue(mutation.promise);
    const write = backedUp(operation, "vault creation");
    const result = write(storage);
    let loggedOut = false;
    const logout = settleKeyBackupBeforeLogout(storage).then(() => { loggedOut = true; });
    await expect(write(storage)).rejects.toThrow("Logout is finishing");
    expect(loggedOut).toBe(false);
    mutation.resolve({ id: "!vault" });
    await result;
    await logout;
    expect(waitForKeyBackup).toHaveBeenCalledWith("!vault", undefined);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("clears a pending target when the SDK confirms remote deletion", async () => {
    const { storage, waitForKeyBackup } = fixture();
    waitForKeyBackup.mockRejectedValue(new Error("backup unavailable"));
    await expect(backedUp(async () => ({ id: "$file" }), "file upload", () => "!vault")(storage)).rejects.toThrow();
    waitForKeyBackup.mockResolvedValueOnce("deleted");
    await settleKeyBackupBeforeLogout(storage);
    expect(waitForKeyBackup).toHaveBeenCalledTimes(2);
    expect(sessionStorage.length).toBe(0);
  });

  it("settles backup targets from a committed upload error and preserves the mutation error", async () => {
    const { storage, waitForKeyBackup } = fixture();
    const mutation = new MutationPartialError(
      "upload file",
      ["mxc://example.test/media", "$file"],
      "the listing readback failed",
      { treeId: "!vault", backupTargets: [{ treeId: "!vault", fileId: "$file" }] },
    );
    const upload = vi.fn().mockRejectedValue(mutation);

    await expect(backedUp(upload, "file upload", () => "!vault")(storage)).rejects.toBe(mutation);

    expect(waitForKeyBackup).toHaveBeenCalledWith("!vault", "$file");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.length).toBe(0);
  });

  it("retains partial-write backup targets across reload and retries without repeating upload", async () => {
    const { storage, waitForKeyBackup } = fixture();
    const mutation = new MutationPartialError(
      "upload file",
      ["mxc://example.test/media", "$file"],
      "the listing readback failed",
      { treeId: "!vault", backupTargets: [{ treeId: "!vault", fileId: "$file" }] },
    );
    const upload = vi.fn().mockRejectedValue(mutation);
    waitForKeyBackup.mockRejectedValue(new Error("backup unavailable"));
    await expect(backedUp(upload, "file upload", () => "!vault")(storage)).rejects.toMatchObject({
      operation: "upload file",
      completedIds: ["mxc://example.test/media", "$file"],
      backupTargets: [{ treeId: "!vault", fileId: "$file" }],
    });
    expect(sessionStorage.length).toBe(1);

    stopBackupTracking(storage);
    const reloaded = fixture();
    startBackupTracking(reloaded.storage);
    await settleKeyBackupBeforeLogout(reloaded.storage);

    expect(reloaded.waitForKeyBackup).toHaveBeenCalledWith("!vault", "$file");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.length).toBe(0);
  });

  it("does not apply another device's pending backup to this logout", async () => {
    const { storage, waitForKeyBackup } = fixture("FIRST");
    waitForKeyBackup.mockRejectedValue(new Error("backup unavailable"));
    await expect(backedUp(async () => ({ id: "!vault" }), "vault creation")(storage)).rejects.toThrow();
    const other = fixture("SECOND");
    await settleKeyBackupBeforeLogout(other.storage);
    expect(other.waitForKeyBackup).not.toHaveBeenCalled();
  });
});

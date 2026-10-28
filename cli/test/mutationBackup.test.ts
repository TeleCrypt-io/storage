import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createVault: vi.fn(),
  createSubfolder: vi.fn(),
  renameVault: vi.fn(),
  renameFolder: vi.fn(),
  renameFile: vi.fn(),
  uploadFile: vi.fn(),
  cleanupFileUpload: vi.fn(),
  openStorage: vi.fn(),
  markBackupWorkPending: vi.fn(),
  waitForBackupSettled: vi.fn(),
  waitForKeyBackup: vi.fn(),
  close: vi.fn(),
  loginAndInitialize: vi.fn(),
}));

vi.mock("../src/storage.js", () => ({
  openStorage: mocks.openStorage,
  markBackupWorkPending: mocks.markBackupWorkPending,
  waitForBackupSettled: mocks.waitForBackupSettled,
}));
vi.mock("@telecrypt-io/storage/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@telecrypt-io/storage/core")>()),
  createVault: mocks.createVault,
  createSubfolder: mocks.createSubfolder,
  renameVault: mocks.renameVault,
  renameFolder: mocks.renameFolder,
  renameFile: mocks.renameFile,
  uploadFile: mocks.uploadFile,
  cleanupFileUpload: mocks.cleanupFileUpload,
}));
vi.mock("../src/processExit.js", () => ({ scheduleBoundedNormalExit: vi.fn() }));
vi.mock("../src/loginTransaction.js", () => ({ loginAndInitialize: mocks.loginAndInitialize }));
vi.mock("../src/fileTransfer.js", () => ({ readBoundedInput: () => new Uint8Array([1]), writeDownload: vi.fn() }));

import { main } from "../src/index.js";
import { MutationPartialError } from "@telecrypt-io/storage/core";

const mutations = [
  ["createVault", ["vault", "create", "name"]],
  ["createSubfolder", ["vault", "subfolder", "create", "!parent:example.test", "name"]],
  ["renameVault", ["vault", "rename", "!vault:example.test", "name"]],
  ["renameFolder", ["vault", "subfolder", "rename", "!folder:example.test", "name"]],
  ["renameFile", ["file", "rename", "!vault:example.test", "$file", "name"]],
  ["uploadFile", ["file", "upload", "!vault:example.test", "name.txt"]],
] as const;

const originalExitCode = process.exitCode;
let stdout = "";
let stderr = "";

beforeEach(() => {
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array, callback?: () => void) => {
    stdout += String(chunk);
    callback?.();
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array, callback?: () => void) => {
    stderr += String(chunk);
    callback?.();
    return true;
  }) as typeof process.stderr.write);
  mocks.openStorage.mockResolvedValue({
    storage: {
      startSync: vi.fn().mockResolvedValue(undefined),
      keySafe: { getStatus: vi.fn().mockResolvedValue({ state: "ready" }) },
      waitForKeyBackup: mocks.waitForKeyBackup,
    },
    run: async (operation: (signal: AbortSignal) => Promise<unknown>) => operation(new AbortController().signal),
    persist: vi.fn().mockResolvedValue(undefined),
    close: mocks.close,
  });
  mocks.close.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

describe("encrypted mutations and backup settlement", () => {
  it.each(mutations)("%s preserves the committed ID when backup fails", async (operation, args) => {
    const id = operation === "uploadFile" || operation === "renameFile" ? "$committed-file" : "!committed:example.test";
    mocks[operation].mockResolvedValue({ id, name: "name" });
    mocks.waitForKeyBackup.mockRejectedValue(new Error("backup unavailable"));

    await main(["node", "telecrypt-io", "storage", ...args, "--json"]);

    expect(process.exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({
      code: "MUTATION_PARTIAL",
      completedIds: [id],
      error: expect.stringContaining(`the mutation committed (${id})`),
    });
    expect(stderr).toContain("key-safe setup");
    expect(stderr).toContain("do not repeat the mutation");
    expect(mocks[operation]).toHaveBeenCalledTimes(1);
    expect(mocks.waitForKeyBackup).toHaveBeenCalledWith(
      operation === "uploadFile" || operation === "renameFile" ? "!vault:example.test" : id,
      operation === "uploadFile" || operation === "renameFile" ? id : undefined,
      { signal: expect.any(AbortSignal) },
    );
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("reports success and closes storage only after backup settles", async () => {
    const result = { id: "!created:example.test", name: "name" };
    mocks.createVault.mockResolvedValue(result);
    let settle!: () => void;
    mocks.waitForKeyBackup.mockImplementation(() => new Promise<"backed_up">((resolve) => { settle = () => resolve("backed_up"); }));
    const pending = main(["node", "telecrypt-io", "storage", "vault", "create", "name", "--json"]);
    await vi.waitFor(() => expect(mocks.waitForKeyBackup).toHaveBeenCalled());
    expect(stdout).toBe("");
    expect(mocks.close).not.toHaveBeenCalled();
    settle();
    await pending;
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(result);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("retains committed IDs when backup and profile cleanup both fail", async () => {
    const id = "!created:example.test";
    mocks.createVault.mockResolvedValue({ id, name: "name" });
    mocks.waitForKeyBackup.mockRejectedValue(new Error("backup unavailable"));
    mocks.close.mockRejectedValue(new Error("snapshot failed"));
    await main(["node", "telecrypt-io", "storage", "vault", "create", "name", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stderr)).toMatchObject({
      code: "MUTATION_PARTIAL",
      completedIds: [id],
      error: expect.stringContaining("snapshot failed"),
    });
    expect(stderr).toContain("backup unavailable");
  });

  it("retries pending backup through setup without repeating a committed mutation", async () => {
    mocks.waitForBackupSettled.mockRejectedValueOnce(new Error("backup still unavailable"));
    await main(["node", "telecrypt-io", "storage", "key-safe", "setup", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(stdout).toBe("");

    mocks.waitForBackupSettled.mockResolvedValueOnce(undefined);
    await main(["node", "telecrypt-io", "storage", "key-safe", "setup", "--json"]);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ state: "ready", alreadyReady: true });
    expect(mocks.createVault).not.toHaveBeenCalled();
    expect(mocks.markBackupWorkPending).not.toHaveBeenCalled();
  });

  it.each([undefined, "$attachment"])("prints a usable cleanup command for partial upload with event %s", async (fileId) => {
    const treeId = "!vault:example.test";
    const mediaId = "mxc://example.test/uploaded";
    const completedIds = fileId ? [mediaId, fileId] : [mediaId];
    mocks.uploadFile.mockRejectedValue(Object.assign(
      new MutationPartialError("file upload", completedIds, "upload reconciliation required"),
      { treeId },
    ));
    await main(["node", "telecrypt-io", "storage", "file", "upload", treeId, "name.txt", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({
      code: "MUTATION_PARTIAL",
      completedIds,
      error: expect.stringContaining(`telecrypt-io storage file cleanup-upload '${treeId}' '${mediaId}'${fileId ? ` '${fileId}'` : ""}`),
    });
    expect(mocks.waitForKeyBackup).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("settles a backup target from a committed upload error without repeating the upload", async () => {
    const treeId = "!vault:example.test";
    const mediaId = "mxc://example.test/uploaded";
    const fileId = "$attachment";
    const partial = new MutationPartialError(
      "file upload",
      [mediaId, fileId],
      "listing readback failed",
      { treeId, backupTargets: [{ treeId, fileId }] },
    );
    mocks.uploadFile.mockRejectedValue(partial);
    mocks.waitForKeyBackup.mockResolvedValue("backed_up");

    await main(["node", "telecrypt-io", "storage", "file", "upload", treeId, "name.txt", "--json"]);

    expect(process.exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({
      code: "MUTATION_PARTIAL",
      completedIds: [mediaId, fileId],
      backupTargets: [{ treeId, fileId }],
    });
    expect(mocks.waitForKeyBackup).toHaveBeenCalledWith(treeId, fileId, { signal: expect.any(AbortSignal) });
    expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
  });

  it("settles the exact acknowledged rename metadata without repeating the rename", async () => {
    const treeId = "!vault:example.test";
    const fileId = "$attachment";
    const metadataEventId = "$metadata";
    mocks.renameFile.mockRejectedValue(new MutationPartialError("rename file", [metadataEventId], "pointer failed", {
      treeId, backupTargets: [{ treeId, fileId, metadataEventId }],
    }));
    mocks.waitForKeyBackup.mockResolvedValue("backed_up");
    await main(["node", "telecrypt-io", "storage", "file", "rename", treeId, fileId, "new.txt", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(mocks.waitForKeyBackup).toHaveBeenCalledWith(treeId, fileId, {
      signal: expect.any(AbortSignal), metadataEventId,
    });
    expect(mocks.renameFile).toHaveBeenCalledTimes(1);
  });

  it("retains the exact target when a successful rename's backup fails", async () => {
    const treeId = "!vault:example.test";
    const fileId = "$attachment";
    const target = { treeId, fileId, metadataEventId: "$first-name" };
    mocks.renameFile.mockResolvedValue({ id: fileId, name: "new.txt", backupTarget: target });
    mocks.waitForKeyBackup.mockRejectedValue(new Error("backup unavailable"));
    await main(["node", "telecrypt-io", "storage", "file", "rename", treeId, fileId, "new.txt", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stderr)).toMatchObject({ code: "MUTATION_PARTIAL", backupTargets: [target] });
    expect(mocks.waitForKeyBackup).toHaveBeenCalledWith(treeId, fileId, {
      signal: expect.any(AbortSignal), metadataEventId: "$first-name",
    });
    expect(mocks.renameFile).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "$attachment"])("cleans up acknowledged upload IDs with event %s", async (fileId) => {
    const treeId = "!vault:example.test";
    const mediaId = "mxc://example.test/uploaded";
    mocks.cleanupFileUpload.mockResolvedValue(undefined);
    await main(["node", "telecrypt-io", "storage", "file", "cleanup-upload", treeId, mediaId, ...(fileId ? [fileId] : []), "--json"]);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ cleanedUp: true, treeId, mediaId, ...(fileId ? { fileId } : {}) });
    expect(mocks.cleanupFileUpload).toHaveBeenCalledWith(expect.anything(), treeId, mediaId, fileId, { signal: expect.any(AbortSignal) });
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("retains a failed cleanup for retry without claiming success", async () => {
    mocks.cleanupFileUpload.mockRejectedValue(new Error("cleanup unavailable"));
    await main(["node", "telecrypt-io", "storage", "file", "cleanup-upload", "!vault:example.test", "mxc://example.test/media", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr).error).toContain("cleanup unavailable");
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});

it("opens the browser by default and respects --no-browser", async () => {
  mocks.loginAndInitialize.mockRejectedValue(new Error("stop before remote login"));
  const args = ["node", "telecrypt-io", "storage", "login", "--homeserver", "http://localhost:8008", "--server-name", "localhost:8008"];
  await main(args);
  expect(mocks.loginAndInitialize.mock.calls[0][2].openBrowser).toBe(true);
  await main([...args, "--no-browser"]);
  expect(mocks.loginAndInitialize.mock.calls[1][2].openBrowser).toBe(false);
});

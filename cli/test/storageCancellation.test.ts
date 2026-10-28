import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeleCryptIOStorage } from "@telecrypt-io/storage";
import { MutationPartialError } from "@telecrypt-io/storage/core";
import { persistCryptoStore } from "../src/cryptoSnapshot.js";
import { acquireProfileLock, type Session } from "../src/profile.js";
import { initStorageForNewSession } from "../src/storage.js";

vi.mock("../src/cryptoSnapshot.js", () => ({
  persistCryptoStore: vi.fn().mockResolvedValue(undefined),
  restoreCryptoStore: vi.fn().mockResolvedValue(undefined),
}));

const SESSION: Session = {
  homeserver: "https://backend.telecrypt.io",
  userId: "@alice:telecrypt.io",
  matrixServerName: "telecrypt.io",
  deviceId: "DEVICE",
  accessToken: "access-original",
  oidcIssuer: "https://backend.telecrypt.io/",
  refreshToken: "refresh-original",
  oidcClientId: "client",
  oidcTokenEndpoint: "https://backend.telecrypt.io/token",
  oidcRevocationEndpoint: "https://backend.telecrypt.io/revoke",
};
const directories: string[] = [];

async function openFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telecrypt-upload-cancellation-"));
  directories.push(directory);
  const controller = new AbortController();
  const stopClient = vi.fn();
  const client = Object.assign(new EventEmitter(), { stopClient });
  const storage = { getClient: () => client } as unknown as TeleCryptIOStorage;
  vi.spyOn(TeleCryptIOStorage, "createFromOidc").mockResolvedValue(storage);
  const opened = await initStorageForNewSession(SESSION, directory, undefined, controller.signal);
  return { opened, directory, controller, stopClient };
}

afterEach(({ task }) => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  const pending = directories.splice(0);
  if (task.result?.state === "fail") {
    process.stderr.write(`Retaining upload cancellation fixtures: ${pending.join(", ")}\n`);
    return;
  }
  for (const directory of pending) fs.rmSync(directory, { recursive: true, force: true });
});

describe("upload cancellation receipts", () => {
  it.each(["signal", "deadline"])("retains late acknowledged IDs after %s cancellation", async (boundary) => {
    vi.useFakeTimers();
    const { opened, directory, controller, stopClient } = await openFixture();
    let rejectUpload!: (error: unknown) => void;
    let uploadSignal!: AbortSignal;
    const pending = opened.run((signal) => {
      uploadSignal = signal;
      return new Promise<never>((_resolve, reject) => { rejectUpload = reject; });
    }, "file upload", 100, { settleAfterCancellation: true });
    let settled = false;
    const failure = pending.catch((error: unknown) => {
      settled = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(0);
    if (boundary === "signal") controller.abort();
    else await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(uploadSignal.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(stopClient).not.toHaveBeenCalled();
    expect(persistCryptoStore).not.toHaveBeenCalled();
    expect(() => acquireProfileLock(directory)).toThrow(/profile is busy/);

    const receipt = new MutationPartialError("file upload", ["mxc://telecrypt.io/media", "$attachment"],
      "Upload cancelled after attachment acknowledgement", { treeId: "!folder:telecrypt.io" });
    rejectUpload(receipt);
    expect(await failure).toBe(receipt);
    await opened.close();
    expect(stopClient).toHaveBeenCalledTimes(1);
    expect(persistCryptoStore).toHaveBeenCalledTimes(1);
    acquireProfileLock(directory).release();
  });

  it("preserves an acknowledged successful result for the caller's backup check", async () => {
    vi.useFakeTimers();
    const { opened, controller } = await openFixture();
    let resolveUpload!: (value: { id: string }) => void;
    const pending = opened.run(() => new Promise<{ id: string }>((resolve) => {
      resolveUpload = resolve;
    }), "file upload", 100, { settleAfterCancellation: true });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    const committed = { id: "$attachment" };
    resolveUpload(committed);
    expect(await pending).toBe(committed);
    await expect(opened.run(async () => undefined, "key backup")).rejects.toThrow("operation cancelled");
    await opened.close();
  });

  it("bounds an upload that never settles, then stops the client and preserves the prior snapshot", async () => {
    vi.useFakeTimers();
    const { opened, directory, controller, stopClient } = await openFixture();
    const pending = opened.run(() => new Promise<never>(() => {}), "file upload", 100,
      { settleAfterCancellation: true });
    const failure = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(stopClient).not.toHaveBeenCalled();
    expect(() => acquireProfileLock(directory)).toThrow(/profile is busy/);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await failure).toMatchObject({ message: "operation cancelled; storage cleanup failed" });
    expect(stopClient).toHaveBeenCalledTimes(1);
    await opened.close();
    expect(persistCryptoStore).not.toHaveBeenCalled();
    acquireProfileLock(directory).release();
  });

  it("keeps immediate client cancellation for ordinary operations", async () => {
    vi.useFakeTimers();
    const { opened, controller, stopClient } = await openFixture();
    const pending = opened.run(() => new Promise<never>(() => {}), "list files");
    const failure = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await failure).toMatchObject({ message: "operation cancelled; storage cleanup failed" });
    expect(stopClient).toHaveBeenCalled();
    await opened.close();
    expect(persistCryptoStore).not.toHaveBeenCalled();
  });
});

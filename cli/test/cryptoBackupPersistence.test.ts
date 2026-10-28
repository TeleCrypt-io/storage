import "fake-indexeddb/auto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TeleCryptIOStorage } from "@telecrypt-io/storage";
import { initStorageForNewSession } from "../src/storage.js";
import { cryptoSnapshotPath, writeSession, type Session } from "../src/profile.js";
import { persistCryptoStore, loadSnapshotFromDisk, TELECRYPT_CRYPTO_DATABASE_PREFIX } from "../src/cryptoSnapshot.js";

const SESSION: Session = {
  homeserver: "https://backend.telecrypt.io", userId: "@alice:telecrypt.io",
  matrixServerName: "telecrypt.io", deviceId: "DEVICE", accessToken: "local-fixture-token",
  oidcIssuer: "https://backend.telecrypt.io/", refreshToken: "local-fixture-refresh",
  oidcClientId: "client", oidcTokenEndpoint: "https://backend.telecrypt.io/token",
  oidcRevocationEndpoint: "https://backend.telecrypt.io/revoke",
};
const directories: string[] = [];
const dbNames: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const name of dbNames.splice(0)) await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  });
});
async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telecrypt-audit-backup-"));
  directories.push(dir);
  writeSession(SESSION, dir);
  const name = `${TELECRYPT_CRYPTO_DATABASE_PREFIX}audit-${Math.random()}`;
  dbNames.push(name);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("sessions");
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const put = async (key: string) => new Promise<void>((resolve, reject) => {
    const tx = db.transaction("sessions", "readwrite");
    tx.objectStore("sessions").put({ localKey: key, backedUp: false }, key);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
  await put("old-key");
  await persistCryptoStore(cryptoSnapshotPath(dir));
  return { dir, db, put };
}
it("retains a post-write local key when cancellation happens during backup settlement", async () => {
  const { dir, db, put } = await setup();
  const client = Object.assign(new EventEmitter(), { stopClient: vi.fn() });
  const storage = { getClient: () => client } as unknown as TeleCryptIOStorage;
  vi.spyOn(TeleCryptIOStorage, "createFromOidc").mockResolvedValue(storage);
  const controller = new AbortController();
  const opened = await initStorageForNewSession(SESSION, dir, undefined, controller.signal);
  try {
    // Controlled SDK boundary: the completed mutation leaves a new local key before its backup.
    await opened.run(async () => { await put("committed-file-key"); return { id: "$committed" }; },
      "file upload", undefined, { settleAfterCancellation: true });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const backup = opened.run(async (signal) => {
      started();
      return new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    }, "key backup settlement", 25_000);
    const failure = backup.catch((error: unknown) => error);
    await ready;
    controller.abort();
    expect(await failure).toHaveProperty("message", "operation cancelled");
    await opened.close();
    const snapshot = loadSnapshotFromDisk(cryptoSnapshotPath(dir))!;
    const keys = snapshot.dbs.flatMap((item) => Object.values(item.records).flat().map((record) => record.key));
    expect(keys).toContain("old-key");
    expect(keys).toContain("committed-file-key");
    console.info("retained committed key after backup cancellation");
  } finally { db.close(); await opened.close(); }
});
it("retains a post-write local key on ordinary backup timeout without user cancellation", async () => {
  const { dir, db, put } = await setup();
  const client = Object.assign(new EventEmitter(), { stopClient: vi.fn() });
  const storage = { getClient: () => client } as unknown as TeleCryptIOStorage;
  vi.spyOn(TeleCryptIOStorage, "createFromOidc").mockResolvedValue(storage);
  const controller = new AbortController();
  const opened = await initStorageForNewSession(SESSION, dir, undefined, controller.signal);
  try {
    await opened.run(async () => { await put("committed-file-key"); return { id: "$committed" }; },
      "file upload", undefined, { settleAfterCancellation: true });
    // Use the production backup run path with only its timer shortened from 25 seconds.
    await expect(opened.run(async (signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }), "key backup settlement", 20)).rejects.toThrow("key backup settlement timed out");
    expect(controller.signal.aborted).toBe(false);
    await opened.close();
    const snapshot = loadSnapshotFromDisk(cryptoSnapshotPath(dir))!;
    const keys = snapshot.dbs.flatMap((item) => Object.values(item.records).flat().map((record) => record.key));
    expect(keys).toContain("old-key");
    expect(keys).toContain("committed-file-key");
    console.info("retained committed key after backup timeout");
  } finally { db.close(); await opened.close(); }
});

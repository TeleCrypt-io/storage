import fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenedStorage } from "../src/storage.js";
import { getKeySafeStatus, requireReadyKeySafe, writeRecoveryKeyFile } from "../src/keySafe.js";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "storage-cli-key-safe-"));
  fs.chmodSync(directory, 0o700);
  directories.push(directory);
  return directory;
}

afterEach(({ task }) => {
  const pending = directories.splice(0);
  if (task.result?.state === "fail") {
    process.stderr.write(`CLI key-safe test failed; retaining fixtures: ${pending.join(", ")}\n`);
    return;
  }
  for (const directory of pending) fs.rmSync(directory, { recursive: true, force: true });
});

function openedWithStatus(state: string): OpenedStorage {
  const storage = {
    keySafe: { getStatus: vi.fn().mockResolvedValue({ state }) },
  };
  return {
    storage,
    run: async (operation: (signal: AbortSignal) => Promise<unknown>) =>
      operation(new AbortController().signal),
  } as unknown as OpenedStorage;
}

describe("Decryption Key Safe CLI support", () => {
  it("writes Recovery Keys to private new files and refuses to overwrite", () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, "recovery-key.txt");

    expect(writeRecoveryKeyFile(target, "recovery-key-value")).toBe(target);
    expect(fs.readFileSync(target, "utf8")).toBe("recovery-key-value\n");
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(() => writeRecoveryKeyFile(target, "replacement-key")).toThrow(/already exists/u);
    expect(fs.readFileSync(target, "utf8")).toBe("recovery-key-value\n");
  });

  it("blocks normal commands with the actionable step for each incomplete state", async () => {
    for (const [state, instruction] of [
      ["setup-required", "storage key-safe setup"],
      ["confirmation-required", "storage key-safe confirm-saved"],
      ["restore-required", "storage key-safe restore"],
    ]) {
      const opened = openedWithStatus(state);
      await expect(requireReadyKeySafe(opened)).rejects.toThrow(instruction);
    }
  });

  it("allows normal commands after the SDK reports the Safe ready", async () => {
    const opened = openedWithStatus("ready");
    await expect(requireReadyKeySafe(opened)).resolves.toBeUndefined();
    await expect(getKeySafeStatus(opened)).resolves.toEqual({ state: "ready" });
  });
});

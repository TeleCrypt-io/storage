import fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { StorageError } from "@telecrypt-io/storage/core";
import { runWithAbortRace } from "./cancellation.js";
import type { OpenedStorage } from "./storage.js";

export type KeySafeState = "setup-required" | "confirmation-required" | "restore-required" | "ready";

export interface KeySafeStatus {
  state: KeySafeState;
  recoveryKey?: string;
}

interface KeySafeApi {
  getStatus(signal?: AbortSignal): Promise<KeySafeStatus>;
  setup(signal?: AbortSignal): Promise<{ recoveryKey: string }>;
  confirmSaved(signal?: AbortSignal): Promise<{ state: "ready" }>;
  restore(recoveryKey: string, signal?: AbortSignal): Promise<{
    imported: number;
    total: number;
    state: "ready";
  }>;
}

export function keySafeApi(opened: OpenedStorage): KeySafeApi {
  const api = (opened.storage as unknown as { keySafe?: KeySafeApi }).keySafe;
  if (!api) {
    throw new StorageError("the installed storage SDK does not provide Decryption Key Safe support");
  }
  return api;
}

export function isInteractiveTerminal(jsonMode: boolean): boolean {
  return !jsonMode && Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

export async function getKeySafeStatus(
  opened: OpenedStorage,
): Promise<KeySafeStatus> {
  return opened.run(
    (signal) => keySafeApi(opened).getStatus(signal),
    "Decryption Key Safe status",
  );
}

export async function requireReadyKeySafe(opened: OpenedStorage): Promise<void> {
  const status = await getKeySafeStatus(opened);
  if (status.state === "ready") return;

  const instruction = status.state === "setup-required"
    ? "run `telecrypt-io storage key-safe setup`"
    : status.state === "confirmation-required"
      ? "save the displayed Recovery Key, then run `telecrypt-io storage key-safe confirm-saved`"
      : "run `telecrypt-io storage key-safe restore` with the saved Recovery Key";
  throw new StorageError(`the Decryption Key Safe is not ready (${status.state}); ${instruction}`);
}

/** Create a new private file and refuse replacement, including symlinks. */
export function writeRecoveryKeyFile(outputPath: string, recoveryKey: string): string {
  const target = path.resolve(outputPath);
  if (path.basename(target) === "" || path.basename(target) === "." || path.basename(target) === "..") {
    throw new StorageError("Recovery Key output must name a file");
  }

  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      target,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, `${recoveryKey}\n`, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    return target;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the operation failure; the private file is removed below.
      }
      try {
        fs.rmSync(target, { force: true });
      } catch {
        // Preserve the operation failure; the path was created by this call.
      }
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new StorageError("Recovery Key output already exists; choose a new path", { cause: error });
    }
    throw new StorageError("Recovery Key could not be saved to the requested file", { cause: error });
  }
}

export async function confirmRecoveryKeyWasSaved(signal: AbortSignal): Promise<boolean> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  try {
    const answer = await runWithAbortRace(
      () => readline.question("Have you saved the Recovery Key somewhere safe? Type yes to continue: "),
      signal,
      new StorageError("saved-key confirmation was cancelled"),
    );
    return /^(?:y|yes)$/iu.test(answer.trim());
  } finally {
    readline.close();
  }
}

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecoveryPanel } from "./RecoveryPanel";
import { useStorage } from "../context/StorageContext";

vi.mock("../context/StorageContext", () => ({ useStorage: vi.fn() }));
type Status = { state: "setup-required" | "confirmation-required" | "restore-required" | "ready"; recoveryKey?: string };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
function fakeStorage(initial: Status = { state: "setup-required" }) {
  let status = initial;
  return { startSync: vi.fn(async () => undefined), keySafe: {
    getStatus: vi.fn(async () => status),
    setup: vi.fn(async () => {
      status = { state: "confirmation-required", recoveryKey: "test-key" };
      return { recoveryKey: "test-key" };
    }),
    confirmSaved: vi.fn(async () => { status = { state: "ready" }; return status; }),
    restore: vi.fn(async () => { status = { state: "ready" }; return { imported: 1, total: 1, state: "ready" }; }),
  } };
}
const useStorageMock = vi.mocked(useStorage);
let ready = vi.fn<(ready: boolean) => void>();
beforeEach(() => { vi.clearAllMocks(); ready = vi.fn(); });

describe("Decryption Key Safe account lifecycle", () => {
  it("surfaces status diagnostics and does not offer setup until status is known", async () => {
    const storage = fakeStorage();
    storage.keySafe.getStatus.mockRejectedValue(new Error("Status backend detail"));
    useStorageMock.mockReturnValue({ storage } as never);
    render(<RecoveryPanel onReadinessChange={ready} />);
    expect(await screen.findByTestId("key-safe-error")).toHaveTextContent("Status backend detail");
    expect(screen.queryByTestId("setup-key-safe")).not.toBeInTheDocument();
    expect(ready).not.toHaveBeenCalledWith(true);
  });

  it("starts room history sync only after the Safe is ready", async () => {
    const storage = fakeStorage({ state: "ready" });
    useStorageMock.mockReturnValue({ storage } as never);
    render(<RecoveryPanel onReadinessChange={ready} />);
    await screen.findByTestId("key-safe-ready");
    expect(storage.startSync).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenLastCalledWith(true);
  });

  it("does not start room history sync while the Safe needs setup or restore", async () => {
    const storage = fakeStorage({ state: "restore-required" });
    useStorageMock.mockReturnValue({ storage } as never);
    render(<RecoveryPanel onReadinessChange={ready} />);
    await screen.findByTestId("key-safe-restore-required");
    expect(storage.startSync).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalledWith(true);
  });

  it("discards a setup result from the previous account", async () => {
    const storageA = fakeStorage();
    const storageB = fakeStorage({ state: "ready" });
    const pending = deferred<{ recoveryKey: string }>();
    storageA.keySafe.setup.mockReturnValue(pending.promise);
    useStorageMock.mockReturnValue({ storage: storageA } as never);
    const view = render(<RecoveryPanel onReadinessChange={ready} />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("setup-key-safe"));
    useStorageMock.mockReturnValue({ storage: storageB } as never);
    view.rerender(<RecoveryPanel onReadinessChange={ready} />);
    await screen.findByTestId("key-safe-ready");
    await act(async () => pending.resolve({ recoveryKey: "old-account-key" }));
    expect(screen.queryByTestId("key-safe-key-display")).not.toBeInTheDocument();
    expect(screen.getByTestId("key-safe-ready")).toBeVisible();
    expect(storageA.keySafe.getStatus).toHaveBeenCalledTimes(1);
  });

  it("clears the displayed key and restore input when the account changes", async () => {
    const storageA = fakeStorage({ state: "confirmation-required", recoveryKey: "old-key" });
    const storageB = fakeStorage({ state: "restore-required" });
    useStorageMock.mockReturnValue({ storage: storageA } as never);
    const view = render(<RecoveryPanel onReadinessChange={ready} />);
    await screen.findByTestId("key-safe-recovery-key");
    useStorageMock.mockReturnValue({ storage: storageB } as never);
    view.rerender(<RecoveryPanel onReadinessChange={ready} />);
    expect(await screen.findByTestId("restore-key-input")).toHaveValue("");
    expect(screen.queryByText("old-key")).not.toBeInTheDocument();
  });

  it("reconciles an interrupted setup using SDK status without another create", async () => {
    const storage = fakeStorage();
    storage.keySafe.setup.mockRejectedValue(new Error("Setup response interrupted"));
    useStorageMock.mockReturnValue({ storage } as never);
    const user = userEvent.setup();
    render(<RecoveryPanel onReadinessChange={ready} />);
    await user.click(await screen.findByTestId("setup-key-safe"));
    expect(await screen.findByTestId("key-safe-error")).toHaveTextContent("Setup response interrupted");
    expect(screen.queryByTestId("setup-key-safe")).not.toBeInTheDocument();
    storage.keySafe.getStatus.mockResolvedValue({ state: "confirmation-required", recoveryKey: "same-key" });
    await user.click(screen.getByTestId("key-safe-retry"));
    expect(await screen.findByTestId("key-safe-recovery-key")).toHaveTextContent("same-key");
    expect(storage.keySafe.setup).toHaveBeenCalledTimes(1);
  });

  it("times out a setup and reads status before offering another operation", async () => {
    vi.useFakeTimers();
    try {
      const storage = fakeStorage();
      storage.keySafe.setup.mockReturnValue(new Promise(() => {}));
      useStorageMock.mockReturnValue({ storage } as never);
      render(<RecoveryPanel onReadinessChange={ready} />);
      await act(async () => { await Promise.resolve(); });
      fireEvent.click(screen.getByTestId("setup-key-safe"));
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(screen.getByTestId("key-safe-retry")).toBeVisible();
      expect(screen.queryByTestId("setup-key-safe")).not.toBeInTheDocument();
      expect(ready).not.toHaveBeenCalledWith(true);
    } finally { vi.useRealTimers(); }
  });

  it("does not make a completed late status request ready after account cancellation", async () => {
    const storage = fakeStorage();
    const pending = deferred<Status>();
    const controller = new AbortController();
    storage.keySafe.getStatus.mockReturnValue(pending.promise);
    useStorageMock.mockReturnValue({ storage, accountSignal: controller.signal } as never);
    render(<RecoveryPanel onReadinessChange={ready} />);
    await act(async () => {
      controller.abort();
      pending.resolve({ state: "ready" });
    });
    expect(ready).not.toHaveBeenCalledWith(true);
  });

  it("keeps the account locked and clears the entered key after failed restore", async () => {
    const storage = fakeStorage({ state: "restore-required" });
    storage.keySafe.restore.mockRejectedValue(new Error("Incorrect key"));
    useStorageMock.mockReturnValue({ storage } as never);
    const user = userEvent.setup();
    render(<RecoveryPanel onReadinessChange={ready} />);
    await user.type(await screen.findByTestId("restore-key-input"), "bad key");
    await user.click(screen.getByTestId("restore-key-submit"));
    expect(await screen.findByTestId("key-safe-error")).toHaveTextContent("Incorrect key");
    expect(ready).not.toHaveBeenCalledWith(true);
    await user.click(screen.getByTestId("key-safe-retry"));
    await waitFor(() => expect(screen.getByTestId("restore-key-input")).toHaveValue(""));
  });
});

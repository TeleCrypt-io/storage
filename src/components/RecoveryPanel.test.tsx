import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecoveryPanel } from "./RecoveryPanel";
import { useStorage } from "../context/StorageContext";
import { RecoverySetupAmbiguousError } from "../lib/core";

vi.mock("../context/StorageContext", () => ({
  useStorage: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function fakeStorage(isSetup: boolean) {
  const crypto = {
    getKeyBackupInfo: vi.fn().mockResolvedValue(isSetup ? {} : null),
    getSecretStorageStatus: vi.fn().mockResolvedValue({
      defaultKeyId: isSetup ? "key" : null,
      ready: isSetup,
    }),
  };
  return {
    keys: {
      isRecoverySetup: vi.fn().mockResolvedValue(isSetup),
      setupRecovery: vi.fn().mockResolvedValue({ recoveryKey: "test-key" }),
      restoreFromRecoveryKey: vi.fn().mockResolvedValue({ imported: 1, total: 1 }),
    },
    getClient: () => ({
      getCrypto: () => crypto,
      getAccountDataFromServer: vi.fn().mockResolvedValue(isSetup ? {} : null),
    }),
  };
}

const useStorageMock = vi.mocked(useStorage);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RecoveryPanel identity", () => {
  it("surfaces recovery status diagnostics", async () => {
    const storage = fakeStorage(false);
    vi.mocked(storage.keys.isRecoverySetup).mockRejectedValue(
      new Error("recovery status backend detail"),
    );
    useStorageMock.mockReturnValue({ storage } as never);

    render(<RecoveryPanel />);

    expect(await screen.findByTestId("recovery-error")).toHaveTextContent(
      "recovery status backend detail",
    );
  });

  it("discards a recovery result from the previous storage identity", async () => {
    const storageA = fakeStorage(false);
    const storageB = fakeStorage(true);
    const setup = deferred<{ recoveryKey: string }>();
    vi.mocked(storageA.keys.setupRecovery).mockReturnValue(setup.promise as never);
    useStorageMock.mockReturnValue({ storage: storageA } as never);

    const view = render(<RecoveryPanel />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("setup-recovery"));
    await waitFor(() => expect(storageA.keys.setupRecovery).toHaveBeenCalled());

    useStorageMock.mockReturnValue({ storage: storageB } as never);
    view.rerender(<RecoveryPanel />);
    expect(await screen.findByTestId("recovery-active")).toBeInTheDocument();

    setup.resolve({ recoveryKey: "old-account-key" });
    await waitFor(() => expect(screen.queryByTestId("recovery-key-display")).not.toBeInTheDocument());
    expect(screen.getByTestId("recovery-active")).toBeInTheDocument();
  });

  it("clears the displayed key when the identity changes", async () => {
    const storageA = fakeStorage(false);
    const storageB = fakeStorage(true);
    vi.mocked(storageA.keys.setupRecovery).mockResolvedValue({ recoveryKey: "old-key" });
    useStorageMock.mockReturnValue({ storage: storageA } as never);

    const view = render(<RecoveryPanel />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("setup-recovery"));
    await screen.findByTestId("recovery-key-display");

    useStorageMock.mockReturnValue({ storage: storageB } as never);
    view.rerender(<RecoveryPanel />);

    await waitFor(() => expect(screen.queryByTestId("recovery-key-display")).not.toBeInTheDocument());
  });

  it("does not expose a clipboard action for recovery keys", async () => {
    const storage = fakeStorage(false);
    vi.mocked(storage.keys.setupRecovery).mockResolvedValue({ recoveryKey: "done-key" });
    useStorageMock.mockReturnValue({ storage } as never);

    const user = userEvent.setup();
    render(<RecoveryPanel />);
    await user.click(await screen.findByTestId("setup-recovery"));
    expect(screen.queryByTestId("copy-recovery-key")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("confirm-saved-recovery-key"));
    await user.click(screen.getByTestId("recovery-setup-done"));

    await waitFor(() => expect(screen.queryByTestId("recovery-key-display")).not.toBeInTheDocument());
  });

  it("locks setup after an ambiguous result until status is reconciled", async () => {
    const storage = fakeStorage(false);
    const failure = new RecoverySetupAmbiguousError();
    vi.mocked(storage.keys.setupRecovery).mockRejectedValue(failure);
    useStorageMock.mockReturnValue({ storage } as never);

    const user = userEvent.setup();
    render(<RecoveryPanel />);
    await user.click(await screen.findByTestId("setup-recovery"));
    expect(await screen.findByTestId("reconcile-recovery")).toBeInTheDocument();
    expect(screen.getByTestId("recovery-error")).toHaveTextContent(failure.message);
    expect(screen.queryByTestId("setup-recovery")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("reconcile-recovery"));
    expect(await screen.findByTestId("setup-recovery")).toBeInTheDocument();
  });

  it("times out setup and requires reconciliation before another attempt", async () => {
    vi.useFakeTimers();
    try {
      const storage = fakeStorage(false);
      const setup = deferred<{ recoveryKey: string }>();
      vi.mocked(storage.keys.setupRecovery).mockReturnValue(setup.promise as never);
      useStorageMock.mockReturnValue({ storage } as never);
      render(<RecoveryPanel />);

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      fireEvent.click(screen.getByTestId("setup-recovery"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(screen.getByTestId("reconcile-recovery")).toBeInTheDocument();
      expect(screen.queryByTestId("setup-recovery")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses account-level status text and hides setup when recovery is configured", async () => {
    const storage = fakeStorage(true);
    useStorageMock.mockReturnValue({ storage } as never);

    render(<RecoveryPanel />);

    expect(await screen.findByTestId("recovery-active")).toHaveTextContent(
      "Recovery is configured for this account.",
    );
    expect(screen.queryByTestId("recovery-not-setup")).not.toBeInTheDocument();
    expect(screen.queryByTestId("setup-recovery")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /set up recovery/i })).not.toBeInTheDocument();
    expect(screen.getByTestId("restore-expand")).toHaveTextContent("Restore with Recovery Key");
  });

  it("offers account setup only when recovery is not configured", async () => {
    const storage = fakeStorage(false);
    useStorageMock.mockReturnValue({ storage } as never);

    render(<RecoveryPanel />);

    expect(await screen.findByTestId("recovery-not-setup")).toHaveTextContent(
      "Recovery is not configured on this account.",
    );
    expect(screen.getByTestId("setup-recovery")).toHaveTextContent("Set up recovery on this device");
  });

  it("fails closed when the SDK rejects an inconsistent recovery state", async () => {
    const storage = fakeStorage(false);
    vi.mocked(storage.keys.isRecoverySetup).mockRejectedValue(
      new Error("secret storage state is inconsistent"),
    );
    useStorageMock.mockReturnValue({ storage } as never);

    render(<RecoveryPanel />);

    expect(await screen.findByTestId("recovery-status-unknown")).toBeInTheDocument();
    expect(screen.queryByTestId("setup-recovery")).not.toBeInTheDocument();
  });

  it("clears a restore key after a failed restore", async () => {
    const storage = fakeStorage(true);
    vi.mocked(storage.keys.restoreFromRecoveryKey).mockRejectedValue(new Error("upstream room id leaked"));
    useStorageMock.mockReturnValue({ storage } as never);

    const view = render(<RecoveryPanel />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("restore-expand"));
    const input = screen.getByTestId("restore-key-input");
    await user.type(input, "bad key");
    await user.click(screen.getByTestId("restore-submit"));

    await waitFor(() => expect(input).toHaveValue(""));
    expect(screen.getByTestId("recovery-error")).toHaveTextContent(
      "upstream room id leaked",
    );
    view.unmount();
  });

  it("passes restore-key validation to the SDK", async () => {
    const storage = fakeStorage(true);
    useStorageMock.mockReturnValue({ storage } as never);

    const user = userEvent.setup();
    render(<RecoveryPanel />);
    await user.click(await screen.findByTestId("restore-expand"));
    fireEvent.change(screen.getByTestId("restore-key-input"), {
      target: { value: "x".repeat(4097) },
    });
    await user.click(screen.getByTestId("restore-submit"));

    expect(storage.keys.restoreFromRecoveryKey).toHaveBeenCalledWith(
      "x".repeat(4097),
      expect.anything(),
    );
    expect(await screen.findByTestId("restore-result")).toHaveTextContent("Imported 1 of 1 keys.");
  });
});

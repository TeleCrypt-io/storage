import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecoveryPanel } from "./RecoveryPanel";
import { useStorage } from "../context/StorageContext";
import { RecoveryAlreadyConfiguredError, RecoverySetupAmbiguousError, type RecoveryStatus } from "../lib/core";

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

const unconfiguredStatus: RecoveryStatus = {
  state: "unconfigured",
  crossSigning: {
    publicKeysOnDevice: false,
    privateKeysCachedLocally: false,
    privateKeysInSecretStorage: false,
  },
  secretStorage: { ready: false, defaultKeyId: null },
  backupVersion: null,
};

const configuredStatus: RecoveryStatus = {
  state: "ready",
  crossSigning: {
    publicKeysOnDevice: true,
    privateKeysCachedLocally: true,
    privateKeysInSecretStorage: true,
  },
  secretStorage: { ready: true, defaultKeyId: "key" },
  backupVersion: "1",
};

const partialConfiguredStatus: RecoveryStatus = {
  state: "partial",
  crossSigning: {
    publicKeysOnDevice: true,
    privateKeysCachedLocally: false,
    privateKeysInSecretStorage: false,
  },
  secretStorage: { ready: false, defaultKeyId: null },
  backupVersion: "1",
};

const partialCrossSigningStatus: RecoveryStatus = {
  state: "partial",
  crossSigning: {
    publicKeysOnDevice: true,
    privateKeysCachedLocally: true,
    privateKeysInSecretStorage: false,
  },
  secretStorage: { ready: false, defaultKeyId: null },
  backupVersion: null,
};

function fakeStorage(status: RecoveryStatus = unconfiguredStatus) {
  const crypto = {
    getKeyBackupInfo: vi.fn().mockResolvedValue(status.backupVersion ? {} : null),
    getSecretStorageStatus: vi.fn().mockResolvedValue(status.secretStorage),
  };
  return {
    keys: {
      getStatus: vi.fn().mockResolvedValue(status),
      setupRecovery: vi.fn().mockResolvedValue({ recoveryKey: "test-key" }),
      restoreFromRecoveryKey: vi.fn().mockResolvedValue({ imported: 1, total: 1 }),
    },
    getClient: () => ({
      getCrypto: () => crypto,
      getAccountDataFromServer: vi.fn().mockResolvedValue(status.state === "ready" ? {} : null),
    }),
  };
}

const useStorageMock = vi.mocked(useStorage);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RecoveryPanel identity", () => {
  it("surfaces recovery status diagnostics", async () => {
    const storage = fakeStorage();
    vi.mocked(storage.keys.getStatus).mockRejectedValue(
      new Error("recovery status backend detail"),
    );
    useStorageMock.mockReturnValue({ storage } as never);

    render(<RecoveryPanel />);

    expect(await screen.findByTestId("recovery-error")).toHaveTextContent(
      "recovery status backend detail",
    );
  });

  it("discards a recovery result from the previous storage identity", async () => {
    const storageA = fakeStorage();
    const storageB = fakeStorage(configuredStatus);
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
    const storageA = fakeStorage();
    const storageB = fakeStorage(configuredStatus);
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
    const storage = fakeStorage();
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
    const storage = fakeStorage();
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
      const storage = fakeStorage();
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
    const storage = fakeStorage(configuredStatus);
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

  it("offers restore when a backup exists but this device is not ready", async () => {
    const storage = fakeStorage(partialConfiguredStatus);
    useStorageMock.mockReturnValue({ storage } as never);

    render(<RecoveryPanel />);

    expect(await screen.findByTestId("recovery-configured-not-ready")).toHaveTextContent(
      "Recovery is configured for this account, but this device is not ready to use it.",
    );
    expect(screen.queryByTestId("setup-recovery")).not.toBeInTheDocument();
    expect(screen.getByTestId("restore-key-input")).toBeInTheDocument();
  });

  it("does not hide setup for a partial cross-signing state without recovery configuration", async () => {
    const storage = fakeStorage(partialCrossSigningStatus);
    useStorageMock.mockReturnValue({ storage } as never);

    render(<RecoveryPanel />);

    expect(await screen.findByTestId("setup-recovery")).toBeInTheDocument();
    expect(screen.queryByTestId("recovery-configured-not-ready")).not.toBeInTheDocument();
  });

  it("reconciles a setup race when the SDK reports an existing configuration", async () => {
    const storage = fakeStorage();
    vi.mocked(storage.keys.setupRecovery).mockRejectedValue(new RecoveryAlreadyConfiguredError());
    vi.mocked(storage.keys.getStatus)
      .mockResolvedValueOnce(unconfiguredStatus)
      .mockResolvedValueOnce(partialConfiguredStatus);
    useStorageMock.mockReturnValue({ storage } as never);

    const user = userEvent.setup();
    render(<RecoveryPanel />);
    await user.click(await screen.findByTestId("setup-recovery"));

    expect(await screen.findByTestId("recovery-configured-not-ready")).toBeInTheDocument();
    expect(screen.getByTestId("restore-key-input")).toBeInTheDocument();
    expect(screen.getByTestId("recovery-error")).toHaveTextContent(
      "Recovery is already configured. Restore with the existing Recovery Key.",
    );
  });

  it("offers account setup only when recovery is not configured", async () => {
    const storage = fakeStorage();
    useStorageMock.mockReturnValue({ storage } as never);

    render(<RecoveryPanel />);

    expect(await screen.findByTestId("recovery-not-setup")).toHaveTextContent(
      "Recovery is not configured on this account.",
    );
    expect(screen.getByTestId("setup-recovery")).toHaveTextContent("Set up recovery on this device");
  });

  it("fails closed when the SDK rejects an inconsistent recovery state", async () => {
    const storage = fakeStorage();
    vi.mocked(storage.keys.getStatus).mockRejectedValue(
      new Error("secret storage state is inconsistent"),
    );
    useStorageMock.mockReturnValue({ storage } as never);

    render(<RecoveryPanel />);

    expect(await screen.findByTestId("recovery-status-unknown")).toBeInTheDocument();
    expect(screen.queryByTestId("setup-recovery")).not.toBeInTheDocument();
  });

  it("clears a restore key after a failed restore", async () => {
    const storage = fakeStorage(configuredStatus);
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
    const storage = fakeStorage(configuredStatus);
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

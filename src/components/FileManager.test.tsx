import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { FileManager } from "./FileManager";
import { useStorage } from "../context/StorageContext";
import * as core from "../lib/core";
import type { TeleCryptIOStorage } from "../lib/core";

vi.mock("../context/StorageContext", () => ({
  useStorage: vi.fn(),
}));

vi.mock("../lib/core", async () => {
  const actual = await vi.importActual<typeof import("../lib/core")>("../lib/core");
  return {
    ...actual,
    listVaults: vi.fn(),
    listPendingInvites: vi.fn(),
    getVaultOwnership: vi.fn(),
    createVault: vi.fn(),
    listFiles: vi.fn(),
    listSubfolders: vi.fn(),
    createSubfolder: vi.fn(),
    getVaultDetails: vi.fn(),
    getFolderDetails: vi.fn(),
    listMembers: vi.fn(),
    renameVault: vi.fn(),
    deleteVault: vi.fn(),
  };
});

const POLL_MS = 2500;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeStorage(name: string) {
  return {
    name,
    keys: {
      getStatus: vi.fn().mockResolvedValue({
        state: "ready",
        crossSigning: {
          publicKeysOnDevice: true,
          privateKeysCachedLocally: true,
          privateKeysInSecretStorage: true,
        },
        secretStorage: { ready: true, defaultKeyId: "key" },
        backupVersion: "1",
      }),
    },
  } as unknown as TeleCryptIOStorage;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const useStorageMock = vi.mocked(useStorage);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(core.listPendingInvites).mockResolvedValue([]);
  vi.mocked(core.getVaultOwnership).mockReturnValue({ status: "owner" });
  vi.mocked(core.listFiles).mockResolvedValue([]);
  vi.mocked(core.listSubfolders).mockResolvedValue([]);
  vi.mocked(core.listMembers).mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FileManager refresh identity", () => {
  it("leaves recovery status and setup controls to the Recovery view", async () => {
    const storage = fakeStorage("configured");
    vi.mocked(core.listVaults).mockResolvedValue([]);
    useStorageMock.mockReturnValue({ storage } as never);

    render(<FileManager />);
    await flush();

    expect(storage.keys.getStatus).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /set up account recovery/i })).not.toBeInTheDocument();
  });

  it("discards a previous account refresh after storage changes", async () => {
    const storageA = fakeStorage("A");
    const storageB = fakeStorage("B");
    const stale = deferred<Array<{ id: string; name: string }>>();

    vi.mocked(core.listVaults).mockImplementation(async (storage) =>
      storage === storageA
        ? stale.promise
        : [{ id: "!b:localhost", name: "Account B vault" }],
    );

    useStorageMock.mockReturnValue({ storage: storageA } as never);
    const view = render(<FileManager />);
    await flush();

    useStorageMock.mockReturnValue({ storage: storageB } as never);
    view.rerender(<FileManager />);
    await flush();

    expect(screen.getByText("Account B vault")).toBeInTheDocument();
    stale.resolve([{ id: "!a:localhost", name: "Account A vault" }]);
    await flush();

    expect(screen.queryByText("Account A vault")).not.toBeInTheDocument();
    expect(screen.getByText("Account B vault")).toBeInTheDocument();
    expect(screen.queryByTestId("vault-detail")).not.toBeInTheDocument();
  });

  it("keeps the newest overlapping refresh result", async () => {
    const storage = fakeStorage("shared");
    const stale = deferred<Array<{ id: string; name: string }>>();
    let call = 0;
    vi.mocked(core.listVaults).mockImplementation(async () => {
      call += 1;
      if (call === 2) return stale.promise;
      return call >= 3
        ? [{ id: "!fresh:localhost", name: "Fresh vault" }]
        : [{ id: "!initial:localhost", name: "Initial vault" }];
    });

    vi.mocked(core.renameVault).mockResolvedValue({ id: "!initial:localhost", name: "Renamed" });
    vi.mocked(core.createVault).mockResolvedValue({ id: "!created:localhost", name: "Created" });
    useStorageMock.mockReturnValue({ storage } as never);
    const user = userEvent.setup();
    render(<FileManager />);
    await screen.findByText("Initial vault");

    await user.click(screen.getByTestId("rename-vault"));
    fireEvent.change(screen.getByTestId("rename-vault-input"), { target: { value: "Renamed" } });
    fireEvent.keyDown(screen.getByTestId("rename-vault-input"), { key: "Enter" });
    await waitFor(() => expect(core.listVaults).toHaveBeenCalledTimes(2));

    await user.click(screen.getByTestId("create-vault"));
    await waitFor(() => expect(core.listVaults).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("Fresh vault")).toBeInTheDocument();
    stale.resolve([{ id: "!stale:localhost", name: "Stale vault" }]);
    await flush();

    expect(screen.queryByText("Stale vault")).not.toBeInTheDocument();
    expect(screen.getByText("Fresh vault")).toBeInTheDocument();
  });

  it("removes stale owner controls when the role snapshot becomes unavailable", async () => {
    vi.useFakeTimers();
    const storage = fakeStorage("shared");
    vi.mocked(core.listVaults).mockResolvedValue([{ id: "!vault:localhost", name: "Shared" }]);
    useStorageMock.mockReturnValue({ storage } as never);
    render(<FileManager />);
    await flush();

    expect(screen.getByTestId("rename-vault")).toBeInTheDocument();
    vi.mocked(core.getVaultOwnership).mockImplementation(() => {
      throw new Error("role unavailable");
    });

    await act(async () => {
      vi.advanceTimersByTime(POLL_MS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByTestId("rename-vault")).not.toBeInTheDocument();
    expect(screen.queryByTestId("delete-vault")).not.toBeInTheDocument();
    expect(screen.getByTestId("vault-list-error")).toHaveTextContent(
      "role unavailable",
    );
  });

  it("does not delete a vault after an owner role is revoked while its control is open", async () => {
    const storage = fakeStorage("shared");
    let role = "owner";
    vi.mocked(core.getVaultOwnership).mockImplementation(() =>
      role === "owner" ? { status: "owner" } : { status: "not-owner" },
    );
    vi.mocked(core.listVaults).mockResolvedValue([{ id: "!vault:localhost", name: "Shared" }]);
    vi.mocked(core.deleteVault).mockResolvedValue({ id: "!vault:localhost", deleted: true });
    useStorageMock.mockReturnValue({ storage } as never);
    const user = userEvent.setup();
    render(<FileManager />);
    await waitFor(() => expect(screen.getByTestId("delete-vault")).toBeInTheDocument());

    const deleteButton = screen.getByTestId("delete-vault");
    role = "viewer";
    vi.stubGlobal("confirm", () => true);
    await user.click(deleteButton);

    expect(core.deleteVault).not.toHaveBeenCalled();
  });

  it("surfaces the SDK nonempty-vault refusal without refreshing or removing the vault", async () => {
    const storage = fakeStorage("shared");
    const vault = { id: "!vault:localhost", name: "Shared" };
    vi.mocked(core.listVaults).mockResolvedValue([vault]);
    const failure = new core.NonEmptyTreeError(vault.id);
    vi.mocked(core.deleteVault).mockRejectedValue(failure);
    useStorageMock.mockReturnValue({ storage } as never);
    const user = userEvent.setup();
    render(<FileManager />);
    await waitFor(() => expect(screen.getByTestId("delete-vault")).toBeInTheDocument());

    vi.stubGlobal("confirm", () => true);
    await user.click(screen.getByTestId("delete-vault"));

    await waitFor(() =>
      expect(screen.getByTestId("vault-list-error")).toHaveTextContent(
        failure.message,
      ),
    );
    expect(screen.getByText("Shared")).toBeInTheDocument();
    expect(core.listVaults).toHaveBeenCalledTimes(1);
  });

  it("refreshes after a confirmed delete even when the SDK no longer reports ownership", async () => {
    const storage = fakeStorage("shared");
    const deletion = deferred<{ id: string; deleted: true }>();
    let role = "owner";
    let refreshCount = 0;
    vi.mocked(core.getVaultOwnership).mockImplementation(() =>
      role === "owner" ? { status: "owner" } : { status: "not-owner" },
    );
    vi.mocked(core.listVaults).mockImplementation(async () => {
      refreshCount += 1;
      return refreshCount === 1 ? [{ id: "!vault:localhost", name: "Shared" }] : [];
    });
    vi.mocked(core.deleteVault).mockReturnValue(deletion.promise);
    useStorageMock.mockReturnValue({ storage } as never);
    const user = userEvent.setup();
    render(<FileManager />);
    await waitFor(() => expect(screen.getByTestId("delete-vault")).toBeInTheDocument());

    vi.stubGlobal("confirm", () => true);
    const deleteTask = user.click(screen.getByTestId("delete-vault"));
    await waitFor(() => expect(core.deleteVault).toHaveBeenCalled());
    role = "viewer";
    deletion.resolve({ id: "!vault:localhost", deleted: true });
    await deleteTask;

    await waitFor(() => expect(screen.getByTestId("no-vaults")).toBeInTheDocument());
    expect(screen.queryByText("Shared")).not.toBeInTheDocument();
    expect(core.listVaults).toHaveBeenCalledTimes(2);
  });

  it("clears owner controls when the vault refresh fails", async () => {
    vi.useFakeTimers();
    const storage = fakeStorage("shared");
    let refreshCount = 0;
    vi.mocked(core.listVaults).mockImplementation(async () => {
      refreshCount += 1;
      if (refreshCount > 1) throw new Error("vault list unavailable");
      return [{ id: "!vault:localhost", name: "Shared" }];
    });
    useStorageMock.mockReturnValue({ storage } as never);
    render(<FileManager />);
    await flush();
    expect(screen.getByTestId("delete-vault")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(POLL_MS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByTestId("delete-vault")).not.toBeInTheDocument();
    expect(screen.getByTestId("vault-list-error")).toHaveTextContent(
      "vault list unavailable",
    );
  });

  it("delegates remote vault-name validation to the SDK", async () => {
    const storage = fakeStorage("shared");
    vi.mocked(core.listVaults).mockResolvedValue([{ id: "!vault:localhost", name: "Shared" }]);
    vi.mocked(core.renameVault).mockRejectedValue(new Error("invalid name"));
    useStorageMock.mockReturnValue({ storage } as never);
    const user = userEvent.setup();
    render(<FileManager />);
    await waitFor(() => expect(screen.getByTestId("rename-vault")).toBeInTheDocument());

    await user.click(screen.getByTestId("rename-vault"));
    fireEvent.change(screen.getByTestId("rename-vault-input"), {
      target: { value: "bad\u0000name" },
    });
    fireEvent.keyDown(screen.getByTestId("rename-vault-input"), { key: "Enter" });

    expect(core.renameVault).toHaveBeenCalledWith(
      storage,
      "!vault:localhost",
      "bad\u0000name",
      expect.anything(),
    );
    await waitFor(() =>
      expect(screen.getByTestId("vault-list-error")).toHaveTextContent(
        "invalid name",
      ),
    );
  });

  it("clears a selected vault when the account no longer lists it", async () => {
    vi.useFakeTimers();
    const storage = fakeStorage("shared");
    let refreshCount = 0;
    vi.mocked(core.listVaults).mockImplementation(async () => {
      refreshCount += 1;
      return refreshCount === 1 ? [{ id: "!vault:localhost", name: "Shared" }] : [];
    });
    useStorageMock.mockReturnValue({ storage } as never);
    render(<FileManager />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Shared" }));
    expect(screen.getByTestId("vault-detail")).toHaveAttribute("data-vault-id", "!vault:localhost");

    await act(async () => {
      vi.advanceTimersByTime(POLL_MS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("select-vault-prompt")).toBeInTheDocument();
  });

  it("pauses top-level refresh during folder creation and resumes it afterward", async () => {
    vi.useFakeTimers();
    const storage = fakeStorage("shared");
    const vault = { id: "!vault:localhost", name: "Shared" };
    const creation = deferred<{ id: string; name: string }>();
    const laterRefreshFailure = new Error("later vault refresh failed");
    let refreshCount = 0;
    vi.mocked(core.listVaults).mockImplementation(async () => {
      refreshCount += 1;
      if (refreshCount === 3) throw laterRefreshFailure;
      return [vault];
    });
    vi.mocked(core.createSubfolder).mockReturnValue(creation.promise as never);
    useStorageMock.mockReturnValue({ storage } as never);
    render(<FileManager />);
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Shared" }));
    fireEvent.click(screen.getByTestId("create-subfolder"));
    await flush();
    expect(core.createSubfolder).toHaveBeenCalled();
    expect(refreshCount).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(POLL_MS);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(refreshCount).toBe(1);
    expect(screen.queryByTestId("vault-list-error")).not.toBeInTheDocument();

    await act(async () => {
      creation.resolve({ id: "!folder:localhost", name: "Untitled folder" });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(refreshCount).toBe(2);
    expect(screen.queryByTestId("vault-list-error")).not.toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(POLL_MS);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(refreshCount).toBe(3);
    expect(screen.getByTestId("vault-list-error")).toHaveTextContent(laterRefreshFailure.message);
  });

  it("does not auto-navigate after a pending vault creation if the user navigated away", async () => {
    const storage = fakeStorage("shared");
    const creation = deferred<{ id: string; name: string }>();
    vi.mocked(core.listVaults).mockResolvedValue([
      { id: "!a:localhost", name: "A" },
      { id: "!b:localhost", name: "B" },
    ]);
    vi.mocked(core.createVault).mockReturnValue(creation.promise as never);

    useStorageMock.mockReturnValue({ storage } as never);
    const user = userEvent.setup();
    render(<FileManager />);
    await waitFor(() => expect(screen.getByText("A")).toBeInTheDocument());

    await user.click(screen.getByTestId("create-vault"));
    await waitFor(() => expect(core.createVault).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "B" }));
    await waitFor(() =>
      expect(screen.getByTestId("vault-detail")).toHaveAttribute("data-vault-id", "!b:localhost"),
    );

    creation.resolve({ id: "!created:localhost", name: "Untitled vault" });
    await flush();

    expect(screen.getByTestId("vault-detail")).toHaveAttribute("data-vault-id", "!b:localhost");
  });

  it("does not treat a failed background refresh as navigation during vault creation", async () => {
    const storage = fakeStorage("shared");
    const firstRefresh = deferred<{ id: string; name: string }[]>();
    const creation = deferred<{ id: string; name: string }>();
    vi.mocked(core.listVaults)
      .mockReturnValueOnce(firstRefresh.promise as never)
      .mockResolvedValue([]);
    vi.mocked(core.createVault).mockReturnValue(creation.promise as never);
    useStorageMock.mockReturnValue({ storage } as never);
    const user = userEvent.setup();
    render(<FileManager />);

    await waitFor(() => expect(core.listVaults).toHaveBeenCalledTimes(1));
    await user.click(screen.getByTestId("create-vault"));
    await waitFor(() => expect(core.createVault).toHaveBeenCalled());

    await act(async () => {
      firstRefresh.reject(new Error("Matrix request aborted"));
      await Promise.resolve();
      await Promise.resolve();
    });
    creation.resolve({ id: "!created:localhost", name: "Untitled vault" });

    expect(await screen.findByTestId("rename-vault-input")).toHaveValue("Untitled vault");
    expect(screen.getByTestId("vault-detail")).toHaveAttribute("data-vault-id", "!created:localhost");
  });

  it("keeps a newly created vault selected when a refresh request aborts", async () => {
    const storage = fakeStorage("shared");
    const created = { id: "!created:localhost", name: "Untitled vault" };
    let refreshCount = 0;
    vi.mocked(core.listVaults).mockImplementation(async () => {
      refreshCount += 1;
      if (refreshCount === 2) throw new Error("Matrix request aborted");
      return [];
    });
    vi.mocked(core.createVault).mockResolvedValue(created);
    useStorageMock.mockReturnValue({ storage } as never);
    render(<FileManager />);
    await waitFor(() => expect(refreshCount).toBe(1));

    fireEvent.click(screen.getByTestId("create-vault"));

    expect(await screen.findByTestId("rename-vault-input")).toHaveValue("Untitled vault");
    expect(screen.getByTestId("vault-detail")).toHaveAttribute("data-vault-id", created.id);
    expect(screen.getByTestId("vault-list-error")).toHaveTextContent("Matrix request aborted");
  });

  it("keeps a selected new vault through repeated missing sync snapshots", async () => {
    vi.useFakeTimers();
    const storage = fakeStorage("shared");
    const created = { id: "!created:localhost", name: "Untitled vault" };
    let refreshCount = 0;
    vi.mocked(core.listVaults).mockImplementation(async () => {
      refreshCount += 1;
      return refreshCount === 2 ? [created] : [];
    });
    vi.mocked(core.createVault).mockResolvedValue(created);
    useStorageMock.mockReturnValue({ storage } as never);
    render(<FileManager />);
    await flush();

    fireEvent.click(screen.getByTestId("create-vault"));
    await flush();
    expect(refreshCount).toBe(2);
    expect(screen.getByTestId("rename-vault-input")).toHaveValue("Untitled vault");

    for (let i = 0; i < 2; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(POLL_MS);
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    expect(screen.getByTestId("rename-vault-input")).toHaveValue("Untitled vault");
    expect(screen.getByTestId("vault-detail")).toHaveAttribute("data-vault-id", created.id);
  });

  it("keeps a new vault selected while the server list catches up", async () => {
    const storage = fakeStorage("shared");
    vi.mocked(core.listVaults).mockResolvedValue([]);
    vi.mocked(core.createVault).mockResolvedValue({ id: "!created:localhost", name: "Untitled vault" });
    useStorageMock.mockReturnValue({ storage } as never);
    const user = userEvent.setup();
    render(<FileManager />);
    await screen.findByTestId("create-vault");

    await user.click(screen.getByTestId("create-vault"));
    await waitFor(() => expect(core.listVaults).toHaveBeenCalledTimes(2));
    await flush();

    expect(screen.getByTestId("vault-detail")).toHaveAttribute("data-vault-id", "!created:localhost");
    expect(screen.getByTestId("vault-item")).toHaveAttribute("data-vault-id", "!created:localhost");
    expect(screen.getByTestId("rename-vault-input")).toHaveValue("Untitled vault");
  });

  it("keeps a renamed new vault selected across one missing sync snapshot", async () => {
    const storage = fakeStorage("shared");
    const created = { id: "!created:localhost", name: "Untitled vault" };
    const renamed = { id: created.id, name: "TreeVault" };
    let refreshCount = 0;
    vi.mocked(core.listVaults).mockImplementation(async () => {
      refreshCount += 1;
      if (refreshCount === 2) return [created];
      if (refreshCount === 3) return [];
      return [];
    });
    vi.mocked(core.createVault).mockResolvedValue(created);
    vi.mocked(core.renameVault).mockResolvedValue(renamed);
    useStorageMock.mockReturnValue({ storage } as never);
    const user = userEvent.setup();
    render(<FileManager />);

    await user.click(screen.getByTestId("create-vault"));
    const renameInput = await screen.findByTestId("rename-vault-input");
    await waitFor(() => expect(refreshCount).toBeGreaterThanOrEqual(2));
    fireEvent.change(renameInput, { target: { value: renamed.name } });
    fireEvent.keyDown(renameInput, { key: "Enter" });

    await waitFor(() => expect(refreshCount).toBeGreaterThanOrEqual(3));
    await waitFor(() => expect(screen.getByTestId("vault-detail")).toHaveAttribute("data-vault-id", created.id));
    expect(screen.getAllByTestId("vault-item")).toHaveLength(1);
    expect(within(screen.getByTestId("vault-item")).getByRole("button", { name: renamed.name })).toBeInTheDocument();
    expect(screen.queryByTestId("select-vault-prompt")).not.toBeInTheDocument();
  });

  it("does not duplicate a vault already seen by sync before creation returns", async () => {
    const storage = fakeStorage("shared");
    const created = { id: "!created:localhost", name: "Untitled vault" };
    const firstRefresh = deferred<typeof created[]>();
    const creation = deferred<typeof created>();
    vi.mocked(core.listVaults)
      .mockReturnValueOnce(firstRefresh.promise as never)
      .mockResolvedValue([created]);
    vi.mocked(core.createVault).mockReturnValue(creation.promise as never);
    useStorageMock.mockReturnValue({ storage } as never);
    const user = userEvent.setup();
    render(<FileManager />);

    await user.click(screen.getByTestId("create-vault"));
    await waitFor(() => expect(core.createVault).toHaveBeenCalled());
    firstRefresh.resolve([created]);
    await waitFor(() => expect(screen.getAllByTestId("vault-item")).toHaveLength(1));

    creation.resolve(created);
    await waitFor(() => expect(screen.getAllByTestId("rename-vault-input")).toHaveLength(1));
    expect(screen.getAllByTestId("vault-item")).toHaveLength(1);
  });
});

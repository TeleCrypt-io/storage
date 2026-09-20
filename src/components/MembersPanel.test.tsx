import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MembersPanel } from "./MembersPanel";
import { useStorage } from "../context/StorageContext";
import * as core from "../lib/core";

vi.mock("../context/StorageContext", () => ({
  useStorage: vi.fn(),
}));

vi.mock("../lib/core", async () => {
  const actual = await vi.importActual<typeof import("../lib/core")>("../lib/core");
  return {
    ...actual,
    getVaultOwnership: vi.fn(),
    getVaultDetails: vi.fn(),
    listMembers: vi.fn(),
    shareVault: vi.fn(),
    unshareVault: vi.fn(),
  };
});

const POLL_MS = 4000;
const useStorageMock = vi.mocked(useStorage);

function fakeStorage() {
  return { keys: {} };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(core.getVaultOwnership).mockReturnValue({ status: "owner" });
  vi.mocked(core.getVaultDetails).mockResolvedValue({
    name: "Vault",
    id: "!vault:localhost",
    createdAt: null,
    memberCount: 0,
  });
  useStorageMock.mockReturnValue({
    storage: fakeStorage(),
    session: { userId: "@alice:localhost:8008" },
  } as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MembersPanel access state", () => {
  it("clears member identities when a refresh fails", async () => {
    vi.useFakeTimers();
    vi.mocked(core.listMembers)
      .mockResolvedValueOnce([{ userId: "@bob:localhost:8008", role: "viewer", membership: "join" }])
      .mockRejectedValueOnce(new Error("membership unavailable"));
    render(<MembersPanel vaultId="!vault:localhost" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("member-item")).toHaveAttribute("data-user-id", "@bob:localhost:8008");

    await act(async () => {
      vi.advanceTimersByTime(POLL_MS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByTestId("member-item")).not.toBeInTheDocument();
    expect(screen.getByTestId("members-error")).toHaveTextContent(
      "membership unavailable",
    );
  });

  it("refreshes a confirmed invite after ownership is revoked in flight", async () => {
    const share = deferred<{ vaultId: string; userId: string; role: "viewer" }>();
    let role = "owner";
    vi.mocked(core.getVaultOwnership).mockImplementation(() =>
      role === "owner" ? { status: "owner" } : { status: "not-owner" },
    );
    vi.mocked(core.listMembers).mockResolvedValue([]);
    vi.mocked(core.shareVault).mockReturnValue(share.promise);
    const user = userEvent.setup();
    render(<MembersPanel vaultId="!vault:localhost" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await user.type(screen.getByTestId("share-user-id"), "@bob:localhost:8008");
    const submit = user.click(screen.getByTestId("share-submit"));
    await waitFor(() => expect(core.shareVault).toHaveBeenCalled());
    role = "viewer";
    share.resolve({ vaultId: "!vault:localhost", userId: "@bob:localhost:8008", role: "viewer" });
    await submit;

    await waitFor(() => expect(core.listMembers).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("share-submit")).not.toBeInTheDocument());
  });

  it("surfaces a share failure after ownership is revoked in flight", async () => {
    const share = deferred<{ vaultId: string; userId: string; role: "viewer" }>();
    vi.mocked(core.listMembers).mockResolvedValue([]);
    vi.mocked(core.shareVault).mockReturnValue(share.promise);
    const user = userEvent.setup();
    render(<MembersPanel vaultId="!vault:localhost" />);
    await screen.findByText("No members");
    await user.type(screen.getByTestId("share-user-id"), "@bob:localhost:8008");
    const submit = user.click(screen.getByTestId("share-submit"));
    await waitFor(() => expect(core.shareVault).toHaveBeenCalled());
    vi.mocked(core.getVaultOwnership).mockReturnValue({ status: "not-owner" });
    share.reject(new Error("permission denied"));
    await submit;

    expect(await screen.findByTestId("members-error")).toHaveTextContent(
      "permission denied",
    );
    expect(screen.queryByTestId("share-submit")).not.toBeInTheDocument();
  });

  it("renders SDK-authoritative member identities", async () => {
    vi.mocked(core.listMembers).mockResolvedValue([
      { userId: "@bob+device:localhost:8008", role: "viewer", membership: "join" },
    ]);
    render(<MembersPanel vaultId="!vault:localhost" />);
    expect(await screen.findByTestId("member-item")).toHaveAttribute(
      "data-user-id",
      "@bob+device:localhost:8008",
    );
  });

  it("serializes overlapping invitations", async () => {
    const share = deferred<{ vaultId: string; userId: string; role: "viewer" }>();
    vi.mocked(core.listMembers).mockResolvedValue([]);
    vi.mocked(core.shareVault).mockReturnValue(share.promise);
    const user = userEvent.setup();
    render(<MembersPanel vaultId="!vault:localhost" />);
    await waitFor(() => expect(screen.getByText("No members")).toBeInTheDocument());
    await user.type(screen.getByTestId("share-user-id"), "@bob:localhost:8008");

    const first = user.click(screen.getByTestId("share-submit"));
    await waitFor(() => expect(core.shareVault).toHaveBeenCalledTimes(1));
    const second = user.click(screen.getByTestId("share-submit"));
    expect(core.shareVault).toHaveBeenCalledTimes(1);
    share.resolve({ vaultId: "!unexpected:localhost", userId: "@bob:localhost:8008", role: "viewer" });
    await first;
    await second;

    expect(screen.queryByTestId("members-error")).not.toBeInTheDocument();
  });
});

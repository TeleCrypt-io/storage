import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    getMemberActionCapabilities: vi.fn(),
    listMembers: vi.fn(),
    shareVault: vi.fn(),
    unshareVault: vi.fn(),
  };
});

const POLL_MS = 4000;
const ALL_MEMBER_ACTIONS: core.MemberActionCapabilities = {
  canShare: { viewer: true, editor: true, owner: true },
  canChangeRole: { viewer: true, editor: true, owner: true },
  canUnshare: true,
};
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
  vi.mocked(core.getMemberActionCapabilities).mockImplementation(async (_storage, _vaultId, userIds) =>
    Object.fromEntries(userIds.map((userId) => [userId, ALL_MEMBER_ACTIONS])),
  );
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

  it("offers access changes for a Viewer summary and reports Matrix permission failures", async () => {
    vi.mocked(core.listMembers).mockResolvedValue([]);
    vi.mocked(core.getVaultOwnership).mockReturnValue({ status: "not-owner" });
    vi.mocked(core.shareVault).mockRejectedValue(new Error("M_FORBIDDEN"));
    const user = userEvent.setup();
    render(<MembersPanel vaultId="!vault:localhost" />);

    await screen.findByText("No members");
    await user.type(screen.getByTestId("share-user-id"), "@bob:localhost:8008");
    await waitFor(() => expect(screen.getByTestId("share-submit")).toBeEnabled());
    await user.click(screen.getByTestId("share-submit"));

    expect(await screen.findByTestId("members-error")).toHaveTextContent(
      "M_FORBIDDEN",
    );
    expect(core.shareVault).toHaveBeenCalledWith(
      expect.anything(),
      "!vault:localhost",
      "@bob:localhost:8008",
      "viewer",
      expect.objectContaining({ signal: undefined }),
    );
    expect(screen.getByTestId("share-submit")).toBeInTheDocument();
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

  it("keeps role and removal actions available for Owner members", async () => {
    const memberId = "@bob:localhost:8008";
    vi.mocked(core.listMembers).mockResolvedValue([
      { userId: memberId, role: "owner", membership: "join" },
    ]);
    vi.mocked(core.shareVault).mockResolvedValue({
      vaultId: "!vault:localhost",
      userId: memberId,
      role: "viewer",
      rootMembership: "join",
    });
    vi.mocked(core.unshareVault).mockResolvedValue({
      vaultId: "!vault:localhost",
      userId: memberId,
      removed: true,
    });
    render(<MembersPanel vaultId="!vault:localhost" />);

    const role = await screen.findByLabelText("Set role for bob");
    expect(role).toHaveValue("owner");
    fireEvent.change(role, { target: { value: "viewer" } });
    await waitFor(() => expect(core.shareVault).toHaveBeenCalledWith(
      expect.anything(),
      "!vault:localhost",
      memberId,
      "viewer",
      expect.objectContaining({ signal: undefined }),
    ));

    fireEvent.click(screen.getByLabelText("Remove bob"));
    await waitFor(() => expect(core.unshareVault).toHaveBeenCalledWith(
      expect.anything(),
      "!vault:localhost",
      memberId,
      expect.objectContaining({ signal: undefined }),
    ));
  });

  it("hides role and membership controls when refreshed native capabilities deny them", async () => {
    const memberId = "@bob:localhost:8008";
    vi.mocked(core.listMembers).mockResolvedValue([
      { userId: memberId, role: "viewer", membership: "join" },
    ]);
    vi.mocked(core.getMemberActionCapabilities).mockResolvedValue({
      [memberId]: {
        canShare: { viewer: false, editor: false, owner: false },
        canChangeRole: { viewer: false, editor: false, owner: false },
        canUnshare: false,
      },
    });
    const user = userEvent.setup();
    render(<MembersPanel vaultId="!vault:localhost" />);

    expect(await screen.findByTestId("member-item")).toBeInTheDocument();
    expect(screen.getByLabelText("Set role for bob")).toBeDisabled();
    expect(screen.queryByLabelText("Remove bob")).not.toBeInTheDocument();
    await user.type(screen.getByTestId("share-user-id"), "@carol:localhost:8008");
    await waitFor(() => expect(screen.getByTestId("share-submit")).toBeDisabled());
    expect(core.shareVault).not.toHaveBeenCalled();
  });

  it("serializes overlapping invitations", async () => {
    const share = deferred<{ vaultId: string; userId: string; role: "viewer"; rootMembership: string }>();
    vi.mocked(core.listMembers).mockResolvedValue([]);
    vi.mocked(core.shareVault).mockReturnValue(share.promise);
    const user = userEvent.setup();
    render(<MembersPanel vaultId="!vault:localhost" />);
    await waitFor(() => expect(screen.getByText("No members")).toBeInTheDocument());
    await user.type(screen.getByTestId("share-user-id"), "@bob:localhost:8008");
    await waitFor(() => expect(screen.getByTestId("share-submit")).toBeEnabled());

    const first = user.click(screen.getByTestId("share-submit"));
    await waitFor(() => expect(core.shareVault).toHaveBeenCalledTimes(1));
    const second = user.click(screen.getByTestId("share-submit"));
    expect(core.shareVault).toHaveBeenCalledTimes(1);
    share.resolve({ vaultId: "!unexpected:localhost", userId: "@bob:localhost:8008", role: "viewer", rootMembership: "invite" });
    await first;
    await second;

    expect(screen.queryByTestId("members-error")).not.toBeInTheDocument();
  });
  it("keeps a failed invite visible after the member list refreshes", async () => {
    vi.useFakeTimers();
    vi.mocked(core.listMembers).mockResolvedValue([]);
    vi.mocked(core.shareVault).mockRejectedValueOnce(new Error("Invite may have completed"));
    render(<MembersPanel vaultId="!vault:localhost" />);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    fireEvent.change(screen.getByTestId("share-user-id"), { target: { value: "@bob:localhost:8008" } });
    await act(async () => vi.advanceTimersByTimeAsync(250));
    fireEvent.click(screen.getByTestId("share-submit"));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByTestId("members-error")).toHaveTextContent("Invite may have completed");
    await act(async () => vi.advanceTimersByTimeAsync(POLL_MS * 2));
    expect(screen.getByTestId("members-error")).toHaveTextContent("Invite may have completed");
  });

});

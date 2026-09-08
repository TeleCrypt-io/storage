import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import * as core from "./lib/core";
import * as oidcAuth from "./lib/oidcAuth";
import { formatElapsed } from "./lib/formatElapsed";
import { formatOperationError } from "./lib/formatOperationError";
import { runtimeOidcIssuer, getRuntimeSettings } from "./lib/buildConfig";
import * as revocation from "./lib/revokeSession";
import * as session from "./lib/session";

vi.mock("./lib/core", async () => {
  const actual = await vi.importActual<typeof import("./lib/core")>("./lib/core");
  return {
    ...actual,
    TeleCryptIOStorage: { create: vi.fn(), createFromOidc: vi.fn() },
    buildTokenRefreshFunction: vi.fn(actual.buildTokenRefreshFunction),
    discoverOidcIssuer: vi.fn(),
    listVaults: vi.fn(),
    listPendingInvites: vi.fn(),
    getVaultOwnership: vi.fn(),
    createVault: vi.fn(),
    joinVault: vi.fn(),
    declineInvite: vi.fn(),
    listFiles: vi.fn(),
    listSubfolders: vi.fn(),
    createSubfolder: vi.fn(),
    uploadFile: vi.fn(),
    downloadFile: vi.fn(),
    renameFile: vi.fn(),
    renameVault: vi.fn(),
    renameFolder: vi.fn(),
    deleteFile: vi.fn(),
    deleteVault: vi.fn(),
    deleteFolder: vi.fn(),
    shareVault: vi.fn(),
    unshareVault: vi.fn(),
    listMembers: vi.fn(),
    getFileDetails: vi.fn(),
    getVaultDetails: vi.fn(),
    getFolderDetails: vi.fn(),
  };
});

vi.mock("./lib/oidcAuth", () => ({
  beginOidcLogin: vi.fn(),
  completeOidcLoginFromCallback: vi.fn(),
}));

vi.mock("./lib/revokeSession", async () => {
  const session = await vi.importActual<typeof import("./lib/session")>("./lib/session");
  const revokeMatrixSession = vi.fn();
  const revokeOrRemember = vi.fn(async (target: { homeserver: string; accessToken: string }, signal?: AbortSignal, primary?: unknown) => {
    try {
      await revokeMatrixSession(target, undefined, signal);
      if (session.clearPendingRevocation(target)) return null;
      const cleanupError = new Error("Session cleanup persistence failed");
      return primary instanceof Error
        ? new Error(primary.message, { cause: new AggregateError([primary, cleanupError]) })
        : cleanupError;
    } catch (error) {
      const recorded = session.savePendingRevocation(target);
      return new Error(
        recorded && primary instanceof Error
          ? primary.message
          : recorded
            ? "Session cleanup pending"
            : "Session cleanup persistence failed",
        { cause: primary ? new AggregateError([primary, error]) : error },
      );
    }
  });
  return { revokeMatrixSession, revokeOrRemember };
});

const SESSION = {
  homeserver: "http://localhost:8008",
  userId: "@alice:localhost",
  deviceId: "DEVICE1",
  accessToken: "tok-123",
  refreshToken: "refresh-123",
  oidcClientId: "client-123",
};

function abortOptions() {
  return expect.objectContaining({ signal: expect.anything() });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeStorage(recoverySetup = false) {
  const stopClient = vi.fn();
  const crypto = {
    getKeyBackupInfo: vi.fn().mockResolvedValue(recoverySetup ? {} : null),
    getSecretStorageStatus: vi.fn().mockResolvedValue({
      defaultKeyId: recoverySetup ? "key" : null,
      ready: recoverySetup,
    }),
  };
  return {
    stopClient,
    getClient: () => ({
      stopClient,
      getCrypto: () => crypto,
      getAccountDataFromServer: vi.fn().mockResolvedValue(recoverySetup ? {} : null),
    }),
    keys: {
      isRecoverySetup: vi.fn().mockResolvedValue(recoverySetup),
      setupRecovery: vi.fn(),
      restoreFromRecoveryKey: vi.fn(),
    },
  };
}

async function loginAndReachVaults(
  initialVaults: Array<{ id: string; name: string }> = [],
  recoverySetup = false,
) {
  const storage = fakeStorage(recoverySetup);
  vi.mocked(core.discoverOidcIssuer).mockResolvedValue({
    issuer: runtimeOidcIssuer(),
    token_endpoint: `${getRuntimeSettings().homeserver}/auth/token`,
  } as never);
  vi.mocked(core.TeleCryptIOStorage.createFromOidc).mockResolvedValue(storage as never);
  vi.mocked(core.listVaults).mockResolvedValue(initialVaults);
  sessionStorage.setItem("telecrypt-io-ui:session", JSON.stringify(SESSION));

  const user = userEvent.setup();
  const view = render(<App />);

  await waitFor(() => expect(screen.getByTestId("current-user")).toHaveTextContent(SESSION.userId));
  if (initialVaults.length === 0) {
    await screen.findByTestId("no-vaults");
  } else {
    await screen.findByText(initialVaults[0].name);
  }
  return { storage, user, view };
}

async function openVault(
  name = "Docs",
  opts?: {
    files?: Array<{ id: string; name: string }>;
    subfolders?: Array<{ id: string; name: string }>;
    members?: Array<{ userId: string; role: string; membership: string }>;
    vaultDetailsError?: unknown;
  },
) {
  vi.mocked(core.listFiles).mockImplementation(async () => opts?.files ?? []);
  vi.mocked(core.listSubfolders).mockImplementation(async () => opts?.subfolders ?? []);
  vi.mocked(core.listMembers).mockImplementation(async () => opts?.members ?? []);
  if (opts?.vaultDetailsError) {
    vi.mocked(core.getVaultDetails).mockRejectedValue(opts.vaultDetailsError);
  } else {
    vi.mocked(core.getVaultDetails).mockResolvedValue({
      name,
      id: "!vault:localhost",
      createdAt: null,
      memberCount: opts?.members?.length ?? 1,
    });
  }
  const { user } = await loginAndReachVaults([{ id: "!vault:localhost", name }]);
  await user.click(screen.getByRole("button", { name }));
  await screen.findByTestId("vault-detail");
  return user;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  vi.mocked(core.getVaultOwnership).mockReturnValue({ status: "owner" });
  vi.mocked(core.listPendingInvites).mockResolvedValue([]);
  vi.mocked(core.getFileDetails).mockResolvedValue({
    name: "file.txt",
    mimetype: "text/plain",
    size: 5,
    createdAt: null,
    updatedAt: null,
  });
  vi.mocked(revocation.revokeMatrixSession).mockResolvedValue(undefined);
});

describe("formatElapsed", () => {
  it("shows milliseconds under 2 seconds", () => {
    expect(formatElapsed(340)).toBe("340ms");
    expect(formatElapsed(1999)).toBe("1999ms");
  });

  it("shows seconds with one decimal under one minute", () => {
    expect(formatElapsed(2500)).toBe("2.5s");
    expect(formatElapsed(45000)).toBe("45.0s");
  });

  it("shows m:ss at one minute and beyond", () => {
    expect(formatElapsed(65000)).toBe("1:05");
    expect(formatElapsed(125000)).toBe("2:05");
  });
});

describe("formatOperationError", () => {
  it("preserves complete non-SDK operation details", () => {
    expect(formatOperationError(new Error("HTTP 413"))).toContain("HTTP 413");
    expect(formatOperationError(new Error("M_TOO_LARGE"))).toContain("M_TOO_LARGE");
    expect(formatOperationError(new Error("Upload request body is too large"))).toContain(
      "Upload request body is too large",
    );
  });

  it("preserves upstream details while redacting credentials and control characters", () => {
    expect(formatOperationError(new Error("HTTP 500 for !secret-room:localhost"))).toContain(
      "HTTP 500 for !secret-room:localhost",
    );
    expect(formatOperationError(new Error("OIDC token exchange failed: provider body contains a token"))).toContain(
      "OIDC token exchange failed: provider body contains a token",
    );
    const detail = formatOperationError(new AggregateError([
      new Error("backend detail\nAuthorization: Bearer access-token-secret"),
      new Error("response access_token=refresh-token-secret"),
    ], "backend request failed"));
    expect(detail).toContain("backend detail\\u000a");
    expect(detail).toContain("backend request failed");
    expect(detail).toContain("[REDACTED]");
    expect(detail).not.toContain("access-token-secret");
    expect(detail).not.toContain("refresh-token-secret");

    const nested = Object.assign(new Error("outer failure"), {
      backend: {
        response: {
          status: 503,
          access_token: "nested-token-secret",
          userId: "@alice:localhost",
          email: "alice@example.test",
          privateKey: "private-key-secret",
        },
        detail: "complete nested detail",
      },
    });
    const nestedDetail = formatOperationError(nested);
    expect(nestedDetail).toContain("complete nested detail");
    expect(nestedDetail).toContain("status=503");
    expect(nestedDetail).toContain("access_token=[REDACTED]");
    expect(nestedDetail).toContain("userId=[REDACTED]");
    expect(nestedDetail).toContain("email=[REDACTED]");
    expect(nestedDetail).toContain("privateKey=[REDACTED]");
    expect(nestedDetail).not.toContain("nested-token-secret");
    expect(nestedDetail).not.toContain("@alice:localhost");
    expect(nestedDetail).not.toContain("alice@example.test");
    expect(nestedDetail).not.toContain("private-key-secret");

    const named = new Error("named failure");
    named.name = "BackendFailure";
    named.stack = "BackendFailure: named failure\n    at provider boundary";
    const namedDetail = formatOperationError(named);
    expect(namedDetail).toContain("name=BackendFailure");
    expect(namedDetail).toContain("stack=BackendFailure: named failure\\u000a");

    const throwingError = new Error("getter failure");
    Object.defineProperties(throwingError, {
      name: { get: () => { throw new Error("name getter failed"); } },
      stack: { get: () => { throw new Error("stack getter failed"); } },
    });
    const throwingDetail = formatOperationError(throwingError);
    expect(throwingDetail).toContain("name=[property unavailable: name getter failed]");
    expect(throwingDetail).toContain("stack=[property unavailable: stack getter failed]");

    const getterFailure = {};
    Object.defineProperty(getterFailure, "details", {
      get: () => {
        throw new Error("diagnostic getter failed");
      },
    });
    expect(formatOperationError(getterFailure)).toContain(
      "details=[property unavailable: diagnostic getter failed]",
    );
  });

  it("preserves persistence and retry failure details", () => {
    expect(formatOperationError(new Error("Session persistence failed"))).toContain(
      "Session persistence failed",
    );
    expect(formatOperationError(new Error("Session cleanup is pending"))).toContain(
      "Session cleanup is pending",
    );
    expect(formatOperationError(new Error("Session cleanup could not be persisted"))).toContain(
      "Session cleanup could not be persisted",
    );
    expect(formatOperationError(new Error("Browser persistent storage is unavailable"))).toContain(
      "Browser persistent storage is unavailable",
    );
  });

  it("preserves SDK failure and recovery instructions without reinterpreting the outcome", () => {
    for (const error of [
      new core.FileTooLargeError(),
      new core.RecoveryRestoreError(),
      new core.RecoverySetupAmbiguousError(),
      new core.NonEmptyTreeError("!vault:localhost"),
      new core.MutationPartialError("share vault", []),
      new core.MutationOutcomeUnknownError("upload"),
      new core.RoomCreationAmbiguousError(),
    ]) {
      expect(formatOperationError(error)).toContain(error.message);
    }
  });
});

describe("login", () => {
  it("offers only MAS/OIDC sign-in", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.queryByTestId("password")).not.toBeInTheDocument();
    expect(screen.queryByTestId("submit")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("oidc-login"));
    expect(oidcAuth.beginOidcLogin).toHaveBeenCalledWith(expect.anything());
  });

  it("restores only an OIDC session and opens the vault list", async () => {
    await loginAndReachVaults();
    expect(core.buildTokenRefreshFunction).toHaveBeenCalledWith(
      expect.anything(),
      SESSION.oidcClientId,
      expect.any(Function),
      SESSION.deviceId,
    );
    expect(core.TeleCryptIOStorage.createFromOidc).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: SESSION.homeserver,
        serverName: "localhost",
        userId: SESSION.userId,
        deviceId: SESSION.deviceId,
        accessToken: SESSION.accessToken,
      }),
    );
    expect(screen.getByTestId("no-vaults")).toBeInTheDocument();
  });

  it("reports an incomplete stored OIDC session", () => {
    sessionStorage.setItem(
      "telecrypt-io-ui:session",
      JSON.stringify({ ...SESSION, refreshToken: undefined }),
    );
    render(<App />);
    expect(screen.getByTestId("auth-error")).toHaveTextContent("Stored session is invalid");
    expect(screen.getByTestId("oidc-login")).toBeInTheDocument();
    expect(core.TeleCryptIOStorage.create).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("telecrypt-io-ui:session")).toBeNull();
  });

  it("reports a saved session without a device identity before building a refresh adapter", () => {
    const incomplete = { ...SESSION } as Record<string, unknown>;
    delete incomplete.deviceId;
    sessionStorage.setItem("telecrypt-io-ui:session", JSON.stringify(incomplete));

    render(<App />);

    expect(screen.getByTestId("auth-error")).toHaveTextContent("Stored session is invalid");
    expect(screen.getByTestId("oidc-login")).toBeInTheDocument();
    expect(core.buildTokenRefreshFunction).not.toHaveBeenCalled();
    expect(core.TeleCryptIOStorage.createFromOidc).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("telecrypt-io-ui:session")).toBeNull();
  });

  it("reports a saved session for a different runtime homeserver", () => {
    sessionStorage.setItem(
      "telecrypt-io-ui:session",
      JSON.stringify({ ...SESSION, homeserver: "https://unexpected.example.test" }),
    );
    render(<App />);
    expect(screen.getByTestId("auth-error")).toHaveTextContent("Stored session is invalid");
    expect(screen.getByTestId("oidc-login")).toBeInTheDocument();
    expect(core.TeleCryptIOStorage.createFromOidc).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("telecrypt-io-ui:session")).toBeNull();
  });

  it("refuses to send a refresh token to a changed OIDC issuer", async () => {
    sessionStorage.setItem("telecrypt-io-ui:session", JSON.stringify(SESSION));
    vi.mocked(core.discoverOidcIssuer).mockResolvedValue({
      issuer: "https://unexpected.example.test/",
      token_endpoint: "https://unexpected.example.test/token",
    } as never);

    render(<App />);

    expect(await screen.findByTestId("auth-error")).toHaveTextContent(
      "Authentication issuer changed; log in again",
    );
    expect(core.TeleCryptIOStorage.createFromOidc).not.toHaveBeenCalled();
  });

  it("keeps the latest rotated refresh token when a later refresh omits one", async () => {
    await loginAndReachVaults();
    const createOptions = vi.mocked(core.TeleCryptIOStorage.createFromOidc).mock.calls[0][0];
    const refresh = createOptions.tokenRefreshFunction;
    expect(refresh).toBeDefined();

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token_type: "Bearer",
            access_token: "access-rotated",
            refresh_token: "refresh-rotated",
            scope: "urn:matrix:client:api:* urn:matrix:client:device:DEVICE1",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          token_type: "Bearer",
          access_token: "access-later",
          scope: "urn:matrix:client:api:* urn:matrix:client:device:DEVICE1",
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const first = await refresh!(SESSION.refreshToken);
    await refresh!(first.refreshToken!);

    expect(JSON.parse(sessionStorage.getItem("telecrypt-io-ui:session")!)).toEqual(
      expect.objectContaining({
        accessToken: "access-later",
        refreshToken: "refresh-rotated",
      }),
    );
    fetchMock.mockRestore();
  });

  it("rejects an oversized refresh token before making a token request", async () => {
    await loginAndReachVaults();
    const createOptions = vi.mocked(core.TeleCryptIOStorage.createFromOidc).mock.calls[0][0];
    const refresh = createOptions.tokenRefreshFunction;
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(refresh!("x".repeat(8193))).rejects.toThrow("OIDC refresh token is invalid or too large");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("rejects a token refresh that completes after logout without restoring the session", async () => {
    const { storage, user } = await loginAndReachVaults();
    const createOptions = vi.mocked(core.TeleCryptIOStorage.createFromOidc).mock.calls[0][0];
    const refresh = createOptions.tokenRefreshFunction;
    expect(refresh).toBeDefined();

    await user.click(screen.getByTestId("logout"));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        token_type: "Bearer",
        access_token: "stale-access",
        refresh_token: "stale-refresh",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(refresh!(SESSION.refreshToken)).rejects.toThrow("Session is no longer active");
    expect(sessionStorage.getItem("telecrypt-io-ui:session")).toBeNull();
    expect(storage.stopClient).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("stops the client and locks the persisted session when remote logout cannot be confirmed", async () => {
    const { storage, user } = await loginAndReachVaults();
    vi.mocked(revocation.revokeMatrixSession).mockRejectedValueOnce(
      new Error("Session revocation failed"),
    );

    await user.click(screen.getByTestId("logout"));

    expect(screen.queryByTestId("current-user")).not.toBeInTheDocument();
    expect(screen.getByTestId("auth-error")).toHaveTextContent("Session revocation failed");
    expect(screen.getByTestId("auth-error")).not.toHaveTextContent("token-body-secret");
    expect(sessionStorage.getItem("telecrypt-io-ui:session")).not.toBeNull();
    expect(storage.stopClient).toHaveBeenCalled();
  });

  it("revokes a callback token when tab session persistence fails", async () => {
    window.history.replaceState({}, "", "/?code=one&state=two");
    sessionStorage.setItem(
      session.OIDC_LOGIN_INTENT_STORAGE_KEY,
      JSON.stringify({ state: "two", createdAt: Date.now() }),
    );
    vi.mocked(oidcAuth.completeOidcLoginFromCallback).mockResolvedValue(SESSION);
    const saveSpy = vi.spyOn(session, "saveSessionIfCurrent").mockImplementation(() => {
      throw new Error("session storage write failed");
    });

    render(<App />);

    await waitFor(() =>
      expect(revocation.revokeMatrixSession).toHaveBeenCalledWith(
        expect.objectContaining({ homeserver: SESSION.homeserver, accessToken: SESSION.accessToken }),
        undefined,
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findByTestId("auth-error")).toHaveTextContent(
      "Session persistence failed",
    );
    expect(screen.getByTestId("auth-error")).toHaveTextContent("session storage write failed");
    expect(screen.getByTestId("oidc-login")).toBeInTheDocument();
    saveSpy.mockRestore();
    window.history.replaceState({}, "", "/");
  });

  it("connects the callback session and renders the authenticated identity", async () => {
    window.history.replaceState({}, "", "/?code=one&state=two");
    sessionStorage.setItem(
      session.OIDC_LOGIN_INTENT_STORAGE_KEY,
      JSON.stringify({ state: "two", createdAt: Date.now() }),
    );
    const storage = fakeStorage();
    vi.mocked(oidcAuth.completeOidcLoginFromCallback).mockResolvedValue(SESSION);
    vi.mocked(core.discoverOidcIssuer).mockResolvedValue({
      issuer: runtimeOidcIssuer(),
      token_endpoint: `${getRuntimeSettings().homeserver}/auth/token`,
    } as never);
    vi.mocked(core.TeleCryptIOStorage.createFromOidc).mockResolvedValue(storage as never);
    vi.mocked(core.listVaults).mockResolvedValue([]);

    render(<App />);

    expect(await screen.findByTestId("current-user")).toHaveTextContent(SESSION.userId);
    expect(await screen.findByTestId("no-vaults")).toBeInTheDocument();
    expect(oidcAuth.completeOidcLoginFromCallback).toHaveBeenCalledWith(expect.any(AbortSignal));
    window.history.replaceState({}, "", "/");
  });

  it("does not disrupt a saved session for a spurious callback without login intent", async () => {
    window.history.replaceState({}, "", "/?code=spurious&state=unknown");
    const { storage } = await loginAndReachVaults();

    expect(screen.getByTestId("current-user")).toHaveTextContent(SESSION.userId);
    expect(storage.stopClient).not.toHaveBeenCalled();
    expect(oidcAuth.completeOidcLoginFromCallback).not.toHaveBeenCalled();
    window.history.replaceState({}, "", "/");
  });

  it("stops a client that finishes after the connection timeout", async () => {
    vi.useFakeTimers();
    try {
      const storage = fakeStorage();
      const bootstrap = deferred<unknown>();
      vi.mocked(core.discoverOidcIssuer).mockResolvedValue({
        issuer: runtimeOidcIssuer(),
        token_endpoint: `${getRuntimeSettings().homeserver}/auth/token`,
      } as never);
      vi.mocked(core.TeleCryptIOStorage.createFromOidc).mockReturnValue(bootstrap.promise as never);
      sessionStorage.setItem("telecrypt-io-ui:session", JSON.stringify(SESSION));
      render(<App />);

      for (let i = 0; i < 8 && !vi.mocked(core.TeleCryptIOStorage.createFromOidc).mock.calls.length; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      expect(core.TeleCryptIOStorage.createFromOidc).toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(120_000);
        await Promise.resolve();
      });
      expect(screen.getByTestId("auth-error")).toHaveTextContent("Connection timed out after 120s");
      expect(vi.getTimerCount()).toBe(0);

      bootstrap.resolve(storage);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(storage.stopClient).toHaveBeenCalled();
      expect(screen.queryByTestId("current-user")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the client when the storage provider unmounts", async () => {
    const { storage, view } = await loginAndReachVaults();
    view.unmount();
    expect(storage.stopClient).toHaveBeenCalledTimes(1);
  });

  it("stops a client that finishes after the storage provider unmounts", async () => {
    const storage = fakeStorage();
    const bootstrap = deferred<unknown>();
    vi.mocked(core.discoverOidcIssuer).mockResolvedValue({
      issuer: runtimeOidcIssuer(),
      token_endpoint: `${getRuntimeSettings().homeserver}/auth/token`,
    } as never);
    vi.mocked(core.TeleCryptIOStorage.createFromOidc).mockReturnValue(bootstrap.promise as never);
    sessionStorage.setItem("telecrypt-io-ui:session", JSON.stringify(SESSION));
    const view = render(<App />);

    for (let i = 0; i < 8 && !vi.mocked(core.TeleCryptIOStorage.createFromOidc).mock.calls.length; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    expect(core.TeleCryptIOStorage.createFromOidc).toHaveBeenCalled();

    view.unmount();
    bootstrap.resolve(storage);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(storage.stopClient).toHaveBeenCalledTimes(1);
  });
});

describe("vaults", () => {
  it("creates a vault via core.createVault with untitled name and inline rename", async () => {
    await loginAndReachVaults();
    vi.mocked(core.listFiles).mockResolvedValue([]);
    vi.mocked(core.listSubfolders).mockResolvedValue([]);
    vi.mocked(core.listMembers).mockResolvedValue([]);
    vi.mocked(core.getVaultDetails).mockResolvedValue({
      name: "Untitled vault",
      id: "!new:localhost",
      createdAt: null,
      memberCount: 1,
    });
    vi.mocked(core.createVault).mockResolvedValue({ id: "!new:localhost", name: "Untitled vault" });
    vi.mocked(core.renameVault).mockResolvedValue({ id: "!new:localhost", name: "Docs" });
    vi.mocked(core.listVaults).mockResolvedValue([{ id: "!new:localhost", name: "Docs" }]);

    const user = userEvent.setup();
    await user.click(screen.getByTestId("create-vault"));

    expect(core.createVault).toHaveBeenCalledWith(
      expect.anything(),
      "Untitled vault",
      abortOptions(),
    );

    const renameInput = await screen.findByTestId("rename-vault-input");
    fireEvent.change(renameInput, { target: { value: "Docs" } });
    fireEvent.keyDown(renameInput, { key: "Enter" });
    await waitFor(() =>
      expect(core.renameVault).toHaveBeenCalledWith(
        expect.anything(),
        "!new:localhost",
        "Docs",
        abortOptions(),
      ),
    );
    expect(await screen.findByTestId("vault-detail")).toHaveAttribute("data-vault-id", "!new:localhost");
  });

  it("lists and selects a vault", async () => {
    vi.mocked(core.listFiles).mockResolvedValue([{ id: "$file1", name: "report.pdf" }]);
    await loginAndReachVaults([{ id: "!vault:localhost", name: "Docs" }]);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Docs" }));

    expect(core.listFiles).toHaveBeenCalledWith(expect.anything(), "!vault:localhost", abortOptions());
    expect(await screen.findByText("report.pdf")).toBeInTheDocument();
  });

  it("hides destructive vault controls from non-owners", async () => {
    vi.mocked(core.getVaultOwnership).mockReturnValue({ status: "not-owner" });
    await loginAndReachVaults([{ id: "!shared:localhost", name: "Shared" }]);

    const item = screen.getByTestId("vault-item");
    expect(item).not.toContainElement(screen.queryByTestId("rename-vault"));
    expect(item).not.toContainElement(screen.queryByTestId("delete-vault"));
  });

  it("hides access mutations from non-owners", async () => {
    vi.mocked(core.getVaultOwnership).mockReturnValue({ status: "not-owner" });
    await openVault("Shared", {
      members: [{ userId: "@bob:localhost", role: "viewer", membership: "join" }],
    });

    await waitFor(() => expect(screen.getByTestId("member-item")).toBeInTheDocument());
    expect(screen.getByTestId("members-readonly")).toHaveTextContent(
      "Only vault owners can manage access.",
    );
    expect(screen.queryByTestId("share-submit")).not.toBeInTheDocument();
    expect(screen.queryByTestId("unshare-member")).not.toBeInTheDocument();
  });

  it("rechecks ownership before an already-rendered access mutation", async () => {
    let role = "owner";
    vi.mocked(core.getVaultOwnership).mockImplementation(() =>
      role === "owner" ? { status: "owner" } : { status: "not-owner" },
    );
    const user = await openVault("Shared", {
      members: [{ userId: "@bob:localhost", role: "viewer", membership: "join" }],
    });
    await waitFor(() => expect(screen.getByTestId("member-item")).toBeInTheDocument());

    await user.type(screen.getByTestId("share-user-id"), "@carol:localhost");
    const shareSubmit = screen.getByTestId("share-submit");
    const unshareMember = screen.getByTestId("unshare-member");
    role = "viewer";
    await user.click(shareSubmit);
    await user.click(unshareMember);

    expect(core.shareVault).not.toHaveBeenCalled();
    expect(core.unshareVault).not.toHaveBeenCalled();
  });

  it("accepts a pending invite via core.joinVault", async () => {
    vi.mocked(core.listVaults).mockResolvedValue([]);
    vi.mocked(core.listPendingInvites).mockResolvedValue([
      { id: "!shared:localhost", name: "Shared" },
    ]);

    const { user } = await loginAndReachVaults();
    await screen.findByTestId("invite-list");
    await user.click(screen.getByTestId("accept-invite"));

    await waitFor(() =>
      expect(core.joinVault).toHaveBeenCalledWith(
        expect.anything(),
        "!shared:localhost",
        abortOptions(),
      ),
    );
  });

  it("declines a pending invite via core.declineInvite", async () => {
    vi.mocked(core.listVaults).mockResolvedValue([]);
    vi.mocked(core.listPendingInvites).mockResolvedValue([
      { id: "!shared:localhost", name: "Shared" },
    ]);

    const { user } = await loginAndReachVaults();
    await screen.findByTestId("invite-list");
    await user.click(screen.getByTestId("decline-invite"));

    await waitFor(() =>
      expect(core.declineInvite).toHaveBeenCalledWith(
        expect.anything(),
        "!shared:localhost",
        abortOptions(),
      ),
    );
  });

  it("nav up at vault root returns to vault list", async () => {
    const user = await openVault();
    await user.click(screen.getByTestId("nav-up"));
    expect(await screen.findByTestId("select-vault-prompt")).toBeInTheDocument();
  });

  it("keeps a later vault selected when an earlier vault deletion finishes", async () => {
    const deletion = deferred<{ id: string; deleted: boolean }>();
    vi.mocked(core.listFiles).mockResolvedValue([]);
    vi.mocked(core.listSubfolders).mockResolvedValue([]);
    vi.mocked(core.listMembers).mockResolvedValue([]);
    vi.mocked(core.listVaults).mockResolvedValue([
      { id: "!a:localhost", name: "A" },
      { id: "!b:localhost", name: "B" },
    ]);
    vi.mocked(core.deleteVault).mockReturnValue(deletion.promise);

    const { user } = await loginAndReachVaults([
      { id: "!a:localhost", name: "A" },
      { id: "!b:localhost", name: "B" },
    ]);
    await user.click(screen.getByRole("button", { name: "A" }));
    vi.stubGlobal("confirm", () => true);
    await user.click(screen.getAllByTestId("delete-vault")[0]);
    await user.click(screen.getByRole("button", { name: "B" }));
    expect(await screen.findByTestId("vault-detail")).toHaveAttribute("data-vault-id", "!b:localhost");

    deletion.resolve({ id: "!a:localhost", deleted: true });
    await waitFor(() =>
      expect(screen.getByTestId("vault-detail")).toHaveAttribute("data-vault-id", "!b:localhost"),
    );
    vi.unstubAllGlobals();
  });
});

describe("vault contents", () => {
  it("creates a subfolder via button + inline rename", async () => {
    const user = await openVault();
    vi.mocked(core.createSubfolder).mockResolvedValue({ id: "!sub:localhost", name: "Untitled folder" });
    vi.mocked(core.listSubfolders).mockResolvedValue([{ id: "!sub:localhost", name: "Child" }]);

    await user.click(screen.getByTestId("create-subfolder"));
    expect(core.createSubfolder).toHaveBeenCalledWith(
      expect.anything(),
      "!vault:localhost",
      "Untitled folder",
      abortOptions(),
    );

    const renameInput = await screen.findByTestId("rename-input");
    fireEvent.change(renameInput, { target: { value: "Child" } });
    fireEvent.keyDown(renameInput, { key: "Enter" });
    await waitFor(() =>
      expect(core.renameFolder).toHaveBeenCalledWith(
        expect.anything(),
        "!sub:localhost",
        "Child",
        abortOptions(),
      ),
    );
  });

  it("uploads a picked file via core.uploadFile", async () => {
    const user = await openVault();
    vi.mocked(core.uploadFile).mockResolvedValue({ id: "$new", name: "hello.txt" });
    vi.mocked(core.listFiles).mockResolvedValue([{ id: "$new", name: "hello.txt" }]);

    const file = new File(["hello world"], "hello.txt", { type: "text/plain" });
    const input = screen.getByTestId("file-input") as HTMLInputElement;
    await user.upload(input, file);

    await waitFor(() =>
      expect(core.uploadFile).toHaveBeenCalledWith(
        expect.anything(),
        "!vault:localhost",
        "hello.txt",
        expect.any(Uint8Array),
        "text/plain",
        abortOptions(),
      ),
    );
    expect(await screen.findByText("hello.txt")).toBeInTheDocument();
  });

  it("clears root contents while a nested folder is still loading", async () => {
    const childFiles = deferred<Array<{ id: string; name: string }>>();
    const childDetails = deferred<{
      name: string;
      id: string;
      createdAt: string | null;
      memberCount: number | null;
    }>();
    const user = await openVault("Docs", {
      files: [{ id: "$root", name: "root.txt" }],
      subfolders: [{ id: "!sub:localhost", name: "Child" }],
    });
    await screen.findByText("root.txt");
    await waitFor(() =>
      expect(screen.getByTestId("details-panel").querySelector(".details-list dd")).toHaveTextContent(
        "Docs",
      ),
    );

    vi.mocked(core.listFiles).mockImplementation(async (_, id) =>
      id === "!sub:localhost" ? childFiles.promise : [{ id: "$root", name: "root.txt" }],
    );
    vi.mocked(core.listSubfolders).mockImplementation(async (_, id) =>
      id === "!sub:localhost" ? [] : [{ id: "!sub:localhost", name: "Child" }],
    );
    vi.mocked(core.getFolderDetails).mockReturnValue(childDetails.promise);

    await user.click(screen.getByTestId("subfolder-item").querySelector(".row-name-btn")!);
    expect(screen.queryByText("root.txt")).not.toBeInTheDocument();
    expect(screen.getByTestId("vault-detail")).toHaveAttribute("data-folder-id", "!sub:localhost");
    expect(screen.getByTestId("details-panel").querySelector(".details-list dd")).toBeNull();

    childFiles.resolve([]);
    childDetails.resolve({
      name: "Child",
      id: "!sub:localhost",
      createdAt: null,
      memberCount: 1,
    });
    expect(await screen.findByTestId("no-files")).toBeInTheDocument();
    expect(screen.getByTestId("vault-detail")).toHaveAttribute("data-folder-id", "!sub:localhost");
    expect(screen.getByTestId("vault-detail")).not.toHaveAttribute("data-vault-id");
    expect(screen.queryByTestId("members-panel")).not.toBeInTheDocument();

    await user.click(screen.getAllByTestId("breadcrumb-item")[0]);
    await waitFor(() =>
      expect(screen.getByTestId("vault-detail")).toHaveAttribute("data-vault-id", "!vault:localhost"),
    );
    expect(screen.getByTestId("vault-detail")).not.toHaveAttribute("data-folder-id");
    expect(screen.getByTestId("members-panel")).toBeInTheDocument();
  });

  it("shows the complete backend error when upload fails with 413", async () => {
    const user = await openVault();
    vi.mocked(core.uploadFile).mockRejectedValue(new Error("HTTP 413 M_TOO_LARGE"));

    const file = new File(["x"], "big.bin", { type: "application/octet-stream" });
    await user.upload(screen.getByTestId("file-input"), file);

    expect(await screen.findByTestId("vault-detail-error")).toHaveTextContent(
      "HTTP 413 M_TOO_LARGE",
    );
  });

  it("downloads a file via core.downloadFile", async () => {
    vi.mocked(core.downloadFile).mockResolvedValue({
      bytes: new TextEncoder().encode("hello world"),
      mimetype: "text/plain",
      name: "hello.txt",
    });
    const user = await openVault("Docs", { files: [{ id: "$f1", name: "hello.txt" }] });
    await screen.findByText("hello.txt");

    await user.click(screen.getByTestId("download-file"));

    await waitFor(() =>
      expect(core.downloadFile).toHaveBeenCalledWith(
        expect.anything(),
        "!vault:localhost",
        "$f1",
        abortOptions(),
      ),
    );
  });

  it("renames and deletes a file", async () => {
    const user = await openVault("Docs", { files: [{ id: "$f1", name: "old.txt" }] });
    await screen.findByText("old.txt");

    await user.click(screen.getByTestId("rename-file"));
    const input = screen.getByTestId("rename-input");
    fireEvent.change(input, { target: { value: "new.txt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(core.renameFile).toHaveBeenCalledWith(
        expect.anything(),
        "!vault:localhost",
        "$f1",
        "new.txt",
        abortOptions(),
      ),
    );

    vi.stubGlobal("confirm", () => true);
    vi.mocked(core.listFiles).mockResolvedValue([]);
    await user.click(screen.getByTestId("delete-file"));
    await waitFor(() =>
      expect(core.deleteFile).toHaveBeenCalledWith(
        expect.anything(),
        "!vault:localhost",
        "$f1",
        abortOptions(),
      ),
    );
    vi.unstubAllGlobals();
  });

  it("renames and deletes a subfolder", async () => {
    const user = await openVault("Docs", { subfolders: [{ id: "!sub:localhost", name: "Child" }] });
    await waitFor(() => expect(screen.getByTestId("subfolder-item")).toHaveTextContent("Child"));

    await user.click(screen.getByTestId("rename-subfolder"));
    const input = screen.getByTestId("rename-input");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(core.renameFolder).toHaveBeenCalledWith(
        expect.anything(),
        "!sub:localhost",
        "Renamed",
        abortOptions(),
      ),
    );

    vi.stubGlobal("confirm", () => true);
    await user.click(screen.getByTestId("delete-subfolder"));
    await waitFor(() =>
      expect(core.deleteFolder).toHaveBeenCalledWith(
        expect.anything(),
        "!sub:localhost",
        abortOptions(),
      ),
    );
    vi.unstubAllGlobals();
  });

  it("shows the details panel when a vault is open", async () => {
    await openVault();
    expect(screen.getByTestId("details-panel")).toBeInTheDocument();
  });

  it("surfaces details-loading failures instead of rendering empty details", async () => {
    await openVault("Docs", { vaultDetailsError: new Error("details unavailable") });

    expect(await screen.findByTestId("details-error")).toHaveTextContent(
      "details unavailable",
    );
    expect(screen.getByTestId("details-panel").querySelector(".details-list")).toBeNull();
  });

  it("uses vault details at the root and folder details for a selected subfolder", async () => {
    vi.mocked(core.getVaultDetails).mockResolvedValue({
      name: "Docs",
      id: "!vault:localhost",
      createdAt: null,
      memberCount: 1,
    });
    vi.mocked(core.getFolderDetails).mockResolvedValue({
      name: "Child",
      id: "!sub:localhost",
      createdAt: null,
      memberCount: 1,
    });
    const user = await openVault("Docs", {
      subfolders: [{ id: "!sub:localhost", name: "Child" }],
    });

    await waitFor(() =>
      expect(core.getVaultDetails).toHaveBeenCalledWith(
        expect.anything(),
        "!vault:localhost",
        abortOptions(),
      ),
    );
    await user.click(screen.getByTestId("subfolder-item"));
    await waitFor(() =>
      expect(core.getFolderDetails).toHaveBeenCalledWith(
        expect.anything(),
        "!sub:localhost",
        abortOptions(),
      ),
    );
  });
});

describe("sharing", () => {
  it("ignores member responses from a previously selected vault", async () => {
    const membersA = deferred<Array<{ userId: string; role: string; membership: string }>>();
    const membersB = deferred<Array<{ userId: string; role: string; membership: string }>>();
    vi.mocked(core.listVaults).mockResolvedValue([
      { id: "!a:localhost", name: "A" },
      { id: "!b:localhost", name: "B" },
    ]);
    vi.mocked(core.listFiles).mockResolvedValue([]);
    vi.mocked(core.listSubfolders).mockResolvedValue([]);
    vi.mocked(core.getVaultDetails).mockResolvedValue({
      name: "Vault",
      id: "!vault:localhost",
      createdAt: null,
      memberCount: 1,
    });
    vi.mocked(core.listMembers).mockImplementation(async (_, id) =>
      id === "!a:localhost" ? membersA.promise : membersB.promise,
    );

    const { user } = await loginAndReachVaults([
      { id: "!a:localhost", name: "A" },
      { id: "!b:localhost", name: "B" },
    ]);
    await user.click(screen.getByRole("button", { name: "A" }));
    await screen.findByTestId("vault-detail");
    await user.click(screen.getByRole("button", { name: "B" }));
    membersA.resolve([{ userId: "@old:localhost", role: "viewer", membership: "join" }]);
    await waitFor(() => expect(screen.queryByTestId("member-item")).not.toBeInTheDocument());

    membersB.resolve([{ userId: "@new:localhost", role: "viewer", membership: "join" }]);
    await waitFor(() =>
      expect(screen.getByTestId("member-item")).toHaveAttribute("data-user-id", "@new:localhost"),
    );
  });

  it("ignores a stale share completion after returning to the same vault", async () => {
    const firstMembersA = deferred<Array<{ userId: string; role: string; membership: string }>>();
    const membersB = deferred<Array<{ userId: string; role: string; membership: string }>>();
    const secondMembersA = deferred<Array<{ userId: string; role: string; membership: string }>>();
    const share = deferred<{ vaultId: string; userId: string; role: "editor" }>();
    let callsA = 0;
    vi.mocked(core.listVaults).mockResolvedValue([
      { id: "!a:localhost", name: "A" },
      { id: "!b:localhost", name: "B" },
    ]);
    vi.mocked(core.listFiles).mockResolvedValue([]);
    vi.mocked(core.listSubfolders).mockResolvedValue([]);
    vi.mocked(core.getVaultDetails).mockResolvedValue({
      name: "Vault",
      id: "!vault:localhost",
      createdAt: null,
      memberCount: 1,
    });
    vi.mocked(core.listMembers).mockImplementation(async (_, id) => {
      if (id === "!a:localhost") {
        callsA += 1;
        return callsA === 1 ? firstMembersA.promise : secondMembersA.promise;
      }
      return membersB.promise;
    });
    vi.mocked(core.shareVault).mockReturnValue(share.promise);

    const { user } = await loginAndReachVaults([
      { id: "!a:localhost", name: "A" },
      { id: "!b:localhost", name: "B" },
    ]);
    await user.click(screen.getByRole("button", { name: "A" }));
    await screen.findByTestId("vault-detail");
    await user.type(screen.getByTestId("share-user-id"), "@old:localhost");
    const shareTask = user.click(screen.getByTestId("share-submit"));
    await waitFor(() => expect(core.shareVault).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "B" }));
    await user.click(screen.getByRole("button", { name: "A" }));
    const currentInput = await screen.findByTestId("share-user-id");
    await user.type(currentInput, "@new:localhost");

    share.resolve({ vaultId: "!a:localhost", userId: "@old:localhost", role: "editor" });
    await shareTask;
    await waitFor(() => expect(currentInput).toHaveValue("@new:localhost"));

    firstMembersA.resolve([]);
    membersB.resolve([]);
    secondMembersA.resolve([]);
  });

  it("invites a user via core.shareVault and shows them in the member list", async () => {
    const user = await openVault();
    await screen.findByTestId("no-files");

    vi.mocked(core.shareVault).mockResolvedValue({
      vaultId: "!vault:localhost",
      userId: "@bob:localhost",
      role: "editor",
    });
    vi.mocked(core.listMembers).mockResolvedValue([
      { userId: "@bob:localhost", role: "editor", membership: "invite" },
    ]);

    await user.type(screen.getByTestId("share-user-id"), "@bob:localhost");
    await user.click(screen.getByTestId("share-submit"));

    expect(core.shareVault).toHaveBeenCalledWith(
      expect.anything(),
      "!vault:localhost",
      "@bob:localhost",
      "editor",
      abortOptions(),
    );
    expect(await screen.findByTestId("member-item")).toHaveAttribute("data-user-id", "@bob:localhost");
  });

  it("removes a member via core.unshareVault", async () => {
    const user = await openVault("Docs", {
      members: [{ userId: "@bob:localhost", role: "viewer", membership: "join" }],
    });
    await waitFor(() => expect(screen.getByTestId("member-item")).toBeInTheDocument());

    vi.mocked(core.unshareVault).mockResolvedValue({
      vaultId: "!vault:localhost",
      userId: "@bob:localhost",
      removed: true,
    });
    vi.mocked(core.listMembers).mockResolvedValue([]);

    await user.click(screen.getByTestId("unshare-member"));

    expect(core.unshareVault).toHaveBeenCalledWith(
      expect.anything(),
      "!vault:localhost",
      "@bob:localhost",
      abortOptions(),
    );
  });
});

describe("recovery", () => {
  it("sets up recovery, requires confirm saved, then dismisses key display", async () => {
    const { storage } = await loginAndReachVaults();
    vi.mocked(storage.keys.isRecoverySetup).mockResolvedValue(false);
    vi.mocked(storage.keys.setupRecovery).mockResolvedValue({ recoveryKey: "EsTx 1234 5678" });

    const user = userEvent.setup();
    await user.click(screen.getByTestId("nav-recovery"));
    await user.click(await screen.findByTestId("setup-recovery"));

    expect(storage.keys.setupRecovery).toHaveBeenCalled();
    expect(await screen.findByTestId("recovery-key-value")).toHaveTextContent("EsTx 1234 5678");
    expect(screen.queryByTestId("restore-key-input")).not.toBeInTheDocument();

    expect(screen.getByTestId("recovery-setup-done")).toBeDisabled();
    await user.click(screen.getByTestId("confirm-saved-recovery-key"));
    await user.click(screen.getByTestId("recovery-setup-done"));

    await waitFor(() =>
      expect(screen.queryByTestId("recovery-key-display")).not.toBeInTheDocument(),
    );
    expect(await screen.findByTestId("recovery-active")).toBeInTheDocument();
  });

  it("restores from a pasted key when recovery is already configured", async () => {
    const { storage } = await loginAndReachVaults([], true);
    vi.mocked(storage.keys.restoreFromRecoveryKey).mockResolvedValue({ imported: 3, total: 3 });

    const user = userEvent.setup();
    await user.click(screen.getByTestId("nav-recovery"));
    expect(await screen.findByTestId("recovery-active")).toHaveTextContent(
      "Recovery is configured for this account.",
    );
    expect(screen.queryByTestId("setup-recovery")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /set up recovery/i })).not.toBeInTheDocument();
    await user.click(await screen.findByTestId("restore-expand"));
    await user.type(screen.getByTestId("restore-key-input"), "EsTx recovery key text");
    await user.click(screen.getByTestId("restore-submit"));

    expect(storage.keys.restoreFromRecoveryKey).toHaveBeenCalledWith(
      "EsTx recovery key text",
      expect.anything(),
    );
    expect(await screen.findByTestId("restore-result")).toHaveTextContent("Imported 3 of 3");
  });

  it("shows restore expandable when account recovery is not configured", async () => {
    const { storage } = await loginAndReachVaults();
    vi.mocked(storage.keys.isRecoverySetup).mockResolvedValue(false);

    const user = userEvent.setup();
    await user.click(screen.getByTestId("nav-recovery"));
    expect(await screen.findByTestId("recovery-not-setup")).toHaveTextContent(
      "Recovery is not configured on this account.",
    );
    expect(await screen.findByTestId("restore-expand")).toBeInTheDocument();
    expect(screen.queryByTestId("restore-key-input")).not.toBeInTheDocument();
  });
});

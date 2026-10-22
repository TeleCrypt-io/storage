import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeSettings } from "./buildConfig";
import { formatOperationError } from "./formatOperationError";
import { discoverOidcIssuer } from "./core";
import { clearPendingRevocation, loadPendingRevocations, savePendingRevocation, SESSION_STORAGE_KEY } from "./session";
import { revokeOrRemember, revokeOidcSession } from "./revokeSession";

const target = {
  homeserver: getRuntimeSettings().homeserver,
  accessToken: "access-token-secret",
  refreshToken: "refresh-token-secret",
  oidcClientId: "client-id",
};

const endpoint = `${target.homeserver}/oauth2/revoke`;
vi.mock("./core", async () => ({
  ...await vi.importActual<typeof import("./core")>("./core"),
  discoverOidcIssuer: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(discoverOidcIssuer).mockResolvedValue({
    issuer: `${target.homeserver}/`, revocation_endpoint: endpoint,
  } as never);
  clearPendingRevocation();
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("revokeOidcSession", () => {
  it("revokes the refresh grant at the validated OAuth endpoint", async () => {
    const response = new Response(null, { status: 200 });
    Object.defineProperty(response, "url", { value: endpoint });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);

    await revokeOidcSession(target, fetchMock);

    expect(fetchMock).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(Object.fromEntries(fetchMock.mock.calls[0][1]?.body as URLSearchParams)).toEqual({
      token: target.refreshToken, token_type_hint: "refresh_token", client_id: target.oidcClientId,
    });
  });

  it("retains a complete redacted HTTP failure body", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("token-body-secret\naccess_token=body-access-secret\nfull detail", { status: 503 }));

    let caught: unknown;
    try {
      await revokeOidcSession(target, fetchMock);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ reason: "failed" });
    const detail = formatOperationError(caught);
    expect(detail).toContain("HTTP 503");
    expect(detail).toContain("full detail");
    expect(detail).toContain("[REDACTED]");
    expect(detail).not.toContain("token-body-secret");
    expect(detail).not.toContain("body-access-secret");
  });

  it("does not accept a Matrix unknown-token error as OAuth revocation", async () => {
    const response = new Response(JSON.stringify({ errcode: "M_UNKNOWN_TOKEN", error: "unknown token" }), { status: 401 });
    Object.defineProperty(response, "url", { value: endpoint });
    const readBody = vi.spyOn(response, "text");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(revokeOidcSession(target, fetchMock)).rejects.toMatchObject({ reason: "failed" });
    expect(readBody).toHaveBeenCalledTimes(1);
  });

  it("rejects an arbitrary 401 while retaining its complete redacted body", async () => {
    const response = new Response(
      "not an unknown-token response\naccess_token=body-access-secret\nfull detail",
      { status: 401 },
    );
    Object.defineProperty(response, "url", { value: endpoint });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);

    let caught: unknown;
    try {
      await revokeOidcSession(target, fetchMock);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ reason: "failed" });
    const detail = formatOperationError(caught);
    expect(detail).toContain("HTTP 401");
    expect(detail).toContain("full detail");
    expect(detail).toContain("[REDACTED]");
    expect(detail).not.toContain("body-access-secret");
  });

  it("rejects a redirect instead of following it", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "https://other.example/logout" } }),
    );

    await expect(revokeOidcSession(target, fetchMock)).rejects.toMatchObject({ reason: "failed" });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("finishes confirmed logout without waiting for the unused response stream", async () => {
    const cancellation = deferred<void>();
    const response = new Response(new ReadableStream({
      cancel: () => cancellation.promise,
    }), { status: 200 });
    Object.defineProperty(response, "url", { value: endpoint });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(revokeOidcSession(target, fetchMock)).resolves.toBeUndefined();
    cancellation.reject(new Error("underlying stream disposal failed"));
  });

  it("preserves response-body read failures as a cause", async () => {
    const response = new Response(null, { status: 503 });
    Object.defineProperty(response, "url", { value: endpoint });
    const bodyError = new Error("response body stream failed");
    Object.defineProperty(response, "text", { value: vi.fn().mockRejectedValue(bodyError) });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);

    let caught: unknown;
    try {
      await revokeOidcSession(target, fetchMock);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ reason: "failed" });
    expect(formatOperationError(caught)).toContain("HTTP 503: response body could not be read");
    expect(formatOperationError(caught)).toContain("response body stream failed");
  });

  it("retains a redacted network failure as a cause", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("network token-body-secret"));

    let caught: unknown;
    try {
      await revokeOidcSession(target, fetchMock);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ reason: "failed" });
    expect(formatOperationError(caught)).toContain("network token-[REDACTED]");
    expect(formatOperationError(caught)).not.toContain("token-body-secret");
  });

  it("bounds a hung request and aborts it", async () => {
    vi.useFakeTimers();
    const pending = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(pending.promise);

    const result = revokeOidcSession(target, fetchMock);
    const assertion = expect(result).rejects.toMatchObject({ reason: "timed-out" });
    await vi.advanceTimersByTimeAsync(10_000);

    await assertion;
    expect(fetchMock.mock.calls[0][1]?.signal).toMatchObject({ aborted: true });
    pending.resolve(new Response(null, { status: 200 }));
  });

  it("rejects a session target that is not the configured homeserver", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    await expect(
      revokeOidcSession({ ...target, homeserver: "https://attacker.example.test/" }, fetchMock),
    ).rejects.toMatchObject({ reason: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["token\nwith-control", "token with-space", "token\u007fwith-delete"])(
    "rejects a token containing whitespace/control characters (%s)",
    async (accessToken) => {
      const fetchMock = vi.fn<typeof fetch>();
      await expect(revokeOidcSession({ ...target, accessToken }, fetchMock)).rejects.toMatchObject({
        reason: "failed",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it.each([
    { issuer: "https://untrusted.example/", revocation_endpoint: endpoint },
    { issuer: `${target.homeserver}/`, revocation_endpoint: "https://untrusted.example/revoke" },
    { issuer: `${target.homeserver}/`, revocation_endpoint: `${endpoint}?redirect=elsewhere` },
    { issuer: `${target.homeserver}/` },
  ])("rejects untrusted or missing discovery before sending credentials", async (metadata) => {
    vi.mocked(discoverOidcIssuer).mockResolvedValue(metadata as never);
    const fetchMock = vi.fn<typeof fetch>();
    await expect(revokeOidcSession(target, fetchMock)).rejects.toMatchObject({ reason: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not start requests after caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn<typeof fetch>();
    await expect(revokeOidcSession(target, fetchMock, controller.signal)).rejects.toMatchObject({ reason: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds a hung discovery and response-body read", async () => {
    vi.useFakeTimers();
    vi.mocked(discoverOidcIssuer).mockReturnValueOnce(new Promise(() => undefined));
    const discover = expect(revokeOidcSession(target)).rejects.toMatchObject({ reason: "timed-out" });
    await vi.advanceTimersByTimeAsync(10_000);
    await discover;
    const response = new Response(null, { status: 503 });
    Object.defineProperty(response, "url", { value: endpoint });
    vi.spyOn(response, "text").mockReturnValue(new Promise(() => undefined));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
    const read = expect(revokeOidcSession(target, fetchMock)).rejects.toMatchObject({ reason: "timed-out" });
    await vi.advanceTimersByTimeAsync(10_000);
    await read;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("persists the refresh grant after an outage and clears it after retry succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await revokeOrRemember(target)).toBeInstanceOf(Error);
    expect(loadPendingRevocations()).toEqual([target]);
    const response = new Response(null, { status: 200 });
    Object.defineProperty(response, "url", { value: endpoint });
    vi.mocked(fetch).mockResolvedValue(response);
    await expect(revokeOrRemember(loadPendingRevocations()[0])).resolves.toBeNull();
    expect(loadPendingRevocations()).toEqual([]);
    expect(Object.fromEntries(vi.mocked(fetch).mock.calls[1][1]?.body as URLSearchParams)).toEqual({
      token: target.refreshToken, token_type_hint: "refresh_token", client_id: target.oidcClientId,
    });
  });

  it("recovers legacy cleanup credentials only from the exact matching persisted session", async () => {
    const pending = { homeserver: target.homeserver, accessToken: target.accessToken };
    savePendingRevocation(pending);
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
      ...target, userId: "@alice:localhost:8008", deviceId: "DEVICE1",
    }));
    const response = new Response(null, { status: 200 });
    Object.defineProperty(response, "url", { value: endpoint });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));
    await expect(revokeOrRemember(loadPendingRevocations()[0])).resolves.toBeNull();
    expect(Object.fromEntries(vi.mocked(fetch).mock.calls[0][1]?.body as URLSearchParams)).toEqual({
      token: target.refreshToken, token_type_hint: "refresh_token", client_id: target.oidcClientId,
    });
    expect(loadPendingRevocations()).toEqual([]);
  });

  it("retains legacy credentials and explains missing client identity instead of claiming revocation", async () => {
    const pending = { homeserver: target.homeserver, accessToken: target.accessToken };
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
      ...target, accessToken: "unrelated", userId: "@alice:localhost:8008", deviceId: "DEVICE1",
    }));
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const failure = await revokeOrRemember(pending);
    expect(formatOperationError(failure)).toContain("original OAuth client ID is unavailable");
    expect(loadPendingRevocations()).toEqual([pending]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

});

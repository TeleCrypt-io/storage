import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeSettings } from "./buildConfig";
import { formatOperationError } from "./formatOperationError";
import { revokeMatrixSession } from "./revokeSession";

const target = {
  homeserver: getRuntimeSettings().homeserver,
  accessToken: "access-token-secret",
};

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
});

afterEach(() => {
  vi.useRealTimers();
});

describe("revokeMatrixSession", () => {
  it("uses the same-homeserver logout endpoint without a request body", async () => {
    const response = new Response(null, { status: 204 });
    Object.defineProperty(response, "url", { value: `${target.homeserver}/_matrix/client/v3/logout` });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);

    await revokeMatrixSession(target, fetchMock);

    expect(fetchMock).toHaveBeenCalledWith(
      `${target.homeserver}/_matrix/client/v3/logout`,
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        redirect: "manual",
        headers: { Authorization: `Bearer ${target.accessToken}` },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("body");
  });

  it("retains a complete redacted HTTP failure body", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("token-body-secret\naccess_token=body-access-secret\nfull detail", { status: 503 }));

    let caught: unknown;
    try {
      await revokeMatrixSession(target, fetchMock);
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

  it("accepts an already-invalid token as confirmed cleanup", async () => {
    const endpoint = `${target.homeserver}/_matrix/client/v3/logout`;
    const response = new Response(JSON.stringify({ errcode: "M_UNKNOWN_TOKEN", error: "unknown token" }), { status: 401 });
    Object.defineProperty(response, "url", { value: endpoint });
    const readBody = vi.spyOn(response, "text");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(revokeMatrixSession(target, fetchMock)).resolves.toBeUndefined();
    expect(readBody).toHaveBeenCalledTimes(1);
  });

  it("rejects an arbitrary 401 while retaining its complete redacted body", async () => {
    const endpoint = `${target.homeserver}/_matrix/client/v3/logout`;
    const response = new Response(
      "not an unknown-token response\naccess_token=body-access-secret\nfull detail",
      { status: 401 },
    );
    Object.defineProperty(response, "url", { value: endpoint });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);

    let caught: unknown;
    try {
      await revokeMatrixSession(target, fetchMock);
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

    await expect(revokeMatrixSession(target, fetchMock)).rejects.toMatchObject({ reason: "failed" });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("bounds successful response cleanup", async () => {
    vi.useFakeTimers();
    const endpoint = `${target.homeserver}/_matrix/client/v3/logout`;
    const response = new Response(null, { status: 204 });
    Object.defineProperty(response, "url", { value: endpoint });
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    Object.defineProperty(response, "body", { value: { cancel } });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
    const result = revokeMatrixSession(target, fetchMock);
    const assertion = expect(result).rejects.toMatchObject({ reason: "failed" });
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("propagates successful-response cleanup failures", async () => {
    const endpoint = `${target.homeserver}/_matrix/client/v3/logout`;
    const response = new Response(null, { status: 204 });
    Object.defineProperty(response, "url", { value: endpoint });
    Object.defineProperty(response, "body", {
      value: { cancel: vi.fn().mockRejectedValue(new Error("response cleanup failed")) },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);

    let caught: unknown;
    try {
      await revokeMatrixSession(target, fetchMock);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ reason: "failed" });
    expect(formatOperationError(caught)).toContain("response cleanup failed");
  });

  it("preserves response-body read failures as a cause", async () => {
    const endpoint = `${target.homeserver}/_matrix/client/v3/logout`;
    const response = new Response(null, { status: 503 });
    Object.defineProperty(response, "url", { value: endpoint });
    const bodyError = new Error("response body stream failed");
    Object.defineProperty(response, "text", { value: vi.fn().mockRejectedValue(bodyError) });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);

    let caught: unknown;
    try {
      await revokeMatrixSession(target, fetchMock);
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
      await revokeMatrixSession(target, fetchMock);
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

    const result = revokeMatrixSession(target, fetchMock);
    const assertion = expect(result).rejects.toMatchObject({ reason: "timed-out" });
    await vi.advanceTimersByTimeAsync(10_000);

    await assertion;
    expect(fetchMock.mock.calls[0][1]?.signal).toMatchObject({ aborted: true });
    pending.resolve(new Response(null, { status: 204 }));
  });

  it("rejects a session target that is not the configured homeserver", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    await expect(
      revokeMatrixSession({ ...target, homeserver: "https://attacker.example.test/" }, fetchMock),
    ).rejects.toMatchObject({ reason: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized token before sending an authorization header", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    await expect(
      revokeMatrixSession({ ...target, accessToken: "x".repeat(8193) }, fetchMock),
    ).rejects.toMatchObject({ reason: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["token\nwith-control", "token with-space", "token\u007fwith-delete"])(
    "rejects a token containing whitespace/control characters (%s)",
    async (accessToken) => {
      const fetchMock = vi.fn<typeof fetch>();
      await expect(revokeMatrixSession({ ...target, accessToken }, fetchMock)).rejects.toMatchObject({
        reason: "failed",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTokenRefreshFunction, StorageError } from "@telecrypt-io/storage/core";
import { runAction, safeErrorMessage, safeOutputField } from "../src/output.js";
import { sanitizeOutput } from "./harness/cli.js";

const TOKEN_ENDPOINT = "https://issuer.example.test/oauth2/token";

function responseAtEndpoint(body: BodyInit | null, init: ResponseInit): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { configurable: true, value: TOKEN_ENDPOINT });
  return response;
}

async function captureRefreshFailure(json: boolean, response: Response): Promise<{
  error: unknown;
  exitCode: number | undefined;
  stderr: string;
  stdout: string;
  fetchMock: ReturnType<typeof vi.fn>;
  persist: ReturnType<typeof vi.fn>;
}> {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  const stderr: string[] = [];
  const stdout: string[] = [];
  const captureWrite = (chunks: string[]) => ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    (typeof encodingOrCallback === "function" ? encodingOrCallback : callback)?.();
    return true;
  }) as never;
  vi.spyOn(process.stderr, "write").mockImplementation(captureWrite(stderr));
  vi.spyOn(process.stdout, "write").mockImplementation(captureWrite(stdout));

  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  const persist = vi.fn().mockResolvedValue(undefined);
  const refresh = buildTokenRefreshFunction(
    { issuer: "https://issuer.example.test/", token_endpoint: TOKEN_ENDPOINT },
    "cli-client",
    persist,
    "DEVICE123",
  );
  const command = new Command();
  command.option("--json");
  command.setOptionValue("json", json);

  let error: unknown;
  try {
    await runAction(command, async () => {
      try {
        await refresh("refresh-token-secret");
      } catch (failure) {
        error = failure;
        throw failure;
      }
      return { json: {}, text: "unexpected refresh success" };
    });
    return {
      error,
      exitCode: process.exitCode,
      stderr: stderr.join(""),
      stdout: stdout.join(""),
      fetchMock,
      persist,
    };
  } finally {
    process.exitCode = previousExitCode;
  }
}

describe("CLI diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("escapes controls in human-output fields", () => {
    expect(safeOutputField("name\nnext\tvalue\u0000\u0085\u2028")).toBe(
      "name\\x0anext\\x09value\\x00\\x85\\x2028",
    );
  });
  it("keeps diagnostics on one physical line", () => {
    expect(safeErrorMessage("first\u0085second\u2028third\u2029fourth")).toBe("first second third fourth");
  });
  it("keeps structured CLI error output parseable while redacting secret fields", () => {
    const expected = {
      error: 'MutationPartialError: backup failed after "room" was created',
      client_secret: "must not escape",
    };
    const sanitized = sanitizeOutput(`diagnostic before JSON\n${JSON.stringify(expected)}\n`);
    const line = sanitized.trimEnd().split("\n").at(-1);

    expect(line).toBeTruthy();
    expect(JSON.parse(line!)).toEqual({ ...expected, client_secret: "<redacted>" });
  });
  it("retains both operation and cleanup failures in one sanitized diagnostic", () => {
    const message = safeErrorMessage(
      new AggregateError(
        [
          new Error("upload failed\naccess_token=operation-secret"),
          new AggregateError([
            new Error("snapshot failed\trefresh_token=cleanup-secret"),
            new Error("lock failed"),
          ]),
        ],
        "storage operation and cleanup failed",
      ),
    );

    expect(message).toContain("storage operation and cleanup failed");
    expect(message).toContain("upload failed");
    expect(message).toContain("snapshot failed");
    expect(message).not.toContain("operation-secret");
    expect(message).not.toContain("cleanup-secret");
    expect(message).not.toMatch(/[\r\n\t]/u);
  });
  it("retains error names, stacks, causes, and aggregate children", () => {
    const cause = new Error("transport failure");
    cause.name = "TransportError";
    cause.stack = "TransportError: transport failure\n    at transport";
    const failure = new Error("operation failure", { cause });
    failure.name = "OperationError";
    failure.stack = "OperationError: operation failure\n    at operation";
    const message = safeErrorMessage(
      new AggregateError([failure, new Error("cleanup failure")], "operation and cleanup failed"),
    );

    expect(message).toContain("AggregateError: operation and cleanup failed");
    expect(message).toContain("OperationError: operation failure");
    expect(message).toContain("cause: TransportError: transport failure");
    expect(message).toContain("stack: OperationError: operation failure");
    expect(message).toContain("aggregate child 1: Error: cleanup failure");
  });
  it("redacts JSON-style token, credential, and identifier fields", () => {
    const message = safeErrorMessage(
      '{"access_token":"access-secret","refresh_token":"refresh-secret","client_id":"client-secret","user_id":"@alice:example.test","device_id":"DEVICE-SECRET","password":"password-secret"} Bearer bearer-secret token=plain-secret',
    );

    expect(message).not.toContain("access-secret");
    expect(message).not.toContain("refresh-secret");
    expect(message).not.toContain("client-secret");
    expect(message).not.toContain("@alice:example.test");
    expect(message).not.toContain("DEVICE-SECRET");
    expect(message).not.toContain("password-secret");
    expect(message).not.toContain("bearer-secret");
    expect(message).not.toContain("plain-secret");
    expect(message).toContain("<redacted>");
  });

  it("redacts camel-case and escaped JSON-quoted secret fields", () => {
    const message = safeErrorMessage(
      '{"accessToken":"access-secret","refreshToken":"refresh-secret","clientId":"client-secret","deviceId":"device-secret","authorizationCode":"auth-secret","apiKey":"api-secret"}',
    );
    expect(message).not.toMatch(/access-secret|refresh-secret|client-secret|device-secret|auth-secret|api-secret/u);
    expect(message.match(/<redacted>/gu)?.length).toBe(6);
  });

  it("redacts client secrets and generic token fields in structured errors", () => {
    const message = safeErrorMessage('{"client_secret":"client-secret","token":"bearer-secret","private_key":"private-secret"}');
    const escaped = safeErrorMessage(String.raw`{\"client_secret\":\"escaped-secret\"}`);

    expect(message).not.toMatch(/client-secret|bearer-secret|private-secret/u);
    expect(message.match(/<redacted>/gu)?.length).toBe(3);
    expect(escaped).not.toContain("escaped-secret");
  });

  it.each([
    ["human", false],
    ["JSON", true],
  ] as const)("formats a real SDK refresh provider error in %s mode", async (_mode, json) => {
    const body = String.raw`{"error":"temporarily_unavailable","error_description":"try again\nsoon\u0001please","trace_id":"trace-safe-123","access_token":"plain-access-secret","client_id":"plain-client-secret","nested":{"refresh_token":"nested-refresh-secret","items":[{"user_id":"@private:example.test"},{"\u0061ccess_token":"escaped-access-secret"},{"\u0063lient_secret":"escaped-client-secret"},{"device_id":"nested-device-secret"}]}}`;
    const result = await captureRefreshFailure(
      json,
      responseAtEndpoint(body, { status: 503, headers: { "content-type": "application/json" } }),
    );

    expect(result.error).toBeInstanceOf(StorageError);
    expect(result.error).toMatchObject({
      name: "StorageError",
      message: "OIDC token refresh failed (503): OAuth error temporarily_unavailable",
      cause: { name: "OidcResponseError", status: 503 },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.fetchMock).toHaveBeenCalledWith(TOKEN_ENDPOINT, expect.objectContaining({
      method: "POST",
      redirect: "manual",
      body: expect.any(String),
    }));
    expect(result.persist).not.toHaveBeenCalled();

    const line = result.stderr.trimEnd();
    expect(line).not.toMatch(/[\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
    for (const secret of [
      "plain-access-secret",
      "plain-client-secret",
      "nested-refresh-secret",
      "@private:example.test",
      "escaped-access-secret",
      "escaped-client-secret",
      "nested-device-secret",
      "refresh-token-secret",
    ]) {
      expect(line).not.toContain(secret);
    }
    expect(line).toContain("503");
    expect(line).toContain("temporarily_unavailable");
    expect(line).toContain("trace-safe-123");
    expect(line).toContain("try again soon please");
    expect(line).toContain("<redacted>");

    if (json) {
      expect(line.startsWith("{")).toBe(true);
      const machineError: unknown = JSON.parse(line);
      expect(machineError).toEqual({ error: expect.any(String) });
      expect((machineError as { error: string }).error).toContain("OIDC token refresh failed (503)");
    } else {
      expect(line).toContain("Error: StorageError: OIDC token refresh failed (503)");
      expect(line).toContain("cause: OidcResponseError: OIDC token refresh provider response (503)");
    }
  });

  it.each([
    ["malformed", "upstream failure access_token=malformed-secret\nretry later"],
    ["partial", "{\"error\":\"temporarily_unavailable\",\"diagnostic\":\"partial-body-marker-safe\",\"access_token\":\"partial-secret\""],
  ] as const)("keeps %s SDK refresh response failures machine-readable", async (kind, text) => {
    let partialChunkSent = false;
    const body = kind === "partial"
      ? new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!partialChunkSent) {
              partialChunkSent = true;
              controller.enqueue(new TextEncoder().encode(text));
              return;
            }
            controller.error(new Error("provider stream closed"));
          },
        })
      : text;
    const result = await captureRefreshFailure(
      true,
      responseAtEndpoint(body, {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    const line = result.stderr.trimEnd();
    const machineError: unknown = JSON.parse(line);

    expect(result.error).toBeInstanceOf(StorageError);
    expect(machineError).toEqual({ error: expect.any(String) });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(line).not.toContain(kind === "partial" ? "partial-secret" : "malformed-secret");
    expect(line).not.toMatch(/[\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
    expect((machineError as { error: string }).error).toContain("OIDC token refresh");
    if (kind === "partial") {
      expect((machineError as { error: string }).error).toContain("partial-body-marker-safe");
    }
    expect(result.persist).not.toHaveBeenCalled();
  });
});

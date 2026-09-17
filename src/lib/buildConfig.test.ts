import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeSettings, loadRuntimeSettings, runtimeOidcIssuer } from "./buildConfig";

function setOrigin(origin: string): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { origin },
  });
}

beforeEach(() => {
  setOrigin("http://localhost:5173");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("page-bound environment", () => {
  it("uses the disposable loopback fixture during development", async () => {
    await expect(loadRuntimeSettings()).resolves.toEqual({
      homeserver: "http://localhost:8008",
      serverName: "localhost:8008",
    });
    expect(getRuntimeSettings()).toEqual({ homeserver: "http://localhost:8008", serverName: "localhost:8008" });
  });

  it("loads a deployment identity from same-origin config without a build-time environment", async () => {
    vi.stubEnv("DEV", false);
    setOrigin("https://storage.example.test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ serverName: "example.test" }))));

    await expect(loadRuntimeSettings()).resolves.toEqual({
      homeserver: "https://backend.example.test",
      serverName: "example.test",
    });
    expect(runtimeOidcIssuer()).toBe("https://backend.example.test/");
  });

  it("rejects config from a different page origin", async () => {
    vi.stubEnv("DEV", false);
    setOrigin("https://storage.example.test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ serverName: "other.test" }))));
    await expect(loadRuntimeSettings()).rejects.toThrow(/does not match deployment config/u);
  });
});

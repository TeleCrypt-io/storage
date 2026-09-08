import { beforeEach, describe, expect, it } from "vitest";
import { getRuntimeSettings, runtimeOidcIssuer } from "./buildConfig";

function setOrigin(origin: string): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { origin },
  });
}

beforeEach(() => {
  setOrigin("https://storage.telecrypt.io");
});

describe("page-bound environment", () => {
  it("maps production storage hosting to the production backend", async () => {
    expect(getRuntimeSettings()).toEqual({ homeserver: "https://backend.telecrypt.io", serverName: "telecrypt.io" });
  });

  it("maps stage hosting to the matching backend", async () => {
    setOrigin("https://storage.stage.telecrypt.io");
    expect(getRuntimeSettings()).toEqual({
      homeserver: "https://backend.stage.telecrypt.io",
      serverName: "stage.telecrypt.io",
    });
  });

  it("allows only explicit loopback development", async () => {
    setOrigin("http://localhost:5173");
    expect(getRuntimeSettings()).toEqual({ homeserver: "http://localhost:8008", serverName: "localhost" });

    setOrigin("http://127.0.0.1:5173");
    expect(getRuntimeSettings()).toEqual({ homeserver: "http://localhost:8008", serverName: "localhost" });

    setOrigin("http://[::1]:5173");
    expect(getRuntimeSettings()).toEqual({ homeserver: "http://localhost:8008", serverName: "localhost" });
  });

  it.each([
    "https://evil.telecrypt.io",
    "https://storage.preview.telecrypt.io",
    "https://storage.test.telecrypt.io",
    "https://storage.a.telecrypt.io",
    "https://storage.region.extra.telecrypt.io",
    "https://storage--stage.telecrypt.io",
    "https://storage-stage.telecrypt.io",
    "http://storage.telecrypt.io",
    "https://storage.telecrypt.io:8443",
    "https://storage.telecrypt.io:443",
    "http://user@localhost:5173",
  ])("rejects an unapproved page origin: %s", async (origin) => {
    setOrigin(origin);
    expect(() => getRuntimeSettings()).toThrow();
  });
});

describe("runtimeOidcIssuer", () => {
  it("derives the canonical MAS path from the page-bound backend", async () => {
    expect(runtimeOidcIssuer()).toBe("https://backend.telecrypt.io/auth/");
  });
});

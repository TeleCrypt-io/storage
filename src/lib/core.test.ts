import { describe, expect, it } from "vitest";
import { getVaultOwnership } from "./core";

describe("ownership boundary", () => {
  it("preserves an ownership-read failure as unknown", () => {
    const failure = new Error("permissions unavailable");
    const storage = {
      getClient: () => ({ getUserId: () => "@alice:localhost" }),
      getTree: () => ({ getPermissions: () => { throw failure; } }),
    };

    expect(getVaultOwnership(storage as never, "!vault:localhost")).toEqual({
      status: "unknown",
      error: failure,
    });
  });

  it("distinguishes a known non-owner from unavailable storage", () => {
    const storage = {
      getClient: () => ({ getUserId: () => "@alice:localhost" }),
      getTree: () => ({ getPermissions: () => "viewer" }),
    };

    expect(getVaultOwnership(storage as never, "!vault:localhost")).toEqual({ status: "not-owner" });
    expect(getVaultOwnership(null, "!vault:localhost").status).toBe("unknown");
  });
});

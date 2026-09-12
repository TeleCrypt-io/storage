import { describe, expect, it } from "vitest";
import { classifyOidcCallback } from "./oidcCallback";

function location(search = "", hash = "") {
  return { search, hash };
}

describe("OIDC callback classification", () => {
  it("accepts a code/state success response", () => {
    expect(classifyOidcCallback(location("?code=code&state=state"))).toBe("success");
    expect(classifyOidcCallback(location("?code=code&state=state&iss=https%3A%2F%2Fissuer"))).toBe(
      "success",
    );
  });

  it("accepts an exact provider error with state", () => {
    expect(classifyOidcCallback(location("?error=access_denied&state=state"))).toBe("error");
  });

  it("ignores unrecognized response parameters", () => {
    expect(classifyOidcCallback(location("?unexpected=value"))).toBe("none");
    expect(classifyOidcCallback(location("?code=code&state=state&unexpected=value"))).toBe("success");
  });

  it("marks spurious or malformed OIDC-looking parameters for scrubbing only", () => {
    expect(classifyOidcCallback(location("?iss=issuer"))).toBe("malformed");
    expect(classifyOidcCallback(location("?code=code"))).toBe("malformed");
    expect(classifyOidcCallback(location("?code=one&code=two&state=state"))).toBe("malformed");
    expect(classifyOidcCallback(location("?code=one&state=state", "#code=two"))).toBe("malformed");
    expect(classifyOidcCallback(location("?error=access_denied&error_description=a&error_description=b&state=state"))).toBe(
      "malformed",
    );
    expect(classifyOidcCallback(location("?code=one&state=state&error_description=unexpected"))).toBe(
      "malformed",
    );
  });
});

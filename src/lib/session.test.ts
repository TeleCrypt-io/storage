import { beforeEach, describe, expect, it } from "vitest";
import { formatOperationError } from "./formatOperationError";
import {
  PENDING_REVOCATION_STORAGE_KEY,
  SESSION_CLEANUP_PERSISTENCE_ERROR,
  SESSION_STORAGE_KEY,
  clearPendingRevocation,
  clearSession,
  loadOidcLoginIntent,
  loadPendingRevocations,
  loadSession,
  savePendingRevocation,
  saveSessionIfCurrent,
  isRuntimeMatrixDeviceId,
  isRuntimeMatrixUserId,
  type Session,
} from "./session";

const SESSION: Session = {
  homeserver: "http://localhost:8008",
  userId: "@alice:localhost:8008",
  deviceId: "DEVICE1",
  accessToken: "access-a",
  refreshToken: "refresh-a",
  oidcClientId: "client-a",
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  clearPendingRevocation();
});

describe("tab-scoped session persistence", () => {
  it("stores and reloads the session from sessionStorage only", () => {
    expect(saveSessionIfCurrent(SESSION, null)).toBe(true);
    expect(JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY)!)).toEqual(SESSION);
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(loadSession()).toEqual(SESSION);
  });

  it("rejects a saved session without a device identity before connecting", () => {
    const incomplete = { ...SESSION } as Record<string, unknown>;
    delete incomplete.deviceId;
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(incomplete));

    expect(() => loadSession()).toThrow("Stored session is invalid");
    expect(sessionStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it("preserves malformed stored session parse failures", () => {
    sessionStorage.setItem(SESSION_STORAGE_KEY, "{");

    let caught: unknown;
    try {
      loadSession();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SyntaxError);
    expect(sessionStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it("preserves invalid-session and cleanup failures together", () => {
    const original = window.sessionStorage;
    const broken = {
      length: 0,
      setItem: () => undefined,
      getItem: (key: string) => (key === SESSION_STORAGE_KEY ? "{" : null),
      removeItem: (key: string) => {
        if (key === SESSION_STORAGE_KEY) throw new Error("invalid session cleanup failed");
      },
      key: () => null,
    } as unknown as Storage;
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: broken });
    try {
      let caught: unknown;
      try {
        loadSession();
      } catch (error) {
        caught = error;
      }
      const detail = formatOperationError(caught);
      expect(detail).toContain("invalid session cleanup failed");
      expect(detail).toContain("SyntaxError");
    } finally {
      Object.defineProperty(window, "sessionStorage", { configurable: true, value: original });
    }
  });

  it("fails closed when sessionStorage cannot be written", () => {
    const original = window.sessionStorage;
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get: () => {
        throw new Error("blocked");
      },
    });
    try {
      expect(() => saveSessionIfCurrent(SESSION, null)).toThrow("Session persistence failed");
      expect(() => loadSession()).toThrow("Browser session storage is unavailable");
    } finally {
      Object.defineProperty(window, "sessionStorage", {
        configurable: true,
        value: original,
      });
    }
  });

  it("reports an unwriteable pending-revocation record without exposing its token", () => {
    const original = window.sessionStorage;
    const blocked = {
      get length() {
        return 0;
      },
      clear: () => undefined,
      getItem: () => null,
      key: () => null,
      removeItem: () => undefined,
      setItem: () => {
        throw new Error("provider token should not escape");
      },
    } as unknown as Storage;
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: blocked,
    });
    try {
      let caught: unknown;
      try {
        savePendingRevocation({
          homeserver: SESSION.homeserver,
          accessToken: "secret-token",
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const detail = formatOperationError(caught);
      expect(detail).toContain("provider token should not escape");
      expect(detail).not.toContain("secret-token");
    } finally {
      Object.defineProperty(window, "sessionStorage", {
        configurable: true,
        value: original,
      });
    }
  });

  it("retains a volatile same-tab cleanup retry when storage becomes unavailable", () => {
    const original = window.sessionStorage;
    const blocked = {
      get length() {
        return 0;
      },
      getItem: () => null,
      key: () => null,
      removeItem: () => undefined,
      setItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: blocked });
    expect(() =>
      savePendingRevocation({ homeserver: SESSION.homeserver, accessToken: "volatile-token" }),
    ).toThrow("Session cleanup could not be persisted");
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: original });
    expect(loadPendingRevocations()).toEqual([{
      homeserver: SESSION.homeserver,
      accessToken: "volatile-token",
    }]);
    clearPendingRevocation();
    expect(loadPendingRevocations()).toEqual([]);
  });

  it("retains the volatile cleanup token when persistent removal is denied", () => {
    const pending = { homeserver: SESSION.homeserver, accessToken: "volatile-retry" };
    expect(savePendingRevocation(pending)).toBe(true);
    const original = window.sessionStorage;
    const blocked = {
      get length() {
        return 0;
      },
      getItem: () => pending.accessToken,
      key: () => null,
      removeItem: () => {
        throw new Error("blocked");
      },
      setItem: () => undefined,
    } as unknown as Storage;
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: blocked });
    try {
      expect(() => clearPendingRevocation()).toThrow("Session cleanup could not be persisted");
    } finally {
      Object.defineProperty(window, "sessionStorage", { configurable: true, value: original });
    }
    expect(loadPendingRevocations()).toEqual([pending]);
  });

  it("rejects whitespace and non-canonical Matrix identities", () => {
    for (const invalid of [
      { ...SESSION, userId: "@alice smith:localhost" },
      { ...SESSION, userId: "alice:localhost" },
      { ...SESSION, userId: "@alice:other.example" },
      { ...SESSION, deviceId: "DEVICE 1" },
      { ...SESSION, accessToken: "token\nwith-control" },
    ]) {
      expect(saveSessionIfCurrent(invalid, null)).toBe(false);
      expect(loadSession()).toBeNull();
    }
  });

  it("accepts canonical Matrix plus localparts while binding the server", () => {
    const withPlus = { ...SESSION, userId: "@alice+device:localhost:8008" };
    expect(saveSessionIfCurrent(withPlus, null)).toBe(true);
    expect(loadSession()?.userId).toBe("@alice+device:localhost:8008");
  });

  it("matches the SDK Matrix identifier grammar", () => {
    expect(isRuntimeMatrixUserId("@Alice+device/1:LOCALHOST:8008")).toBe(true);
    expect(isRuntimeMatrixDeviceId("DEVICE~1")).toBe(true);
    expect(isRuntimeMatrixDeviceId("DEVICE=1")).toBe(false);
  });

  it("propagates runtime configuration failures instead of treating them as invalid identities", () => {
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { origin: "https://unknown.example" },
    });
    try {
      expect(() => isRuntimeMatrixUserId("@alice:localhost")).toThrow(
        "Storage page host is not an allowed TeleCrypt environment",
      );
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original });
    }
  });

  it("clears only this tab's session", () => {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(SESSION));
    sessionStorage.setItem("mx_oidc_state", "transient-state");
    sessionStorage.setItem("telecrypt:oauth2:pkce:v1:state", "transient-state");
    sessionStorage.setItem("telecrypt-io-ui:device:https://backend.telecrypt.io/", "DEVICE1");
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(SESSION));
    localStorage.setItem(
      "telecrypt-io-ui:oidc-client:https://backend.telecrypt.io/",
      "client-a",
    );
    clearSession();
    expect(sessionStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem("mx_oidc_state")).toBeNull();
    expect(sessionStorage.getItem("telecrypt:oauth2:pkce:v1:state")).toBeNull();
    expect(sessionStorage.getItem("telecrypt-io-ui:device:https://backend.telecrypt.io/")).toBe(
      "DEVICE1",
    );
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toEqual(JSON.stringify(SESSION));
    expect(
      localStorage.getItem("telecrypt-io-ui:oidc-client:https://backend.telecrypt.io/"),
    ).toBe("client-a");
  });

  it("returns null only when the login intent is absent", () => {
    expect(loadOidcLoginIntent()).toBeNull();
    sessionStorage.setItem("telecrypt-io-ui:oidc-login-intent", "{");
    expect(() => loadOidcLoginIntent()).toThrow(SyntaxError);
  });

  it("stores a pending token revocation only in this tab", () => {
    const pending = { homeserver: SESSION.homeserver, accessToken: SESSION.accessToken };

    expect(savePendingRevocation(pending)).toBe(true);
    expect(loadPendingRevocations()).toEqual([pending]);
    expect(sessionStorage.getItem(PENDING_REVOCATION_STORAGE_KEY)).toContain(SESSION.accessToken);
    expect(localStorage.getItem(PENDING_REVOCATION_STORAGE_KEY)).toBeNull();
  });

  it("rejects a stored null pending-revocation value as invalid state", () => {
    sessionStorage.setItem(PENDING_REVOCATION_STORAGE_KEY, "null");
    let caught: unknown;
    try {
      loadPendingRevocations();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      message: SESSION_CLEANUP_PERSISTENCE_ERROR,
      cause: { message: "Stored pending revocation state is invalid" },
    });
  });

  it("preserves pending-revocation read failures", () => {
    const original = window.sessionStorage;
    const broken = {
      setItem: () => undefined,
      removeItem: () => undefined,
      getItem: () => {
        throw new Error("pending revocation read failed");
      },
    } as unknown as Storage;
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: broken });
    try {
      let caught: unknown;
      try {
        loadPendingRevocations();
      } catch (error) {
        caught = error;
      }
      expect(formatOperationError(caught)).toContain("pending revocation read failed");
    } finally {
      Object.defineProperty(window, "sessionStorage", { configurable: true, value: original });
    }
  });
});

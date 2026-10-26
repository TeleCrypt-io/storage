import { test, expect } from "./fixtures";
import type { Page, Response } from "@playwright/test";
import { registerE2eUser } from "./testUsers";
import { loginViaUI } from "./uiHelpers";
import type { Session } from "../../src/lib/session";

const HOMESERVER = "http://localhost:8008";
const MATRIX_LOGOUT = `${HOMESERVER}/_matrix/client/v3/logout`;

function captureTwoMatrixLogoutResponses(page: Page): {
  responses: Promise<Response[]>;
  stop: () => void;
} {
  let resolveResponses!: (responses: Response[]) => void;
  const responses = new Promise<Response[]>((resolve) => {
    resolveResponses = resolve;
  });
  const received: Response[] = [];
  const listener = (response: Response): void => {
    if (response.url() !== MATRIX_LOGOUT) return;
    received.push(response);
    if (received.length === 2) {
      page.off("response", listener);
      resolveResponses(received);
    }
  };
  page.on("response", listener);
  return { responses, stop: () => page.off("response", listener) };
}

async function sessionInTab(page: Page): Promise<Session | null> {
  return page.evaluate(() => {
    const stored = sessionStorage.getItem("telecrypt-io-ui:session");
    return stored ? JSON.parse(stored) as Session : null;
  });
}

async function expectUnknownTokenResponses(responses: Response[]): Promise<void> {
  expect(responses.map((response) => response.status())).toEqual([401, 401]);
  for (const response of responses) {
    expect(await response.json()).toMatchObject({ errcode: "M_UNKNOWN_TOKEN" });
  }
}

async function expectRotatedCredentialsPersisted(page: Page, rotated: Session | null): Promise<void> {
  expect(rotated).not.toBeNull();
  const stored = await sessionInTab(page);
  expect(stored).toMatchObject({
    accessToken: rotated!.accessToken,
    refreshToken: rotated!.refreshToken,
  });
  const pending = await page.evaluate(() => JSON.parse(
    sessionStorage.getItem("telecrypt-io-ui:pending-revocation")!,
  ) as Array<{ accessToken: string; refreshToken: string }>);
  expect(pending[0]).toMatchObject({
    accessToken: rotated!.accessToken,
    refreshToken: rotated!.refreshToken,
  });
  await expect(page.getByTestId("auth-error")).toContainText("Session cleanup is pending");
}

async function authMetadata() {
  const metadata = await (await fetch(`${HOMESERVER}/_matrix/client/v1/auth_metadata`)).json() as {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    revocation_endpoint: string;
  };
  expect(new URL(metadata.issuer).origin).not.toBe(new URL(HOMESERVER).origin);
  return metadata;
}

for (const expired of [false, true]) {
  test(expired
    ? "logout refreshes an expired Matrix token and persists rotated credentials when revocation metadata is absent"
    : "logout revokes a real OAuth grant with a valid access token", async ({ page }) => {
    test.setTimeout(expired ? 420_000 : 90_000);
    const user = await registerE2eUser(expired ? "e2e_logout_expired" : "e2e_logout");
    const metadata = await authMetadata();
    const issued = page.waitForResponse((response) => response.url() === metadata.token_endpoint)
      .then((response) => response.json() as Promise<{ expires_in: number }>);
    await loginViaUI(page, user, { deferKeySafe: true });
    const tokenResponse = await issued;
    const session = await page.evaluate(() => JSON.parse(sessionStorage.getItem("telecrypt-io-ui:session")!) as Session);
    let refreshedSession: Session | null = null;
    try {
      if (expired) {
        // Keep the actual expired grant without background sync refreshing it. Let logout
        // reach Matrix and strip only the optional revocation endpoint from real discovery.
        let logoutRequests = 0;
        await page.route("**/_matrix/client/**", async (route) => {
          const url = new URL(route.request().url());
          if (url.pathname.endsWith("/auth_metadata")) {
            const response = await route.fetch();
            const body = await response.json() as Record<string, unknown>;
            delete body.revocation_endpoint;
            await route.fulfill({ response, json: body });
          } else if (url.pathname.endsWith("/logout")) {
            logoutRequests += 1;
            if (logoutRequests === 2) {
              refreshedSession = await page.evaluate(() => JSON.parse(
                sessionStorage.getItem("telecrypt-io-ui:session")!,
              ) as Session);
            }
            await route.continue();
          } else {
            await route.abort();
          }
        });
        expect(tokenResponse.expires_in).toBeGreaterThan(0);
        expect(tokenResponse.expires_in).toBeLessThanOrEqual(300);
        await new Promise((resolve) => setTimeout(resolve, (tokenResponse.expires_in + 1) * 1000));
        expect((await fetch(`${HOMESERVER}/_matrix/client/v3/account/whoami`, {
          headers: { Authorization: `Bearer ${session.accessToken}` },
        })).status).toBe(401);
      }
      const logoutResponses = expired ? captureTwoMatrixLogoutResponses(page) : undefined;
      await page.getByTestId("logout").click();
      if (logoutResponses) {
        await expectUnknownTokenResponses(await logoutResponses.responses);
        expect(refreshedSession!.accessToken).not.toBe(session.accessToken);
        expect(refreshedSession!.refreshToken).not.toBe(session.refreshToken);
        await expectRotatedCredentialsPersisted(page, refreshedSession);
      }
      if (!expired) {
        await expect(page.getByTestId("oidc-login")).toBeEnabled();
        await expect(page.getByTestId("auth-error")).not.toBeVisible();
        expect(await sessionInTab(page)).toBeNull();
        const who = await fetch(`${HOMESERVER}/_matrix/client/v3/account/whoami`, {
          headers: { Authorization: `Bearer ${session.accessToken}` },
        });
        expect(who.status).toBe(401);
        const refreshed = await fetch(metadata.token_endpoint, {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", client_id: session.oidcClientId, refresh_token: session.refreshToken }),
        });
        expect(refreshed.status).toBe(400);
        expect(await refreshed.json()).toMatchObject({ error: "invalid_grant" });
      }
      logoutResponses?.stop();
    } finally {
      // Also clean up if an assertion fails before the UI confirms revocation.
      const current = refreshedSession ?? await sessionInTab(page);
      const cleanup = await fetch(metadata.revocation_endpoint, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: session.oidcClientId, token: current?.refreshToken ?? session.refreshToken, token_type_hint: "refresh_token" }),
      });
      if (cleanup.status === 400) expect(await cleanup.json()).toMatchObject({ error: "invalid_grant" });
      else expect(cleanup.status).toBe(200);
    }
  });
}

test("logout and sign-in work when Matrix auth metadata omits optional revocation", async ({ page }) => {
  const user = await registerE2eUser("e2e_logout_optional_revocation");
  const metadata = await authMetadata();
  await loginViaUI(page, user, { deferKeySafe: true });
  const session = await page.evaluate(() => JSON.parse(sessionStorage.getItem("telecrypt-io-ui:session")!) as Session);
  const refreshedSession: { value?: Session } = {};
  let logoutRequests = 0;
  const logoutResponses = captureTwoMatrixLogoutResponses(page);
  await page.route("**/_matrix/client/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/auth_metadata")) {
      const response = await route.fetch();
      const body = await response.json() as Record<string, unknown>;
      delete body.revocation_endpoint;
      await route.fulfill({ response, json: body });
    } else if (url.pathname.endsWith("/logout")) {
      logoutRequests += 1;
      if (logoutRequests === 2) {
        const current = await sessionInTab(page);
        if (current) refreshedSession.value = current;
      }
      await route.continue();
    } else {
      await route.continue();
    }
  });
  try {
    await page.getByTestId("logout").click();
    await expectUnknownTokenResponses(await logoutResponses.responses);
    await expectRotatedCredentialsPersisted(page, refreshedSession.value ?? null);
    expect(refreshedSession.value!.accessToken).not.toBe(session.accessToken);
    expect(refreshedSession.value!.refreshToken).not.toBe(session.refreshToken);
    await expect(page.getByTestId("oidc-login")).toBeEnabled();
    const revocationResponse = page.waitForResponse((response) => response.url() === metadata.revocation_endpoint);
    await page.unroute("**/_matrix/client/**");

    await page.getByTestId("oidc-login").click();
    expect((await revocationResponse).status()).toBe(200);
    const authOrigin = new URL(metadata.authorization_endpoint).origin;
    await page.waitForURL((url) => url.origin === authOrigin);
  } finally {
    logoutResponses.stop();
    await page.unroute("**/_matrix/client/**");
    const cleanup = await fetch(metadata.revocation_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: session.oidcClientId,
        token: refreshedSession.value?.refreshToken ?? session.refreshToken,
        token_type_hint: "refresh_token",
      }),
    });
    if (cleanup.status === 400) {
      expect(await cleanup.json()).toMatchObject({ error: "invalid_grant" });
    } else {
      expect(cleanup.status).toBe(200);
    }
  }
});

test("logout retains a real grant through an outage and retries cleanup before replacement login", async ({ page }) => {
  const user = await registerE2eUser("e2e_logout_retry");
  await loginViaUI(page, user, { deferKeySafe: true });
  const session = await page.evaluate(() => JSON.parse(sessionStorage.getItem("telecrypt-io-ui:session")!) as Session);
  const metadata = await authMetadata();
  try {
    await page.route(metadata.revocation_endpoint, (route) => route.fulfill({ status: 503, body: "temporary revocation outage" }));
    await page.getByTestId("logout").click();
    await expect(page.getByTestId("auth-error")).toContainText("Session cleanup is pending");
    expect(await page.evaluate(() => {
      const pending = JSON.parse(sessionStorage.getItem("telecrypt-io-ui:pending-revocation")!);
      return Boolean(pending[0]?.refreshToken && pending[0]?.oidcClientId);
    })).toBe(true);
    expect((await fetch(`${HOMESERVER}/_matrix/client/v3/account/whoami`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    })).status).toBe(200);
    await page.unroute(metadata.revocation_endpoint);
    await page.reload();
    await page.getByTestId("oidc-login").click();
    const authOrigin = new URL(metadata.authorization_endpoint).origin;
    await page.waitForURL((url) => url.origin === authOrigin);
    const refreshed = await fetch(metadata.token_endpoint, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: session.oidcClientId, refresh_token: session.refreshToken }),
    });
    expect(refreshed.status).toBe(400);
    expect(await refreshed.json()).toMatchObject({ error: "invalid_grant" });
  } finally {
    await page.unroute(metadata.revocation_endpoint);
    const cleanup = await fetch(metadata.revocation_endpoint, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: session.oidcClientId, token: session.refreshToken, token_type_hint: "refresh_token" }),
    });
    expect(cleanup.status).toBe(200);
  }
});

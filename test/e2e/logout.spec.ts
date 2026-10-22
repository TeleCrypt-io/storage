import { test, expect } from "./fixtures";
import { registerE2eUser } from "./testUsers";
import { loginViaUI } from "./uiHelpers";
import type { Session } from "../../src/lib/session";

const HOMESERVER = "http://localhost:8008";

for (const expired of [false, true]) {
  test(`logout revokes a real OAuth grant with ${expired ? "an expired" : "a valid"} access token`, async ({ page }) => {
    test.setTimeout(expired ? 420_000 : 90_000);
    const user = await registerE2eUser(expired ? "e2e_logout_expired" : "e2e_logout");
    const issued = page.waitForResponse((response) => response.url() === `${HOMESERVER}/oauth2/token`);
    await loginViaUI(page, user, { deferKeySafe: true });
    const tokenResponse = await (await issued).json() as { expires_in: number };
    const session = await page.evaluate(() => JSON.parse(sessionStorage.getItem("telecrypt-io-ui:session")!) as Session);
    const metadata = await (await fetch(`${HOMESERVER}/_matrix/client/v1/auth_metadata`)).json() as {
      token_endpoint: string;
      revocation_endpoint: string;
    };
    try {
      if (expired) {
        // Keep the actual expired grant, without a background sync refreshing it first.
        // Discovery remains real so logout still has to find and validate native revocation.
        await page.route("**/_matrix/client/**", (route) => new URL(route.request().url()).pathname.endsWith("/auth_metadata")
          ? route.continue() : route.abort());
        expect(tokenResponse.expires_in).toBeGreaterThan(0);
        expect(tokenResponse.expires_in).toBeLessThanOrEqual(300);
        await new Promise((resolve) => setTimeout(resolve, (tokenResponse.expires_in + 1) * 1000));
        expect((await fetch(`${HOMESERVER}/_matrix/client/v3/account/whoami`, {
          headers: { Authorization: `Bearer ${session.accessToken}` },
        })).status).toBe(401);
      }
      await page.getByTestId("logout").click();
      await expect(page.getByTestId("oidc-login")).toBeEnabled();
      await expect(page.getByTestId("auth-error")).not.toBeVisible();
      expect(await page.evaluate(() => sessionStorage.getItem("telecrypt-io-ui:session"))).toBeNull();
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
    } finally {
      // Also clean up if an assertion fails before the UI confirms revocation.
      const cleanup = await fetch(metadata.revocation_endpoint, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: session.oidcClientId, token: session.refreshToken, token_type_hint: "refresh_token" }),
      });
      expect(cleanup.status).toBe(200);
    }
  });
}

test("logout retains a real grant through an outage and retries cleanup before replacement login", async ({ page }) => {
  const user = await registerE2eUser("e2e_logout_retry");
  await loginViaUI(page, user, { deferKeySafe: true });
  const session = await page.evaluate(() => JSON.parse(sessionStorage.getItem("telecrypt-io-ui:session")!) as Session);
  const metadata = await (await fetch(`${HOMESERVER}/_matrix/client/v1/auth_metadata`)).json() as { revocation_endpoint: string; token_endpoint: string };
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
    await page.waitForURL(/localhost:8008\/(?:authorize|login|consent)(?:\/|[?#]|$)/);
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

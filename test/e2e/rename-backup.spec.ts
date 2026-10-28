import { test, expect, type BrowserContext } from "@playwright/test";
import { registerE2eUser } from "./testUsers";
import { loginViaUI, createVault, openVaultByName, uploadFile, restoreRecoveryKey } from "./uiHelpers";

for (const failure of ["readback", "pointer"] as const) test(`preserves rename metadata after ${failure} failure through reload and logout retry`, async ({ browser }) => {
  test.setTimeout(300000);
  const user = await registerE2eUser("rename_backup");
  const contexts: BrowserContext[] = [];
  const newPage = async () => {
    const context = await browser.newContext({ baseURL: "http://localhost:5173" });
    contexts.push(context);
    return context.newPage();
  };
  try {
    const first = await newPage();
    const recoveryKey = await loginViaUI(first, user);
    await createVault(first, "Rename recovery");
    await openVaultByName(first, "Rename recovery");
    await uploadFile(first, "before.txt", "text/plain", Buffer.from("rename content"));
    await first.getByTestId("logout").click();
    await expect(first.getByTestId("oidc-login")).toBeVisible();

    const page = await newPage();
    await loginViaUI(page, user, { deferKeySafe: true });
    await restoreRecoveryKey(page, recoveryKey!);
    await page.getByTestId("nav-vaults").click();
    await openVaultByName(page, "Rename recovery");
    let listingWrites = 0;
    let readbackFailed = false;
    await page.route("**/_matrix/client/v3/rooms/**", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === "PUT" && /\/state\/(?:org\.matrix\.msc3089\.branch|m\.branch)\//.test(url.pathname)) {
        listingWrites++;
        if (failure === "pointer") {
          readbackFailed = true;
          await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ errcode: "M_UNKNOWN", error: "controlled pointer failure" }) });
        } else {
          const response = await route.fetch();
          await route.fulfill({ response });
        }
      } else if (listingWrites && !readbackFailed && route.request().method() === "GET" && url.pathname.includes("/event/")) {
        readbackFailed = true;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ errcode: "M_UNKNOWN", error: "controlled readback failure" }) });
      } else await route.continue();
    });
    await page.route("**/_matrix/client/v3/room_keys/keys**", async (route) => {
      if (route.request().method() === "PUT") {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ errcode: "M_UNKNOWN", error: "backup unavailable" }) });
      } else await route.continue();
    });
    await page.locator('[data-testid="file-item"]', { hasText: "before.txt" }).getByTestId("rename-file").click();
    await page.getByTestId("rename-input").fill("after.txt");
    await page.getByTestId("rename-input").press("Enter");
    await expect(page.getByTestId("vault-detail-error")).toContainText("Do not repeat", { timeout: 60000 });
    expect(readbackFailed).toBe(true);
    expect(listingWrites).toBe(1);
    const retained = await page.evaluate(() => {
      const key = Object.keys(sessionStorage).find((entry) => entry.startsWith("telecrypt-io-ui:pending-key-backups:"));
      const session = JSON.parse(sessionStorage.getItem("telecrypt-io-ui:session")!);
      return { targets: JSON.parse(sessionStorage.getItem(key!)!), token: session.accessToken as string };
    });
    const target = retained.targets[0] as { treeId: string; metadataEventId: string };
    expect(target.metadataEventId).toBeTruthy();
    const headers = { Authorization: `Bearer ${retained.token}` };
    const eventResponse = await page.request.get(`http://localhost:8008/_matrix/client/v3/rooms/${encodeURIComponent(target.treeId)}/event/${encodeURIComponent(target.metadataEventId)}`, { headers });
    expect(eventResponse.ok()).toBe(true);
    const event = await eventResponse.json() as { content: { session_id: string } };
    const versionResponse = await page.request.get("http://localhost:8008/_matrix/client/v3/room_keys/version", { headers });
    const version = (await versionResponse.json() as { version: string }).version;
    const backupUrl = `http://localhost:8008/_matrix/client/v3/room_keys/keys/${encodeURIComponent(target.treeId)}/${encodeURIComponent(event.content.session_id)}?version=${encodeURIComponent(version)}`;
    expect((await page.request.get(backupUrl, { headers })).status()).toBe(404);
    page.on("dialog", (dialog) => dialog.accept());
    await page.reload();
    await expect(page.getByTestId("current-user")).toBeVisible({ timeout: 60000 });
    await page.getByTestId("logout").click();
    await expect(page.getByTestId("shell-error")).toContainText("Keep this tab open", { timeout: 60000 });
    await page.unroute("**/_matrix/client/v3/room_keys/keys**");
    await page.getByTestId("logout").click();
    await expect(page.getByTestId("oidc-login")).toBeVisible({ timeout: 60000 });
    expect(listingWrites).toBe(1);

    const recovered = await newPage();
    await loginViaUI(recovered, user, { deferKeySafe: true });
    await restoreRecoveryKey(recovered, recoveryKey!);
    const recoveredToken = await recovered.evaluate(() => JSON.parse(sessionStorage.getItem("telecrypt-io-ui:session")!).accessToken as string);
    expect((await recovered.request.get(backupUrl, { headers: { Authorization: `Bearer ${recoveredToken}` } })).status()).toBe(200);
    await recovered.getByTestId("nav-vaults").click();
    await openVaultByName(recovered, "Rename recovery");
    const renamed = recovered.locator('[data-testid="file-item"]', { hasText: failure === "pointer" ? "before.txt" : "after.txt" });
    await expect(renamed).toBeVisible();
    recovered.once("dialog", (dialog) => dialog.accept());
    await renamed.getByTestId("delete-file").click();
    await expect(recovered.getByTestId("no-files")).toBeVisible();
    recovered.once("dialog", (dialog) => dialog.accept());
    await recovered.locator('[data-testid="vault-item"]', { hasText: "Rename recovery" }).getByTestId("delete-vault").click();
    await expect(recovered.getByTestId("select-vault-prompt")).toBeVisible();
    await recovered.getByTestId("logout").click();
    await expect(recovered.getByTestId("oidc-login")).toBeVisible();
  } finally {
    for (const context of contexts) await context.close();
  }
});

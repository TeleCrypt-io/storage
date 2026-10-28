import { test, expect, type BrowserContext } from "@playwright/test";
import { registerE2eUser } from "./testUsers";
import { loginViaUI, createVault, openVaultByName, uploadFile, restoreRecoveryKey } from "./uiHelpers";

test("preserves a committed rename through failed backup, reload and logout retry", async ({ browser }) => {
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
        const response = await route.fetch();
        await route.fulfill({ response });
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
    await recovered.getByTestId("nav-vaults").click();
    await openVaultByName(recovered, "Rename recovery");
    const renamed = recovered.locator('[data-testid="file-item"]', { hasText: "after.txt" });
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

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { registerE2eUser } from "./testUsers";
import { loginViaUI, createVault, openVaultByName, uploadFile, restoreRecoveryKey, downloadFileBytes } from "./uiHelpers";

test("keeps an uploaded file recoverable through backup failure, reload, retry and logout", async ({ browser }, testInfo) => {
  test.setTimeout(300000);
  const user = await registerE2eUser("backup_failure");
  const contexts: BrowserContext[] = [];
  const media: string[] = [];
  let roomId: string | undefined;
  let currentPage: Page | undefined;
  let backupAttempts = 0;
  const newPage = async () => {
    const context = await browser.newContext({ baseURL: "http://localhost:5173" });
    contexts.push(context);
    currentPage = await context.newPage();
    return currentPage;
  };
  try {
    const first = await newPage();
    const recoveryKey = await loginViaUI(first, user);
    await writeFile(testInfo.outputPath("account.json"), JSON.stringify({ user, recoveryKey }), { mode: 0o600 });
    roomId = await createVault(first, "Backup recovery");
    await first.getByTestId("logout").click();
    await expect(first.getByTestId("oidc-login")).toBeVisible();

    // This device has a new sending session, so the attachment requires a new
    // backup even though the vault's older name is already recoverable.
    const second = await newPage();
    await loginViaUI(second, user, { deferKeySafe: true });
    await restoreRecoveryKey(second, recoveryKey!);
    await second.getByTestId("nav-vaults").click();
    await openVaultByName(second, "Backup recovery");
    second.on("response", async (response) => {
      if (/\/_matrix\/media\/v3\/upload/.test(response.url()) && response.status() === 200) {
        const value = await response.json();
        if (value.content_uri) media.push(value.content_uri);
      }
    });
    await second.route("**/_matrix/client/v3/room_keys/keys**", async (route) => {
      if (route.request().method() === "PUT") {
        backupAttempts++;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ errcode: "M_UNKNOWN", error: "backup temporarily unavailable" }) });
      } else await route.continue();
    });
    const bytes = Buffer.from("a committed upload must remain recoverable");
    await uploadFile(second, "saved-once.txt", "text/plain", bytes);
    await expect(second.getByTestId("file-input")).toBeDisabled();
    await second.getByTestId("logout").click();
    await expect(second.getByTestId("shell-error")).toContainText("Keep this tab open", { timeout: 60000 });
    await expect(second.getByTestId("current-user")).toBeVisible();
    await expect(second.getByTestId("vault-detail-error")).toContainText("Do not repeat");
    expect(backupAttempts).toBeGreaterThan(0);

    // Pending identifiers survive a reload of this device's session.
    second.on("dialog", (dialog) => dialog.accept());
    await second.reload();
    await expect(second.getByTestId("current-user")).toBeVisible({ timeout: 60000 });
    await second.getByTestId("logout").click();
    await expect(second.getByTestId("shell-error")).toContainText("Keep this tab open", { timeout: 40000 });
    await second.unroute("**/_matrix/client/v3/room_keys/keys**");
    await second.getByTestId("logout").click();
    await expect(second.getByTestId("oidc-login")).toBeVisible({ timeout: 40000 });

    const recovered = await newPage();
    await loginViaUI(recovered, user, { deferKeySafe: true });
    await restoreRecoveryKey(recovered, recoveryKey!);
    await recovered.getByTestId("nav-vaults").click();
    await openVaultByName(recovered, "Backup recovery");
    await expect(recovered.getByTestId("file-item")).toHaveCount(1);
    expect(await downloadFileBytes(recovered, "saved-once.txt")).toEqual(bytes);
    expect(media).toHaveLength(1);
  } finally {
    if (currentPage && roomId) {
      const token = await currentPage.evaluate(() => {
        const value = sessionStorage.getItem("telecrypt-io-ui:session");
        return value ? JSON.parse(value).accessToken as string : undefined;
      });
      if (token) {
        const headers = { Authorization: `Bearer ${token}` };
        if (media.length) {
          const deleted = await currentPage.request.post("http://localhost:8008/_matrix/client/unstable/io.telecrypt.storage/delete_media", { headers, data: { media_ids: media } });
          expect(deleted.ok()).toBe(true);
        }
        for (const action of ["leave", "forget"]) {
          const response = await currentPage.request.post(`http://localhost:8008/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/${action}`, { headers, data: {} });
          expect(response.ok()).toBe(true);
        }
      }
    }
    for (const context of contexts) await context.close();
  }
});

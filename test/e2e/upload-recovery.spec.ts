import { test, expect } from "./fixtures";
import { registerE2eUser } from "./testUsers";
import { createVault, loginViaUI } from "./uiHelpers";
import type { PendingUpload } from "../../src/lib/pendingUploads";
import type { Session } from "../../src/lib/session";

const HOMESERVER = "http://localhost:8008";

test("partial upload survives reload and can be cleaned up after an outage", async ({ page }) => {
  const user = await registerE2eUser("e2e_upload_cleanup");
  await loginViaUI(page, user);
  const vaultId = await createVault(page, "Upload recovery");
  const listing = "**/state/org.matrix.msc3089.branch/**";
  const deletion = `${HOMESERVER}/_matrix/client/unstable/io.telecrypt.storage/delete_media`;
  const reject = { status: 403, contentType: "application/json", body: JSON.stringify({ errcode: "M_FORBIDDEN", error: "controlled outage" }) };
  await page.route(listing, (route) => route.fulfill(reject));
  await page.route(deletion, (route) => route.fulfill(reject));
  await page.getByTestId("file-input").setInputFiles({ name: "partial.txt", mimeType: "text/plain", buffer: Buffer.from("recover this upload") });
  await expect(page.getByTestId("cleanup-upload")).toBeEnabled();
  const { session, receipt } = await page.evaluate(() => {
    const session = JSON.parse(sessionStorage.getItem("telecrypt-io-ui:session")!) as Session;
    const key = `telecrypt-io-ui:pending-uploads:${JSON.stringify([session.homeserver, session.userId])}`;
    return { session, receipt: (JSON.parse(localStorage.getItem(key)!) as PendingUpload[])[0] };
  });
  expect(receipt.treeId).toBe(vaultId);
  expect(receipt.fileId).toBeTruthy();
  const media = new URL(receipt.mediaId);
  const mediaUrl = `${HOMESERVER}/_matrix/client/v1/media/download/${media.host}${media.pathname}`;
  const headers = { Authorization: `Bearer ${session.accessToken}` };
  expect((await fetch(mediaUrl, { headers })).status).toBe(200);

  await page.reload();
  await expect(page.getByTestId("nav-vaults")).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId("nav-vaults").click();
  await page.getByTestId("cleanup-upload").click();
  await expect(page.getByTestId("upload-cleanup-error")).toContainText("controlled outage");
  await expect(page.getByTestId("cleanup-upload")).toBeEnabled();
  await page.unroute(listing);
  await page.unroute(deletion);
  await page.getByTestId("cleanup-upload").click();
  await expect(page.getByTestId("pending-upload-cleanup")).not.toBeVisible();
  expect((await fetch(mediaUrl, { headers })).status).toBe(404);
  const event = await (await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(vaultId)}/event/${encodeURIComponent(receipt.fileId!)}`, { headers })).json() as { unsigned?: { redacted_because?: unknown } };
  expect(event.unsigned?.redacted_because).toBeTruthy();
  await page.reload();
  await expect(page.getByTestId("nav-vaults")).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId("nav-vaults").click();
  await expect(page.getByTestId("pending-upload-cleanup")).not.toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(`[data-testid="vault-item"][data-vault-id="${vaultId}"]`).getByTestId("delete-vault").click();
  await expect(page.getByTestId("no-vaults")).toBeVisible();
  await page.getByTestId("logout").click();
  await expect(page.getByTestId("oidc-login")).toBeEnabled();
});

import { test, expect } from "./fixtures";
import { registerE2eUser, waitForServerBackupCount } from "./testUsers";
import { auditConsole, createVault, downloadFileBytes, loginViaUI, openVaultByName, uploadFile, confirmRecoveryKeySaved, restoreRecoveryKey } from "./uiHelpers";

// Mirrors test/functional/keys.test.ts 5.3 ("a genuinely new device recovers
// files via the Recovery Key") through the UI: set up recovery, capture the
// shown key, then a FRESH browser context (= fresh IndexedDB crypto store,
// fresh device_id/access_token via a real MAS/OIDC login) restores with
// that key and reads the file. Before restoring, mandatory onboarding blocks Files.
test("recovery: set up on device A, restore and read a file on a fresh device B", async ({
  contexts,
}) => {
  test.setTimeout(300_000);
  const user = await registerE2eUser("e2e_recover");

  const contextA = await contexts.create();
  const pageA = await contextA.newPage();
  const consoleA = auditConsole(pageA);

  const original = Buffer.from("lost laptop recovery test content, via the UI\n".repeat(10));

  const recoveryKey = await loginViaUI(pageA, user);
  expect(recoveryKey).toBeTruthy();
  await createVault(pageA, "RecoveryTest");
  await openVaultByName(pageA, "RecoveryTest");
  await uploadFile(pageA, "important.txt", "text/plain", original);

  // Server-side proof the backup engine actually finished uploading the
  // file's room key, not just that the engine believes it's active — read
  // the access token straight out of this tab's sessionStorage.
  const accessToken = await pageA.evaluate(() => {
    const raw = sessionStorage.getItem("telecrypt-io-ui:session");
    return raw ? (JSON.parse(raw) as { accessToken: string }).accessToken : null;
  });
  expect(accessToken).toBeTruthy();
  await waitForServerBackupCount(accessToken!, 1, 60_000);

  // Device B: a genuinely fresh browser context (empty IndexedDB) logging
  // in through the same MAS/OIDC flow. That produces a brand-new Matrix
  // device_id/access_token, exactly the "new laptop" scenario.
  const contextB = await contexts.create();
  const pageB = await contextB.newPage();
  const consoleB = auditConsole(pageB, [
    /Failed to decrypt a room event|Error decrypting event|key backup is not working|Can't find the room key/i,
  ]);
  await loginViaUI(pageB, user, { deferKeySafe: true });
  await expect(pageB.getByTestId("key-safe-restore-required")).toBeVisible({ timeout: 60_000 });
  await expect(pageB.getByTestId("nav-vaults")).toBeDisabled();
  await expect(pageB.getByTestId("vault-detail")).not.toBeVisible();
  await expect(pageB.getByTestId("setup-key-safe")).not.toBeVisible();
  await restoreRecoveryKey(pageB, recoveryKey!);

  // Now the file must decrypt (poll — decryption settling after a
  // restore is real async work, not instant).
  await pageB.getByTestId("nav-vaults").click();
  await openVaultByName(pageB, "RecoveryTest");
  const downloaded = await downloadFileBytes(pageB, "important.txt");
  expect(downloaded.equals(original)).toBe(true);
  consoleB.assertClean();
  consoleA.assertClean();
});


test("first-use safe resumes the same key after reload and requires saved confirmation", async ({ page }) => {
  test.setTimeout(300_000);
  const user = await registerE2eUser("e2e_safe_resume");
  await loginViaUI(page, user, { deferKeySafe: true });
  await expect(page.getByTestId("nav-vaults")).toBeDisabled();
  await page.getByTestId("setup-key-safe").click();
  const key = await page.getByTestId("key-safe-recovery-key").textContent({ timeout: 60_000 });
  expect(key).toBeTruthy();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("save-key-safe-key").click(),
  ]);
  const stream = await download.createReadStream();
  expect(stream).toBeTruthy();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk as Buffer);
  expect(Buffer.concat(chunks).toString("utf8").trim()).toBe(key!.trim());
  await expect(page.getByTestId("nav-vaults")).toBeDisabled();
  await page.reload();
  await expect(page.getByTestId("current-user")).toHaveText(user.userId, { timeout: 90_000 });
  await expect(page.getByTestId("key-safe-recovery-key")).toHaveText(key!, { timeout: 60_000 });
  await expect(page.getByTestId("setup-key-safe")).not.toBeVisible();
  await expect(page.getByTestId("nav-vaults")).toBeDisabled();
  await confirmRecoveryKeySaved(page);
  await expect(page.getByTestId("no-vaults")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("current-user")).toHaveText(user.userId, { timeout: 90_000 });
  await expect(page.getByTestId("no-vaults")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("setup-key-safe")).not.toBeVisible();
});

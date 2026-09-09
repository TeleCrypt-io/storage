import { test, expect } from "./fixtures";
import { registerE2eUser, waitForServerBackupCount } from "./testUsers";
import { auditConsole, createVault, downloadFileBytes, loginViaUI, openVaultByName, uploadFile, confirmRecoveryKeySaved, restoreRecoveryKey } from "./uiHelpers";

// Mirrors test/functional/keys.test.ts 5.3 ("a genuinely new device recovers
// files via the Recovery Key") through the UI: set up recovery, capture the
// shown key, then a FRESH browser context (= fresh IndexedDB crypto store,
// fresh device_id/access_token via a real MAS/OIDC login) restores with
// that key and reads the file. Includes the same negative control: before
// restoring, the new device must NOT be able to decrypt.
test("recovery: set up on device A, restore and read a file on a fresh device B", async ({
  contexts,
}) => {
  test.setTimeout(300_000);
  const user = await registerE2eUser("e2e_recover");

  const contextA = await contexts.create();
  const pageA = await contextA.newPage();
  const consoleA = auditConsole(pageA, [
    /resetCrossSigning: Secret storage is not yet set up/,
  ]);

  const original = Buffer.from("lost laptop recovery test content, via the UI\n".repeat(10));

  await loginViaUI(pageA, user);
  await createVault(pageA, "RecoveryTest");
  await openVaultByName(pageA, "RecoveryTest");
  await uploadFile(pageA, "important.txt", "text/plain", original);

  await pageA.getByTestId("nav-recovery").click();
  await pageA.getByTestId("setup-recovery").click();
  const recoveryKey = await pageA
    .getByTestId("recovery-key-value")
    .textContent({ timeout: 20000 });
  expect(recoveryKey).toBeTruthy();
  await confirmRecoveryKeySaved(pageA);

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
  await loginViaUI(pageB, user);
  await openVaultByName(pageB, "RecoveryTest");
  await expect(
    pageB.locator('[data-testid="file-item"]', { hasText: "important.txt" }),
  ).toBeVisible({ timeout: 20000 });

  // NEGATIVE CONTROL: device B has no keys yet, so download must fail
  // cleanly — proves the empty start, so the later success is meaningful.
  await pageB.locator('[data-testid="file-item"]', { hasText: "important.txt" })
    .getByTestId("download-file")
    .click();
  await expect(pageB.getByTestId("vault-detail-error")).toBeVisible({ timeout: 10000 });

  // Restore from the captured Recovery Key.
  await pageB.getByTestId("nav-recovery").click();
  await restoreRecoveryKey(pageB, recoveryKey!);
  const resultText = await pageB.getByTestId("restore-result").textContent();
  expect(resultText).toMatch(/Imported [1-9]\d* of \d+ keys/);

  // Now the file must decrypt (poll — decryption settling after a
  // restore is real async work, not instant).
  await pageB.getByTestId("nav-vaults").click();
  await openVaultByName(pageB, "RecoveryTest");
  const downloaded = await downloadFileBytes(pageB, "important.txt");
  expect(downloaded.equals(original)).toBe(true);
  consoleB.assertClean();
  consoleA.assertClean();
});

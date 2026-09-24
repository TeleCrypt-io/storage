import { test, expect } from "./fixtures";
import { registerE2eUser } from "./testUsers";
import {
  auditConsole,
  createVault,
  downloadFileBytes,
  joinVault,
  loginViaUI,
  openVaultByName,
  uploadFile,
} from "./uiHelpers";

// The core product flow: userA creates a vault, uploads a file, and shares it
// with userB as a viewer (two independent browser contexts — two real, separate
// crypto devices); userB downloads and decrypts the owner's file. No mocks —
// real Synapse, real E2EE, two real browser sessions.
test("multi-participant share: userA and userB exchange a file", async ({ contexts }) => {
  test.setTimeout(300_000);
  const userA = await registerE2eUser("e2e_share_a");
  const userB = await registerE2eUser("e2e_share_b");

  const contextA = await contexts.create();
  const contextB = await contexts.create();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const consoleA = auditConsole(pageA);
  const consoleB = auditConsole(pageB, [
    /^Failed to load resource: the server responded with a status of 403 \(Forbidden\) \(http:\/\/localhost:8008\/_matrix\/client\/v3\/rooms\/![^/]+%3Alocalhost%3A8008\/members\)$/,
    // Matrix offers the encrypted history only after the reader joins; before
    // that, the SDK reports that these earlier events are unavailable.
    /^WARN matrix_sdk_crypto::machine: Failed to decrypt a room event: Can't find the room key to decrypt the event/,
    /DecryptionError\[msg: This message was sent when we were not a member of the room\./,
    // Before the owner shares history, the reader cannot fetch the old room
    // key. The test later proves the invite delivers it and the file decrypts.
    /^Failed to load resource: the server responded with a status of 404 \(Not Found\) \(http:\/\/localhost:8008\/_matrix\/client\/v3\/room_keys\/keys\/[^/]+\/[^?]+\?version=\d+\)/,
  ]);

  await loginViaUI(pageA, userA);
  // Both clients complete ordinary first-use setup before sharing can deliver history.
  await loginViaUI(pageB, userB);
  const vaultId = await createVault(pageA, "Team Vault");
  await openVaultByName(pageA, "Team Vault");
  const payload = Buffer.from("hello from the vault owner\n".repeat(20));
  await uploadFile(pageA, "from-a.txt", "text/plain", payload);

  await pageA.getByTestId("share-user-id").fill(userB.userId);
  await pageA.getByTestId("share-submit").click();
  await expect(
    pageA.locator(`[data-testid="member-item"][data-user-id="${userB.userId}"]`),
  ).toBeVisible({ timeout: 20000 });

  // userB: join from the separate browser context and crypto store, then download
  // the vault by the ID userA's session exposed in the DOM, and download.
  await joinVault(pageB, vaultId);
  await openVaultByName(pageB, "Team Vault");

  // The owner's existing file must appear and decrypt for the reader.
  await expect(
    pageB.locator('[data-testid="file-item"]', { hasText: "from-a.txt" }),
  ).toBeVisible({ timeout: 20000 });
  const downloadedByB = await downloadFileBytes(pageB, "from-a.txt");
  expect(downloadedByB.equals(payload)).toBe(true);
  consoleA.assertClean();
  consoleB.assertClean();
});

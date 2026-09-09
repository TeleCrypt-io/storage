import { test, expect } from "./fixtures";
import { registerE2eUser } from "./testUsers";
import {
  auditConsole,
  confirmRecoveryKeySaved,
  createVault,
  downloadFileBytes,
  joinVault,
  loginViaUI,
  openVaultByName,
  uploadFile,
} from "./uiHelpers";

// The core product flow: userA creates a vault and shares it with userB as
// editor (two independent browser contexts — two real, separate crypto
// devices); userB uploads a file; userA sees and downloads userB's file,
// with bytes identical to what userB uploaded. No mocks — real Synapse,
// real E2EE, two real browser sessions.
test("multi-participant share: userA and userB exchange a file", async ({ contexts }) => {
  const userA = await registerE2eUser("e2e_share_a");
  const userB = await registerE2eUser("e2e_share_b");

  const contextA = await contexts.create();
  const contextB = await contexts.create();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const consoleA = auditConsole(pageA);
  const consoleB = auditConsole(pageB, [
    /^Failed to load resource: the server responded with a status of 403 \(Forbidden\) \(http:\/\/localhost:8008\/_matrix\/client\/v3\/rooms\/![^/]+%3Alocalhost%3A8008\/members\)$/,
  ]);

  await loginViaUI(pageA, userA);
  // Sharing a vault may attempt to send historical room keys. Establish the
  // account's cross-signing/backup trust state first; an unverified-device
  // warning here would mean the share did not meet that security contract.
  await pageA.getByTestId("nav-recovery").click();
  await pageA.getByTestId("setup-recovery").click();
  await expect(pageA.getByTestId("recovery-key-value")).toBeVisible({ timeout: 20000 });
  await confirmRecoveryKeySaved(pageA);
  await expect(pageA.getByTestId("recovery-active")).toBeVisible({ timeout: 20000 });
  await pageA.getByTestId("nav-vaults").click();
  const vaultId = await createVault(pageA, "Team Vault");
  await openVaultByName(pageA, "Team Vault");

  await pageA.getByTestId("share-user-id").fill(userB.userId);
  await pageA.getByTestId("share-role").selectOption("editor");
  await pageA.getByTestId("share-submit").click();
  await expect(
    pageA.locator(`[data-testid="member-item"][data-user-id="${userB.userId}"]`),
  ).toBeVisible({ timeout: 20000 });

  // userB: log in (separate context = separate device/crypto store), join
  // the vault by the ID userA's session exposed in the DOM, and upload.
  await loginViaUI(pageB, userB);
  await joinVault(pageB, vaultId, "Team Vault");
  await openVaultByName(pageB, "Team Vault");

  const bobBytes = Buffer.from("hello from userB's editor upload\n".repeat(20));
  await uploadFile(pageB, "from-b.txt", "text/plain", bobBytes);

  // userA: the file userB just uploaded must appear and decrypt.
  await expect(
    pageA.locator('[data-testid="file-item"]', { hasText: "from-b.txt" }),
  ).toBeVisible({ timeout: 20000 });
  const downloadedByA = await downloadFileBytes(pageA, "from-b.txt");
  expect(downloadedByA.equals(bobBytes)).toBe(true);
  consoleA.assertClean();
  consoleB.assertClean();
});

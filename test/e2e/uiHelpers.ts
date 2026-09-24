import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { E2eUser } from "./testUsers";

export interface ConsoleAudit {
  assertClean: () => void;
}

function sanitizeStartupDiagnostic(value: string): string {
  return value
    .replace(/\b(access_token|refresh_token|id_token|client_secret|code|state)=([^\s&]+)/giu, "$1=<redacted>")
    .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\b/gu, "<redacted>")
    .replace(/@[\w.-]+:localhost:8008/gu, "@<test-user>:localhost:8008");
}

const EXPECTED_LOCAL_CONSOLE = [
  /^Applying inline style violates .* \(http:\/\/localhost:5173\/@vite\/client\)$/,
  /^Failed to load resource: net::ERR_SSL_PROTOCOL_ERROR \(https:\/\/localhost:8008\/\.well-known\/matrix\/client\)$/,
  /^Failed to load resource: the server responded with a status of 404 \(Not Found\) \(http:\/\/localhost:8008\/_matrix\/client\/v3\/room_keys\/version\)$/,
  // An empty Matrix account has no Safe, signing, or backup account-data yet;
  // these 404s are the documented "setup required" result during first use.
  /^Failed to load resource: the server responded with a status of 404 \(Not Found\) \(http:\/\/localhost:8008\/_matrix\/client\/v3\/user\/%40[^/]+\/account_data\/(?:m\.secret_storage\.default_key|m\.secret_storage\.key\.[^/]+|m\.cross_signing\.(?:master|self_signing|user_signing)|m\.megolm_backup\.v1)\)$/,
  /^Failed to load resource: the server responded with a status of 404 \(Not Found\) \(http:\/\/localhost:8008\/_matrix\/client\/unstable\/org\.matrix\.msc4143\/rtc\/transports\)$/,
  /^Adding default global (?:override|underride) push rule \.(?:org\.matrix\.msc3786\.rule\.room\.server_acl|org\.matrix\.msc3914\.rule\.room\.call) \(http:\/\/localhost:5173\/@vite\/client\)$/,
  /^resetCrossSigning: Secret storage is not yet set up; not exporting keys to secret storage yet\. \(http:\/\/localhost:5173\/@vite\/client\)$/,
  // Safe initialization writes Matrix's existing signing/backup records before
  // timeline sync so a fresh login cannot decrypt history prematurely. The SDK
  // warning only concerns its in-memory account-data cache; reads are refreshed
  // from the homeserver before the crypto library imports these records.
  /^Calling \x60setAccountData\x60 before the client is started: \x60getAccountData\x60 may return inconsistent results\. \(http:\/\/localhost:5173\/@vite\/client\)$/,
  // Rust crypto can report this transiently while its own-device key query is
  // still in flight during initial Safe setup. Functional checks below still
  // require setup, sharing, and decryption to finish successfully.
  /^warning: WARN matrix_sdk_crypto::store: The user has a pending \x60\/keys\/query\x60 request which did not finish yet, some devices might be missing\./,
];

/** Fail a test on every unexpected browser warning, error, or uncaught page error. */
export function auditConsole(page: Page, allowed: RegExp[] = []): ConsoleAudit {
  const unexpected: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "warning" && message.type() !== "error") return;
    const location = message.location().url;
    const detail = `${message.text()}${location ? ` (${location})` : ""}`;
    const accepted = [...EXPECTED_LOCAL_CONSOLE, ...allowed].some(
      (pattern) => pattern.test(detail) || pattern.test(message.type() + ": " + detail),
    );
    if (!accepted) {
      unexpected.push(`${message.type()}: ${detail}`);
    }
  });
  page.on("pageerror", (error) => unexpected.push(`pageerror: ${error.message}`));
  return {
    assertClean: () => expect(unexpected).toEqual([]),
  };
}

/** Drives the real browser authorization-code + PKCE flow through the local
 * disposable MAS. Test credentials are entered only into MAS's page, never
 * into the Storage application. */
async function completeMasOidcLogin(page: Page, user: E2eUser): Promise<void> {
  await page.waitForURL(/localhost:8008\/(?:authorize|login|consent|link)(?:\/|[?#]|$)/, { timeout: 20_000 });
  await page.getByLabel("Username").fill(user.localpart);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Continue" }).click();

  // Each isolated browser context dynamically registers its own public OIDC
  // client, so MAS normally asks for consent. Accept it when presented; an
  // existing authorized client may instead redirect straight back to Storage.
  const consentHeading = page.getByRole("heading", { name: /^Continue to / });
  if (await consentHeading.isVisible({ timeout: 5_000 }).catch(() => false)) {
    const consentCheckbox = page.locator('input[type="checkbox"]');
    if (await consentCheckbox.isVisible().catch(() => false)) await consentCheckbox.check();
    await page.getByRole("button", { name: "Continue" }).click();
  }
}

/** Opens Storage and signs in through its real MAS/OIDC browser flow. */
export async function loginViaUI(
  page: Page,
  user: E2eUser,
  options: { deferKeySafe?: boolean } = {},
): Promise<string | undefined> {
  const startupErrors: string[] = [];
  page.on("pageerror", (error) => startupErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") startupErrors.push(`console: ${message.text()}`);
  });
  await page.goto("/");
  await page.getByTestId("oidc-login").click();
  await completeMasOidcLogin(page, user);
  const currentUser = page.getByTestId("current-user");
  try {
    await expect(currentUser).toHaveText(user.userId, { timeout: 90_000 });
  } catch (error) {
    const visibleState = await page.locator("body").innerText().catch(() => "");
    const currentUrl = new URL(page.url());
    currentUrl.search = "";
    currentUrl.hash = "";
    const diagnostics = startupErrors.map(sanitizeStartupDiagnostic).join(" | ") || "none";
    throw new Error(
      `Storage did not reach ready state after sign-in (${currentUrl.href}): ${visibleState.replace(/\s+/gu, " ").slice(0, 1200)}; browser errors: ${diagnostics}`,
      { cause: error },
    );
  }
  if (options.deferKeySafe) return;
  await page.getByTestId("setup-key-safe").click({ timeout: 60_000 });
  const key = await page.getByTestId("key-safe-recovery-key").textContent({ timeout: 60_000 });
  expect(key).toBeTruthy();
  await confirmRecoveryKeySaved(page);
  return key!;
}

export async function createVault(page: Page, name: string): Promise<string> {
  await page.getByTestId("nav-vaults").click();
  await page.getByTestId("create-vault").click();
  const renameInput = page.getByTestId("rename-vault-input");
  await expect(renameInput).toBeVisible({ timeout: 20000 });
  await renameInput.fill(name);
  await renameInput.press("Enter");
  const item = page.locator('[data-testid="vault-item"]', { hasText: name });
  await expect(item).toBeVisible({ timeout: 20000 });
  const vaultId = await item.getAttribute("data-vault-id");
  if (!vaultId) throw new Error(`vault item for "${name}" has no data-vault-id`);
  return vaultId;
}

export async function openVaultByName(page: Page, name: string): Promise<void> {
  await page.locator(".vault-list-btn", { hasText: name }).click();
  await expect(page.getByTestId("vault-detail")).toBeVisible();
}

/** userB's side: accept a pending invite for the shared vault. */
export async function joinVault(
  page: Page,
  vaultId: string,
): Promise<void> {
  await page.getByTestId("nav-vaults").click();
  const invite = page.locator(`[data-testid="invite-item"][data-vault-id="${vaultId}"]`);
  // Invite-room names are intentionally hidden by encrypted metadata. Wait for
  // the stable Matrix room ID through sync rather than falling back to a name.
  await expect(invite).toBeVisible({ timeout: 20_000 });
  await invite.getByTestId("accept-invite").click();
  await expect(page.locator(`[data-testid="vault-item"][data-vault-id="${vaultId}"]`)).toBeVisible({
    timeout: 20000,
  });
}

export async function uploadFile(
  page: Page,
  name: string,
  mimeType: string,
  buffer: Buffer,
): Promise<void> {
  await page.getByTestId("file-input").setInputFiles({ name, mimeType, buffer });
  await expect(page.locator('[data-testid="file-item"]', { hasText: name })).toBeVisible({
    timeout: 20000,
  });
}

/** Downloads a file whose name is already visible in the file list and
 * returns its bytes, for a byte-identical comparison against what was
 * uploaded. Retries the click: right after a share/upload, the first
 * download attempt can race the recipient's megolm-session delivery and
 * fail to decrypt even though the file is listed — a real async-settling
 * window, not something to paper over with a fixed sleep. */
export async function downloadFileBytes(page: Page, name: string): Promise<Buffer> {
  const row = page.locator('[data-testid="file-item"]', { hasText: name });
  const button = row.getByTestId("download-file");

  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 3000 }),
        button.click(),
      ]);
      const stream = await download.createReadStream();
      if (!stream) throw new Error("download had no stream");
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await page.waitForTimeout(500);
    }
  }
}

export async function confirmRecoveryKeySaved(page: Page): Promise<void> {
  await page.getByTestId("confirm-saved-key").click();
  await expect(page.getByTestId("key-safe-key-display")).not.toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("nav-vaults")).toBeEnabled();
}

export async function restoreRecoveryKey(page: Page, key: string): Promise<void> {
  await expect(page.getByTestId("restore-key-input")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("restore-key-input").fill(key.trim());
  await page.getByTestId("restore-key-submit").click();
  await expect(page.getByTestId("nav-vaults")).toBeEnabled({ timeout: 120_000 });
}

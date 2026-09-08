import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerE2eUser } from "./testUsers";
import { createVault, loginViaUI, openVaultByName, uploadFile } from "./uiHelpers";

test("create vault with rename and navigate up to vault list", async ({ page }) => {
  const user = await registerE2eUser("e2e_vault_nav");
  await loginViaUI(page, user);

  await page.getByTestId("create-vault").click();
  const renameInput = page.getByTestId("rename-vault-input");
  await renameInput.fill("Project Alpha");
  await renameInput.press("Enter");

  await expect(page.locator('[data-testid="vault-item"]', { hasText: "Project Alpha" })).toBeVisible({
    timeout: 20000,
  });
  await expect(page.getByTestId("vault-detail")).toBeVisible();

  await page.getByTestId("nav-up").click();
  await expect(page.getByTestId("select-vault-prompt")).toBeVisible();
});

test("rename and delete a vault from the sidebar", async ({ page }) => {
  const user = await registerE2eUser("e2e_vault_delete");
  await loginViaUI(page, user);
  await createVault(page, "BeforeDelete");

  const item = page.locator('[data-testid="vault-item"]', { hasText: "BeforeDelete" });
  await item.getByTestId("rename-vault").click();
  await page.getByTestId("rename-vault-input").fill("AfterRename");
  await page.getByTestId("rename-vault-input").press("Enter");
  await expect(page.locator('[data-testid="vault-item"]', { hasText: "AfterRename" })).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator('[data-testid="vault-item"]', { hasText: "AfterRename" })
    .getByTestId("delete-vault")
    .click();
  await expect(page.getByTestId("select-vault-prompt")).toBeVisible({ timeout: 20_000 });
});

test("vault view creates an untitled subfolder with inline rename", async ({ page }) => {
  const user = await registerE2eUser("e2e_new_subfolder");
  await loginViaUI(page, user);
  await createVault(page, "Workspace");
  await openVaultByName(page, "Workspace");

  await page.getByTestId("create-subfolder").click();
  const renameInput = page.getByTestId("rename-input");
  await expect(renameInput).toBeVisible({ timeout: 20000 });
  await renameInput.fill("Notes");
  await renameInput.press("Enter");

  await expect(page.locator('[data-testid="subfolder-item"]', { hasText: "Notes" })).toBeVisible({
    timeout: 20000,
  });
});

test("upload folder with nested tree", async ({ page }) => {
  const user = await registerE2eUser("e2e_upload_folder");
  await loginViaUI(page, user);
  await createVault(page, "TreeVault");
  await openVaultByName(page, "TreeVault");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-tree-"));
  const rootDir = path.join(tmpDir, "root");
  fs.mkdirSync(path.join(rootDir, "sub"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "a.txt"), "a");
  fs.writeFileSync(path.join(rootDir, "sub", "b.txt"), "b");

  await page.getByTestId("folder-input").setInputFiles(rootDir);
  await expect(page.getByTestId("upload-folder-button")).toBeEnabled({ timeout: 20000 });

  await page.locator('[data-testid="subfolder-item"]', { hasText: "root" }).locator(".row-name-btn").click();
  await expect(page.locator('[data-testid="file-item"]', { hasText: "a.txt" })).toBeVisible({
    timeout: 20000,
  });
  await page.locator('[data-testid="subfolder-item"]', { hasText: "sub" }).locator(".row-name-btn").click();
  await expect(page.locator('[data-testid="file-item"]', { hasText: "b.txt" })).toBeVisible({
    timeout: 20000,
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("details panel is visible when browsing a vault", async ({ page }) => {
  const user = await registerE2eUser("e2e_details");
  await loginViaUI(page, user);
  await createVault(page, "DetailsTest");

  await expect(page.getByTestId("details-panel")).toBeVisible();
  await expect(page.getByTestId("members-panel")).toBeVisible();

  const bytes = Buffer.from("details panel file");
  await uploadFile(page, "meta.txt", "text/plain", bytes);
  await page.locator('[data-testid="file-item"]', { hasText: "meta.txt" }).click();
  await expect(page.getByText("meta.txt").first()).toBeVisible();
});

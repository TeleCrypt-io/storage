/**
 * Browser-facing SDK boundary.
 *
 * The SDK barrel is the sole operation/OIDC authority; this boundary
 * adds browser backup settlement and ownership presentation without copying
 * Matrix mutations into the UI.
 */
import { getMyVaultRole, type TeleCryptIOStorage } from "@telecrypt-io/storage";
import * as sdk from "@telecrypt-io/storage";
import { backedUp, forgetDeletedBackup } from "./keyBackup";

export * from "@telecrypt-io/storage";

export const createVault = backedUp(sdk.createVault, "vault creation");
export const createSubfolder = backedUp(sdk.createSubfolder, "folder creation");
export const renameVault = backedUp(sdk.renameVault, "vault rename");
export const renameFolder = backedUp(sdk.renameFolder, "folder rename");
export const uploadFile = backedUp(sdk.uploadFile, "file upload", (args) => args[0]);
export const renameFile = backedUp(sdk.renameFile, "file rename", (args) => args[0]);

export async function deleteFile(...args: Parameters<typeof sdk.deleteFile>) {
  const result = await sdk.deleteFile(...args);
  forgetDeletedBackup(args[0], args[1], args[2]);
  return result;
}

export async function deleteVault(...args: Parameters<typeof sdk.deleteVault>) {
  const result = await sdk.deleteVault(...args);
  forgetDeletedBackup(args[0], args[1]);
  return result;
}

export async function deleteFolder(...args: Parameters<typeof sdk.deleteFolder>) {
  const result = await sdk.deleteFolder(...args);
  forgetDeletedBackup(args[0], args[1]);
  return result;
}

export type VaultOwnership =
  | { status: "owner" }
  | { status: "not-owner" }
  | { status: "unknown"; error: unknown };

export function getVaultOwnership(storage: TeleCryptIOStorage | null, vaultId: string): VaultOwnership {
  if (!storage) return { status: "unknown", error: new Error("storage is unavailable") };
  try {
    const role = getMyVaultRole(storage, vaultId);
    if (role === null) return { status: "unknown", error: new Error("vault ownership is unavailable") };
    return role === "owner" ? { status: "owner" } : { status: "not-owner" };
  } catch (error) {
    return { status: "unknown", error };
  }
}

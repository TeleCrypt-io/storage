/**
 * Browser-facing SDK boundary.
 *
 * The repository is intentionally pinned to the exact published storage SDK
 * 0.5.29. The SDK barrel is the sole operation/OIDC authority; this boundary
 * adds only the UI-specific ownership helper without copying SDK implementation
 * into the UI.
 */
import { getMyVaultRole, type TeleCryptIOStorage } from "@telecrypt-io/storage";

export * from "@telecrypt-io/storage";

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

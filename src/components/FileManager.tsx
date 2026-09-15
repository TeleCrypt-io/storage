import { useCallback, useEffect, useRef, useState } from "react";
import { useStorage } from "../context/StorageContext";
import * as core from "../lib/core";
import type { FolderInfo, VaultInfo } from "../lib/core";
import { formatOperationError } from "../lib/formatOperationError";
import { withAccountSignal } from "../lib/accountOperation";
import { DetailsPanel, type Selection } from "./DetailsPanel";
import { VaultContents } from "./VaultContents";

const POLL_MS = 2500;
const UNTITLED = "Untitled vault";

function ownershipError(ownership: core.VaultOwnership): string | null {
  return ownership.status === "unknown" ? formatOperationError(ownership.error) : null;
}

function uniqueUntitledName(existing: VaultInfo[]): string {
  const names = new Set(existing.map((vault) => vault.name.toLowerCase()));
  if (!names.has(UNTITLED.toLowerCase())) return UNTITLED;
  let i = 2;
  while (names.has(`${UNTITLED} ${i}`.toLowerCase())) i++;
  return `${UNTITLED} ${i}`;
}

export function FileManager() {
  const { storage, accountSignal } = useStorage();
  const [vaults, setVaults] = useState<VaultInfo[] | null>(null);
  const [invites, setInvites] = useState<VaultInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rootVault, setRootVault] = useState<VaultInfo | null>(null);
  const [ownedVaultIds, setOwnedVaultIds] = useState<Set<string>>(new Set());
  const [folderPath, setFolderPath] = useState<FolderInfo[]>([]);
  const [sidebarRenaming, setSidebarRenaming] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [selection, setSelection] = useState<Selection>(null);
  const storageRef = useRef<typeof storage>(null);
  const storageGenerationRef = useRef(0);
  const refreshRequestRef = useRef(0);
  const navigationGenerationRef = useRef(0);
  const mutationInflightRef = useRef(false);
  const rootVaultRef = useRef<VaultInfo | null>(null);
  // Keep identity and root selection current during render so callbacks cannot observe a prior
  // account between render and effect cleanup.
  // oxlint-disable-next-line react/refs
  storageRef.current = storage;
  // oxlint-disable-next-line react/refs
  rootVaultRef.current = rootVault;

  // Clear account-specific navigation state before the next identity's asynchronous refresh
  // completes.
  // oxlint-disable react/set-state-in-effect
  useEffect(() => {
    storageRef.current = storage;
    storageGenerationRef.current += 1;
    refreshRequestRef.current += 1;
    navigationGenerationRef.current += 1;
    mutationInflightRef.current = false;
    rootVaultRef.current = null;
    setVaults(null);
    setInvites(null);
    setOwnedVaultIds(new Set());
    setRootVault(null);
    setFolderPath([]);
    setSelection(null);
    setSidebarRenaming(null);
    setError(null);
    return () => {
      storageGenerationRef.current += 1;
      refreshRequestRef.current += 1;
    };
  }, [storage]);
  // oxlint-enable react/set-state-in-effect

  function isCurrentStorage(
    expectedStorage: typeof storage,
    generation: number,
    request?: number,
  ): boolean {
    return (
      !(accountSignal?.aborted ?? false) &&
      storageRef.current === expectedStorage &&
      storageGenerationRef.current === generation &&
      (request === undefined || refreshRequestRef.current === request)
    );
  }

  const clearSelectedRoot = useCallback(() => {
    navigationGenerationRef.current += 1;
    rootVaultRef.current = null;
    setRootVault(null);
    setFolderPath([]);
    setSelection(null);
    setSidebarRenaming(null);
  }, []);

  const refreshVaults = useCallback(async () => {
    if (!storage) return;
    const expectedStorage = storage;
    const generation = storageGenerationRef.current;
    const request = ++refreshRequestRef.current;
    try {
      const [result, pending] = await Promise.all([
        withAccountSignal(accountSignal, () =>
          core.listVaults(expectedStorage, { signal: accountSignal ?? undefined }),
        ),
        withAccountSignal(accountSignal, () =>
          core.listPendingInvites(expectedStorage, { signal: accountSignal ?? undefined }),
        ),
      ]);
      if (!isCurrentStorage(expectedStorage, generation, request)) return;
      setVaults(result);
      setInvites(pending);
      setError(null);
      const selectedRoot = rootVaultRef.current;
      const refreshedRoot = selectedRoot && result.find((vault) => vault.id === selectedRoot.id);
      if (selectedRoot && !refreshedRoot) {
        clearSelectedRoot();
      } else if (selectedRoot && refreshedRoot && refreshedRoot.name !== selectedRoot.name) {
        rootVaultRef.current = refreshedRoot;
        setRootVault(refreshedRoot);
      }
      let firstOwnershipError: string | null = null;
      const ownedIds = new Set<string>();
      for (const vault of result) {
        const ownership = core.getVaultOwnership(expectedStorage, vault.id);
        if (ownership.status === "owner") ownedIds.add(vault.id);
        if (!firstOwnershipError) firstOwnershipError = ownershipError(ownership);
      }
      setOwnedVaultIds(ownedIds);
      setError(firstOwnershipError);
    } catch (err) {
      if (isCurrentStorage(expectedStorage, generation, request)) {
        setOwnedVaultIds(new Set());
        setVaults(null);
        setInvites(null);
        clearSelectedRoot();
        setError(formatOperationError(err));
      }
    }
  // isCurrentStorage is intentionally a render-local identity guard.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [accountSignal, clearSelectedRoot, storage]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refreshVaults();
      if (!stopped) timer = setTimeout(() => void poll(), POLL_MS);
    };
    // The refresh callback is guarded before every state update.
    // oxlint-disable-next-line react/set-state-in-effect
    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [refreshVaults]);

  const currentFolder = folderPath[folderPath.length - 1];
  const currentTree = currentFolder ?? rootVault;

  const breadcrumb: Array<VaultInfo | FolderInfo> = rootVault
    ? [rootVault, ...folderPath.slice(0, -1)]
    : [];

  function selectRoot(vault: VaultInfo) {
    navigationGenerationRef.current += 1;
    rootVaultRef.current = vault;
    setRootVault(vault);
    setFolderPath([]);
    setSelection(null);
  }

  function openSubfolder(sub: FolderInfo) {
    navigationGenerationRef.current += 1;
    setFolderPath((prev) => [...prev, sub]);
    setSelection(null);
  }

  function navigateBreadcrumb(index: number) {
    navigationGenerationRef.current += 1;
    if (index === 0) {
      setFolderPath([]);
    } else {
      setFolderPath((prev) => prev.slice(0, index));
    }
    setSelection(null);
  }

  function handleNavUp() {
    navigationGenerationRef.current += 1;
    if (folderPath.length > 0) {
      setFolderPath((prev) => prev.slice(0, -1));
    } else {
      rootVaultRef.current = null;
      setRootVault(null);
    }
    setSelection(null);
  }

  function handleVaultRenamed(vaultId: string, name: string) {
    if (rootVaultRef.current?.id === vaultId) {
      setRootVault((current) => (current?.id === vaultId ? { ...current, name } : current));
    }
    void refreshVaults();
  }

  function handleFolderRenamed(folderId: string, name: string) {
    setFolderPath((prev) =>
      prev.map((folder) => (folder.id === folderId ? { ...folder, name } : folder)),
    );
  }

  function handleFolderDeleted(folderId: string) {
    navigationGenerationRef.current += 1;
    const index = folderPath.findIndex((folder) => folder.id === folderId);
    if (index >= 0) setFolderPath((prev) => prev.slice(0, index));
    setSelection(null);
  }

  async function handleNewVault() {
    const expectedStorage = storage;
    const generation = storageGenerationRef.current;
    const navigationGeneration = navigationGenerationRef.current;
    if (
      !expectedStorage ||
      !isCurrentStorage(expectedStorage, generation) ||
      mutationInflightRef.current
    ) return;
    mutationInflightRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const name = uniqueUntitledName(vaults ?? []);
      const created = await withAccountSignal(accountSignal, () =>
        core.createVault(expectedStorage, name, { signal: accountSignal ?? undefined }),
      );
      if (!isCurrentStorage(expectedStorage, generation)) return;
      setVaults((prev) => [...(prev ?? []), created]);
      setOwnedVaultIds((prev) => new Set(prev).add(created.id));
      if (navigationGenerationRef.current === navigationGeneration) {
        selectRoot(created);
        setSidebarRenaming({ id: created.id, name: created.name });
      }
      void refreshVaults();
    } catch (err) {
      if (isCurrentStorage(expectedStorage, generation)) setError(formatOperationError(err));
    } finally {
      if (storageGenerationRef.current === generation) mutationInflightRef.current = false;
      if (isCurrentStorage(expectedStorage, generation)) setBusy(false);
    }
  }

  async function commitSidebarRename() {
    if (!sidebarRenaming) return;
    const expectedStorage = storage;
    const generation = storageGenerationRef.current;
    const target = sidebarRenaming;
    if (
      !expectedStorage ||
      !isCurrentStorage(expectedStorage, generation) ||
      mutationInflightRef.current
    ) return;
    const targetName = target.name;
    const ownership = core.getVaultOwnership(expectedStorage, target.id);
    if (ownership.status !== "owner") {
      if (ownership.status === "unknown") setError(ownershipError(ownership));
      return;
    }
    mutationInflightRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const renamed = await withAccountSignal(accountSignal, () =>
        core.renameVault(expectedStorage, target.id, targetName, { signal: accountSignal ?? undefined }),
      );
      if (!isCurrentStorage(expectedStorage, generation)) return;
      handleVaultRenamed(renamed.id, renamed.name);
    } catch (err) {
      if (isCurrentStorage(expectedStorage, generation)) setError(formatOperationError(err));
    } finally {
      if (storageGenerationRef.current === generation) mutationInflightRef.current = false;
      if (isCurrentStorage(expectedStorage, generation)) {
        setBusy(false);
        setSidebarRenaming(null);
      }
    }
  }

  async function handleDeleteVault(vault: VaultInfo) {
    const expectedStorage = storage;
    const generation = storageGenerationRef.current;
    if (
      !expectedStorage ||
      !isCurrentStorage(expectedStorage, generation) ||
      mutationInflightRef.current
    ) return;
    const ownership = core.getVaultOwnership(expectedStorage, vault.id);
    if (ownership.status !== "owner") {
      if (ownership.status === "unknown") setError(ownershipError(ownership));
      return;
    }
    if (!confirm(`Delete empty vault "${vault.name}"? Delete its files and child folders first.`)) return;
    mutationInflightRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await withAccountSignal(accountSignal, () =>
        core.deleteVault(expectedStorage, vault.id, { signal: accountSignal ?? undefined }),
      );
      // A successful delete changes the SDK's ownership projection immediately. Refresh based on
      // the confirmed mutation result, not on the post-delete owner snapshot.
      if (!isCurrentStorage(expectedStorage, generation)) return;
      if (rootVaultRef.current?.id === vault.id) {
        rootVaultRef.current = null;
        setRootVault(null);
        setFolderPath([]);
        setSelection(null);
      }
      await refreshVaults();
    } catch (err) {
      if (isCurrentStorage(expectedStorage, generation)) setError(formatOperationError(err));
    } finally {
      if (storageGenerationRef.current === generation) mutationInflightRef.current = false;
      if (isCurrentStorage(expectedStorage, generation)) setBusy(false);
    }
  }

  async function handleAcceptInvite(vaultId: string) {
    const expectedStorage = storage;
    const generation = storageGenerationRef.current;
    if (
      !expectedStorage ||
      !isCurrentStorage(expectedStorage, generation) ||
      mutationInflightRef.current
    ) return;
    mutationInflightRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await withAccountSignal(accountSignal, () =>
        core.joinVault(expectedStorage, vaultId, { signal: accountSignal ?? undefined }),
      );
      if (!isCurrentStorage(expectedStorage, generation)) return;
      await refreshVaults();
    } catch (err) {
      if (isCurrentStorage(expectedStorage, generation)) setError(formatOperationError(err));
    } finally {
      if (storageGenerationRef.current === generation) mutationInflightRef.current = false;
      if (isCurrentStorage(expectedStorage, generation)) setBusy(false);
    }
  }

  async function handleDeclineInvite(vaultId: string) {
    const expectedStorage = storage;
    const generation = storageGenerationRef.current;
    if (
      !expectedStorage ||
      !isCurrentStorage(expectedStorage, generation) ||
      mutationInflightRef.current
    ) return;
    mutationInflightRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await withAccountSignal(accountSignal, () =>
        core.declineInvite(expectedStorage, vaultId, { signal: accountSignal ?? undefined }),
      );
      if (!isCurrentStorage(expectedStorage, generation)) return;
      await refreshVaults();
    } catch (err) {
      if (isCurrentStorage(expectedStorage, generation)) setError(formatOperationError(err));
    } finally {
      if (storageGenerationRef.current === generation) mutationInflightRef.current = false;
      if (isCurrentStorage(expectedStorage, generation)) setBusy(false);
    }
  }

  return (
    <div className="file-manager" data-testid="file-manager">
      <aside className="vault-sidebar">
        <h2 className="sidebar-title">Vaults</h2>

        <button
          type="button"
          className="btn btn-primary sidebar-new-vault"
          onClick={() => void handleNewVault()}
          disabled={busy}
          data-testid="create-vault"
        >
          New vault
        </button>

        {invites != null && invites.length > 0 && (
          <section className="invite-section" data-testid="invite-list">
            <h3 className="sidebar-subtitle">Invitations</h3>
            <ul className="invite-list">
              {invites.map((inv) => (
                <li
                  key={inv.id}
                  className="invite-item"
                  data-testid="invite-item"
                  data-vault-id={inv.id}
                >
                  <span className="invite-name">{inv.name}</span>
                  <div className="invite-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={busy}
                      onClick={() => void handleAcceptInvite(inv.id)}
                      data-testid="accept-invite"
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => void handleDeclineInvite(inv.id)}
                      data-testid="decline-invite"
                    >
                      Decline
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {error && (
          <p className="error" data-testid="vault-list-error">
            {error}
          </p>
        )}

        {vaults === null ? (
          <p className="muted">Loading…</p>
        ) : vaults.length === 0 ? (
          <p className="muted" data-testid="no-vaults">
            No vaults yet.
          </p>
        ) : (
          <ul className="vault-list" data-testid="vault-list">
            {vaults.map((vault) => (
              <li key={vault.id} data-testid="vault-item" data-vault-id={vault.id}>
                {sidebarRenaming?.id === vault.id ? (
                  <input
                    className="tc-field rename-input sidebar-rename"
                    aria-label={`Rename vault ${vault.name}`}
                    value={sidebarRenaming.name}
                    autoFocus
                    onChange={(e) =>
                      setSidebarRenaming({ ...sidebarRenaming, name: e.target.value })
                    }
                    onBlur={() => void commitSidebarRename()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitSidebarRename();
                      if (e.key === "Escape") setSidebarRenaming(null);
                    }}
                    data-testid="rename-vault-input"
                  />
                ) : (
                  <button
                    type="button"
                    className={`vault-list-btn${rootVault?.id === vault.id ? " active" : ""}`}
                    onClick={() => selectRoot(vault)}
                  >
                    {vault.name}
                  </button>
                )}
                {ownedVaultIds.has(vault.id) && sidebarRenaming?.id !== vault.id && (
                  <div className="vault-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSidebarRenaming({ id: vault.id, name: vault.name });
                      }}
                      data-testid="rename-vault"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDeleteVault(vault);
                      }}
                      data-testid="delete-vault"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="vault-main">
        {!currentTree ? (
          <div className="empty-panel muted" data-testid="select-vault-prompt">
            Select or create a vault to browse files.
          </div>
        ) : (
          <VaultContents
            treeId={currentTree.id}
            breadcrumb={[...breadcrumb, ...(currentFolder ? [currentFolder] : [])]}
            isVaultRoot={folderPath.length === 0}
            onNavigate={navigateBreadcrumb}
            onNavUp={handleNavUp}
            onOpenSubfolder={openSubfolder}
            onFolderRenamed={handleFolderRenamed}
            onFolderDeleted={handleFolderDeleted}
            selection={selection}
            onSelect={setSelection}
          />
        )}
      </section>

      {currentTree && (
        <DetailsPanel
          treeId={currentTree.id}
          isVaultRoot={folderPath.length === 0}
          selection={selection}
        />
      )}
    </div>
  );
}

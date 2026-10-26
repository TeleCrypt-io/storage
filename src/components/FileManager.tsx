import { useCallback, useEffect, useRef, useState } from "react";
import { useStorage } from "../context/StorageContext";
import * as core from "../lib/core";
import type { FolderInfo, TreeActionCapabilities, VaultInfo } from "../lib/core";
import { formatOperationError } from "../lib/formatOperationError";
import { withAccountSignal } from "../lib/accountOperation";
import {
  clearPendingUpload,
  loadPendingUploads,
  savePendingUpload,
  samePendingUpload,
  type PendingUpload,
} from "../lib/pendingUploads";
import { DetailsPanel, type Selection } from "./DetailsPanel";
import { VaultContents } from "./VaultContents";

const POLL_MS = 2500;
const UNTITLED = "Untitled vault";

function uniqueUntitledName(existing: VaultInfo[]): string {
  const names = new Set(existing.map((vault) => vault.name.toLowerCase()));
  if (!names.has(UNTITLED.toLowerCase())) return UNTITLED;
  let i = 2;
  while (names.has(`${UNTITLED} ${i}`.toLowerCase())) i++;
  return `${UNTITLED} ${i}`;
}

export function FileManager() {
  const { storage, session, accountSignal } = useStorage();
  const accountHomeserver = session?.homeserver;
  const accountUserId = session?.userId;
  const [vaults, setVaults] = useState<VaultInfo[] | null>(null);
  const [vaultActions, setVaultActions] = useState<Record<string, TreeActionCapabilities>>({});
  const [invites, setInvites] = useState<VaultInfo[] | null>(null);
  const [mutationError, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const error = [mutationError, refreshError].filter(Boolean).join("\n") || null;
  const [busy, setBusy] = useState(false);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const cleanupInflightRef = useRef(false);
  const [rootVault, setRootVault] = useState<VaultInfo | null>(null);
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
  const treeCreationCountRef = useRef(0);
  const rootVaultRef = useRef<VaultInfo | null>(null);
  // Keep confirmed local selection if its first refresh fails. A successful
  // listing is authoritative even when another client has already deleted it.
  const pendingVaultIdsRef = useRef(new Set<string>());
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
    pendingVaultIdsRef.current.clear();
    rootVaultRef.current = null;
    setVaults(null);
    setVaultActions({});
    setInvites(null);
    setRootVault(null);
    setFolderPath([]);
    setSelection(null);
    setSidebarRenaming(null);
    setError(null);
    setRefreshError(null);
    return () => {
      storageGenerationRef.current += 1;
      refreshRequestRef.current += 1;
    };
  }, [storage]);
  // oxlint-enable react/set-state-in-effect

  // Cleanup receipts contain only remote identifiers and survive reload, logout, and tab closure.
  // oxlint-disable react/set-state-in-effect
  useEffect(() => {
    setPendingUploads([]);
    setCleanupError(null);
    setCleanupBusy(false);
    cleanupInflightRef.current = false;
    if (!accountHomeserver || !accountUserId) return;
    try {
      setPendingUploads(loadPendingUploads({ homeserver: accountHomeserver, userId: accountUserId }));
    } catch (error) {
      setCleanupError(formatOperationError(error));
    }
  }, [storage, accountHomeserver, accountUserId]);
  // oxlint-enable react/set-state-in-effect

  function handlePartialUpload(expectedStorage: core.TeleCryptIOStorage, failure: core.MutationPartialError) {
    if (!session) return false;
    const isCurrent = storageRef.current === expectedStorage && !accountSignal?.aborted;
    const [mediaId, fileId] = failure.completedIds;
    if (failure.operation !== "file upload" || !failure.treeId || !mediaId) return false;
    const target = { treeId: failure.treeId, mediaId, fileId };
    if (isCurrent) {
      setCleanupError(formatOperationError(failure));
      setPendingUploads((current) => current.some((item) => samePendingUpload(item, target)) ? current : [...current, target]);
    }
    try {
      savePendingUpload(session, target);
    } catch (error) {
      if (isCurrent) setCleanupError(`Upload cleanup details could not be saved; keep this page open. ${formatOperationError(error)}`);
    }
    return true;
  }

  async function handleCleanupUpload(target: PendingUpload) {
    if (!storage || !session || cleanupInflightRef.current) return;
    const expectedStorage = storage;
    const generation = storageGenerationRef.current;
    cleanupInflightRef.current = true;
    setCleanupBusy(true);
    setCleanupError(null);
    try {
      await withAccountSignal(accountSignal, () => core.cleanupFileUpload(
        expectedStorage, target.treeId, target.mediaId, target.fileId,
        { signal: accountSignal ?? undefined },
      ));
      // Persist confirmed cleanup even if the user navigated while the request was in flight.
      clearPendingUpload(session, target);
      if (isCurrentStorage(expectedStorage, generation)) {
        setPendingUploads((current) => current.filter((item) => !samePendingUpload(item, target)));
      }
    } catch (error) {
      if (isCurrentStorage(expectedStorage, generation)) setCleanupError(formatOperationError(error));
    } finally {
      if (isCurrentStorage(expectedStorage, generation)) {
        cleanupInflightRef.current = false;
        setCleanupBusy(false);
      }
    }
  }

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
    // A background refresh is not user navigation. Keep it from cancelling
    // an in-flight create that should select its newly created vault.
    rootVaultRef.current = null;
    setRootVault(null);
    setFolderPath([]);
    setSelection(null);
    setSidebarRenaming(null);
  }, []);

  const refreshVaults = useCallback(async () => {
    if (!storage || treeCreationCountRef.current > 0) return;
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
      // The request generation excludes pre-mutation reads. This successful
      // result owns subsequent names and membership, including remote deletions.
      const refreshedVaults = result;
      const actionEntries = await Promise.all(refreshedVaults.map(async (vault) => {
        try {
          return {
            vaultId: vault.id,
            capabilities: await core.getTreeActionCapabilities(expectedStorage, vault.id, {
              signal: accountSignal ?? undefined,
            }),
          };
        } catch (error) {
          return { vaultId: vault.id, capabilities: null, error };
        }
      }));
      if (!isCurrentStorage(expectedStorage, generation, request)) return;
      const nextActions = Object.fromEntries(
        actionEntries
          .filter((entry): entry is typeof entry & { capabilities: TreeActionCapabilities } => entry.capabilities !== null)
          .map(({ vaultId, capabilities }) => [vaultId, capabilities]),
      );
      pendingVaultIdsRef.current.clear();
      setVaults(refreshedVaults);
      setVaultActions(nextActions);
      setInvites(pending);
      const capabilityFailure = actionEntries.find((entry) => entry.capabilities === null)?.error;
      setRefreshError(capabilityFailure ? formatOperationError(capabilityFailure) : null);
      const selectedRoot = rootVaultRef.current;
      const refreshedRoot = selectedRoot && refreshedVaults.find((vault) => vault.id === selectedRoot.id);
      if (selectedRoot && !refreshedRoot) {
        clearSelectedRoot();
      } else if (selectedRoot && refreshedRoot && refreshedRoot.name !== selectedRoot.name) {
        rootVaultRef.current = refreshedRoot;
        setRootVault(refreshedRoot);
      }
    } catch (err) {
      if (isCurrentStorage(expectedStorage, generation, request)) {
        const selectedRoot = rootVaultRef.current;
        if (selectedRoot && pendingVaultIdsRef.current.has(selectedRoot.id)) {
          setRefreshError(formatOperationError(err));
          return;
        }
        setVaults(null);
        setVaultActions({});
        setInvites(null);
        clearSelectedRoot();
        setRefreshError(formatOperationError(err));
      }
    }
  // isCurrentStorage is intentionally a render-local identity guard.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [accountSignal, clearSelectedRoot, storage]);

  const handleTreeCreationStateChange = useCallback((creating: boolean) => {
    if (creating) {
      treeCreationCountRef.current += 1;
      if (treeCreationCountRef.current === 1) refreshRequestRef.current += 1;
      return;
    }
    if (treeCreationCountRef.current === 0) return;
    treeCreationCountRef.current -= 1;
    if (treeCreationCountRef.current === 0) void refreshVaults();
  }, [refreshVaults]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!mutationInflightRef.current && treeCreationCountRef.current === 0) {
        await refreshVaults();
      }
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
    pendingVaultIdsRef.current.add(vaultId);
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
      pendingVaultIdsRef.current.add(created.id);
      setVaults((prev) => {
        const current = prev ?? [];
        return current.some((vault) => vault.id === created.id)
          ? current.map((vault) => (vault.id === created.id ? created : vault))
          : [...current, created];
      });
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
      pendingVaultIdsRef.current.delete(vault.id);
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
                {sidebarRenaming?.id !== vault.id && (vaultActions[vault.id]?.renameTree || vaultActions[vault.id]?.deleteTree) && (
                  <div className="vault-actions">
                    {vaultActions[vault.id]?.renameTree && <button
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
                    </button>}
                    {vaultActions[vault.id]?.deleteTree && <button
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
                    </button>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="vault-main">
        {(pendingUploads.length > 0 || cleanupError) && (
          <div className="error" data-testid="pending-upload-cleanup">
            {pendingUploads.map((target) => (
              <p key={`${target.treeId}:${target.mediaId}`}>
                An upload did not finish. Remove its stored data before retrying.
                {" "}
                <button className="btn btn-sm" disabled={cleanupBusy} onClick={() => void handleCleanupUpload(target)} data-testid="cleanup-upload">
                  Clean up upload
                </button>
              </p>
            ))}
            {cleanupError && <p data-testid="upload-cleanup-error">{cleanupError}</p>}
          </div>
        )}
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
            onTreeCreationStateChange={handleTreeCreationStateChange}
            onPartialUpload={handlePartialUpload}
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

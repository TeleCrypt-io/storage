import { useCallback, useEffect, useRef, useState } from "react";
import { useStorage } from "../context/StorageContext";
import * as core from "../lib/core";
import type { FileDetails, FolderDetails, VaultDetails } from "../lib/core";
import { MembersPanel } from "./MembersPanel";
import { withAccountSignal } from "../lib/accountOperation";
import { formatOperationError } from "../lib/formatOperationError";

function formatSize(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export type Selection =
  | { kind: "file"; id: string; treeId: string }
  | { kind: "folder"; id: string; treeId: string }
  | null;

export function DetailsPanel({
  treeId,
  isVaultRoot,
  selection,
}: {
  treeId: string;
  isVaultRoot: boolean;
  selection: Selection;
}) {
  const { storage, accountSignal } = useStorage();
  const [fileDetails, setFileDetails] = useState<FileDetails | null>(null);
  const [treeDetails, setTreeDetails] = useState<(VaultDetails | FolderDetails) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const activeSelection = selection && selection.treeId === treeId ? selection : null;
  const selectionKey = activeSelection
    ? `${activeSelection.kind}:${activeSelection.id}:${activeSelection.treeId}`
    : "none";
  const identityRef = useRef<{
    storage: typeof storage;
    treeId: string;
    isVaultRoot: boolean;
    selectionKey: string;
  }>({ storage: null, treeId: "", isVaultRoot: false, selectionKey: "" });
  const identityGenerationRef = useRef(0);
  const refreshRequestRef = useRef(0);
  // Keep identity current during render so callbacks cannot observe a prior selection between
  // render and effect cleanup.
  // oxlint-disable-next-line react/refs
  identityRef.current = { storage, treeId, isVaultRoot, selectionKey };

  // Clear detail state before the next identity's asynchronous request completes.
  // oxlint-disable react/set-state-in-effect
  useEffect(() => {
    identityRef.current = { storage, treeId, isVaultRoot, selectionKey };
    identityGenerationRef.current += 1;
    refreshRequestRef.current += 1;
    setFileDetails(null);
    setTreeDetails(null);
    setError(null);
    setLoading(Boolean(storage));
    return () => {
      identityGenerationRef.current += 1;
      refreshRequestRef.current += 1;
    };
  }, [storage, treeId, isVaultRoot, selectionKey]);
  // oxlint-enable react/set-state-in-effect

  const targetTreeId = activeSelection?.treeId ?? treeId;
  const showingFile = activeSelection?.kind === "file";
  const showingSubfolder = activeSelection?.kind === "folder" && activeSelection.id !== treeId;

  const refresh = useCallback(async () => {
    if (!storage) return;
    const generation = identityGenerationRef.current;
    const request = ++refreshRequestRef.current;
    const isCurrent = () =>
      !(accountSignal?.aborted ?? false) &&
      generation === identityGenerationRef.current &&
      request === refreshRequestRef.current &&
      identityRef.current.storage === storage &&
      identityRef.current.treeId === treeId &&
      identityRef.current.isVaultRoot === isVaultRoot &&
      identityRef.current.selectionKey === selectionKey;
    if (!isCurrent()) return;
    setLoading(true);
    try {
      if (showingFile && activeSelection?.kind === "file") {
        const details = await withAccountSignal(accountSignal, () =>
          core.getFileDetails(storage, targetTreeId, activeSelection.id, {
            signal: accountSignal ?? undefined,
          }),
        );
        if (!isCurrent()) return;
        setFileDetails(details);
        setTreeDetails(null);
      } else {
        let details: VaultDetails | FolderDetails;
        if (showingSubfolder && activeSelection?.kind === "folder") {
          details = await withAccountSignal(accountSignal, () =>
            core.getFolderDetails(storage, activeSelection.id, {
              signal: accountSignal ?? undefined,
            }),
          );
        } else if (isVaultRoot) {
          details = await withAccountSignal(accountSignal, () =>
            core.getVaultDetails(storage, treeId, { signal: accountSignal ?? undefined }),
          );
        } else {
          details = await withAccountSignal(accountSignal, () =>
            core.getFolderDetails(storage, treeId, { signal: accountSignal ?? undefined }),
          );
        }
        if (!isCurrent()) return;
        setTreeDetails(details);
        setFileDetails(null);
      }
      if (isCurrent()) setError(null);
    } catch (err) {
      if (!isCurrent()) return;
      setFileDetails(null);
      setTreeDetails(null);
      setError(formatOperationError(err));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [
    storage,
    treeId,
    isVaultRoot,
    targetTreeId,
    activeSelection,
    selectionKey,
    showingFile,
    showingSubfolder,
    accountSignal,
  ]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refresh();
      if (!stopped) timer = setTimeout(() => void poll(), 4000);
    };
    // The refresh callback is guarded before every state update.
    // oxlint-disable-next-line react/set-state-in-effect
    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [refresh]);

  return (
    <aside className="right-panel" data-testid="details-panel">
      <section className="details-section">
        <h3 className="panel-section-title">Details</h3>
        {error && (
          <p className="error" data-testid="details-error">
            {error}
          </p>
        )}
        {loading && !fileDetails && !treeDetails ? (
          <p className="muted">Loading…</p>
        ) : showingFile && fileDetails ? (
          <dl className="details-list">
            <div>
              <dt>Name</dt>
              <dd>{fileDetails.name}</dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>{fileDetails.mimetype ?? "—"}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{formatSize(fileDetails.size)}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{formatDate(fileDetails.createdAt)}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{formatDate(fileDetails.updatedAt)}</dd>
            </div>
          </dl>
        ) : treeDetails ? (
          <dl className="details-list">
            <div>
              <dt>Name</dt>
              <dd>{treeDetails.name}</dd>
            </div>
            <div>
              <dt>ID</dt>
              <dd className="muted details-id">{treeDetails.id}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{formatDate(treeDetails.createdAt)}</dd>
            </div>
            <div>
              <dt>Members</dt>
              <dd>{treeDetails.memberCount ?? "—"}</dd>
            </div>
          </dl>
        ) : (
          <p className="muted">—</p>
        )}
      </section>

      {isVaultRoot && (
        <section className="access-section">
          <MembersPanel vaultId={treeId} embedded />
        </section>
      )}
    </aside>
  );
}

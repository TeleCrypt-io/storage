import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type MouseEvent,
} from "react";
import { useStorage } from "../context/StorageContext";
import * as core from "../lib/core";
import type { FileInfo, FolderInfo, TeleCryptIOStorage, VaultInfo } from "../lib/core";
import { formatOperationError } from "../lib/formatOperationError";
import { withAccountSignal } from "../lib/accountOperation";
import {
  FILE_TOO_LARGE_ERROR,
  isFileWithinLimit,
  readFileBytes,
} from "../lib/fileLimits";
import type { Selection } from "./DetailsPanel";

const POLL_MS = 2500;
const UNTITLED_SUBFOLDER = "Untitled folder";

type MutationIdentity = {
  storage: TeleCryptIOStorage;
  treeId: string;
  generation: number;
  request: number;
  signal: AbortSignal | null;
};

function validateUploadSelection(files: File[], preservePaths: boolean): string[] {
  if (files.some((file) => !isFileWithinLimit(file))) throw new Error(FILE_TOO_LARGE_ERROR);
  return files.map((file) =>
    preservePaths
      ? (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
      : file.name,
  );
}

function uniqueUntitledSubfolderName(existing: FolderInfo[]): string {
  const names = new Set(existing.map((f) => f.name.toLowerCase()));
  if (!names.has(UNTITLED_SUBFOLDER.toLowerCase())) return UNTITLED_SUBFOLDER;
  let i = 2;
  while (names.has(`${UNTITLED_SUBFOLDER} ${i}`.toLowerCase())) i++;
  return `${UNTITLED_SUBFOLDER} ${i}`;
}

function FolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 4.5A1 1 0 0 1 2.5 3.5h3.17l1.33 1.33h6.5a1 1 0 0 1 1 1v7.17a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1V4.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4.5 1.5h4.59L12.5 4.91v9.59a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M9 1.5v3.5h3.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/** Ensure nested path segments exist under a vault or folder; returns the leaf folder ID. */
async function ensurePath(
  storage: TeleCryptIOStorage,
  rootTreeId: string,
  relativePath: string,
  isCurrent: () => boolean,
  pathLocks: Map<string, Promise<void>>,
  signal: AbortSignal | null,
): Promise<string | null> {
  const parts = relativePath.split("/").filter(Boolean);
  if (parts.length <= 1) return rootTreeId;

  let currentId = rootTreeId;
  for (const segment of parts.slice(0, -1)) {
    if (!isCurrent()) return null;
    const lockKey = `${rootTreeId}\u0000${currentId}\u0000${segment}`;
    const previous = pathLocks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    pathLocks.set(lockKey, lock);
    try {
      await previous;
      if (!isCurrent()) return null;
      // Re-list after waiting for an earlier creator. This makes concurrent folder uploads share
      // one child instead of racing two createSubfolder calls for the same path segment.
      const subs = await withAccountSignal(signal, () =>
        core.listSubfolders(storage, currentId, { signal: signal ?? undefined }),
      );
      if (!isCurrent()) return null;
      const existing = subs.find((s) => s.name === segment);
      if (existing) {
        currentId = existing.id;
      } else {
        if (!isCurrent()) return null;
        const created = await withAccountSignal(signal, () =>
          core.createSubfolder(storage, currentId, segment, { signal: signal ?? undefined }),
        );
        if (!isCurrent()) return null;
        currentId = created.id;
      }
    } finally {
      release();
      if (pathLocks.get(lockKey) === lock) pathLocks.delete(lockKey);
    }
  }
  return currentId;
}

export function VaultContents({
  treeId,
  breadcrumb,
  isVaultRoot,
  onNavigate,
  onNavUp,
  onOpenSubfolder,
  onFolderRenamed,
  onFolderDeleted,
  selection,
  onSelect,
}: {
  treeId: string;
  breadcrumb: Array<VaultInfo | FolderInfo>;
  isVaultRoot: boolean;
  onNavigate: (index: number) => void;
  onNavUp: () => void;
  onOpenSubfolder: (sub: FolderInfo) => void;
  onFolderRenamed: (folderId: string, name: string) => void;
  onFolderDeleted: (folderId: string) => void;
  selection: Selection;
  onSelect: (sel: Selection) => void;
}) {
  const { storage, accountSignal } = useStorage();
  const [files, setFiles] = useState<FileInfo[] | null>(null);
  const [subfolders, setSubfolders] = useState<FolderInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [renaming, setRenaming] = useState<{ kind: "file" | "folder"; id: string; name: string } | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const identityRef = useRef<{ storage: TeleCryptIOStorage | null; treeId: string }>({
    storage: null,
    treeId: "",
  });
  const identityGenerationRef = useRef(0);
  const refreshRequestRef = useRef(0);
  const mutationRequestRef = useRef(0);
  const mutationInFlightRef = useRef(false);
  const pathLocksRef = useRef(new Map<string, Promise<void>>());
  const selectionRef = useRef<Selection>(selection);
  // Keep identity and selection current during render so callbacks cannot observe a prior tree
  // between render and effect cleanup.
  // oxlint-disable-next-line react/refs
  identityRef.current = { storage, treeId };
  // oxlint-disable-next-line react/refs
  selectionRef.current = selection;

  // Clear tree-specific contents before the next identity's asynchronous refresh completes.
  // oxlint-disable react/set-state-in-effect
  useEffect(() => {
    identityRef.current = { storage, treeId };
    identityGenerationRef.current += 1;
    refreshRequestRef.current += 1;
    mutationRequestRef.current += 1;
    mutationInFlightRef.current = false;
    setFiles(null);
    setSubfolders(null);
    setError(null);
    setBusy(false);
    setRenaming(null);
    return () => {
      identityGenerationRef.current += 1;
      refreshRequestRef.current += 1;
      mutationRequestRef.current += 1;
    };
  }, [storage, treeId]);
  // oxlint-enable react/set-state-in-effect

  function captureMutation(): MutationIdentity | null {
    if (!storage || mutationInFlightRef.current || (accountSignal?.aborted ?? false)) return null;
    mutationInFlightRef.current = true;
    return {
      storage,
      treeId,
      generation: identityGenerationRef.current,
      request: ++mutationRequestRef.current,
      signal: accountSignal,
    };
  }

  function releaseMutation(operation: MutationIdentity): void {
    if (mutationRequestRef.current === operation.request) mutationInFlightRef.current = false;
  }

  function isCurrentMutation(operation: MutationIdentity | null): operation is MutationIdentity {
    return Boolean(
      operation &&
        !(operation.signal?.aborted ?? false) &&
        identityRef.current.storage === operation.storage &&
        identityRef.current.treeId === operation.treeId &&
        identityGenerationRef.current === operation.generation &&
        mutationRequestRef.current === operation.request,
    );
  }

  const refresh = useCallback(async (operation?: MutationIdentity) => {
    if (!storage) return;
    const generation = identityGenerationRef.current;
    const request = ++refreshRequestRef.current;
    const isCurrentRefresh = () =>
      (!operation || mutationRequestRef.current === operation.request) &&
      !(accountSignal?.aborted ?? false) &&
      !(operation?.signal?.aborted ?? false) &&
      generation === identityGenerationRef.current &&
      identityRef.current.storage === storage &&
      identityRef.current.treeId === treeId;
    try {
      const signal = operation?.signal ?? accountSignal;
      const [fileList, subList] = await Promise.all([
        withAccountSignal(signal, () =>
          core.listFiles(storage, treeId, { signal: signal ?? undefined }),
        ),
        withAccountSignal(signal, () =>
          core.listSubfolders(storage, treeId, { signal: signal ?? undefined }),
        ),
      ]);
      if (request !== refreshRequestRef.current || !isCurrentRefresh()) {
        return;
      }
      setFiles(fileList);
      setSubfolders(subList);
      setError(null);
    } catch (err) {
      if (request === refreshRequestRef.current && isCurrentRefresh()) {
        setFiles(null);
        setSubfolders(null);
        setError(formatOperationError(err));
      }
    }
  }, [accountSignal, storage, treeId]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refresh();
      if (!stopped) timer = setTimeout(() => void poll(), POLL_MS);
    };
    // The refresh callback is guarded before every state update.
    // oxlint-disable-next-line react/set-state-in-effect
    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [refresh]);

  async function uploadBytes(
    operation: MutationIdentity,
    targetTreeId: string,
    name: string,
    bytes: Uint8Array,
    mimetype: string,
  ) {
    if (!isCurrentMutation(operation)) return false;
    setBusy(true);
    setError(null);
    try {
      await withAccountSignal(operation.signal, () =>
        core.uploadFile(operation.storage, targetTreeId, name, bytes, mimetype, {
          signal: operation.signal ?? undefined,
        }),
      );
      if (isCurrentMutation(operation)) await refresh(operation);
    } catch (err) {
      if (isCurrentMutation(operation)) setError(formatOperationError(err));
      return false;
    }
    return isCurrentMutation(operation);
  }

  async function handleUpload(e: ChangeEvent<HTMLInputElement>) {
    const list = e.target.files;
    if (!list?.length) return;
    const selectedFiles = Array.from(list);
    try {
      validateUploadSelection(selectedFiles, false);
    } catch (err) {
      setError(formatOperationError(err));
      e.target.value = "";
      return;
    }
    const operation = captureMutation();
    if (!operation) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of selectedFiles) {
        const bytes = await readFileBytes(file);
        const mimetype = file.type || "application/octet-stream";
        if (!(await uploadBytes(operation, operation.treeId, file.name, bytes, mimetype))) return;
      }
    } catch (err) {
      if (isCurrentMutation(operation)) setError(formatOperationError(err));
    } finally {
      releaseMutation(operation);
      if (isCurrentMutation(operation)) {
        setBusy(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    }
  }

  async function handleFolderUpload(e: ChangeEvent<HTMLInputElement>) {
    const list = e.target.files;
    if (!list?.length || !storage) return;
    const selectedFiles = Array.from(list);
    let relativePaths: string[];
    try {
      relativePaths = validateUploadSelection(selectedFiles, true);
    } catch (err) {
      setError(formatOperationError(err));
      e.target.value = "";
      return;
    }
    const operation = captureMutation();
    if (!operation) return;
    setBusy(true);
    setError(null);
    try {
      for (const [index, file] of selectedFiles.entries()) {
        if (!isCurrentMutation(operation)) return;
        const rel = relativePaths[index]!;
        const bytes = await readFileBytes(file);
        if (!isCurrentMutation(operation)) return;
        const targetId = await ensurePath(
          operation.storage,
          operation.treeId,
          rel,
          () => isCurrentMutation(operation),
          pathLocksRef.current,
          operation.signal,
        );
        if (targetId === null || !isCurrentMutation(operation)) return;
        const fileName = rel.includes("/") ? rel.split("/").pop()! : rel;
        await withAccountSignal(
          operation.signal,
          () => core.uploadFile(
            operation.storage,
            targetId,
            fileName,
            bytes,
            file.type || "application/octet-stream",
            { signal: operation.signal ?? undefined },
          ),
        );
      }
      if (isCurrentMutation(operation)) await refresh(operation);
    } catch (err) {
      if (isCurrentMutation(operation)) setError(formatOperationError(err));
    } finally {
      releaseMutation(operation);
      if (isCurrentMutation(operation)) {
        setBusy(false);
        if (folderInputRef.current) folderInputRef.current.value = "";
      }
    }
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const list = e.dataTransfer.files;
    if (!list.length) return;
    const selectedFiles = Array.from(list);
    try {
      validateUploadSelection(selectedFiles, false);
    } catch (err) {
      setError(formatOperationError(err));
      return;
    }
    const operation = captureMutation();
    if (!operation) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of selectedFiles) {
        const bytes = await readFileBytes(file);
        if (!(await uploadBytes(operation, operation.treeId, file.name, bytes, file.type || "application/octet-stream"))) {
          return;
        }
      }
    } catch (err) {
      if (isCurrentMutation(operation)) setError(formatOperationError(err));
    } finally {
      releaseMutation(operation);
      if (isCurrentMutation(operation)) setBusy(false);
    }
  }

  async function handleDownload(f: FileInfo) {
    const operation = captureMutation();
    if (!operation) return;
    setBusy(true);
    setError(null);
    try {
      const result = await withAccountSignal(
        operation.signal,
        () =>
          core.downloadFile(operation.storage, operation.treeId, f.id, {
            signal: operation.signal ?? undefined,
          }),
      );
      if (!isCurrentMutation(operation)) return;
      const bytes = Uint8Array.from(result.bytes);
      const blob = new Blob([bytes], { type: result.mimetype });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.name;
      a.setAttribute("data-testid", "download-anchor");
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Let the browser enqueue the download before releasing the object URL. Immediate
      // revocation is racy in some browsers and can produce a zero-byte download.
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      if (isCurrentMutation(operation)) setError(formatOperationError(err));
    } finally {
      releaseMutation(operation);
      if (isCurrentMutation(operation)) setBusy(false);
    }
  }

  async function handleDeleteFile(fileId: string) {
    if (!confirm("Delete this file?")) return;
    const operation = captureMutation();
    if (!operation) return;
    setBusy(true);
    setError(null);
    try {
      await withAccountSignal(operation.signal, () =>
        core.deleteFile(operation.storage, operation.treeId, fileId, {
          signal: operation.signal ?? undefined,
        }),
      );
      if (!isCurrentMutation(operation)) return;
      if (
        selectionRef.current?.kind === "file" &&
        selectionRef.current.id === fileId &&
        selectionRef.current.treeId === operation.treeId
      ) {
        onSelect(null);
      }
      await refresh(operation);
    } catch (err) {
      if (isCurrentMutation(operation)) setError(formatOperationError(err));
    } finally {
      releaseMutation(operation);
      if (isCurrentMutation(operation)) setBusy(false);
    }
  }

  async function handleDeleteSubfolder(subId: string) {
    if (!confirm("Delete this empty folder? Delete its files and child folders first.")) return;
    const operation = captureMutation();
    if (!operation) return;
    setBusy(true);
    setError(null);
    try {
      await withAccountSignal(operation.signal, () =>
        core.deleteFolder(operation.storage, subId, { signal: operation.signal ?? undefined }),
      );
      if (!isCurrentMutation(operation)) return;
      if (selectionRef.current?.id === subId && selectionRef.current.treeId === operation.treeId) {
        onSelect(null);
      }
      onFolderDeleted(subId);
      await refresh(operation);
    } catch (err) {
      if (isCurrentMutation(operation)) setError(formatOperationError(err));
    } finally {
      releaseMutation(operation);
      if (isCurrentMutation(operation)) setBusy(false);
    }
  }

  async function commitRename() {
    if (!renaming) return;
    const operation = captureMutation();
    if (!operation) return;
    const target = renaming;
    const targetName = target.name;
    setBusy(true);
    setError(null);
    try {
      if (target.kind === "file") {
        await withAccountSignal(
          operation.signal,
          () => core.renameFile(operation.storage, operation.treeId, target.id, targetName, {
            signal: operation.signal ?? undefined,
          }),
        );
      } else {
        const renamed = await withAccountSignal(
          operation.signal,
          () => core.renameFolder(operation.storage, target.id, targetName, {
            signal: operation.signal ?? undefined,
          }),
        );
        if (!isCurrentMutation(operation)) return;
        onFolderRenamed(renamed.id, renamed.name);
      }
      if (isCurrentMutation(operation)) await refresh(operation);
    } catch (err) {
      if (isCurrentMutation(operation)) setError(formatOperationError(err));
    } finally {
      releaseMutation(operation);
      if (isCurrentMutation(operation)) {
        setBusy(false);
        setRenaming(null);
      }
    }
  }

  async function handleNewSubfolder() {
    const operation = captureMutation();
    if (!operation) return;
    setBusy(true);
    setError(null);
    try {
      const name = uniqueUntitledSubfolderName(subfolders ?? []);
      const created = await withAccountSignal(
        operation.signal,
        () => core.createSubfolder(operation.storage, operation.treeId, name, {
          signal: operation.signal ?? undefined,
        }),
      );
      if (!isCurrentMutation(operation)) return;
      await refresh(operation);
      if (isCurrentMutation(operation)) {
        setRenaming({ kind: "folder", id: created.id, name: created.name });
      }
    } catch (err) {
      if (isCurrentMutation(operation)) setError(formatOperationError(err));
    } finally {
      releaseMutation(operation);
      if (isCurrentMutation(operation)) setBusy(false);
    }
  }

  function isFileSelected(fileId: string) {
    return selection?.kind === "file" && selection.treeId === treeId && selection.id === fileId;
  }

  function isSubfolderSelected(subId: string) {
    return selection?.kind === "folder" && selection.treeId === treeId && selection.id === subId;
  }

  function handleFileRowClick(f: FileInfo) {
    onSelect({ kind: "file", id: f.id, treeId });
  }

  function handleSubfolderRowClick(sub: FolderInfo, e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest(".row-name-btn")) return;
    onSelect({ kind: "folder", id: sub.id, treeId });
  }

  const loading = files === null || subfolders === null;
  const empty = !loading && files!.length === 0 && subfolders!.length === 0;
  const upLabel = isVaultRoot ? "Back to vaults" : "Up";

  return (
    <div
      className={`vault-contents tc-surface${dragOver ? " drag-over" : ""}`}
      data-testid="vault-detail"
      data-vault-id={isVaultRoot ? treeId : undefined}
      data-folder-id={!isVaultRoot ? treeId : undefined}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <div className="vault-nav-row">
        <button
          type="button"
          className="btn btn-sm nav-up-btn"
          onClick={onNavUp}
          data-testid="nav-up"
        >
          ↑ {upLabel}
        </button>
        <nav className="breadcrumb" aria-label="Vault path">
          {breadcrumb.map((crumb, i) => (
            <span key={crumb.id}>
              {i > 0 && <span className="breadcrumb-sep">/</span>}
              <button
                type="button"
                className="link breadcrumb-item"
                onClick={() => onNavigate(i)}
                data-testid="breadcrumb-item"
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>
      </div>

      <div className="toolbar">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void handleNewSubfolder()}
          disabled={busy}
          data-testid="create-subfolder"
        >
          New folder
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => folderInputRef.current?.click()}
          disabled={busy}
          data-testid="upload-folder-button"
        >
          Upload folder
        </button>
        <input
          type="file"
          ref={folderInputRef}
          onChange={handleFolderUpload}
          disabled={busy}
          multiple
          hidden
          // @ts-expect-error webkitdirectory is non-standard but widely supported
          webkitdirectory=""
          data-testid="folder-input"
        />
        <button
          type="button"
          className="btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          data-testid="upload-button"
        >
          Upload files
        </button>
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleUpload}
          disabled={busy}
          multiple
          hidden
          data-testid="file-input"
        />
      </div>

      <p className="upload-hint muted">
        Files upload into this {isVaultRoot ? "vault" : "folder"}. Use Upload files or drag files here.
      </p>

      {error && (
        <p className="error" data-testid="vault-detail-error">
          {error}
        </p>
      )}

      <div className="file-table-wrap">
        <table className="file-table">
          <thead>
            <tr>
              <th>Name</th>
              <th className="col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={2} className="muted">
                  Loading…
                </td>
              </tr>
            )}
            {!loading &&
              subfolders!.map((sub) => (
                <tr
                  key={sub.id}
                  className={isSubfolderSelected(sub.id) ? "selected-row" : undefined}
                  data-testid="subfolder-item"
                  data-folder-id={sub.id}
                  tabIndex={0}
                  aria-selected={isSubfolderSelected(sub.id)}
                  onClick={(e) => handleSubfolderRowClick(sub, e)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect({ kind: "folder", id: sub.id, treeId });
                    }
                  }}
                >
                  <td>
                    {renaming?.kind === "folder" && renaming.id === sub.id ? (
                      <input
                        className="tc-field rename-input"
                        aria-label={`Rename folder ${sub.name}`}
                        value={renaming.name}
                        autoFocus
                        onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                        onBlur={() => void commitRename()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commitRename();
                          if (e.key === "Escape") setRenaming(null);
                        }}
                        data-testid="rename-input"
                      />
                    ) : (
                      <button
                        type="button"
                        className="row-name-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenSubfolder(sub);
                        }}
                      >
                        <FolderIcon />
                        <span>{sub.name}</span>
                      </button>
                    )}
                  </td>
                  <td className="col-actions">
                    <div className="table-actions">
                      <button
                        type="button"
                        className="btn btn-sm row-action"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenSubfolder(sub);
                        }}
                        data-testid="open-subfolder"
                      >
                        Open
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm row-action"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenaming({ kind: "folder", id: sub.id, name: sub.name });
                        }}
                        data-testid="rename-subfolder"
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm row-action btn-danger"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDeleteSubfolder(sub.id);
                        }}
                        data-testid="delete-subfolder"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            {!loading &&
              files!.map((f) => (
                <tr
                  key={f.id}
                  className={isFileSelected(f.id) ? "selected-row" : undefined}
                  data-testid="file-item"
                  data-file-id={f.id}
                  tabIndex={0}
                  aria-selected={isFileSelected(f.id)}
                  onClick={() => handleFileRowClick(f)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleFileRowClick(f);
                    }
                  }}
                >
                  <td>
                    {renaming?.kind === "file" && renaming.id === f.id ? (
                      <input
                        className="tc-field rename-input"
                        aria-label={`Rename file ${f.name}`}
                        value={renaming.name}
                        autoFocus
                        onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                        onBlur={() => void commitRename()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commitRename();
                          if (e.key === "Escape") setRenaming(null);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        data-testid="rename-input"
                      />
                    ) : (
                      <span className="row-name">
                        <FileIcon />
                        <span>{f.name}</span>
                      </span>
                    )}
                  </td>
                  <td className="col-actions">
                    <div className="table-actions">
                      <button
                        type="button"
                        className="btn btn-sm row-action"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDownload(f);
                        }}
                        data-testid="download-file"
                      >
                        Download
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm row-action"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenaming({ kind: "file", id: f.id, name: f.name });
                        }}
                        data-testid="rename-file"
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm row-action btn-danger"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDeleteFile(f.id);
                        }}
                        data-testid="delete-file"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        {empty && (
          <p className="empty-state muted" data-testid="no-files">
            This {isVaultRoot ? "vault" : "folder"} is empty. Upload files with the Upload files
            button above, or drag and drop files here.
          </p>
        )}
      </div>
    </div>
  );
}

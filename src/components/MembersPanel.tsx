import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useStorage } from "../context/StorageContext";
import * as core from "../lib/core";
import type { Member } from "../lib/core";
import { formatOperationError } from "../lib/formatOperationError";
import { withAccountSignal } from "../lib/accountOperation";
import { isRuntimeMatrixUserId, MAX_MATRIX_ID_BYTES } from "../lib/session";

const POLL_MS = 4000;

function ownershipError(ownership: core.VaultOwnership): string | null {
  return ownership.status === "unknown" ? formatOperationError(ownership.error) : null;
}

function displayName(userId: string): string {
  const local = userId.split(":")[0]?.replace(/^@/, "") ?? userId;
  return local;
}

function initials(userId: string): string {
  const name = displayName(userId);
  return name.slice(0, 2).toUpperCase();
}

function isCanonicalMemberId(value: unknown): value is string {
  return typeof value === "string" && isRuntimeMatrixUserId(value);
}

export function MembersPanel({ vaultId }: { vaultId: string }) {
  const { storage, session, accountSignal } = useStorage();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shareUserId, setShareUserId] = useState("");
  const [shareRole, setShareRole] = useState<"viewer" | "editor">("editor");
  const identityRef = useRef<{ storage: typeof storage; vaultId: string }>({
    storage: null,
    vaultId: "",
  });
  const identityGenerationRef = useRef(0);
  const refreshRequestRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const mutationInFlightRef = useRef(false);
  // Keep identity current during render so callbacks cannot observe a prior identity between
  // render and effect cleanup.
  // oxlint-disable-next-line react/refs
  identityRef.current = { storage, vaultId };
  const ownership = core.getVaultOwnership(storage, vaultId);
  const canManage = ownership.status === "owner";
  const ownershipUnavailable = ownershipError(ownership);

  // Clear account-specific member state before the next identity's asynchronous refresh completes.
  // oxlint-disable react/set-state-in-effect
  useEffect(() => {
    identityRef.current = { storage, vaultId };
    identityGenerationRef.current += 1;
    refreshRequestRef.current += 1;
    mutationGenerationRef.current += 1;
    mutationInFlightRef.current = false;
    setMembers(null);
    setError(null);
    setShareUserId("");
    setBusy(false);
    return () => {
      identityGenerationRef.current += 1;
      refreshRequestRef.current += 1;
    };
  }, [storage, vaultId]);
  // oxlint-enable react/set-state-in-effect

  const refresh = useCallback(async () => {
    if (!storage) return;
    const generation = identityGenerationRef.current;
    const request = ++refreshRequestRef.current;
    const isCurrent = () =>
      !(accountSignal?.aborted ?? false) &&
      generation === identityGenerationRef.current &&
      request === refreshRequestRef.current &&
      identityRef.current.storage === storage &&
      identityRef.current.vaultId === vaultId;
    try {
      const nextMembers = await withAccountSignal(accountSignal, () =>
        core.listMembers(storage, vaultId, { signal: accountSignal ?? undefined }),
      );
      if (isCurrent()) {
        setMembers(nextMembers);
        setError(null);
      }
    } catch (err) {
      if (isCurrent()) {
        setMembers(null);
        setError(formatOperationError(err));
      }
    }
  }, [accountSignal, storage, vaultId]);

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

  async function handleShare(e: FormEvent) {
    e.preventDefault();
    const expectedStorage = storage;
    const expectedVaultId = vaultId;
    const expectedGeneration = identityGenerationRef.current;
    if (!expectedStorage) return;
    const ownership = core.getVaultOwnership(expectedStorage, expectedVaultId);
    if (ownership.status !== "owner") {
      if (ownership.status === "unknown") setError(ownershipError(ownership));
      return;
    }
    const targetUserId = shareUserId.trim();
    let canonicalMemberId = false;
    try {
      canonicalMemberId = isCanonicalMemberId(targetUserId);
    } catch (err) {
      setError(formatOperationError(err));
      return;
    }
    if (!canonicalMemberId) {
      setError("Enter a valid Matrix user ID.");
      return;
    }
    if (mutationInFlightRef.current) return;
    const mutationGeneration = ++mutationGenerationRef.current;
    mutationInFlightRef.current = true;
    const isCurrent = () =>
      !(accountSignal?.aborted ?? false) &&
      identityGenerationRef.current === expectedGeneration &&
      mutationGenerationRef.current === mutationGeneration &&
      identityRef.current.storage === expectedStorage &&
      identityRef.current.vaultId === expectedVaultId;
    setBusy(true);
    setError(null);
    try {
      await withAccountSignal(
        accountSignal,
        () => core.shareVault(expectedStorage, expectedVaultId, targetUserId, shareRole, {
          signal: accountSignal ?? undefined,
        }),
      );
      if (isCurrent()) {
        setShareUserId("");
        await refresh();
      }
    } catch (err) {
      if (isCurrent()) setError(formatOperationError(err));
    } finally {
      if (mutationGenerationRef.current === mutationGeneration) {
        mutationInFlightRef.current = false;
        if (isCurrent()) setBusy(false);
      }
    }
  }

  async function handleUnshare(userId: string) {
    const expectedStorage = storage;
    const expectedVaultId = vaultId;
    const expectedGeneration = identityGenerationRef.current;
    if (!expectedStorage) return;
    const ownership = core.getVaultOwnership(expectedStorage, expectedVaultId);
    if (ownership.status !== "owner") {
      if (ownership.status === "unknown") setError(ownershipError(ownership));
      return;
    }
    if (!isCanonicalMemberId(userId)) return;
    if (mutationInFlightRef.current) return;
    const mutationGeneration = ++mutationGenerationRef.current;
    mutationInFlightRef.current = true;
    const isCurrent = () =>
      !(accountSignal?.aborted ?? false) &&
      identityGenerationRef.current === expectedGeneration &&
      mutationGenerationRef.current === mutationGeneration &&
      identityRef.current.storage === expectedStorage &&
      identityRef.current.vaultId === expectedVaultId;
    setBusy(true);
    setError(null);
    try {
      await withAccountSignal(
        accountSignal,
        () => core.unshareVault(expectedStorage, expectedVaultId, userId, {
          signal: accountSignal ?? undefined,
        }),
      );
      if (isCurrent()) await refresh();
    } catch (err) {
      if (isCurrent()) setError(formatOperationError(err));
    } finally {
      if (mutationGenerationRef.current === mutationGeneration) {
        mutationInFlightRef.current = false;
        if (isCurrent()) setBusy(false);
      }
    }
  }

  return (
    <aside className="members-panel" data-testid="members-panel">
      <h3 className="panel-section-title">Access</h3>
      {(error ?? ownershipUnavailable) && (
        <p className="error" data-testid="members-error">
          {error ?? ownershipUnavailable}
        </p>
      )}

      <ul className="member-list" data-testid="member-list">
        {members === null ? (
          <li className="muted">Loading…</li>
        ) : members.length === 0 ? (
          <li className="muted">No members</li>
        ) : (
          members.map((m) => (
            <li key={m.userId} className="member-item" data-testid="member-item" data-user-id={m.userId}>
              <span className="member-avatar" aria-hidden="true">
                {initials(m.userId)}
              </span>
              <span className="member-info">
                <span className="member-name">{displayName(m.userId)}</span>
                <span className={`role-pill ${m.role} ${m.membership === "invite" ? "invited" : ""}`}>
                  {m.membership === "invite" ? `${m.role} · invited` : m.role}
                </span>
              </span>
              {canManage && m.role !== "owner" && m.userId !== session?.userId && (
                <button
                  type="button"
                  className="icon-btn"
                  title="Remove"
                  aria-label={`Remove ${displayName(m.userId)}`}
                  onClick={() => handleUnshare(m.userId)}
                  disabled={busy}
                  data-testid="unshare-member"
                >
                  ×
                </button>
              )}
            </li>
          ))
        )}
      </ul>

      {canManage ? (
        <form onSubmit={handleShare} className="invite-form">
          <label htmlFor="share-user-id">Invite user</label>
          <input
            id="share-user-id"
            placeholder="@user:homeserver"
            value={shareUserId}
            onChange={(e) => setShareUserId(e.target.value)}
            maxLength={MAX_MATRIX_ID_BYTES}
            data-testid="share-user-id"
          />
          <div className="invite-form-row">
            <label htmlFor="share-role">Role</label>
            <select
              id="share-role"
              value={shareRole}
              onChange={(e) => setShareRole(e.target.value as "viewer" | "editor")}
              data-testid="share-role"
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
            </select>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || !shareUserId.trim()}
              data-testid="share-submit"
            >
              Invite
            </button>
          </div>
        </form>
      ) : (
        <p className="members-panel-hint muted" data-testid="members-readonly">
          Only vault owners can manage access.
        </p>
      )}
    </aside>
  );
}

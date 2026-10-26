import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useStorage } from "../context/StorageContext";
import * as core from "../lib/core";
import type { Member, MemberActionCapabilities } from "../lib/core";
import { formatOperationError } from "../lib/formatOperationError";
import { withAccountSignal } from "../lib/accountOperation";
import { isRuntimeMatrixUserId, MAX_MATRIX_ID_BYTES } from "../lib/session";

const POLL_MS = 4000;

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
  const [memberActions, setMemberActions] = useState<Record<string, MemberActionCapabilities>>({});
  const [shareCapabilities, setShareCapabilities] = useState<MemberActionCapabilities | null>(null);
  const [mutationError, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const error = [mutationError, refreshError].filter(Boolean).join("\n") || null;
  const [busy, setBusy] = useState(false);
  const [shareUserId, setShareUserId] = useState("");
  const [shareRole, setShareRole] = useState<"viewer" | "editor" | "owner">("viewer");
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

  // Clear account-specific member state before the next identity's asynchronous refresh completes.
  // oxlint-disable react/set-state-in-effect
  useEffect(() => {
    identityRef.current = { storage, vaultId };
    identityGenerationRef.current += 1;
    refreshRequestRef.current += 1;
    mutationGenerationRef.current += 1;
    mutationInFlightRef.current = false;
    setMembers(null);
    setMemberActions({});
    setShareCapabilities(null);
    setError(null);
    setRefreshError(null);
    setShareUserId("");
    setShareRole("viewer");
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
      let nextActions: Record<string, MemberActionCapabilities> = {};
      let capabilityError: unknown;
      try {
        nextActions = await withAccountSignal(accountSignal, () =>
          core.getMemberActionCapabilities(
            storage,
            vaultId,
            nextMembers.map((member) => member.userId),
            { signal: accountSignal ?? undefined },
          ),
        );
      } catch (error) {
        capabilityError = error;
      }
      if (isCurrent()) {
        setMembers(nextMembers);
        setMemberActions(nextActions);
        setRefreshError(capabilityError ? formatOperationError(capabilityError) : null);
      }
    } catch (err) {
      if (isCurrent()) {
        setMembers(null);
        setMemberActions({});
        setRefreshError(formatOperationError(err));
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

  useEffect(() => {
    const targetUserId = shareUserId.trim();
    if (!storage || !targetUserId || !isCanonicalMemberId(targetUserId)) return;
    let stopped = false;
    const timer = setTimeout(() => {
      void withAccountSignal(accountSignal, () => core.getMemberActionCapabilities(
        storage,
        vaultId,
        [targetUserId],
        { signal: accountSignal ?? undefined },
      )).then((capabilities) => {
        if (!stopped) setShareCapabilities(capabilities[targetUserId] ?? null);
      }, (error: unknown) => {
        if (!stopped) setRefreshError(formatOperationError(error));
      });
    }, 250);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [accountSignal, shareUserId, storage, vaultId]);

  async function handleShare(e: FormEvent) {
    e.preventDefault();
    const expectedStorage = storage;
    const expectedVaultId = vaultId;
    const expectedGeneration = identityGenerationRef.current;
    if (!expectedStorage) return;
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

  async function handleChangeRole(userId: string, role: "viewer" | "editor" | "owner") {
    const expectedStorage = storage;
    const expectedVaultId = vaultId;
    const expectedGeneration = identityGenerationRef.current;
    if (!expectedStorage || !isCanonicalMemberId(userId) || mutationInFlightRef.current) return;
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
      await withAccountSignal(accountSignal, () => core.shareVault(
        expectedStorage,
        expectedVaultId,
        userId,
        role,
        { signal: accountSignal ?? undefined },
      ));
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

  async function handleUnshare(userId: string) {
    const expectedStorage = storage;
    const expectedVaultId = vaultId;
    const expectedGeneration = identityGenerationRef.current;
    if (!expectedStorage) return;
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
      {error && (
        <p className="error" data-testid="members-error">
          {error}
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
                <span className="role-pill-wrap">
                  <span className={`role-pill ${m.role} ${m.membership === "invite" ? "invited" : ""}`}>
                    {m.membership === "invite" ? `${m.role} · invited` : m.role}
                  </span>
                  {m.userId !== session?.userId && (
                    <select
                      className="tc-field member-role-select"
                      aria-label={`Set role for ${displayName(m.userId)}`}
                      value={m.role}
                      onChange={(event) => void handleChangeRole(m.userId, event.target.value as "viewer" | "editor" | "owner")}
                      disabled={busy || !Object.values(memberActions[m.userId]?.canChangeRole ?? {}).some(Boolean)}
                      data-testid="member-role"
                    >
                      <option value="viewer" disabled={m.role !== "viewer" && !memberActions[m.userId]?.canChangeRole.viewer}>Viewer</option>
                      <option value="editor" disabled={m.role !== "editor" && !memberActions[m.userId]?.canChangeRole.editor}>Editor</option>
                      <option value="owner" disabled={m.role !== "owner" && !memberActions[m.userId]?.canChangeRole.owner}>Owner</option>
                    </select>
                  )}
                </span>
              </span>
              {m.userId !== session?.userId && memberActions[m.userId]?.canUnshare && (
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

      <form onSubmit={handleShare} className="invite-form">
          <label htmlFor="share-user-id">Invite or update member</label>
          <input
            className="tc-field"
            id="share-user-id"
            placeholder="@user:homeserver"
            value={shareUserId}
            onChange={(e) => {
              setShareCapabilities(null);
              setShareUserId(e.target.value);
            }}
            maxLength={MAX_MATRIX_ID_BYTES}
            data-testid="share-user-id"
          />
          <div className="invite-form-row">
            <select
              className="tc-field"
              aria-label="Role for invited user"
              value={shareRole}
              onChange={(event) => setShareRole(event.target.value as "viewer" | "editor" | "owner")}
              disabled={busy || !shareCapabilities}
              data-testid="share-role"
            >
              <option value="viewer" disabled={!shareCapabilities?.canShare.viewer}>Viewer</option>
              <option value="editor" disabled={!shareCapabilities?.canShare.editor}>Editor</option>
              <option value="owner" disabled={!shareCapabilities?.canShare.owner}>Owner</option>
            </select>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || !shareUserId.trim() || !shareCapabilities?.canShare[shareRole]}
              data-testid="share-submit"
            >
              Invite
            </button>
          </div>
          <p className="muted">Viewer is the default. Role labels summarize the standard Storage settings; Matrix room permissions authorize each operation. Matrix handles history sharing; devices without older room keys may need the Recovery Key to read old files.</p>
      </form>
    </aside>
  );
}

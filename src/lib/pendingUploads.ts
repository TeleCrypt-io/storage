import type { Session } from "./session";

export interface PendingUpload {
  treeId: string;
  mediaId: string;
  fileId?: string;
}

type Account = Pick<Session, "homeserver" | "userId">;

function storageKey(account: Account): string {
  return `telecrypt-io-ui:pending-uploads:${JSON.stringify([account.homeserver, account.userId])}`;
}

export function samePendingUpload(a: PendingUpload, b: PendingUpload): boolean {
  return a.treeId === b.treeId && a.mediaId === b.mediaId && a.fileId === b.fileId;
}

export function loadPendingUploads(account: Account): PendingUpload[] {
  const raw = window.localStorage.getItem(storageKey(account));
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((item: unknown) => {
    if (!item || typeof item !== "object") return false;
    const target = item as Partial<PendingUpload>;
    return typeof target.treeId === "string" && target.treeId.length > 0 &&
      typeof target.mediaId === "string" && target.mediaId.length > 0 &&
      (target.fileId === undefined || typeof target.fileId === "string");
  })) throw new Error("Stored upload cleanup details are invalid");
  return parsed as PendingUpload[];
}

export function savePendingUpload(account: Account, target: PendingUpload): void {
  const pending = loadPendingUploads(account);
  if (pending.some((item) => samePendingUpload(item, target))) return;
  pending.push(target);
  window.localStorage.setItem(storageKey(account), JSON.stringify(pending));
}

export function clearPendingUpload(account: Account, target: PendingUpload): void {
  const remaining = loadPendingUploads(account).filter((item) => !samePendingUpload(item, target));
  if (remaining.length) window.localStorage.setItem(storageKey(account), JSON.stringify(remaining));
  else window.localStorage.removeItem(storageKey(account));
}

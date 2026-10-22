import { beforeEach, expect, it, vi } from "vitest";
import { clearSession } from "./session";
import { clearPendingUpload, loadPendingUploads, savePendingUpload } from "./pendingUploads";

const account = { homeserver: "https://backend.example", userId: "@alice:example" };
const target = { treeId: "!room:example", mediaId: "mxc://example/media", fileId: "$event:example" };
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

it("keeps only exact upload identifiers across logout, scoped to the account and homeserver", () => {
  savePendingUpload(account, target);
  savePendingUpload(account, target);
  clearSession();
  sessionStorage.clear();
  expect(loadPendingUploads(account)).toEqual([target]);
  expect(loadPendingUploads({ ...account, userId: "@bob:example" })).toEqual([]);
  expect(loadPendingUploads({ ...account, homeserver: "https://other.example" })).toEqual([]);
  clearPendingUpload(account, target);
  expect(loadPendingUploads(account)).toEqual([]);
});

it("preserves a receipt if its confirmed cleanup cannot be persisted", () => {
  savePendingUpload(account, target);
  const spy = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("storage denied"); });
  try {
    expect(() => clearPendingUpload(account, target)).toThrow("storage denied");
    expect(loadPendingUploads(account)).toEqual([target]);
  } finally {
    spy.mockRestore();
  }
});

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultContents } from "./VaultContents";
import { useStorage } from "../context/StorageContext";
import * as core from "../lib/core";
import { MAX_FILE_SIZE_BYTES } from "../lib/fileLimits";

vi.mock("../context/StorageContext", () => ({
  useStorage: vi.fn(),
}));

vi.mock("../lib/core", async () => {
  const actual = await vi.importActual<typeof import("../lib/core")>("../lib/core");
  return {
    ...actual,
    listFiles: vi.fn(),
    listSubfolders: vi.fn(),
    uploadFile: vi.fn(),
    downloadFile: vi.fn(),
    getFileDetails: vi.fn(),
    createSubfolder: vi.fn(),
    deleteFile: vi.fn(),
    deleteFolder: vi.fn(),
  };
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeStorage() {
  return { keys: {} };
}

const useStorageMock = vi.mocked(useStorage);

function oversizedFile(name: string): { file: File; arrayBuffer: ReturnType<typeof vi.fn> } {
  const file = new File([], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "size", { configurable: true, value: MAX_FILE_SIZE_BYTES + 1 });
  const arrayBuffer = vi.fn();
  Object.defineProperty(file, "arrayBuffer", { configurable: true, value: arrayBuffer });
  return { file, arrayBuffer };
}

function renderContents(
  treeId: string,
  onFolderDeleted: (folderId: string) => void,
  onSelect: (
    selection: { kind: "file" | "folder"; id: string; treeId: string } | null,
  ) => void = vi.fn(),
  onOpenSubfolder: (folder: { id: string; name: string }) => void = vi.fn(),
) {
  return render(
    <VaultContents
      treeId={treeId}
      breadcrumb={[{ id: "!vault:localhost", name: "Vault" }]}
      isVaultRoot
      onNavigate={vi.fn()}
      onNavUp={vi.fn()}
      onOpenSubfolder={onOpenSubfolder}
      onFolderRenamed={vi.fn()}
      onFolderDeleted={onFolderDeleted}
      selection={null}
      onSelect={onSelect}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useStorageMock.mockReturnValue({
    storage: fakeStorage(),
    accountSignal: new AbortController().signal,
  } as never);
  vi.mocked(core.listFiles).mockResolvedValue([]);
  vi.mocked(core.listSubfolders).mockResolvedValue([{ id: "!child:localhost", name: "Child" }]);
  vi.mocked(core.getFileDetails).mockResolvedValue({
    name: "file.txt",
    mimetype: "text/plain",
    size: 5,
    createdAt: null,
    updatedAt: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("VaultContents mutation identity", () => {
  it("passes the account signal to every SDK read", async () => {
    const accountSignal = new AbortController().signal;
    useStorageMock.mockReturnValue({ storage: fakeStorage(), accountSignal } as never);

    renderContents("!vault-a:localhost", vi.fn<(folderId: string) => void>());
    await waitFor(() => expect(core.listFiles).toHaveBeenCalled());

    expect(core.listFiles).toHaveBeenCalledWith(
      expect.anything(),
      "!vault-a:localhost",
      { signal: accountSignal },
    );
    expect(core.listSubfolders).toHaveBeenCalledWith(
      expect.anything(),
      "!vault-a:localhost",
      { signal: accountSignal },
    );
  });

  it("renders remote file names using the SDK contract", async () => {
    vi.mocked(core.listFiles).mockResolvedValue([{ id: "$bad:localhost", name: "bad/name" }]);
    vi.mocked(core.listSubfolders).mockResolvedValue([]);

    renderContents("!vault-a:localhost", vi.fn<(folderId: string) => void>());

    expect(await screen.findByText("bad/name")).toBeInTheDocument();
    expect(screen.queryByTestId("vault-detail-error")).not.toBeInTheDocument();
  });

  it("ignores an old upload error after navigating to another tree", async () => {
    const upload = deferred<{ id: string; name: string }>();
    vi.mocked(core.uploadFile).mockReturnValue(upload.promise);
    const user = userEvent.setup();
    const onFolderDeleted = vi.fn<(folderId: string) => void>();
    const view = renderContents("!vault-a:localhost", onFolderDeleted);

    await waitFor(() => expect(screen.getByTestId("upload-button")).toBeEnabled());
    const uploadTask = user.upload(
      screen.getByTestId("file-input"),
      new File(["data"], "data.txt", { type: "text/plain" }),
    );
    await waitFor(() => expect(core.uploadFile).toHaveBeenCalled());

    view.rerender(
      <VaultContents
        treeId="!vault-b:localhost"
        breadcrumb={[{ id: "!vault-b:localhost", name: "Other vault" }]}
        isVaultRoot
        onNavigate={vi.fn()}
        onNavUp={vi.fn()}
        onOpenSubfolder={vi.fn()}
        onFolderRenamed={vi.fn()}
        onFolderDeleted={onFolderDeleted}
        selection={null}
        onSelect={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("vault-detail")).toHaveAttribute("data-vault-id", "!vault-b:localhost"));

    await upload.reject(new Error("old tree failed"));
    await uploadTask;
    await waitFor(() => expect(screen.getByTestId("upload-button")).toBeEnabled());
    expect(screen.queryByTestId("vault-detail-error")).not.toBeInTheDocument();
  });

  it("stops a file batch after the first upload failure and preserves its error", async () => {
    const failure = new Error("first upload failed");
    vi.mocked(core.uploadFile)
      .mockRejectedValueOnce(failure)
      .mockResolvedValue({ id: "$unexpected:localhost", name: "second.txt" });
    const user = userEvent.setup();
    renderContents("!vault-a:localhost", vi.fn<(folderId: string) => void>());

    await waitFor(() => expect(screen.getByTestId("upload-button")).toBeEnabled());
    await user.upload(screen.getByTestId("file-input"), [
      new File(["first"], "first.txt", { type: "text/plain" }),
      new File(["second"], "second.txt", { type: "text/plain" }),
    ]);

    expect(core.uploadFile).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("vault-detail-error")).toHaveTextContent(
      "first upload failed",
    );
  });

  it("does not invoke a stale folder callback after navigation", async () => {
    const deletion = deferred<{ id: string; deleted: boolean }>();
    vi.mocked(core.deleteFolder).mockReturnValue(deletion.promise);
    vi.stubGlobal("confirm", () => true);
    const user = userEvent.setup();
    const onFolderDeleted = vi.fn<(folderId: string) => void>();
    const view = renderContents("!vault-a:localhost", onFolderDeleted);

    await waitFor(() => expect(screen.getByTestId("delete-subfolder")).toBeInTheDocument());
    await user.click(screen.getByTestId("delete-subfolder"));
    await waitFor(() =>
      expect(core.deleteFolder).toHaveBeenCalledWith(
        expect.anything(),
        "!child:localhost",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );

    view.rerender(
      <VaultContents
        treeId="!vault-b:localhost"
        breadcrumb={[{ id: "!vault-b:localhost", name: "Other vault" }]}
        isVaultRoot
        onNavigate={vi.fn()}
        onNavUp={vi.fn()}
        onOpenSubfolder={vi.fn()}
        onFolderRenamed={vi.fn()}
        onFolderDeleted={onFolderDeleted}
        selection={null}
        onSelect={vi.fn()}
      />,
    );
    deletion.resolve({ id: "!child:localhost", deleted: true });
    await waitFor(() => expect(screen.getByTestId("vault-detail")).toHaveAttribute("data-vault-id", "!vault-b:localhost"));

    expect(onFolderDeleted).not.toHaveBeenCalled();
    expect(screen.queryByTestId("vault-detail-error")).not.toBeInTheDocument();
  });

  it("surfaces the SDK nonempty-folder refusal without invoking the delete callback", async () => {
    const failure = new core.NonEmptyTreeError("!child:localhost");
    vi.mocked(core.deleteFolder).mockRejectedValue(failure);
    vi.stubGlobal("confirm", () => true);
    const onFolderDeleted = vi.fn<(folderId: string) => void>();
    const user = userEvent.setup();
    renderContents("!vault-a:localhost", onFolderDeleted);

    await waitFor(() => expect(screen.getByTestId("delete-subfolder")).toBeInTheDocument());
    await user.click(screen.getByTestId("delete-subfolder"));

    await waitFor(() =>
      expect(screen.getByTestId("vault-detail-error")).toHaveTextContent(
        failure.message,
      ),
    );
    expect(onFolderDeleted).not.toHaveBeenCalled();
  });

  it("removes a deleted file after the refreshed list excludes it", async () => {
    let fileStillExists = true;
    vi.mocked(core.listFiles).mockImplementation(async () =>
      fileStillExists ? [{ id: "$file:localhost", name: "gone.txt" }] : [],
    );
    vi.mocked(core.listSubfolders).mockResolvedValue([]);
    vi.mocked(core.deleteFile).mockImplementation(async () => {
      fileStillExists = false;
      return { id: "$file:localhost", deleted: true };
    });
    vi.stubGlobal("confirm", () => true);
    const user = userEvent.setup();
    renderContents("!vault-a:localhost", vi.fn<(folderId: string) => void>());

    await waitFor(() => expect(screen.getByTestId("file-item")).toHaveTextContent("gone.txt"));
    await user.click(screen.getByTestId("delete-file"));

    await waitFor(() =>
      expect(core.deleteFile).toHaveBeenCalledWith(
        expect.anything(),
        "!vault-a:localhost",
        "$file:localhost",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await waitFor(() => expect(screen.queryByTestId("file-item")).not.toBeInTheDocument());
    expect(screen.getByTestId("no-files")).toBeInTheDocument();
  });

  it("does not trigger a download after the contents unmount", async () => {
    const download = deferred<{ bytes: Uint8Array; mimetype: string; name: string }>();
    vi.mocked(core.listFiles).mockResolvedValue([{ id: "$file:localhost", name: "file.txt" }]);
    vi.mocked(core.listSubfolders).mockResolvedValue([]);
    vi.mocked(core.downloadFile).mockReturnValue(download.promise);
    const createObjectURL = vi.fn(() => "blob:stale");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const user = userEvent.setup();
    const view = renderContents("!vault-a:localhost", vi.fn<(folderId: string) => void>());

    await waitFor(() => expect(screen.getByTestId("file-item")).toBeInTheDocument());
    const clickTask = user.click(screen.getByTestId("download-file"));
    await waitFor(() => expect(core.downloadFile).toHaveBeenCalled());
    view.unmount();

    download.resolve({
      bytes: new TextEncoder().encode("stale"),
      mimetype: "text/plain",
      name: "file.txt",
    });
    await clickTask;

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="download-anchor"]')).not.toBeInTheDocument();
  });

  it("stops folder path creation at the first navigation boundary", async () => {
    const createdFolder = deferred<{ id: string; name: string }>();
    let folderUploadStarted = false;
    vi.mocked(core.listFiles).mockResolvedValue([]);
    vi.mocked(core.listSubfolders).mockImplementation(async (_, id) => {
      if (folderUploadStarted && id === "!vault-a:localhost") return [];
      return [];
    });
    vi.mocked(core.createSubfolder).mockReturnValue(createdFolder.promise);
    const user = userEvent.setup();
    const view = renderContents("!vault-a:localhost", vi.fn<(folderId: string) => void>());
    await waitFor(() => expect(screen.getByTestId("vault-detail")).toHaveAttribute("data-vault-id", "!vault-a:localhost"));

    const initialSubfolderCalls = vi.mocked(core.listSubfolders).mock.calls.length;
    folderUploadStarted = true;
    const file = new File(["data"], "file.txt", { type: "text/plain" });
    Object.defineProperty(file, "webkitRelativePath", { value: "dir/nested/file.txt" });
    const uploadTask = user.upload(screen.getByTestId("folder-input"), file);
    await waitFor(() =>
      expect(core.createSubfolder).toHaveBeenCalledWith(
        expect.anything(),
        "!vault-a:localhost",
        "dir",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );

    view.rerender(
      <VaultContents
        treeId="!vault-b:localhost"
        breadcrumb={[{ id: "!vault-b:localhost", name: "Other vault" }]}
        isVaultRoot
        onNavigate={vi.fn()}
        onNavUp={vi.fn()}
        onOpenSubfolder={vi.fn()}
        onFolderRenamed={vi.fn()}
        onFolderDeleted={vi.fn()}
        selection={null}
        onSelect={vi.fn()}
      />,
    );
    createdFolder.resolve({ id: "!dir:localhost", name: "dir" });
    await uploadTask;

    expect(
      vi
        .mocked(core.listSubfolders)
        .mock.calls.slice(initialSubfolderCalls)
        .filter(([, id]) => id === "!vault-a:localhost"),
    ).toHaveLength(1);
    expect(core.createSubfolder).toHaveBeenCalledTimes(1);
    expect(core.uploadFile).not.toHaveBeenCalled();
  });

  it("rejects oversized picked files before reading or calling the SDK", async () => {
    const user = userEvent.setup();
    renderContents("!vault-a:localhost", vi.fn());
    const oversized = oversizedFile("too-large.bin");

    await user.upload(screen.getByTestId("file-input"), oversized.file);

    expect(oversized.arrayBuffer).not.toHaveBeenCalled();
    expect(core.uploadFile).not.toHaveBeenCalled();
    expect(await screen.findByTestId("vault-detail-error")).toHaveTextContent(
      "File exceeds the 128 MiB limit",
    );
  });

  it("rejects oversized folder files before creating a path or reading them", async () => {
    const user = userEvent.setup();
    renderContents("!vault-a:localhost", vi.fn());
    const oversized = oversizedFile("too-large.bin");
    Object.defineProperty(oversized.file, "webkitRelativePath", { value: "dir/too-large.bin" });

    await user.upload(screen.getByTestId("folder-input"), oversized.file);

    expect(oversized.arrayBuffer).not.toHaveBeenCalled();
    expect(core.createSubfolder).not.toHaveBeenCalled();
    expect(core.uploadFile).not.toHaveBeenCalled();
    expect(await screen.findByTestId("vault-detail-error")).toHaveTextContent(
      "File exceeds the 128 MiB limit",
    );
  });

  it("rejects oversized dropped files before reading or calling the SDK", async () => {
    renderContents("!vault-a:localhost", vi.fn());
    const oversized = oversizedFile("too-large.bin");

    fireEvent.drop(screen.getByTestId("vault-detail"), {
      dataTransfer: { files: [oversized.file] },
    });

    expect(oversized.arrayBuffer).not.toHaveBeenCalled();
    expect(core.uploadFile).not.toHaveBeenCalled();
    expect(await screen.findByTestId("vault-detail-error")).toHaveTextContent(
      "File exceeds the 128 MiB limit",
    );
  });

  it("surfaces the SDK download size rejection", async () => {
    vi.mocked(core.listFiles).mockResolvedValue([{ id: "$large", name: "too-large.bin" }]);
    vi.mocked(core.listSubfolders).mockResolvedValue([]);
    const failure = new core.FileTooLargeError();
    vi.mocked(core.downloadFile).mockRejectedValue(failure);
    const user = userEvent.setup();
    renderContents("!vault-a:localhost", vi.fn());

    await user.click(await screen.findByTestId("download-file"));

    expect(await screen.findByTestId("vault-detail-error")).toHaveTextContent(
      failure.message,
    );
  });

  it("lets the SDK own download admission when optional display metadata is absent", async () => {
    vi.mocked(core.listFiles).mockResolvedValue([{ id: "$unknown", name: "unknown.bin" }]);
    vi.mocked(core.listSubfolders).mockResolvedValue([]);
    vi.mocked(core.getFileDetails).mockResolvedValue({
      name: "unknown.bin",
      mimetype: null,
      size: null,
      createdAt: null,
      updatedAt: null,
    });
    vi.mocked(core.downloadFile).mockRejectedValue(new Error("download failed"));
    const user = userEvent.setup();
    renderContents("!vault-a:localhost", vi.fn());

    await user.click(await screen.findByTestId("download-file"));

    expect(core.downloadFile).toHaveBeenCalled();
    expect(core.getFileDetails).not.toHaveBeenCalled();
    expect(await screen.findByTestId("vault-detail-error")).toHaveTextContent(
      "download failed",
    );
  });

  it("reports a file read failure and releases the upload busy state", async () => {
    const file = new File(["data"], "read-fails.txt", { type: "text/plain" });
    const readError = new Error("file read failed");
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: vi.fn().mockRejectedValue(readError),
    });
    const user = userEvent.setup();
    renderContents("!vault-a:localhost", vi.fn());

    await user.upload(screen.getByTestId("file-input"), file);

    expect(await screen.findByTestId("vault-detail-error")).toHaveTextContent(
      "file read failed",
    );
    expect(screen.getByTestId("upload-button")).toBeEnabled();
    expect(core.uploadFile).not.toHaveBeenCalled();
  });

  it("defers object URL revocation until the download is queued", async () => {
    vi.mocked(core.listFiles).mockResolvedValue([{ id: "$file", name: "file.txt" }]);
    vi.mocked(core.listSubfolders).mockResolvedValue([]);
    vi.mocked(core.downloadFile).mockResolvedValue({
      bytes: new TextEncoder().encode("download"),
      mimetype: "text/plain",
      name: "file.txt",
    });
    vi.mocked(core.getFileDetails).mockResolvedValue({
      name: "file.txt",
      mimetype: "text/plain",
      size: 8,
      createdAt: null,
      updatedAt: null,
    });
    const revokeObjectURL = vi.fn();
    const blobInputs: Array<{ parts?: BlobPart[]; options?: BlobPropertyBag }> = [];
    class TestBlob {
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
        blobInputs.push({ parts, options });
      }
    }
    const queued: Array<() => void> = [];
    const realSetTimeout = window.setTimeout.bind(window);
    let timeoutSpy: ReturnType<typeof vi.spyOn> | undefined;
    const createObjectURL = vi.fn(() => {
      timeoutSpy = vi.spyOn(window, "setTimeout").mockImplementation(
        ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
          if (timeout === 0 && typeof handler === "function") {
            queued.push(() => handler(...args));
            return 1;
          }
          return realSetTimeout(handler, timeout, ...args);
        }) as typeof window.setTimeout,
      );
      return "blob:queued";
    });
    vi.stubGlobal("Blob", TestBlob);
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    renderContents("!vault-a:localhost", vi.fn());
    await waitFor(() => expect(screen.getByTestId("download-file")).toBeInTheDocument());

    try {
      fireEvent.click(screen.getByTestId("download-file"));
      await act(async () => {
        for (let index = 0; index < 12; index += 1) await Promise.resolve();
      });
      expect(core.getFileDetails).not.toHaveBeenCalled();
      expect(core.downloadFile).toHaveBeenCalled();
      expect(createObjectURL).toHaveBeenCalledWith(expect.any(TestBlob));
      expect(blobInputs).toEqual([
        {
          parts: [expect.any(Uint8Array)],
          options: { type: "text/plain" },
        },
      ]);
      expect(revokeObjectURL).not.toHaveBeenCalled();
      expect(queued.length).toBeGreaterThan(0);
      act(() => queued.at(-1)!());
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:queued");
    } finally {
      timeoutSpy?.mockRestore();
    }
  });

  it("clears previously listed files when a refresh loses access", async () => {
    vi.mocked(core.listFiles).mockResolvedValue([{ id: "$old:localhost", name: "old.txt" }]);
    vi.mocked(core.listSubfolders).mockResolvedValue([]);
    vi.mocked(core.uploadFile).mockResolvedValue({ id: "$new:localhost", name: "new.txt" });
    const user = userEvent.setup();
    renderContents("!vault-a:localhost", vi.fn<(folderId: string) => void>());
    await waitFor(() => expect(screen.getByTestId("file-item")).toBeInTheDocument());

    vi.mocked(core.listFiles).mockRejectedValueOnce(new Error("access revoked"));
    await user.upload(
      screen.getByTestId("file-input"),
      new File(["new"], "new.txt", { type: "text/plain" }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("vault-detail-error")).toHaveTextContent(
        "access revoked",
      ),
    );
    expect(screen.queryByText("old.txt")).not.toBeInTheDocument();
  });

  it("selects rows from the keyboard and exposes rename labels", async () => {
    vi.mocked(core.listFiles).mockResolvedValue([{ id: "$file:localhost", name: "file.txt" }]);
    vi.mocked(core.listSubfolders).mockResolvedValue([]);
    const onSelect = vi.fn();
    const user = userEvent.setup();
    renderContents("!vault-a:localhost", vi.fn(), onSelect);

    const row = await screen.findByTestId("file-item");
    row.focus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith({ kind: "file", id: "$file:localhost", treeId: "!vault-a:localhost" });

    await user.click(screen.getByTestId("rename-file"));
    expect(screen.getByLabelText("Rename file file.txt")).toBeInTheDocument();
  });

  it("does not select a folder when an action button opens it", async () => {
    const onSelect = vi.fn();
    const onOpenSubfolder = vi.fn();
    const user = userEvent.setup();
    renderContents("!vault-a:localhost", vi.fn(), onSelect, onOpenSubfolder);

    await waitFor(() => expect(screen.getByTestId("open-subfolder")).toBeInTheDocument());
    await user.click(screen.getByTestId("open-subfolder"));

    expect(onOpenSubfolder).toHaveBeenCalledWith({ id: "!child:localhost", name: "Child" });
    expect(onSelect).not.toHaveBeenCalled();
  });
});

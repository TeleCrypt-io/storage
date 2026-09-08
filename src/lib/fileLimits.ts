import { MAX_MEDIA_FILE_BYTES } from "./core";

export const MAX_FILE_SIZE_BYTES = MAX_MEDIA_FILE_BYTES;
export const FILE_TOO_LARGE_ERROR = "File exceeds the 128 MiB limit";
export const MAX_UPLOAD_FILES = 128;
export const MAX_UPLOAD_BATCH_BYTES = 256 * 1024 * 1024;
export const MAX_FILE_NAME_BYTES = 255;
export const MAX_RELATIVE_PATH_BYTES = 4096;
export const MAX_RELATIVE_PATH_SEGMENTS = 32;

const encoder = new TextEncoder();

export function isFileWithinLimit(file: Pick<File, "size">): boolean {
  return Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= MAX_FILE_SIZE_BYTES;
}

function isSafePathSegment(segment: string): boolean {
  return (
    segment !== "" &&
    segment !== "." &&
    segment !== ".." &&
    encoder.encode(segment).byteLength <= MAX_FILE_NAME_BYTES &&
    ![...segment].some(
      (character) =>
        character === "/" ||
        character === "\\" ||
        character.charCodeAt(0) < 0x20 ||
        character.charCodeAt(0) === 0x7f,
    )
  );
}

export function isSafeFileName(name: string): boolean {
  return isSafePathSegment(name);
}

export function isSafeRelativePath(path: string): boolean {
  if (encoder.encode(path).byteLength > MAX_RELATIVE_PATH_BYTES || path.startsWith("/")) {
    return false;
  }
  const parts = path.split("/");
  return parts.length <= MAX_RELATIVE_PATH_SEGMENTS && parts.every(isSafePathSegment);
}

export function isUploadBatchWithinLimit(files: ReadonlyArray<Pick<File, "size">>): boolean {
  if (files.length === 0 || files.length > MAX_UPLOAD_FILES) return false;
  let total = 0;
  for (const file of files) {
    if (!isFileWithinLimit(file)) return false;
    total += file.size;
    if (!Number.isSafeInteger(total) || total > MAX_UPLOAD_BATCH_BYTES) return false;
  }
  return true;
}

export async function readFileWithinLimit(file: File): Promise<Uint8Array> {
  if (!isFileWithinLimit(file)) throw new Error(FILE_TOO_LARGE_ERROR);
  const buffer = await file.slice(0, MAX_FILE_SIZE_BYTES + 1).arrayBuffer();
  if (buffer.byteLength > MAX_FILE_SIZE_BYTES) throw new Error(FILE_TOO_LARGE_ERROR);
  if (buffer.byteLength !== file.size) throw new Error("File changed while it was being read");
  return new Uint8Array(buffer);
}

export function isBytesWithinLimit(bytes: Uint8Array): boolean {
  return bytes.byteLength <= MAX_FILE_SIZE_BYTES;
}

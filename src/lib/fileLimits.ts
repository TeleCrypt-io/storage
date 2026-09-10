import { MAX_MEDIA_FILE_BYTES } from "./core";

export const MAX_FILE_SIZE_BYTES = MAX_MEDIA_FILE_BYTES;
export const FILE_TOO_LARGE_ERROR = "File exceeds the 128 MiB limit";

export function isFileWithinLimit(file: Pick<File, "size">): boolean {
  return Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= MAX_FILE_SIZE_BYTES;
}

function isSafePathSegment(segment: string): boolean {
  return (
    segment !== "" &&
    segment !== "." &&
    segment !== ".." &&
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
  if (path.startsWith("/")) return false;
  const parts = path.split("/");
  return parts.every(isSafePathSegment);
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

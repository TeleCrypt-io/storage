import { MAX_MEDIA_FILE_BYTES } from "./core";

export const MAX_FILE_SIZE_BYTES = MAX_MEDIA_FILE_BYTES;
export const FILE_TOO_LARGE_ERROR = "File exceeds the 128 MiB limit";

export function isFileWithinLimit(file: Pick<File, "size">): boolean {
  return file.size <= MAX_FILE_SIZE_BYTES;
}

export async function readFileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

import { describe, expect, it } from "vitest";
import {
  isBytesWithinLimit,
  isFileWithinLimit,
  MAX_FILE_SIZE_BYTES,
} from "./fileLimits";

describe("media byte boundary", () => {
  it("accepts exactly 128 MiB and rejects the adjacent values", () => {
    expect(MAX_FILE_SIZE_BYTES).toBe(128 * 1024 * 1024);
    expect(isFileWithinLimit({ size: MAX_FILE_SIZE_BYTES - 1 })).toBe(true);
    expect(isFileWithinLimit({ size: MAX_FILE_SIZE_BYTES })).toBe(true);
    expect(isFileWithinLimit({ size: MAX_FILE_SIZE_BYTES + 1 })).toBe(false);
    expect(isBytesWithinLimit({ byteLength: MAX_FILE_SIZE_BYTES } as Uint8Array)).toBe(true);
    expect(isBytesWithinLimit({ byteLength: MAX_FILE_SIZE_BYTES + 1 } as Uint8Array)).toBe(false);
  });
});

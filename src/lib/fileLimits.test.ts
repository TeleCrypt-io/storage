import { describe, expect, it } from "vitest";
import { isFileWithinLimit, MAX_FILE_SIZE_BYTES } from "./fileLimits";

describe("media byte boundary", () => {
  it("accepts exactly 128 MiB and rejects the adjacent values", () => {
    expect(isFileWithinLimit({ size: MAX_FILE_SIZE_BYTES - 1 })).toBe(true);
    expect(isFileWithinLimit({ size: MAX_FILE_SIZE_BYTES })).toBe(true);
    expect(isFileWithinLimit({ size: MAX_FILE_SIZE_BYTES + 1 })).toBe(false);
  });
});

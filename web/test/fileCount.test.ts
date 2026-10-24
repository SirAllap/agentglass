import { expect, test } from "bun:test";
import { fileCount } from "../src/lib/fileCount.ts";

test("one file is singular, everything else is plural with a thousands separator", () => {
  expect(fileCount(1)).toBe("1 file");
  expect(fileCount(0)).toBe("0 files");
  expect(fileCount(2)).toBe("2 files");
  expect(fileCount(1272)).toBe("1,272 files");
});

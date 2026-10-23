import { describe, expect, test } from "bun:test";
import { previewMetaLine } from "../src/lib/finderMiller.ts";

describe("the preview's line under the file name", () => {
  test("size, when, type as Strata writes them", () => {
    expect(previewMetaLine({ folder: false, bytes: 43, items: null, ago: "just now", mime: "text/markdown; charset=utf-8" })).toBe("43 B · Just now · text/markdown");
  });
  test("a folder says how many items and has no type", () => {
    expect(previewMetaLine({ folder: true, bytes: null, items: 26, ago: "8m ago", mime: "inode/directory" })).toBe("26 items · 8m ago");
  });
  test("a size that is not known is left out, not drawn as a blank", () => {
    expect(previewMetaLine({ folder: false, bytes: null, items: null, ago: "2d ago", mime: "" })).toBe("2d ago");
  });

  test("a text file is named by its kind, not text/plain", () => {
    expect(previewMetaLine({ folder: false, bytes: 43, items: null, ago: "just now", mime: "text/plain; charset=utf-8", name: "acme-notes.md" })).toBe("43 B · Just now · text/markdown");
    expect(previewMetaLine({ folder: false, bytes: 8, items: null, ago: "just now", mime: "text/plain", name: "report.py" })).toContain("text/x-python");
    expect(previewMetaLine({ folder: false, bytes: 8, items: null, ago: "just now", mime: "text/plain", name: "README" })).toContain("text/plain");
  });
});

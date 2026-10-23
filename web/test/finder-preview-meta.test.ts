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

import { strataWhen } from "../src/lib/finderMiller.ts";
describe("dates as Strata words them", () => {
  const now = new Date(2026, 9, 14, 15, 0).getTime();
  const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo, d, h, mi).getTime();
  test("minutes, hours, the weekday, weeks, then the calendar date", () => {
    expect(strataWhen(now - 20_000, now)).toBe("Just now");
    expect(strataWhen(now - 4 * 60_000, now)).toBe("4m ago");
    expect(strataWhen(now - 5 * 3_600_000, now)).toBe("5h ago");
    expect(strataWhen(at(2026, 9, 9), now)).toBe("Friday");
    expect(strataWhen(at(2026, 9, 1), now)).toBe("1w ago");
    expect(strataWhen(at(2026, 6, 4, 13, 24), now)).toBe("Jul 4, 13:24");
    expect(strataWhen(at(2025, 6, 4, 13, 24), now)).toBe("Jul 4, 2025");
  });
});

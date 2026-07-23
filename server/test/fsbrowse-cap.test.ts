// The MAX_ENTRIES cap and the "truncated" flag are counted over directories that
// survive the stat, not the raw name list. When a symlink-to-a-file sorts ahead
// of real directories, it must not burn a display slot a real directory never
// gets to fill — that silently dropped openable directories off the end.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completePath } from "../src/fsbrowse.ts";

const MAX_ENTRIES = 60; // must match fsbrowse.ts
let base = "";

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "agx-fscap-"));
  // Symlinks-to-files that sort first (leading "0"): under the old code they
  // took the first slots and pushed real directories past the cap.
  for (let i = 0; i < 5; i++) {
    const f = join(base, `0file${i}`);
    writeFileSync(f, "x");
    symlinkSync(f, join(base, `0link${i}`));
  }
  // Exactly MAX_ENTRIES real directories, named so they all sort after the links.
  for (let i = 0; i < MAX_ENTRIES; i++) mkdirSync(join(base, `dir${String(i).padStart(2, "0")}`));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("completePath cap", () => {
  test("symlinks-to-files don't steal slots from real directories", () => {
    const res = completePath(base + "/");
    const names = res.entries.map((e) => e.name);
    // None of the link entries are directories, so none should appear...
    expect(names.some((n) => n.startsWith("0link"))).toBe(false);
    // ...and every real directory fits, including the last one, which the old
    // pre-filter cap would have dropped.
    expect(names).toContain(`dir${String(MAX_ENTRIES - 1).padStart(2, "0")}`);
    expect(names.filter((n) => n.startsWith("dir")).length).toBe(MAX_ENTRIES);
  });
});

/*
 * "Restore now" counted windows and called them sessions: five windows in two
 * sessions read "Restored 5 sessions". The note and the Settings blurb are
 * source/pure, so both are asserted here.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { restoredNote } from "../src/lib/restoredNote.ts";

const src = (p: string) => readFileSync(join(import.meta.dir, "..", "src", p), "utf8");

describe("the restore note", () => {
  it("counts windows, in the singular too", () => {
    expect(restoredNote(5)).toBe("Restored 5 windows.");
    expect(restoredNote(1)).toBe("Restored 1 window.");
    expect(restoredNote(0)).toBe("Restored 0 windows.");
  });

  it("is what Settings shows", () => {
    const s = src("components/settings/pages/TerminalPage.tsx");
    expect(s).toContain("restoredNote(r.restored ?? 0)");
  });
});

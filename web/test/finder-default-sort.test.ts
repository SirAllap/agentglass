import { describe, expect, test } from "bun:test";
import { DEFAULT_PREFS, isDefaultSort, makeDefaultSort, readPrefs, resetSort, writePrefs } from "../src/lib/finderMiller.ts";

const by = (o: object) => ({ ...DEFAULT_PREFS, ...o });

describe("Strata's default sort", () => {
  test("with nothing remembered, reset goes to name ascending, folders first", () => {
    expect(resetSort(by({ sortKey: "size" }))).toEqual({ sortKey: "name", sortDir: "asc", foldersFirst: true });
    expect(isDefaultSort(DEFAULT_PREFS)).toBe(true);
    expect(isDefaultSort(by({ sortKey: "size" }))).toBe(false);
  });
  test("make this the default remembers the sort in force, and reset returns to it", () => {
    const now = by({ sortKey: "modified", sortDir: "desc", foldersFirst: false });
    const withDef = { ...now, ...makeDefaultSort(now) };
    expect(isDefaultSort(withDef)).toBe(true);
    const changed = { ...withDef, sortKey: "size" as const };
    expect(isDefaultSort(changed)).toBe(false);
    expect(resetSort(changed)).toEqual({ sortKey: "modified", sortDir: "desc", foldersFirst: false });
  });
  test("it survives a reload, and a mangled one is dropped", () => {
    const p = by({ defSort: { sortKey: "type", sortDir: "asc", foldersFirst: true } });
    expect(readPrefs(writePrefs(p)).defSort).toEqual(p.defSort);
    expect(readPrefs(JSON.stringify({ defSort: { sortKey: "colour", sortDir: "asc", foldersFirst: true } })).defSort).toBeUndefined();
    expect(readPrefs(JSON.stringify({ defSort: "name" })).defSort).toBeUndefined();
  });
});

describe("the sort menu offers both", () => {
  test("Column.tsx has the two entries", async () => {
    const t = await Bun.file(new URL("../src/components/finder/machine/Column.tsx", import.meta.url)).text();
    expect(t).toContain("Make this the default sort");
    expect(t).toContain("Reset to default sort");
  });
});

describe("the F1 sheet draws keys as Strata does", () => {
  test("arrows and slashes", async () => {
    const { keyLabel } = await import("../src/lib/finderShortcuts.ts");
    expect(keyLabel("Up, Down")).toBe("↑ / ↓");
    expect(keyLabel("Alt+Left, Alt+Right")).toBe("Alt+← / Alt+→");
    expect(keyLabel("Ctrl+K")).toBe("Ctrl+K");
    expect(keyLabel("Backspace")).toBe("Backspace");
  });
});

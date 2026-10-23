/*
 * Parity rows 57/59 (location box), 91/265 (selection tint), 110 (group
 * headings) and 170 (shortcut sheet). Source rules are asserted on source.
 */
import { describe, expect, test } from "bun:test";
import { SECTIONS } from "../src/lib/finderShortcuts.ts";
import { finderKey } from "../src/lib/finderKeys.ts";

const read = (f: string) => Bun.file(new URL(`../src/components/finder/machine/${f}`, import.meta.url)).text();
const bar = await read("FinderPathBar.tsx");
const views = await read("FolderViews.tsx");
const column = await read("Column.tsx");

describe("rows 57 and 59: the location box", () => {
  test("it says what it takes, in Strata's words", () => {
    expect(bar).toContain('placeholder="Enter a path or URI…"');
  });
  test("it offers up to 50 folders and its footer names Esc", () => {
    expect(bar).toContain(".picks.slice(0, 50)");
    expect(bar).toContain("Esc</b> Cancel");
  });
});

describe("rows 91 and 265: the selected row's tint is Strata's 22 %, with no outline", () => {
  test("Icons/List", () => {
    expect(views).toContain("var(--primary) 22%, transparent)");
    expect(views).not.toContain("inset 0 0 0 1px");
  });
});

describe("row 110: group headings are bold sentence-case with a rule under them", () => {
  for (const [name, src] of [["column", column], ["list", views]] as const) {
    test(name, () => {
      const at = src.indexOf("key={`h:${it.header}`}");
      const tag = src.slice(at, src.indexOf("</div>", at));
      expect(tag).not.toContain("uppercase");
      expect(tag).toContain("borderBottom");
    });
  }
});

describe("row 170: the sheet lists the keys the finder answers", () => {
  const keys = SECTIONS.flatMap((s) => s.rows.map((r) => r.keys));
  test.each(["Ctrl+F", "Ctrl+A", "F5", "Ctrl+T", "Ctrl+W", "Ctrl+Tab", "Ctrl+Enter", "Alt+Enter", "Ctrl+Alt+T"])("%s is listed and answered", (chord) => {
    expect(keys.some((k) => k.includes(chord))).toBe(true);
    const parts = chord.split("+"); const key = parts.pop()!;
    const ev = { key: key.length === 1 ? key.toLowerCase() : key, ctrl: parts.includes("Ctrl"), meta: false, shift: false, alt: parts.includes("Alt") };
    expect(finderKey(ev, { inField: false, hasSelection: true })).not.toBeNull();
  });
});

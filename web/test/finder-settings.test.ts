/*
 * The finder's own settings, the ones of Strata's BROWSING list that mean
 * something here: sizes in Columns, mirroring the selection into the next
 * column, and the F1 button. They live with the other preferences, one object,
 * and a stored value that is missing or the wrong type falls back alone.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_PREFS, opensOnPick, readPrefs, type Row } from "../src/lib/finderMiller.ts";

const dir: Row = { name: "src", kind: "dir", bytes: null, items: 3, mtime: 0, hidden: false };
const file: Row = { name: "a.ts", kind: "file", bytes: 1, items: null, mtime: 0, hidden: false };

describe("preferences", () => {
  test("Strata's defaults: mirror on, F1 button on", () => { expect(DEFAULT_PREFS.mirror).toBe(true); expect(DEFAULT_PREFS.f1).toBe(true); });
  test("each falls back alone", () => {
    const p = readPrefs(JSON.stringify({ mirror: false, f1: "no", sizes: false }));
    expect(p.mirror).toBe(false);
    expect(p.f1).toBe(true);
    expect(p.sizes).toBe(false);
  });
});

describe("mirror columns selection", () => {
  test("on: choosing a folder opens its column", () => { expect(opensOnPick(dir, true)).toBe(true); });
  test("off: choosing a folder only selects it", () => { expect(opensOnPick(dir, false)).toBe(false); });
  test("a file or a locked folder never opens a column", () => {
    expect(opensOnPick(file, true)).toBe(false);
    expect(opensOnPick({ ...dir, locked: true }, true)).toBe(false);
  });
});

describe("the finder draws them", () => {
  const read = (f: string) => Bun.file(new URL(`../src/components/finder/machine/${f}`, import.meta.url)).text();
  test("the F1 button is only there when asked for, and the keys still work", async () => {
    const s = await read("MachineFinder.tsx");
    expect(s).toMatch(/prefs\.f1 && \(?\s*<button/);
    expect(s).toContain('case "help"');
  });
  test("a pick consults the mirror setting", async () => { expect(await read("MachineFinder.tsx")).toContain("opensOnPick(row, prefs.mirror)"); });
  test("the settings sheet lists the three and a reset", async () => {
    const model = await Bun.file(new URL("../src/lib/finderSettingsModel.ts", import.meta.url)).text();
    for (const t of ["Show sizes in Columns view", "Mirror columns selection", "Show F1 Shortcuts button", "Reset finder settings"]) expect(model).toContain(t);
  });
});

/* Strata's Settings window is a centred card over a dimmed browser, not a page that fills it: left nav with an icon and a subtitle per page, a search field with its own icon, and the rows in bordered cards under a section header. */
describe("the settings window looks like Strata's", () => {
  const read = (f: string) => Bun.file(new URL(`../src/components/finder/machine/${f}`, import.meta.url)).text();
  const body = async () => { const s = await read("FinderChrome.tsx"); const a = s.indexOf("export function FinderSettings("); return s.slice(a, s.indexOf("\n}\n", a)); };
  test("centred, 1180 by 860 at most, over a dimmed finder that closes on a click outside", async () => {
    const s = await body();
    expect(s).toContain("grid place-items-center");
    expect(s).toContain("min(1180px, 100%)");
    expect(s).toContain("min(860px, 100%)");
    expect(s).toMatch(/onClick=\{onClose\}/);
    expect(s).toContain("e.stopPropagation()");
  });
  test("the nav wears an icon and a subtitle per page, and the field a search icon", async () => {
    const s = await body();
    expect(s).toContain('name={p.icon}');
    expect(s).toContain("{p.hint}");
    expect(s).toContain('name="search"');
  });
  test("rows sit in a bordered card under their section header, divided from each other", async () => {
    const s = await body();
    expect(s).toContain('data-card={sec}');
    expect(s).toMatch(/overflow-hidden rounded-lg/);
    expect(s).toMatch(/borderTop: i === 0 \? undefined : LINE/);
  });
  test("the reset is a row, not a button hanging off the nav", async () => {
    expect(await body()).not.toContain("Reset finder settings");
  });
});

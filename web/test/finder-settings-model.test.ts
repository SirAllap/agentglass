import { describe, expect, test } from "bun:test";
import { DEFAULT_PREFS } from "../src/lib/finderMiller.ts";
import { PAGES, ROWS, filterRows, pagesWith, toggleValue } from "../src/lib/finderSettingsModel.ts";

describe("Settings rows", () => {
  test("every row belongs to a page that exists, with Strata's wording for the ones Strata has", () => {
    const ids = new Set(PAGES.map((p) => p.id));
    for (const r of ROWS) expect(ids.has(r.page)).toBe(true);
    const titles = ROWS.map((r) => r.title);
    for (const t of ["Single-click file previews", "Show sizes in Columns view", "Mirror columns selection", "Show F1 Shortcuts button", "Default sort", "Forget all folder settings", "Text size"]) expect(titles).toContain(t);
  });
  test("no row is a switch for something the finder does not have", () => {
    const text = ROWS.map((r) => r.title).join("|").toLowerCase();
    for (const absent of ["autoplay", "10xer", "folder peeking", "language", "theme library", "updates"]) expect(text).not.toContain(absent);
  });
});

describe("Search settings", () => {
  test("empty search shows everything", () => expect(filterRows(ROWS, "  ")).toHaveLength(ROWS.length));
  test("every word has to match, in title, description or section", () => {
    expect(filterRows(ROWS, "mirror").map((r) => r.id)).toEqual(["mirror"]);
    expect(filterRows(ROWS, "thumbnail icons").map((r) => r.id)).toEqual(["thumb"]);
    expect(filterRows(ROWS, "zzqx")).toEqual([]);
  });
  test("it says which pages still have matches", () => {
    expect([...pagesWith(filterRows(ROWS, "text"))]).toContain("appearance");
    expect(pagesWith(filterRows(ROWS, "zzqx")).size).toBe(0);
  });
  test("a toggle reads its pref", () => expect(toggleValue(DEFAULT_PREFS, "mirror")).toBe(DEFAULT_PREFS.mirror));
});

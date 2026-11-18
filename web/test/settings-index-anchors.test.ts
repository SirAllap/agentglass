/*
 * Search lands where it says it will: an index row carries the label the page
 * draws, its jump anchor finds exactly one row, and a header action can be found.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SETTINGS_PAGES, SETTINGS_ROWS, rowId, searchSettings as search } from "../src/lib/settingsIndex.ts";

const pages = SETTINGS_PAGES.map((p) => ({ id: p.id, label: p.label, kw: "" }));
const searchSettings = (q: string) => search(q, pages as never);
const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

describe("the settings index", () => {
  test("a row whose label comes from a table is indexed under its words, not its id", () => {
    const r = SETTINGS_ROWS.find((x) => x.settingId === "cleanup.include");
    expect(r?.label).toBe("Leftovers a cleanup plan holds");
    expect(SETTINGS_ROWS.filter((x) => x.label === x.settingId)).toEqual([]);
  });
  test("that row's anchor is the one the page draws", () => {
    const hit = searchSettings("leftovers a cleanup plan").find((h) => h.label === "Leftovers a cleanup plan holds");
    expect(hit?.row).toBe(rowId("Leftovers a cleanup plan holds"));
    expect(src("components/settings/pages/CleanupRows.tsx")).toMatch(/settingId="cleanup\.include" label=\{COPY\["cleanup\.include"\]\.label\}/);
  });
  test("Pair a phone, now a heading button, still carries the anchor search jumps to", () => {
    expect(SETTINGS_ROWS.some((r) => r.pane === "remote" && r.label === "Pair a phone")).toBe(true);
    expect(src("components/PairPanel.tsx")).toMatch(/if \(frame\) return frame\(\s*<span data-row=\{rowId\("Pair a phone"\)\}/);
  });
  test("two setting rows of one page never share an anchor", () => {
    const seen = new Map<string, string>();
    // A row drawn two ways by a ternary (on / locked) is listed twice, identically: one row on screen.
    const once = SETTINGS_ROWS.filter((r, i) => !!r.settingId && SETTINGS_ROWS.findIndex((x) => x.pane === r.pane && x.section === r.section && x.label === r.label) === i);
    for (const r of once) {
      const hit = searchSettings(r.label).find((h) => h.pane === r.pane && h.label === r.label && h.section === r.section);
      if (!hit) continue;
      const k = `${r.pane}/${hit.row}`;
      expect(seen.has(k) ? `${k} twice` : "").toBe("");
      seen.set(k, r.label);
    }
  });
  test("the jump finds a row by its label id or by its setting id", () => {
    expect(src("components/SettingsModal.tsx")).toContain('[data-setting-id="${CSS.escape(id)}"]');
    expect(src("components/settings/shell/SettingRow.tsx")).toContain('"data-setting-id": p.settingId');
  });
  test("the header's New prompt action can be found", () => {
    expect(searchSettings("new prompt").some((h) => h.label === "New prompt")).toBe(true);
  });
});

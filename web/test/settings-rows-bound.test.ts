/*
 * A Settings row in a migrated pane is bound to a def, or says why it is not.
 *
 * The generator (web/scripts/gen-settings-index.ts) writes each row's
 * `settingId` into settingsRows.gen.ts from the JSX, so this reads the same
 * list the search box does. A row added to Appearance, Diff, Rail or the
 * "How it draws" group of Terminal without a binding fails here, and so does a
 * settingId that names a def that does not exist or a def no row points at.
 * Panes not migrated yet are listed in NOT_YET_MIGRATED and do not fail; a pane
 * on neither list does, so a new page forces the decision.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SETTINGS_ROWS, SETTINGS_PAGES } from "../src/lib/settingsRows.gen.ts";
import { globalStubs } from "./stubGlobal.ts";

const stubGlobal = globalStubs();
stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 } as unknown as Storage);
stubGlobal("location", new URL("http://localhost:5173/"));
stubGlobal("window", new EventTarget());
const R = await import("../src/lib/settingsRegistry.ts");

const src = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");
const migratedRows = SETTINGS_ROWS.filter((r) => R.isMigrated(r.pane, r.section));

describe("rows in a migrated pane", () => {
  test("there are some, in each of the four panes", () => {
    for (const p of ["appearance", "diff", "rail", "terminal"]) expect(migratedRows.some((r) => r.pane === p), p).toBe(true);
  });

  test("each carries a settingId or is marked agentExempt", () => {
    const loose = migratedRows.filter((r) => !r.settingId && !r.agentExempt).map((r) => `${r.pane} / ${r.section} / ${r.label}`);
    expect(loose, "bind the row to a def in web/src/lib/settingsRegistry.ts (settingId=\"…\" before label), or mark it agentExempt").toEqual([]);
  });

  test("a row is never both", () => {
    expect(migratedRows.filter((r) => r.settingId && r.agentExempt)).toEqual([]);
  });

  test("every settingId names a def", () => {
    const dangling = SETTINGS_ROWS.filter((r) => r.settingId && !R.settingIdResolves(r.settingId)).map((r) => r.settingId);
    expect(dangling).toEqual([]);
  });

  test("a row outside the migrated scope that names a def is still a real binding", () => {
    for (const r of SETTINGS_ROWS.filter((x) => !R.isMigrated(x.pane, x.section) && x.settingId)) expect(R.settingIdResolves(r.settingId!)).toBe(true);
  });
});

describe("defs and rows agree", () => {
  const modal = src("components/SettingsModal.tsx") + src("components/ThemePicker.tsx");

  test("every def is reached by a row: a settingId in the generated list, or in source for the rows the generator cannot read", () => {
    const fromGen = new Set(SETTINGS_ROWS.map((r) => r.settingId).filter(Boolean) as string[]);
    const orphans = R.SETTING_DEFS.filter((d) => {
      if (fromGen.has(d.id)) return false;
      // The rail draws one Select per view with a computed label: the generator
      // cannot see it, so the template is checked in the source instead.
      if (d.id.startsWith("rail.place.")) return !modal.includes("settingId={`rail.place.${v.id}`}");
      // The palette grid is a picker, not a labelled row; it calls the def.
      return !modal.includes(`setting("${d.id}")`);
    }).map((d) => d.id);
    expect(orphans).toEqual([]);
  });

  test("a def's page and section are the row's", () => {
    for (const r of SETTINGS_ROWS.filter((x) => x.settingId && !x.settingId.endsWith(".*"))) {
      const d = R.SETTING_DEFS.find((x) => x.id === r.settingId);
      if (!d) continue;
      expect(d.page, r.label).toBe(r.pane);
      expect(d.section, r.label).toBe(r.section);
    }
  });

  test("the rows call the def, not the pref module, on the paths they migrated", () => {
    for (const id of ["diff.wrap", "diff.split", "terminal.fontSize", "appearance.mode", "appearance.accent"]) {
      expect(modal.includes(`setting("${id}").set(`), id).toBe(true);
    }
  });
});

describe("every Settings page is on exactly one list", () => {
  const pages = SETTINGS_PAGES.map((p) => p.id);
  test("migrated, or not yet migrated, never both and never neither", () => {
    for (const id of pages) {
      const migrated = id in R.MIGRATED;
      const notYet = (R.NOT_YET_MIGRATED as readonly string[]).includes(id);
      expect(migrated !== notYet, `${id}: migrated=${migrated} notYet=${notYet}`).toBe(true);
    }
    for (const id of Object.keys(R.MIGRATED)) expect(pages, id).toContain(id);
    for (const id of R.NOT_YET_MIGRATED) expect(pages, id).toContain(id);
  });
});

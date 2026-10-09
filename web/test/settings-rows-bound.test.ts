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
  test("there are some, in each migrated pane", () => {
    for (const p of ["appearance", "diff", "rail", "terminal", "notifications", "browser", "tasks", "clickup"]) expect(migratedRows.some((r) => r.pane === p), p).toBe(true);
  });

  test("each carries a settingId, is marked agentExempt (not a setting) or agentNever (a setting an agent must not reach)", () => {
    const loose = migratedRows.filter((r) => !r.settingId && !r.agentExempt && !r.agentNever).map((r) => `${r.pane} / ${r.section} / ${r.label}`);
    expect(loose, "bind the row to a def in web/src/lib/settingsRegistry.ts (settingId=\"…\" before label), or mark it agentExempt, or agentNever with the reason if an agent must not reach it").toEqual([]);
  });

  test("a row is never two of them", () => {
    expect(migratedRows.filter((r) => [r.settingId, r.agentExempt, r.agentNever].filter(Boolean).length > 1)).toEqual([]);
  });

  test("a row an agent must not reach says why, in a sentence", () => {
    for (const r of SETTINGS_ROWS.filter((x) => x.agentNever)) expect(r.agentNever!.length, `${r.pane} / ${r.label}`).toBeGreaterThan(30);
    // The credential-bearing rows are among them: if the cookie import or the
    // mirror of other apps' notifications ever gets a def, this says so.
    const never = new Set(SETTINGS_ROWS.filter((x) => x.agentNever).map((x) => x.label));
    for (const l of ["Home page", "Right-click to paste", "Terminal runs on", "Mirror this machine's notifications", "How much of the message", "All", "None"]) expect(never.has(l), l).toBe(true);
  });

  test("every settingId names a def", () => {
    const dangling = SETTINGS_ROWS.filter((r) => r.settingId && !R.settingIdResolves(r.settingId)).map((r) => r.settingId);
    expect(dangling).toEqual([]);
  });

  test("a row outside the migrated scope that names a def is still a real binding", () => {
    for (const r of SETTINGS_ROWS.filter((x) => !R.isMigrated(x.pane, x.section) && x.settingId)) expect(R.settingIdResolves(r.settingId!)).toBe(true);
  });
});

/** Each family of defs, and the settingId template its rows are drawn with. */
const FAMILIES: [string, string][] = [
  ["rail.place.", "settingId={`rail.place.${v.id}`}"],
  ["tasks.source.", "settingId={`tasks.source.${id}`}"],
  ["keys.binding.", "settingId={`keys.binding.${id}`}"],
];

describe("defs and rows agree", () => {
  const modal = src("components/SettingsModal.tsx") + src("components/ThemePicker.tsx") + src("components/ClickUpPane.tsx");

  test("every def is reached by a row: a settingId in the generated list, or in source for the rows the generator cannot read", () => {
    const fromGen = new Set(SETTINGS_ROWS.map((r) => r.settingId).filter(Boolean) as string[]);
    const orphans = R.SETTING_DEFS.filter((d) => {
      if (fromGen.has(d.id)) return false;
      // A family (one control per view, source or action) draws rows with a
      // computed label: the generator cannot see them, so the template is
      // checked in the source instead.
      const family = FAMILIES.find(([prefix]) => d.id.startsWith(prefix));
      if (family) return !modal.includes(family[1]);
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

  test("the rows call the def, not the pref module, for every def that is one control", () => {
    for (const d of R.SETTING_DEFS.filter((x) => !FAMILIES.some(([prefix]) => x.id.startsWith(prefix)))) {
      expect(modal.includes(`setting("${d.id}").set(`), `${d.id}: no row calls its def`).toBe(true);
    }
    // The families draw one control per member, through a template.
    expect(modal.includes("setting(`tasks.source.${id}`).set("), "tasks.source.*").toBe(true);
    expect(modal.includes("setting(`keys.binding.${capturing}`).set("), "keys.binding.*").toBe(true);
  });
});

describe("pages left out on purpose", () => {
  test("each is a page not yet migrated, with a reason", () => {
    for (const [id, why] of Object.entries(R.NOT_EXPOSED_ON_PURPOSE)) {
      expect((R.NOT_YET_MIGRATED as readonly string[]).includes(id), `${id} is migrated now; drop the reason`).toBe(true);
      expect(why.length, id).toBeGreaterThan(30);
    }
  });

  test("the pages that hold credentials, trust or consent are among them", () => {
    for (const id of ["connections", "remote", "plugins", "hooks", "understudy"]) expect(id in R.NOT_EXPOSED_ON_PURPOSE, id).toBe(true);
  });
});

describe("a page that is migrated for most of it and refuses the rest", () => {
  test("the ClickUp page is migrated, and what it refuses is named with a reason", () => {
    expect("clickup" in R.MIGRATED).toBe(true);
    expect((R.NOT_YET_MIGRATED as readonly string[]).includes("clickup")).toBe(false);
    expect(R.NEVER_ON_PAGE.clickup!.why.length).toBeGreaterThan(30);
  });

  test("no def on such a page is a secret or names the token, the connection, the workspace or the write switch", () => {
    for (const [page, { pattern }] of Object.entries(R.NEVER_ON_PAGE)) {
      const defs = R.SETTING_DEFS.filter((d) => d.page === page);
      expect(defs.length, page).toBeGreaterThan(0);
      expect(defs.filter((d) => d.secret || pattern.test(d.id) || pattern.test(d.label)).map((d) => d.id), page).toEqual([]);
    }
  });

  test("the guard bites: a secret-class ClickUp def is refused, listed as secret, and never read back", () => {
    const secret = { id: "clickup.token", page: "clickup", section: "", label: "ClickUp token", secret: true as const, level: 2 as const, default: "", type: "string" as const, display: (v: unknown) => String(v), get: () => "pk_1_X", validate: () => "x", set: () => ({ ok: true as const, prev: "", value: "x", revert: () => {} }) };
    const sneaky = { ...secret, id: "clickup.connection.workspace", secret: undefined, label: "Workspace" };
    for (const d of [secret, sneaky]) {
      const { pattern } = R.NEVER_ON_PAGE.clickup!;
      expect(!!d.secret || pattern.test(d.id), d.id).toBe(true);
    }
    const s = R.makeSettings([secret]);
    expect(s.set("clickup.token", "pk_2")).toEqual({ ok: false, error: "secret: not writable through this channel" });
    expect(s.get("clickup.token")).toEqual({ ok: true, id: "clickup.token", set: true });
    expect(JSON.stringify(s.list())).not.toContain("pk_1_X");
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

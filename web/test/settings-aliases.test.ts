import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolvePane, paneWhenClickupKnown, FALLBACK_PAGE, OLD_LABELS, aliasTarget, restorePane, foldMarks } from "../src/lib/openSettings.ts";
import { SETTINGS_PAGE_IDS, SETTINGS_PAGE_ALIASES, SETTINGS_FOLD_SECTIONS, SETTINGS_TREE_PAGES as NEW_PAGES } from "../../shared/uiActions.ts";
import { pageScore, type SettingsPage } from "../src/lib/settingsIndex.ts";

const modal = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url).pathname, "utf8");
const oldIds = [...new Set([...SETTINGS_PAGE_IDS, ...Object.keys(SETTINGS_PAGE_ALIASES), "open", "export"])];

describe("old Settings ids land on a page of the new tree", () => {
  test("every old id resolves to a page that exists", () => {
    for (const id of oldIds) expect((NEW_PAGES as readonly string[]).includes(resolvePane(id)), id).toBe(true);
  });
  test("folded pages name their new home and section", () => {
    expect(aliasTarget("permWorkers")).toEqual({ page: "perm", section: "worker-commands" });
    expect(aliasTarget("polaris")).toEqual({ page: "polaris" });
    expect(aliasTarget("tmux")).toEqual({ page: "advanced", section: "terminal-engine" });
    expect(resolvePane("lantern")).toBe("hooks");
    expect(resolvePane("review")).toBe("recipes");
  });
  test("a page that kept its id is left alone; plugin:<name> passes through", () => {
    for (const id of ["finder", "jira", "workers", "fplan"]) expect(resolvePane(id)).toBe(id);
    expect(resolvePane("plugin:solfa")).toBe("plugin:solfa");
  });
  test("the ClickUp rule still runs after the map", () => {
    expect(paneWhenClickupKnown(resolvePane("connections"), false)).toBe("tasks");
    expect(paneWhenClickupKnown(resolvePane("clickup"), false)).toBe("tasks");
    expect(paneWhenClickupKnown(resolvePane("clickup"), true)).toBe("clickup");
  });
  test("every folded id is a tab of the modal, drawn under its home (the alias table has no dead end)", () => {
    for (const old of Object.keys(SETTINGS_FOLD_SECTIONS)) {
      expect(modal, old).toContain(`id: "${old}"`);
      expect((NEW_PAGES as readonly string[]).includes(resolvePane(old)), old).toBe(true);
    }
  });
});

describe("the agent door and the UI open the same page", () => {
  test("every id the door accepted, and every alias it knew, resolves to the page the UI opens, and that page exists", () => {
    const ui = (id: string) => resolvePane(id);
    for (const id of [...SETTINGS_PAGE_IDS, ...Object.keys(SETTINGS_PAGE_ALIASES)]) {
      const want = (SETTINGS_PAGE_ALIASES as Record<string, string>)[id] ?? id;
      expect(ui(id), id).toBe(want);
      expect((NEW_PAGES as readonly string[]).includes(want), `${id} -> ${want}`).toBe(true);
    }
  });
  test("an alias never points at another alias", () => {
    for (const [id, to] of Object.entries(SETTINGS_PAGE_ALIASES)) expect(to in SETTINGS_PAGE_ALIASES, `${id} -> ${to}`).toBe(false);
  });
});

describe("the remembered page", () => {
  test("an old id seeded in storage opens the mapped page", () => {
    expect(restorePane("permBrowser")).toBe("perm");
    expect(restorePane("prefs")).toBe("appearance");
    expect(restorePane("onboarding")).toBe("about");
    expect(restorePane("plugin:solfa")).toBe("plugin:solfa");
  });
  test("an id that names nothing opens Appearance", () => {
    for (const bad of ["nope", "", null, undefined]) expect(restorePane(bad)).toBe(FALLBACK_PAGE);
    expect(FALLBACK_PAGE).toBe("appearance");
  });
  test("the modal restores through the map", () => {
    expect(modal).toContain("restorePane(localStorage.getItem(LAST_PANE_KEY))");
  });
});

describe("old labels stay searchable", () => {
  // The modal's own tabs: label and kw from source, plus the old labels it appends, as the modal does.
  const pages: SettingsPage[] = [...modal.matchAll(/\{ id: "([A-Za-z-]+)"(?: as const)?, label: "([^"]*)", group: "[^"]*"(?: as const)?, kw: "([^"]*)"/g)]
    .map((m) => ({ id: m[1]!, label: m[2]!, kw: `${m[3]} ${OLD_LABELS[m[1]!] ?? ""}` }) as SettingsPage);
  test("every old label finds a page that is, or folds into, a page of the new tree", () => {
    for (const [id, label] of Object.entries(OLD_LABELS)) {
      const best = pages.map((p) => ({ id: p.id, s: pageScore(p, label.toLowerCase()) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
      expect(best.length, label).toBeGreaterThan(0);
      expect((NEW_PAGES as readonly string[]).includes(resolvePane(best[0]!.id)), `${label} -> ${best[0]!.id}`).toBe(true);
      expect(modal.includes(`id: "${id}"`), id).toBe(true);
    }
  });
});

describe("nav marks of a folded page", () => {
  test("show on the page that took it in, the worst state winning", () => {
    expect(foldMarks({ tmux: { state: "needs" } }).advanced?.state).toBe("needs");
    expect(foldMarks({ tmux: { state: "on" }, advanced: { state: "needs" } }).advanced?.state).toBe("needs");
    expect(foldMarks({ connections: { state: "err" }, tasks: { state: "on" } }).tasks?.state).toBe("err");
  });
});

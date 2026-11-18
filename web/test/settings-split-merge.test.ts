import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { modalSource } from "./settingsSource.ts";
import { resolvePane } from "../src/lib/openSettings.ts";
import { SETTINGS_PAGES, SETTINGS_ROWS } from "../src/lib/settingsRows.gen.ts";

const src = modalSource();

function block(id: string): string {
  const a = src.indexOf(`{show("${id}") &&`);
  expect(a).toBeGreaterThan(-1);
  const next = src.indexOf("{ql && show(", a);
  return src.slice(a, next > -1 ? next : undefined);
}
const label = (id: string) => SETTINGS_PAGES.find((p) => p.id === id)?.label;
const rowsOn = (pane: string) => SETTINGS_ROWS.filter((r) => r.pane === pane).map((r) => r.label);

describe("slice 5: Lantern split, usage, data", () => {
  test("Lantern is one block of Agents, with its live card beside Watching", () => {
    expect(block("hooks")).toContain("function WatchingPage");
    expect(src).toContain('title="Watching"');
    expect(src).toContain("<LanternPreview");
    expect(src).not.toContain('id: "lantern", label: "Lantern"');
    expect(src).not.toContain('show("lantern")');
    expect(label("lantern")).toBeUndefined();
  });

  test("labels", () => {
    expect(label("budgets")).toBe("Usage & budgets");
    expect(label("privacy")).toBe("Data & privacy");
    expect(label("prefs")).toBe("Window & startup");
    expect(label("tmux")).toBe("Terminal engine");
    expect(label("export")).toBeUndefined();
  });

  test("Export rows are a section of Data & privacy", () => {
    const b = block("privacy");
    expect(b).toContain("function DataSettingsPage");
    // The card moved into the page's own component, so the exports sit in the same card order as the rest of the page.
    const pane = readFileSync(new URL("../src/components/settings/pages/DataPage.tsx", import.meta.url), "utf8");
    expect(pane).toContain('title="Take your data out"');
    expect(pane).toContain("api.exportUrl(");
    expect(pane).toContain("api.skillsExportUrl()");
    expect(src).not.toContain('show("export")');
  });

  test("old ids resolve: export -> privacy, open -> prefs, lantern -> hooks, live ids stay", () => {
    expect(resolvePane("export")).toBe("privacy");
    expect(resolvePane("open")).toBe("appearance");
    expect(resolvePane("lantern")).toBe("hooks");
    for (const id of ["hooks", "privacy"]) expect(resolvePane(id)).toBe(id);
    expect(resolvePane("budgets")).toBe("engines");
  });

  test("the index puts the Lantern settings on hooks, and no row on a lantern page", () => {
    expect(rowsOn("lantern")).toEqual([]);
    expect(rowsOn("hooks")).toEqual(expect.arrayContaining([
      "Watch the agents and notify me",
      "Ask sessions what they are working on",
    ]));
    // The wake interval is the orchestrator's own timing: drawn on the Orchestration page, so indexed there.
    expect(rowsOn("orchestration")).toContain("Wake the orchestrator at least every");
    expect(rowsOn("export")).toEqual([]);
    // Export rows come from the EXPORTS list (a .map), which the indexer cannot read; the page rows are indexed.
    expect(rowsOn("privacy")).toContain("Erase local history");
  });
});

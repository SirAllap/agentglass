import { describe, expect, test } from "bun:test";
import { resolvePane } from "../src/lib/openSettings.ts";
import { SETTINGS_PAGES, SETTINGS_ROWS } from "../src/lib/settingsRows.gen.ts";

const src = await Bun.file(new URL("../src/components/SettingsModal.tsx", import.meta.url)).text();

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
    expect(block("hooks")).toContain("<AgentsPage");
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
    expect(label("tmux")).toBe("Pane engine");
    expect(label("export")).toBeUndefined();
  });

  test("Export rows are a section of Data & privacy", () => {
    const b = block("privacy");
    expect(b).toContain("<PrivacyPane");
    // The card moved into the page's own component, so the exports sit in the same card order as the rest of the page.
    const pane = src.slice(src.indexOf("function PrivacyPane("), src.indexOf("type ToolsFilter"));
    expect(pane).toContain('<SettingsCard title="Take your data out"');
    expect(pane).toContain("api.exportUrl(");
    expect(pane).toContain("api.skillsExportUrl()");
    expect(src).not.toContain('show("export")');
  });

  test("old ids resolve: export -> privacy, open -> prefs, lantern -> hooks, live ids stay", () => {
    expect(resolvePane("export")).toBe("privacy");
    expect(resolvePane("open")).toBe("prefs");
    expect(resolvePane("lantern")).toBe("hooks");
    for (const id of ["hooks", "budgets", "privacy"]) expect(resolvePane(id)).toBe(id);
  });

  test("the index puts the Lantern settings on hooks, and no row on a lantern page", () => {
    expect(rowsOn("lantern")).toEqual([]);
    expect(rowsOn("hooks")).toEqual(expect.arrayContaining([
      "Watch the agents and notify me",
      "Ask sessions what they are working on",
      "Wake the orchestrator at least every",
    ]));
    expect(rowsOn("export")).toEqual([]);
    expect(rowsOn("privacy").some((l) => /Events/.test(l))).toBe(true);
  });
});

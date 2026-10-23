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
  test("Lantern is its own page and its section is not on Agents", () => {
    expect(block("lantern")).toContain("<LanternSection");
    expect(block("hooks")).not.toContain("LanternSection");
    expect(src).toContain('id: "lantern", label: "Lantern"');
    expect(src).toContain("icon: LanternIcon");
    expect(label("lantern")).toBe("Lantern");
  });

  test("labels", () => {
    expect(label("budgets")).toBe("Usage & budgets");
    expect(label("privacy")).toBe("Data & privacy");
    expect(label("prefs")).toBe("Window & startup");
    expect(label("tmux")).toBe("Pane engine (tmux)");
    expect(label("export")).toBeUndefined();
  });

  test("Export rows are a section of Data & privacy", () => {
    const b = block("privacy");
    expect(b).toContain("<PrivacyPane");
    expect(b).toContain('<SettingsCard title="Take your data out"');
    expect(b).toContain("api.exportUrl(");
    expect(b).toContain("api.skillsExportUrl()");
    expect(src).not.toContain('show("export")');
  });

  test("old ids resolve: export -> privacy, open -> prefs, live ids stay", () => {
    expect(resolvePane("export")).toBe("privacy");
    expect(resolvePane("open")).toBe("prefs");
    for (const id of ["hooks", "budgets", "lantern", "privacy"]) expect(resolvePane(id)).toBe(id);
  });

  test("the index puts Lantern rows on lantern, not hooks", () => {
    expect(rowsOn("lantern").length).toBeGreaterThan(0);
    expect(rowsOn("hooks").some((l) => /lantern/i.test(l))).toBe(false);
    expect(rowsOn("export")).toEqual([]);
    expect(rowsOn("privacy").some((l) => /Events/.test(l))).toBe(true);
  });
});

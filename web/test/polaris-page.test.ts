/*
 * Polaris is a page of its own in Settings > Agents, a sister of Orchestration.
 *
 * Read from source (there is no renderer here): the nav entry, the page body
 * that reuses PolarisView with its own project choice, the pointer left behind
 * in Orchestration, and the old stored link landing on the new page.
 */
import { SETTINGS_TREE_PAGES } from "../../shared/uiActions.ts";
import { aliasTarget } from "../src/lib/openSettings.ts";
import { describe, expect, test } from "bun:test";
import { modalSource } from "./settingsSource.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS_PAGE_IDS } from "../../shared/uiActions.ts";
import { SCOPE_KEY, openingScope, recallScope, rememberScope } from "../src/components/orchestration/orchestrationCopy.ts";

const src = (p: string) => readFileSync(join(import.meta.dir, "..", "src", p), "utf8");
const modal = modalSource();
const pane = src("components/orchestration/OrchestrationPane.tsx");
const flowCss = src("components/orchestration/orchestration.css");
const polaris = src("components/settings/pages/PolarisPage.tsx");
const open = src("lib/openSettings.ts");

describe("the page in the nav", () => {
  test("Polaris is a page of its own under Agents: in the rail group and the tree, no longer an alias of Flow & review", () => {
    expect(modal).toContain('{ id: "polaris", label: "Polaris", group: "Agents"');
    expect(aliasTarget("polaris")).toEqual({ page: "polaris" });
    expect(SETTINGS_TREE_PAGES.indexOf("polaris")).toBe(SETTINGS_TREE_PAGES.indexOf("orchestration") + 1);
  });
  test("the modal draws that page", () => {
    // modalSource() reads a page's file where the modal draws it, so the page's own body is what shows there.
    expect(modal).toContain("<PolarisView root={sc.root} />");
    expect(modal).toContain('<DoorRowList title="Polaris" specs={POLARIS}');
    expect(src("components/SettingsModal.tsx")).toContain('show("polaris") && <PolarisPage />');
  });
  test("the agent door opens it too: settings.open validates against the same list", () => {
    expect([...SETTINGS_PAGE_IDS]).toContain("polaris");
  });
});

describe("the page body", () => {
  test("it reuses the one Polaris view with the project it shows", () => {
    expect(polaris).toContain("<PolarisView root={sc.root} />");
    expect(polaris).toContain("useScope()");
  });
  test("the project choice is a real control, All projects included", () => {
    // The shared Applies to control (All projects | Only <project>), not a dropdown: one control for "whose setting" everywhere.
    expect(polaris).toContain("<ScopeControl");
    expect(polaris).not.toContain("<Select");
  });
  test("picking a project is remembered for the next visit", () => {
    expect(polaris).toContain("sc.controlProps");
    const store = new Map<string, string>();
    const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    rememberScope(s, "/home/acme/orbit");
    expect(recallScope(s)).toBe("/home/acme/orbit");
    expect([...store.keys()]).toEqual([SCOPE_KEY]);
  });
  test("a remembered project that is gone falls back to All projects, never to a scope nobody can see", () => {
    // The rule the page applies when the project list arrives.
    expect(openingScope("/home/acme/gone", ["/home/acme/orbit"], null)).toBe("");
    expect(openingScope("/home/acme/orbit", ["/home/acme/orbit"], null)).toBe("/home/acme/orbit");
    expect(openingScope("", ["/home/acme/orbit"], null)).toBe("");
  });
  test("nothing in the page polls", () => {
    const code = polaris.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/);
  });
  test("the way back to Orchestration is on this page too", () => {
    expect(polaris).toContain('openSettings("orchestration")');
    expect(polaris).toContain("Open Orchestration settings");
  });
});

describe("Orchestration keeps the rules and one pointer", () => {
  test("the Polaris tab and its slot are gone", () => {
    expect(pane).not.toContain("PolarisSlot");
    expect(pane).not.toContain("<PolarisView");
    expect(pane).not.toMatch(/label: "Polaris"/);
  });
  test("the Orchestration page keeps no card for Polaris, only the link row of its Polaris section", () => {
    expect(pane).not.toContain("Open Polaris settings");
    expect(pane.split('openSettings("polaris")').length - 1).toBe(1);
  });
});

describe("an old link", () => {
  test("a stored polaris link opens the page, not Orchestration", () => {
    expect(open).not.toContain('polaris: "orchestration"');
  });
});

describe("the docs follow the page", () => {
  const flat = (s: string) => s.replace(/\s+/g, " ");
  const doc = flat(readFileSync(join(import.meta.dir, "..", "..", "docs", "POLARIS.md"), "utf8"));
  const flowDoc = flat(readFileSync(join(import.meta.dir, "..", "..", "docs", "settings", "orchestration.md"), "utf8"));
  test("POLARIS.md names the page that exists, and its own scope choice", () => {
    expect(doc).toContain("Settings > Agents > Polaris");
    expect(doc).not.toContain("Settings > Orchestration > Polaris");
    expect(doc).not.toContain("scope bar");
    expect(doc).toContain("Settings for");
  });
  test("orchestration.md no longer describes a Flow / Polaris switch", () => {
    expect(flowDoc).not.toContain("Flow / Polaris");
    expect(flowDoc).not.toContain("two views");
    expect(flowDoc).toContain("page of its own in Settings > Agents");
  });
});

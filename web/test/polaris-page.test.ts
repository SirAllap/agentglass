/*
 * Polaris is a page of its own in Settings > Agents, a sister of Orchestration.
 *
 * Read from source (there is no renderer here): the nav entry, the page body
 * that reuses PolarisView with its own project choice, the pointer left behind
 * in Orchestration, and the old stored link landing on the new page.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS_PAGE_IDS } from "../../shared/uiActions.ts";
import { SCOPE_KEY, openingScope, recallScope, rememberScope } from "../src/components/orchestration/orchestrationCopy.ts";

const src = (p: string) => readFileSync(join(import.meta.dir, "..", "src", p), "utf8");
const modal = src("components/SettingsModal.tsx");
const pane = src("components/orchestration/OrchestrationPane.tsx");
const flowCss = src("components/orchestration/orchestration.css");
const polaris = src("components/polaris/PolarisPane.tsx");
const open = src("lib/openSettings.ts");

describe("the page in the nav", () => {
  test("Polaris is a page of the Agents group, right after Orchestration", () => {
    const entry = modal.indexOf('{ id: "polaris", label: "Polaris", group: "Agents"');
    expect(entry).toBeGreaterThan(0);
    const orch = modal.indexOf('{ id: "orchestration", label: "Orchestration"');
    expect(entry).toBeGreaterThan(orch);
    // Nothing between the two but the orchestration entry's own line and comments.
    const between = modal.slice(orch, entry);
    expect(between.match(/\{ id: "/g)?.length).toBe(1);
  });
  test("the modal draws that page", () => {
    expect(modal).toContain('{show("polaris") && <PolarisPane />}');
  });
  test("the agent door opens it too: settings.open validates against the same list", () => {
    expect([...SETTINGS_PAGE_IDS]).toContain("polaris");
  });
});

describe("the page body", () => {
  test("it reuses the one Polaris view with the project it shows", () => {
    expect(polaris).toContain("<PolarisView root={root} />");
    expect(polaris).toContain("api.projects()");
  });
  test("the project choice is a real control, All projects included", () => {
    expect(polaris).toContain('"All projects"');
    // The same chips Orchestration uses, not a dropdown: one control for "whose setting" everywhere.
    expect(polaris).toContain("<OrchSeg");
    expect(polaris).not.toContain("<Select");
  });
  test("picking a project is remembered for the next visit", () => {
    expect(polaris).toContain("rememberScope(storage(), next)");
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
    expect(polaris).toContain("setRoot((cur) => openingScope(cur, ws, null))");
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
  test("the Orchestration page keeps no card or row for Polaris", () => {
    expect(pane).not.toContain("Open Polaris settings");
    expect(pane).not.toContain('openSettings("polaris")');
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

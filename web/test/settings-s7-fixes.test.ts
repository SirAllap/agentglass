/*
 * Visual-QA fixes on the redesigned Settings, asserted against source (there
 * is no renderer here). Each one is a defect measured in a 1440px shot.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const at = (p: string) => readFileSync(new URL(p, import.meta.url).pathname, "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const modal = strip(at("../src/components/SettingsModal.tsx"));
const theme = strip(at("../src/components/ThemePicker.tsx"));
const teach = strip(at("../src/components/understudy/Teach.tsx"));
const diffPreview = strip(at("../src/components/settings/previews/DiffPreview.tsx"));

describe("settings s7 fixes", () => {
  test("the Mode control drops under its text instead of overlapping it", () => {
    expect(theme).toMatch(/settingId="appearance\.mode"\s+wide\b/);
  });
  test("Diff default view drops under its long hint instead of stacking its own options", () => {
    expect(modal).toMatch(/settingId="diff\.split" wide\b/);
    expect(modal).toContain("wide={wide ?? choiceIsWide(");
  });
  test("a shortcut row has a Rebind verb, single-chip rows and app chords", () => {
    expect(modal).toContain("function RebindButton(");
    expect(modal.match(/<RebindButton /g)?.length).toBe(2);
    expect(modal).toMatch(/\{!chord && <RebindButton/);
  });
  test("precedents are capped behind a Show all button", () => {
    expect(teach).toContain("const PRECEDENT_ROWS = 8;");
    expect(teach).toContain("precedents.slice(0, PRECEDENT_ROWS)");
    expect(teach).toContain("Show all ${precedents.length}");
    expect(teach).not.toMatch(/\{precedents\.map\(/);
  });
  test("the diff preview scrolls sideways instead of clipping a long line", () => {
    expect(diffPreview).toContain("overflow-x-auto overflow-y-hidden");
    expect(diffPreview).not.toContain('rounded-lg overflow-hidden min-w-0');
  });
});

describe("settings keyboard (fix 1)", () => {
  test("Settings is a focus-trapped dialog, spread on its shell", () => {
    expect(modal).toContain('useModalDialog(open, "Settings")');
    expect(modal).toMatch(/<motion\.div\s+\{\.\.\.dialog\}/);
  });
  test("the second Escape reads the armed state from a ref, not a stale closure", () => {
    expect(modal).toContain("if (escRef.current) { escRef.current = false;");
    expect(modal).not.toMatch(/\}, \[open, onClose, escArmed\]\);/);
  });
});

describe("marks agree with their pages (fix 2)", () => {
  const engines = strip(at("../src/components/engines/EnginesPane.tsx"));
  test("Agent engines and Knowledge report the same fact their cards show", () => {
    expect(engines).toContain('useReportNeeds("engines"');
    expect(teach).toContain('useReportNeeds("understudy"');
  });
  test("a wizard's next step is info, not the amber of needs-you", () => {
    expect(teach).toContain('active ? "info" as const');
  });
  test("the nav count comes from the Tools page's own rule", () => {
    expect(modal).toContain("connections: connectionsNeeding(deps ?? [], provs ?? [])");
  });
});

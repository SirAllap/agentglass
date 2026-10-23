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

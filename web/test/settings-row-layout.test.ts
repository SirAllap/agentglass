/*
 * Settings row layout rules: one control column, one-line hints that fold,
 * a dot on a row that left its default, and a page Reset that only exists
 * when something on the page can be reset.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resetShown } from "../src/lib/settingsModified.ts";

const at = (p: string) => readFileSync(new URL(p, import.meta.url).pathname, "utf8");
const css = at("../src/index.css");
const rowSrc = at("../src/components/SettingRow.tsx");
const modalSrc = at("../src/components/SettingsModal.tsx");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const rowCode = stripComments(rowSrc);
const modalCode = stripComments(modalSrc);

/** The body of `function name(` up to its own closing brace. */
function fnBody(code: string, sig: string): string {
  const start = code.indexOf(sig);
  expect(start).toBeGreaterThan(-1);
  let depth = 0, i = code.indexOf("{", code.indexOf(")", start) + 1);
  const from = i;
  for (; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) break;
  }
  return code.slice(from, i + 1);
}

describe("control column", () => {
  test("the row grid reads the token, and the token is declared once", () => {
    const rule = css.match(/\.agx-settings-row \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("minmax(var(--settings-control-w), max-content)");
    expect(css.match(/--settings-control-w:\s*220px/g)?.length).toBe(1);
    expect(css.match(/--settings-control-w\s*:/g)?.length).toBe(1);
  });
  test("the narrow container query and the only-child rule are untouched", () => {
    expect(css).toContain(".agx-settings-row { grid-template-columns: 1fr; }");
    expect(css).toContain(".agx-settings-row > :only-child { justify-self: start; }");
  });
});

describe("a description is shown whole", () => {
  test("no fold, no clamp, no More", () => {
    // It folded past twelve words: 89 descriptions cut mid-sentence and 85
    // More buttons, measured across the settings pages.
    expect(rowCode).not.toMatch(/HINT_FOLD_WORDS|hintNeedsFold|HintMore|agx-settings-hint-clamp|agx-settings-more/);
    expect(css).not.toMatch(/agx-settings-hint-clamp|agx-settings-more/);
    const row = fnBody(rowCode, "export function SettingRow(");
    expect(row).toContain('<span className="block text-[12px] t-dim mt-1">{hint}</span>');
  });
  test("the stacked and detail slots are never inside a button or a link", () => {
    const row = fnBody(rowCode, "export function SettingRow(");
    expect(row).toContain("const stacked = operable ? undefined : below;");
    expect(row).toContain("const more = operable ? undefined : detail;");
  });
});

describe("modified dot", () => {
  test("rendered only when modified, in an existing colour token", () => {
    const row = fnBody(rowCode, "export function SettingRow(");
    expect(row).toContain("modified &&");
    expect(rowSrc).toContain("Changed from default");
    expect(rowCode).toContain("var(--success)");
  });
  test("Toggle and Choice pass it through", () => {
    expect(fnBody(rowCode, "export function Toggle(")).toContain("modified={modified}");
    expect(fnBody(modalCode, "function Choice<T extends string>(")).toContain("modified={modified}");
  });
});

describe("Reset page", () => {
  test("only with at least one modified row", () => {
    expect(resetShown([])).toBe(false);
    expect(resetShown([false, false])).toBe(false);
    expect(resetShown([false, true])).toBe(true);
  });
  test("the header offers it, and the four pages are wired", () => {
    expect(modalCode).toContain("Reset page");
    for (const p of ["prefs", "appearance", "terminal", "diff"]) {
      expect(modalCode).toMatch(new RegExp(`\\b${p}: \\[`));
    }
  });
});

describe("card header control", () => {
  test("Section takes a headerControl and draws it in the head", () => {
    const sec = fnBody(modalCode, "function Section(");
    expect(modalCode).toContain("headerControl");
    expect(sec).toContain("headerControl !== undefined && <div");
    expect(sec).toContain("agx-settings-head");
  });
});

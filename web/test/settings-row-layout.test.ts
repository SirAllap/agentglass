/*
 * Settings row layout rules: one control column, one-line hints that fold,
 * a dot on a row that left its default, and a page Reset that only exists
 * when something on the page can be reset.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hintNeedsFold, HINT_FOLD_WORDS } from "../src/components/SettingRow.tsx";
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

describe("one-line hint", () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
  test("13 words fold, 12 do not", () => {
    expect(HINT_FOLD_WORDS).toBe(12);
    expect(hintNeedsFold(words(13))).toBe(true);
    expect(hintNeedsFold(words(12))).toBe(false);
    expect(hintNeedsFold("")).toBe(false);
    expect(hintNeedsFold("  spaced   out  ")).toBe(false);
  });
  test("the full hint stays in the DOM and the clamp is CSS", () => {
    expect(css).toMatch(/\.agx-settings-hint-clamp\s*\{[^}]*-webkit-line-clamp:\s*1/);
    expect(rowCode).toContain("agx-settings-hint-clamp");
  });
  test("More is a real button that never sits inside the row's own button or link", () => {
    const more = fnBody(rowCode, "function HintMore(");
    expect(more).toContain("<button");
    expect(more).not.toContain('role="button"');
    expect(more).toContain("aria-expanded");
    expect(more).toContain("aria-controls");
    const row = fnBody(rowCode, "export function SettingRow(");
    // Operable rows draw it as a sibling after the row; plain rows inline.
    expect(row).toContain("fold && !operable");
    expect(row).toContain("{body}</button>\n        {more}");
    expect(row).toContain("{body}</a>{more}");
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

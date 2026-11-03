/*
 * The Details panel of an engine tile is ONE tone.
 *
 * Measured, not matched as text: the panel is --surface-inset at 40% over the
 * card, and a disclosure body inside it repainted --surface-inset at full
 * strength. The OpenCode tile is where that showed — its key guide opens by
 * default — and its steps sat a shade off every other row of the panel
 * (#2c2c2c against #282828 on graphite, #414255 against #37384b on Catppuccin
 * Mocha). The colour below is computed from index.css and each theme's own
 * vars, so a rule that stops being one tone fails here instead of waiting for
 * somebody to see it.
 */
import { describe, expect, test } from "bun:test";
import { parseColor, toHex, type Rgb } from "../src/lib/contrast.ts";
import { THEMES } from "../src/lib/themes.ts";

const css = (await Bun.file(new URL("../src/index.css", import.meta.url)).text()).replace(/\/\*[\s\S]*?\*\//g, "");

/** A declaration as written, the last one for that selector and property winning. */
function decl(sel: string, prop: string): string | null {
  let found: string | null = null;
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (rule[1]!.trim() !== sel) continue;
    const m = rule[2]!.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
    if (m) found = m[1]!.trim();
  }
  return found;
}

/** The tokens on `:root`, in source order, so a later block wins as it does in CSS. */
const tokens: Record<string, string> = {};
for (const block of css.matchAll(/:root\s*\{([^}]*)\}/g)) {
  for (const m of block[1]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) tokens[m[1]!] = m[2]!.trim();
}

type Paint = { color: Rgb; alpha: number };

/** `var(--x)`, a literal, `transparent`, or a `color-mix` of two of those. */
function paint(value: string, vars: Record<string, string>, depth = 0): Paint {
  const v = value.trim();
  if (depth > 6) throw new Error(`too deep: ${value}`);
  if (v === "transparent") return { color: { r: 0, g: 0, b: 0 }, alpha: 0 };
  const literal = parseColor(v);
  if (literal) return { color: literal, alpha: 1 };
  const variable = v.match(/^var\((--[\w-]+)\)$/);
  if (variable) {
    const next = vars[variable[1]!];
    if (!next) throw new Error(`no ${variable[1]} to resolve ${value}`);
    return paint(next, vars, depth + 1);
  }
  const mix = v.match(/^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*(.+)\)$/);
  if (!mix) throw new Error(`cannot resolve ${value}`);
  const a = paint(mix[1]!, vars, depth + 1), b = paint(mix[3]!, vars, depth + 1);
  const t = Number(mix[2]) / 100;
  const alpha = a.alpha * t + b.alpha * (1 - t);
  const part = (channel: (p: Paint) => number, p: Paint, share: number) => (alpha ? (channel(p) * p.alpha * share) / alpha : 0);
  return {
    alpha,
    color: {
      r: Math.round(part((p) => p.color.r, a, t) + part((p) => p.color.r, b, 1 - t)),
      g: Math.round(part((p) => p.color.g, a, t) + part((p) => p.color.g, b, 1 - t)),
      b: Math.round(part((p) => p.color.b, a, t) + part((p) => p.color.b, b, 1 - t)),
    },
  };
}

/** What is actually seen: the paint laid over the tone under it. */
function over(top: string, under: Rgb, vars: Record<string, string>): Rgb {
  const p = paint(top, vars);
  return {
    r: Math.round(p.color.r * p.alpha + under.r * (1 - p.alpha)),
    g: Math.round(p.color.g * p.alpha + under.g * (1 - p.alpha)),
    b: Math.round(p.color.b * p.alpha + under.b * (1 - p.alpha)),
  };
}

const CARD = tokens["--surface-card"]!;
const FIELD = tokens["--surface-inset"]!;
const PANEL = decl(".agx-tile-d", "background")!;
/** The panel's own body: a descendant rule for a disclosure inside it wins. */
const BODY = decl(".agx-tile-d .agx-disclosure-b", "background") ?? decl(".agx-disclosure-b", "background")!;

const themes = THEMES.filter((t) => parseColor((t.vars as Record<string, string>)["--bg2"] ?? "") && parseColor((t.vars as Record<string, string>)["--bg3"] ?? ""));
const varsOf = (t: (typeof THEMES)[number]) => ({ ...tokens, ...(t.vars as Record<string, string>) });

/** One row of the panel, and the body of a disclosure inside it. */
function tones(t: (typeof THEMES)[number], body: string): { row: string; body: string; field: string } {
  const vars = varsOf(t);
  const card = over(CARD, { r: 0, g: 0, b: 0 }, vars);
  const row = over(PANEL, card, vars);
  return { row: toHex(row), body: toHex(over(body, row, vars)), field: toHex(over(FIELD, row, vars)) };
}

describe("an engine tile's Details panel", () => {
  test("the sweep reads every theme, and both rules it measures", () => {
    expect(themes.length).toBeGreaterThanOrEqual(30);
    expect(PANEL).toContain("--surface-inset");
    expect(BODY).toBe("transparent");
  });

  test("a disclosure body inside it keeps the panel's one tone, in every theme", () => {
    const off = themes.filter((t) => {
      const n = tones(t, BODY);
      return n.row !== n.body;
    }).map((t) => t.id);
    expect(off).toEqual([]);
  });

  test("the guard bites: without that rule the body lands on a second tone", () => {
    const plain = decl(".agx-disclosure-b", "background")!;
    const two = themes.filter((t) => {
      const n = tones(t, plain);
      return n.row !== n.body;
    });
    expect(two.length).toBe(themes.length);
  });

  test("the panel is not the field's own tone: a text field in it still reads as inset", () => {
    const same = themes.filter((t) => {
      const n = tones(t, BODY);
      return n.field === n.row;
    }).map((t) => t.id);
    expect(same).toEqual([]);
  });
});

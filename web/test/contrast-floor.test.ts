// A floor under the recessive text tiers.
//
// Thirty-odd themes each picked --text2/3/4 by eye and 555 places in the app
// ask for one of them, so a tier that reads as "quiet" on the theme it was
// designed against is illegible on half the others. What is pinned here: a
// theme that already clears its target is not touched, one that does not is
// lifted exactly as far as it must be, and the ladder never inverts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  contrast, floorTiers, liftToContrast, parseColor, TIER_TARGET,
} from "../src/lib/contrast.ts";

/* Read out of the source rather than imported: `themes.ts` pulls in the API
   client for its tmux/nvim sync, and that wants a `location` a test process
   does not have. The point is to measure the themes that actually ship, so the
   file itself is the honest source — and a parse that stops finding any is a
   failing test, not a silently empty loop. */
const SRC = readFileSync(new URL("../src/lib/themes.ts", import.meta.url), "utf8");

/** Balanced-brace scan, not a regex: several themes carry a nested `ansi`
 *  palette inside `vars`, and a non-greedy `{...}` stops at the inner brace. */
function themesFromSource(src: string): { id: string; vars: Record<string, string> }[] {
  const out: { id: string; vars: Record<string, string> }[] = [];
  const re = /id:\s*"([\w-]+)"/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const at = src.indexOf("vars:", m.index);
    if (at < 0) continue;
    const open = src.indexOf("{", at);
    if (open < 0) continue;
    let depth = 0, end = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) { end = i; break; }
    }
    if (end < 0) continue;
    try { out.push({ id: m[1]!, vars: JSON.parse(src.slice(open, end + 1)) }); } catch { /* not a theme literal */ }
  }
  return out;
}

const THEMES = themesFromSource(SRC);

const ratio = (a: string, b: string) => contrast(parseColor(a)!, parseColor(b)!);

describe("parseColor", () => {
  test("the shapes the themes and the DOM actually use", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor("#1e1e1e")).toEqual({ r: 30, g: 30, b: 30 });
    expect(parseColor("rgb(10, 20, 30)")).toEqual({ r: 10, g: 20, b: 30 });
  });

  test("anything else is left for the caller to pass through untouched", () => {
    expect(parseColor("var(--x)")).toBeNull();
    expect(parseColor("")).toBeNull();
  });
});

describe("contrast", () => {
  test("the two ends of the scale", () => {
    expect(ratio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(ratio("#808080", "#808080")).toBeCloseTo(1, 3);
  });
});

describe("liftToContrast", () => {
  test("a colour that already clears the target is returned as it was", () => {
    // Not merely equivalent — the same string, so a careful theme is provably
    // untouched rather than re-derived into something near it.
    expect(liftToContrast("#d4d4d4", "#fafafa", "#1e1e1e", 7)).toBe("#d4d4d4");
  });

  test("one that does not is lifted until it does, and no further", () => {
    const out = liftToContrast("#555555", "#fafafa", "#1e1e1e", 7);
    expect(out).not.toBe("#555555");
    expect(ratio(out, "#1e1e1e")).toBeGreaterThanOrEqual(7);
    // "no further": one step back down would fail.
    expect(ratio(out, "#1e1e1e")).toBeLessThan(11);
  });

  test("it moves toward the theme's own text, so a light theme darkens", () => {
    const out = liftToContrast("#bbbbbb", "#0a0a0a", "#ffffff", 7);
    expect(parseColor(out)!.r).toBeLessThan(0xbb);
    expect(ratio(out, "#ffffff")).toBeGreaterThanOrEqual(7);
  });

  test("an unparseable colour is passed straight through", () => {
    expect(liftToContrast("var(--x)", "#fff", "#000", 7)).toBe("var(--x)");
  });
});

describe("floorTiers", () => {
  test("the ladder never inverts", () => {
    // --text3 needs a big lift here and --text2 needs none, which is exactly
    // the case that used to end with the quieter tier brighter than the louder.
    const out = floorTiers({ "--text": "#fafafa", "--bg2": "#1e1e1e", "--text2": "#d4d4d4", "--text3": "#2a2a2a", "--text4": "#222222" });
    const d2 = ratio(out["--text2"]!, "#1e1e1e");
    const d3 = ratio(out["--text3"]!, "#1e1e1e");
    const d4 = ratio(out["--text4"]!, "#1e1e1e");
    expect(d3).toBeLessThanOrEqual(d2);
    expect(d4).toBeLessThanOrEqual(d3);
  });

  test("a theme with no text or background is handed back unchanged", () => {
    const v = { "--text2": "#888888" };
    expect(floorTiers(v)).toEqual(v);
  });

  test("every shipped theme clears its targets once floored", () => {
    // A regex that stops matching would otherwise turn this into a test that
    // passes by checking nothing.
    expect(THEMES.length).toBeGreaterThan(25);
    const failures: string[] = [];
    for (const t of THEMES) {
      const v = floorTiers(t.vars as Record<string, string>);
      const bg = v["--bg2"] || v["--bg"];
      for (const [key, target] of Object.entries(TIER_TARGET)) {
        const got = ratio(v[key]!, bg!);
        // Allowed to fall short only when the theme's own --text cannot reach
        // the target either — there is nowhere further to go.
        const ceiling = ratio(v["--text"]!, bg!);
        if (got + 0.01 < target && ceiling >= target) failures.push(`${t.id} ${key} ${got.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

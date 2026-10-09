// Every desktop theme, through the path the window paints with, measured.
//
// A light theme arrived with a selection colour as dark as its own text, and
// the app took that for a surface: chips, the search field and the pinned strip
// were slate with slate text (1.0:1). Another had a "lighter background" equal
// to its background, so cards vanished into the page. Neither is one theme's
// fault to patch; a surface the desktop names is placed without looking at what
// is drawn on it. So this sweeps the whole set, with and without the `mode`
// line a derived palette does not carry, and fails on any text token below its
// ratio on any surface, any two neighbouring surfaces too alike to tell apart,
// and a border too faint to see.
import { describe, expect, test } from "bun:test";
import { desktopTheme } from "../../shared/desktopPalette.ts";
import { contrast, floorTiers, inkTints, paintDesktop, parseColor } from "../src/lib/contrast.ts";
import { OMARCHY_PALETTES } from "./fixtures/omarchy-palettes.ts";

type Paint = (vars: Record<string, string>, ansi: Parameters<typeof inkTints>[1]) => Record<string, string>;

/* Body text 4.5:1 (WCAG AA); the quietest tier, placeholders and icons, 3:1
   (the large/UI-component ratio). --bg4 is the chip/avatar tone, which only
   --text and --text2 are drawn on. */
const TEXT: Array<[string, number]> = [["--text", 4.5], ["--text2", 4.5], ["--text3", 4.5], ["--text4", 3]];
const STEPS: Array<[string, string, number]> = [
  ["--bg", "--bg2", 1.1], ["--bg2", "--bg3", 1.1], ["--bg3", "--bg4", 1.1],
  ["--border", "--bg", 1.25], ["--border", "--bg2", 1.25], ["--border", "--bg3", 1.25],
  ["--border2", "--bg", 3], ["--border2", "--bg2", 3],
];

function failures(paint: Paint): string[] {
  const out: string[] = [];
  for (const [name, colors] of Object.entries(OMARCHY_PALETTES)) {
    const { mode: _mode, ...derived } = colors;
    for (const [label, c] of [[name, colors], [`${name} (no mode line)`, derived]] as const) {
      const th = desktopTheme(c, label);
      if (!th) { out.push(`${label}: not a palette`); continue; }
      const v = paint(th.vars, th.ansi);
      const r = (a: string, b: string) => contrast(parseColor(v[a]!)!, parseColor(v[b]!)!);
      for (const s of ["--bg", "--bg2", "--bg3", "--bg4"]) {
        for (const [t, min] of TEXT) {
          if (s === "--bg4" && (t === "--text3" || t === "--text4")) continue;
          if (r(t, s) < min) out.push(`${label}: ${t} on ${s} ${r(t, s).toFixed(2)} < ${min}`);
        }
      }
      for (const [a, b, min] of STEPS) if (r(a, b) < min) out.push(`${label}: ${a} vs ${b} ${r(a, b).toFixed(2)} < ${min}`);
      for (const k of ["--success", "--warning", "--error", "--info", "--primary"]) {
        if (r(`${k}-ink`, "--bg3") < 4.5) out.push(`${label}: ${k}-ink on --bg3 ${r(`${k}-ink`, "--bg3").toFixed(2)} < 4.5`);
      }
    }
  }
  return out;
}

describe("desktop themes, as painted", () => {
  test("the sweep sees the whole set, not an empty loop", () => {
    expect(Object.keys(OMARCHY_PALETTES).length).toBeGreaterThanOrEqual(24);
  });

  test("no text token, surface step or border falls below its ratio on any theme", () => {
    expect(failures(paintDesktop)).toEqual([]);
  });

  test("the sweep is not vacuous: without the surface shaping it fails, on the derived light theme among others", () => {
    const bare = failures((vars, ansi) => inkTints(floorTiers(vars), ansi));
    expect(bare.length).toBeGreaterThan(20);
    expect(bare.some((f) => f.startsWith("solarized-light-derived") && f.includes("--text2 on --bg3"))).toBe(true);
  });
});

// Every theme's tinted chips read a chip's text as the tint itself — pale
// amber on pale amber, pale green on pale green — which is fine on the dark
// themes these tints were picked against and unreadable on the light ones.
// `inkTints` computes one text colour per tint per theme that clears 4.5:1
// against the ground a tinted chip actually sits on, and this is what is
// pinned: every shipped theme's `-ink` variant clears the target, a theme
// that already clears it is left untouched, and the desktop's own bright/
// normal ANSI pair is preferred over a mix toward grey when either clears it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { altShade, contrast, inkFor, inkTints, parseColor, TINT_KEYS } from "../src/lib/contrast.ts";

// Same balanced-brace source scan as contrast-floor.test.ts, for the reason
// given there: importing themes.ts pulls in the API client.
const SRC = readFileSync(new URL("../src/lib/themes.ts", import.meta.url), "utf8");

function themesFromSource(src: string): { id: string; vars: Record<string, string>; ansi?: Record<string, string> }[] {
  const out: { id: string; vars: Record<string, string>; ansi?: Record<string, string> }[] = [];
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
    let vars: Record<string, string>;
    try { vars = JSON.parse(src.slice(open, end + 1)); } catch { continue; }
    let ansi: Record<string, string> | undefined;
    const aAt = src.indexOf("ansi:", end);
    const nextId = src.indexOf('id: "', end);
    if (aAt >= 0 && (nextId < 0 || aAt < nextId)) {
      const aOpen = src.indexOf("{", aAt);
      let d2 = 0, aEnd = -1;
      for (let i = aOpen; i < src.length; i++) {
        if (src[i] === "{") d2++;
        else if (src[i] === "}" && --d2 === 0) { aEnd = i; break; }
      }
      if (aOpen >= 0 && aEnd >= 0) { try { ansi = JSON.parse(src.slice(aOpen, aEnd + 1)); } catch { /* skip */ } }
    }
    out.push({ id: m[1]!, vars, ansi });
  }
  return out;
}

const THEMES = themesFromSource(SRC);
const TARGET = 4.5;

describe("altShade", () => {
  const ansi = { green: "#0a0", brightGreen: "#0f0", yellow: "#a80" } as const;
  test("finds the other shade by value, in either direction", () => {
    expect(altShade("#0a0", ansi)).toBe("#0f0");
    expect(altShade("#0f0", ansi)).toBe("#0a0");
  });
  test("a colour with no pair, or no palette at all, has none", () => {
    expect(altShade("#a80", ansi)).toBeUndefined();
    expect(altShade("#0a0", undefined)).toBeUndefined();
  });
});

describe("inkFor", () => {
  test("a tint that already clears the target is left alone", () => {
    expect(inkFor("#000000", "#000000", "#ffffff", 4.5)).toBe("#000000");
  });
  test("prefers the palette's own other shade over a mix toward text", () => {
    // Pale yellow fails on white; its ANSI pair (a darker olive) clears it,
    // and should win over lifting the pale yellow toward black.
    const dark = "#5c4a1a"; // stands in for a theme's "normal" yellow, dark enough to pass
    const got = inkFor("#f9e2af", "#111111", "#ffffff", 4.5, { yellow: "#f9e2af", brightYellow: dark });
    expect(got).toBe(dark);
  });
  test("falls back to mixing toward text when no shade clears it", () => {
    const got = inkFor("#fbbf24", "#000000", "#ffffff", 4.5);
    expect(contrast(parseColor(got)!, parseColor("#ffffff")!)).toBeGreaterThanOrEqual(4.5 - 0.01);
  });
});

describe("inkTints", () => {
  test("a theme with no text or background is handed back unchanged", () => {
    const v = { "--warning": "#fbbf24" };
    expect(inkTints(v)).toEqual(v);
  });

  test("every shipped theme's ink clears 4.5:1 on every semantic tint it has", () => {
    expect(THEMES.length).toBeGreaterThan(25);
    const failures: string[] = [];
    for (const t of THEMES) {
      const v = inkTints(t.vars, t.ansi as any);
      const bg = v["--bg3"] || v["--bg2"] || v["--bg"]!;
      // Allowed to fall short only when the theme's own --text cannot reach
      // the target either — same exception contrast-floor.test.ts makes for
      // floorTiers, and for the same reason: there is nowhere further to go.
      const ceiling = contrast(parseColor(t.vars["--text"]!)!, parseColor(bg)!);
      for (const key of TINT_KEYS) {
        const tint = t.vars[key];
        if (!tint) continue;
        const ink = v[`${key}-ink`]!;
        const got = contrast(parseColor(ink)!, parseColor(bg)!);
        if (got + 0.01 < TARGET && ceiling >= TARGET) failures.push(`${t.id} ${key} ${got.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("break it on purpose: an un-inked tint would fail this same check", () => {
    const porcelain = THEMES.find((t) => t.id === "porcelain")!;
    const bg = porcelain.vars["--bg3"] || porcelain.vars["--bg2"] || porcelain.vars["--bg"]!;
    const raw = contrast(parseColor(porcelain.vars["--warning"]!)!, parseColor(bg)!);
    expect(raw).toBeLessThan(TARGET);
  });

  // Round 2: the bug was never the ink computed for a chip's FILL — it was
  // every place a tint was painted straight on as TEXT, on the plain page
  // surface rather than a chip. The pin chip ("Pin #1042"), the usage
  // popover's verdict line ("76% used", "Cut back"), and half of PrPanel's
  // status glyphs all read `var(--warning)`/`var(--success)` directly instead
  // of the `-ink` variant computed here. `inkTints` measures against `--bg3`
  // because that is the palest ground a chip's own colour-mixed fill reaches
  // — this checks that the same ink also clears `--bg` and `--bg2`, the plain
  // surfaces that TEXT (no fill of its own) sits on directly.
  test("every shipped theme's ink also clears 4.5:1 painted straight on --bg and --bg2, not only the chip ground --bg3", () => {
    const failures: string[] = [];
    for (const t of THEMES) {
      const v = inkTints(t.vars, t.ansi as any);
      for (const grd of ["--bg", "--bg2"] as const) {
        const bg = v[grd] || v["--bg"]!;
        const ceiling = contrast(parseColor(t.vars["--text"]!)!, parseColor(bg)!);
        for (const key of TINT_KEYS) {
          const tint = t.vars[key];
          if (!tint) continue;
          const ink = v[`${key}-ink`]!;
          const got = contrast(parseColor(ink)!, parseColor(bg)!);
          if (got + 0.01 < TARGET && ceiling >= TARGET) failures.push(`${t.id} ${grd} ${key} ${got.toFixed(2)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test("break it on purpose: the LIGHT theme's raw tint painted as text on its own bg (no chip fill) fails, which is exactly the pin-chip / usage-popover defect", () => {
    const light = THEMES.find((t) => t.id === "light")!;
    const raw = contrast(parseColor(light.vars["--warning"]!)!, parseColor(light.vars["--bg"]!)!);
    expect(raw).toBeLessThan(TARGET);
  });
});

// A GitHub label or a ClickUp status carries its OWN hex, read off an API —
// never a theme token, so it never went through `inkTints` at all. `dataInk`
// (contrast.ts) is `inkFor` read live off the document instead of a theme
// object; these exercise the same `inkFor` core it calls, with real label
// colours reported unreadable on the light theme's cream surface: ClickUp's
// "READY FOR QA" pink and GitHub's pale "good first issue" green.
describe("inkFor on data-coloured labels (GitHub labels, ClickUp status pills)", () => {
  const CREAM_BG = "#efeadb"; // stands in for the light theme's --bg3
  const DARK_TEXT = "#3a3527";

  test("a pale status pink fails on cream and gets lifted", () => {
    const pink = "#f9c4d2"; // stands in for a real tracker's "ready for qa" pink
    const raw = contrast(parseColor(pink)!, parseColor(CREAM_BG)!);
    expect(raw).toBeLessThan(TARGET);
    const ink = inkFor(pink, DARK_TEXT, CREAM_BG, TARGET);
    expect(contrast(parseColor(ink)!, parseColor(CREAM_BG)!)).toBeGreaterThanOrEqual(TARGET - 0.01);
  });

  test("a pale label green fails on cream and gets lifted", () => {
    const green = "#c2f2c2"; // stands in for a real "good first issue" green
    const raw = contrast(parseColor(green)!, parseColor(CREAM_BG)!);
    expect(raw).toBeLessThan(TARGET);
    const ink = inkFor(green, DARK_TEXT, CREAM_BG, TARGET);
    expect(contrast(parseColor(ink)!, parseColor(CREAM_BG)!)).toBeGreaterThanOrEqual(TARGET - 0.01);
  });

  test("a label colour that already reads fine is left alone", () => {
    const dark = "#7a1030";
    expect(inkFor(dark, DARK_TEXT, CREAM_BG, TARGET)).toBe(dark);
  });
});

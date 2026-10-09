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
import { ACCENTS } from "../src/lib/accent.ts";
import { chipInk, contrast, floorTiers, inkTints, onPrimaryInk, ON_PRIMARY, paintDesktop, parseColor } from "../src/lib/contrast.ts";
import { THEMES } from "../src/lib/themes.ts";
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
      // Text on a solid primary fill (buttons, selected chips, badges): the ink
      // the call sites paint with is --on-primary, never --bg.
      if (!v["--on-primary"]) out.push(`${label}: no --on-primary`);
      else {
        if (r("--on-primary", "--primary") < ON_PRIMARY) out.push(`${label}: --on-primary on --primary ${r("--on-primary", "--primary").toFixed(2)} < ${ON_PRIMARY}`);
      }
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

  test("the old ink, --bg on --primary, is what this guards against: it fails on palettes of the set", () => {
    const old: string[] = [];
    for (const [name, colors] of Object.entries(OMARCHY_PALETTES)) {
      const th = desktopTheme(colors, name)!;
      const v = paintDesktop(th.vars, th.ansi);
      if (contrast(parseColor(v["--bg"]!)!, parseColor(v["--primary"]!)!) < ON_PRIMARY) old.push(name);
    }
    expect(old.length).toBeGreaterThanOrEqual(4);
  });

  test("the listed themes, and every accent laid over each, keep their ink on the primary", () => {
    const bad: string[] = [];
    for (const t of THEMES) {
      const v = inkTints(floorTiers(t.vars as Record<string, string>), t.ansi);
      const rows = [{ id: t.id, primary: v["--primary"]!, on: v["--on-primary"] }];
      for (const a of ACCENTS) {
        if (!a.primary) continue;
        rows.push({ id: `${t.id}+${a.id}`, primary: a.primary, on: onPrimaryInk(a.primary, v["--bg"], v["--text"])! });
      }
      for (const row of rows) {
        const on = parseColor(row.on ?? "");
        if (!on) { bad.push(`${row.id}: no ink`); continue; }
        const c = contrast(on, parseColor(row.primary)!);
        if (c < ON_PRIMARY) bad.push(`${row.id}: ${c.toFixed(2)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("a primary button's label is --on-primary in source, not --bg", async () => {
    // The sites differ in shape (inline style, CSS string, ternary), so the rule
    // is the one thing they share: a line that fills with --primary and writes
    // in --bg or --bg2 on the same line.
    const glob = new Bun.Glob("**/*.{ts,tsx,css}");
    const bad: string[] = [];
    for await (const f of glob.scan({ cwd: new URL("../src", import.meta.url).pathname })) {
      const text = await Bun.file(new URL(`../src/${f}`, import.meta.url)).text();
      text.split("\n").forEach((line, i) => {
        const code = line.replace(/color-mix\([^)]*\)/g, "");
        if (/(background|bg-)[^;]*var\(--primary\)(?!-)/.test(code) && /(^|[^-\w])color\s*:\s*"?var\(--bg2?\)/.test(code)) bad.push(`${f}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
  });
  test("a selected segmented option is --on-primary on a solid --primary fill, in every theme", async () => {
    // The old fill was --primary at 55% over the page with --text on it:
    // 2.2 to 3.0:1 on the dark themes. A solid primary is the ground
    // --on-primary is already held to 4.5:1 on, per theme, above.
    const src = await Bun.file(new URL("../src/components/SettingsModal.tsx", import.meta.url)).text();
    const selected = src.split("\n").filter((l) => /color-mix\(in srgb, var\(--primary\) 55%/.test(l) && /color:\s*"var\(--text\)"/.test(l));
    expect(selected).toEqual([]);
    expect((src.match(/background: "var\(--primary\)", color: "var\(--on-primary\)"/g) ?? []).length).toBeGreaterThanOrEqual(2);
    const bad: string[] = [];
    for (const t of THEMES) {
      const v = inkTints(floorTiers(t.vars as Record<string, string>), t.ansi);
      const on = parseColor(v["--on-primary"] ?? ""), p = parseColor(v["--primary"] ?? "");
      if (!on || !p || contrast(on, p) < ON_PRIMARY) bad.push(t.id);
    }
    expect(bad).toEqual([]);
  });

  test("assignee initials stay readable on a pale and on a dark chip", () => {
    const fills = ["#f5e6a8", "#ffffff", "#ffd1dc", "#1d3557", "#2b2b2b", "#e63946", "#7aa2f7", "#00b894"];
    const bad = fills.filter((f) => contrast(parseColor(chipInk(f))!, parseColor(f)!) < ON_PRIMARY);
    expect(bad).toEqual([]);
    // No colour: the chip sits on --bg4 and the ink is the theme's text.
    expect(chipInk(undefined)).toBe("var(--text)");
    expect(chipInk("not-a-colour")).toBe("#fff");
  });

  test("the chip sites ask chipInk, not a hard-coded white", async () => {
    const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
    expect(src).not.toMatch(/\.color \|\| "var\(--bg4\)", color: "#fff"/);
    expect((src.match(/color: chipInk\(/g) ?? []).length).toBe(2);
  });
});

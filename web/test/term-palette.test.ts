/*
 * The terminal used to paint its output in one hardcoded palette, so switching
 * theme changed the panel around it and nothing inside. These tests pin the two
 * guarantees that fixed it: every theme yields a full, valid ANSI palette, and a
 * *derived* palette (any theme without a pinned one) stays legible against its
 * own background — the exact thing the old fixed palette failed at on the light
 * themes, where mid-brightness colours tuned for a dark background washed out.
 */
import { describe, expect, test } from "bun:test";
import { deriveAnsi, contrastRatio, type AnsiPalette } from "../src/lib/termPalette.ts";
import type { Theme } from "../src/lib/themes.ts";

// themes.ts imports api.ts, which reads `location` at module scope. Stub it
// before the import evaluates, exactly as the pairing test does.
(globalThis as any).location = { hostname: "localhost", origin: "http://localhost:4000" };
const { THEMES } = await import("../src/lib/themes.ts");

const KEYS: (keyof AnsiPalette)[] = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];
// The colours a reader actually decodes — the ones that must never wash out.
const BASE_CHROMA: (keyof AnsiPalette)[] = ["red", "green", "yellow", "blue", "magenta", "cyan"];
const BRIGHT_CHROMA: (keyof AnsiPalette)[] = ["brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan"];

// Exactly what themeFromCss() does: pinned palette, else derive from the same
// UI vars the panel already follows.
const paletteFor = (t: Theme): AnsiPalette => t.ansi ?? deriveAnsi({
  bg: t.vars["--bg"]!, text: t.vars["--text"]!, primary: t.vars["--primary"]!,
  error: t.vars["--error"]!, success: t.vars["--success"]!, warning: t.vars["--warning"]!, info: t.vars["--info"]!,
});

const isHex = (s: string) => /^#[0-9a-f]{6}$/i.test(s);

describe("every theme produces a full, valid terminal palette", () => {
  for (const t of THEMES) {
    test(t.id, () => {
      const p = paletteFor(t);
      for (const k of KEYS) expect(isHex(p[k]), `${t.id}.${k} = ${p[k]}`).toBe(true);
    });
  }
});

describe("a derived palette is legible against its own background", () => {
  const derived = THEMES.filter((t) => !t.ansi);

  test("there are derived themes to check (most of them)", () => {
    expect(derived.length).toBeGreaterThan(20);
  });

  for (const t of derived) {
    test(`${t.id} — chromatic colours clear a contrast floor`, () => {
      const p = paletteFor(t), bg = t.vars["--bg"]!;
      for (const k of BASE_CHROMA) {
        expect(contrastRatio(p[k], bg), `${t.id}.${k} (${p[k]}) on ${bg}`).toBeGreaterThanOrEqual(2.4);
      }
      for (const k of BRIGHT_CHROMA) {
        expect(contrastRatio(p[k], bg), `${t.id}.${k} (${p[k]}) on ${bg}`).toBeGreaterThanOrEqual(2.0);
      }
    });

    test(`${t.id} — blue and cyan stay distinct`, () => {
      const p = paletteFor(t);
      expect(p.blue).not.toBe(p.cyan);
      expect(p.brightBlue).not.toBe(p.brightCyan);
    });
  }
});

describe("the light themes that used to wash out", () => {
  // The whole point: a light background must not leave the palette invisible.
  for (const id of ["github-light", "catppuccin-latte", "paper", "one-dark"]) {
    test(id, () => {
      const t = THEMES.find((x) => x.id === id)!;
      const p = paletteFor(t), bg = t.vars["--bg"]!;
      for (const k of BASE_CHROMA) expect(contrastRatio(p[k], bg)).toBeGreaterThanOrEqual(2.4);
    });
  }
});

describe("a pinned palette is used verbatim", () => {
  test("Dracula keeps its canonical colours", () => {
    const p = paletteFor(THEMES.find((t) => t.id === "dracula")!);
    expect(p.red).toBe("#ff5555");
    expect(p.green).toBe("#50fa7b");
    expect(p.magenta).toBe("#ff79c6");
  });
  test("Solarized dark and light share one palette", () => {
    const dark = THEMES.find((t) => t.id === "solarized-dark")!.ansi!;
    const light = THEMES.find((t) => t.id === "solarized-light")!.ansi!;
    expect(light).toEqual(dark);
    expect(dark.blue).toBe("#268bd2");
  });
  test("the five well-known palettes are pinned, not derived", () => {
    for (const id of ["dracula", "nord", "gruvbox-dark", "solarized-dark", "solarized-light"]) {
      expect(THEMES.find((t) => t.id === id)!.ansi, id).toBeDefined();
    }
  });
});

describe("deriveAnsi adapts to background luminance", () => {
  const args = { primary: "#7aa2f7", error: "#f7768e", success: "#9ece6a", warning: "#e0af68", info: "#7dcfff" };
  test("dark background → colours readable on dark", () => {
    const p = deriveAnsi({ ...args, bg: "#1a1b26", text: "#c0caf5" });
    for (const k of BASE_CHROMA) expect(contrastRatio(p[k], "#1a1b26")).toBeGreaterThanOrEqual(2.4);
  });
  test("light background → the same hues re-tuned to stay readable on light", () => {
    const p = deriveAnsi({ ...args, bg: "#ffffff", text: "#1f2328" });
    for (const k of BASE_CHROMA) expect(contrastRatio(p[k], "#ffffff")).toBeGreaterThanOrEqual(2.4);
  });
});

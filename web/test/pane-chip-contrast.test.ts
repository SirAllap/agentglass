/*
 * The pane chip's right-hand segment draws arcs, an icon, a badge and a count
 * on tinted surfaces. Contrast is measured on the real theme tokens, in a light
 * and a dark default, so a token change that sinks one is red here.
 * WCAG AA: graphics 3:1, text 4.5:1.
 *
 * Ceiling: the two default themes only. Other themes bring their own
 * palettes; they are not asserted and some will fall short.
 */
import { describe, expect, test } from "bun:test";
import { THEMES } from "../src/lib/themes.ts";
import { inkTints } from "../src/lib/contrast.ts";

type RGB = [number, number, number];
const hex = (h: string): RGB => { const x = h.replace("#", ""); return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)) as RGB; };
const mix = (a: RGB, b: RGB, pctA: number): RGB => a.map((v, i) => v * pctA + b[i]! * (1 - pctA)) as RGB;
const lum = ([r, g, b]: RGB) => { const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a: RGB, b: RGB) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };

for (const id of ["porcelain", "graphite"]) {
  const vars = THEMES.find((t) => t.id === id)!.vars as Record<string, string>;
  const v = (k: string) => hex(vars[k]!);
  const bg = v("--bg"), card = v("--bg2"), text = v("--text");
  // --merged-ink is color-mix(--merged 70%, --text); --merged is #8b8fe8 in index.css.
  const mergedInk = mix(hex("#8b8fe8"), text, 0.7);
  const states: Record<string, RGB> = { open: v("--success"), draft: v("--text3"), merged: mergedInk, closed: v("--error") };
  /** The capsule's lowest fill: the state's 11% over the card surface. */
  const capsule = (sc: RGB) => mix(sc, card, 0.11);

  describe(`contrast, ${id}`, () => {
    test("each arc against the disc the ring sits on is at least 3:1", () => {
      for (const k of ["--success", "--warning", "--error"]) expect(ratio(v(k), bg), k).toBeGreaterThanOrEqual(3);
      // The unknown ring is text3, and it must still be seen.
      expect(ratio(v("--text3"), bg), "--text3").toBeGreaterThanOrEqual(3);
    });
    test("the pull request icon, in its state's colour, against its own capsule is at least 3:1", () => {
      for (const [name, sc] of Object.entries(states)) expect(ratio(sc, bg), `${name} on the ring's disc`).toBeGreaterThanOrEqual(3);
      for (const [name, sc] of Object.entries(states)) expect(ratio(sc, capsule(sc)), `${name} on its capsule`).toBeGreaterThanOrEqual(3);
    });
    test("the review badge's glyph (the card surface) on its fill is at least 3:1", () => {
      expect(ratio(card, v("--success"))).toBeGreaterThanOrEqual(3);
      expect(ratio(card, v("--warning"))).toBeGreaterThanOrEqual(3);
    });
    test("the failing count is text: its ink on the red tint is at least 4.5:1", () => {
      /* `--error-ink` is derived per theme at runtime (lib/contrast.ts inkTints);
         the raw `--error` is 3.7:1 on its own tint in Porcelain, which is why
         the count is not drawn in it. */
      const ink = hex(inkTints(vars as Record<string, string>)["--error-ink"]!);
      expect(ratio(ink, mix(v("--error"), card, 0.07))).toBeGreaterThanOrEqual(4.5);
    });
  });
}

/*
 * The colour the active rail icon is drawn in.
 *
 * The rail lost its tinted box: the glyph is big enough now to carry "you are
 * here" on its own, in the accent. Which is only true while the accent can be
 * SEEN — and the serious themes ship a monochrome primary on purpose, so "the
 * accent" is sometimes a grey a shade from the rail it sits on.
 *
 * What is pinned here is the shape of the rule, because a plain contrast floor
 * is the obvious answer and it is wrong: measured on the shipped palette, the
 * violet accent sits BELOW the dimmed icons it has to be told apart from
 * (3.94:1 against 4.22:1 on Graphite) and is unmistakable on screen, because a
 * hue is distinguishable in a way a lightness step is not. A floor applied
 * honestly would "fix" violet and take away the colour somebody chose.
 */
import { describe, expect, it } from "bun:test";
import { railActiveColor } from "../src/lib/railAccent.ts";
import { contrast, parseColor } from "../src/lib/contrast.ts";
import { ACCENTS } from "../../shared/palettes.ts";

// themes.ts imports api.ts, which reads `location` at module scope. Stub it
// before the import evaluates, exactly as the terminal palette test does.
(globalThis as any).location = { hostname: "localhost", origin: "http://localhost:4000" };
const { THEMES } = await import("../src/lib/themes.ts");

const ratio = (fg: string, bg: string) => contrast(parseColor(fg)!, parseColor(bg)!);
const theme = (id: string) => {
  const t = THEMES.find((x) => x.id === id)!;
  return { bg: t.vars["--bg"]!, text: t.vars["--text"]!, dim: t.vars["--text4"]!, primary: t.vars["--primary"]! };
};

describe("a grey accent, which has only lightness to argue with", () => {
  it("goes white on a dark theme when it is a shade off the rail", () => {
    // The case he asked about: a dark grey would not be seen in dark mode, so
    // in that case it should be white. #232323 on #1e1e1e is 1.06:1.
    const { bg, text, dim } = theme("graphite");
    expect(railActiveColor("#232323", bg, text, dim)).toBe(text);
  });

  it("goes near-black on a light theme, for the same reason", () => {
    const { bg, text, dim } = theme("porcelain");
    expect(railActiveColor("#f2f2f2", bg, text, dim)).toBe(text);
  });

  it("keeps a grey that already out-does the dimmed icons", () => {
    // Graphite's own primary is #e5e5e5 at 13:1. It IS the right colour for the
    // active icon; a rule that replaced it would be fixing something that works.
    for (const id of ["graphite", "porcelain"]) {
      const { bg, text, dim, primary } = theme(id);
      expect(railActiveColor(primary, bg, text, dim)).toBe(primary);
    }
  });
});

describe("a colour, whose hue is doing the work", () => {
  it("keeps every shipped accent recognisably itself on both serious themes", () => {
    // Violet is quieter than the dimmed icons on Graphite and still obvious.
    // This is the assertion that stops a future contrast floor from eating it.
    for (const id of ["graphite", "porcelain"]) {
      const { bg, text, dim } = theme(id);
      for (const a of ACCENTS) {
        const out = railActiveColor(a.primary, bg, text, dim);
        expect(out).not.toBe(text);
        expect(ratio(out, bg)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("darkens a pale accent on paper instead of blacking it out", () => {
    // Amber is 2.15:1 on white. Falling back to --text would turn the warm
    // accent near-black and make one of the six picker swatches a lie.
    const { bg, text, dim } = theme("porcelain");
    const out = railActiveColor("#f59e0b", bg, text, dim);
    expect(out).not.toBe(text);
    expect(ratio(out, bg)).toBeGreaterThanOrEqual(3);
    // Still warm: the red channel still leads and blue still trails.
    const c = parseColor(out)!;
    expect(c.r).toBeGreaterThan(c.b);
  });

  it("leaves an accent that already stands out completely alone", () => {
    const { bg, text, dim } = theme("graphite");
    expect(railActiveColor("#3b82f6", bg, text, dim)).toBe("#3b82f6");
  });
});

describe("when there is nothing to measure", () => {
  it("answers with the text colour rather than something that is not a colour", () => {
    // An unresolved var would otherwise paint the icon in inherited ink and
    // make the active view indistinguishable from the rest.
    expect(railActiveColor("", "#1e1e1e", "#fafafa", "#808080")).toBe("#fafafa");
    expect(railActiveColor("color-mix(in srgb, red, blue)", "#1e1e1e", "#fafafa", "#808080")).toBe("#fafafa");
  });
});

describe("over every theme that ships", () => {
  it("gives each one an active icon that is either visible or its own text", () => {
    // Thirty-odd palettes: the sort of thing that is right on Graphite and
    // quietly wrong on the fourteenth theme down the list.
    const bad: string[] = [];
    for (const t of THEMES) {
      const bg = t.vars["--bg"], text = t.vars["--text"], primary = t.vars["--primary"], dim = t.vars["--text4"];
      if (!bg || !text || !primary) continue;
      const out = railActiveColor(primary, bg, text, dim);
      if (ratio(out, bg) < 3 && out !== text) bad.push(`${t.id}: ${out} on ${bg} = ${ratio(out, bg).toFixed(2)}`);
    }
    expect(bad).toEqual([]);
  });
});

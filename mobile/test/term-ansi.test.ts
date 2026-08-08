/*
 * The sixteen colours the pane is painted with, on both of the phone's surfaces.
 *
 * The phone used to map its palette onto the ANSI slots field by field — bg3 was
 * black, info was blue AND cyan, text was brightWhite — which cannot work,
 * because a palette carries four hues and a terminal needs six. Measured against
 * the two bases, that map put black at 1.24:1 on the dark one and 1.17:1 on
 * white (invisible in both), painted cyan the same hex as blue and brightWhite
 * the same as white, and filled sixteen slots with ten colours. `ls --color`
 * paints directories blue and archives magenta; a diff paints its two sides red
 * and green. Ten of sixteen is a screen where some of that is silently one
 * colour, and the light one was worse than that — which is why the pane had been
 * pinned to the dark base and the phone's Light did not reach it.
 *
 * So this file is about two properties and nothing else: every colour is
 * readable where it is painted, and no two slots are the same colour. Both are
 * checked for every accent, because an accent moves `primary`, and `primary` is
 * where magenta comes from.
 *
 * WCAG is computed here from its definition rather than imported, so this file
 * checks the module's answer instead of agreeing with its arithmetic — the same
 * reason look.test.ts does it.
 */
import { describe, expect, test } from "bun:test";
import { PHONE_ACCENTS, paletteFor, type Polarity } from "../../shared/palettes.ts";
import { deriveAnsi } from "../../shared/termPalette.ts";
import { counterTheme, terminalDocument, terminalTheme } from "../src/terminal/terminal-html.ts";

const channel = (v: number): number => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
function luminance(hex: string): number {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const ANSI = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

/** WCAG's floor for normal text. Somebody reads a filename in every one of
 *  these; there is no such thing as decorative here. */
const FLOOR = 4.5;

const POLARITIES: Polarity[] = ["dark", "light"];

describe("every ANSI colour is readable on the surface it is painted on", () => {
  for (const polarity of POLARITIES) {
    for (const accent of PHONE_ACCENTS) {
      test(`${polarity} + ${accent.id}`, () => {
        const p = paletteFor(polarity, accent.id);
        const theme = terminalTheme(p);
        for (const slot of ANSI) {
          const ratio = contrast(theme[slot]!, p.bg);
          /*
           * ANSI black on a DARK background is the one exception, and it is
           * deliberate rather than tolerated. Programs paint black when they
           * mean "recede" — box rules, dimmed diff context, an inactive tab —
           * and holding it to 4.5 there makes it a mid-grey, at which point it
           * is brightBlack and the palette has two names for one colour. It
           * still has to be VISIBLE, which is what the phone's old #21262d at
           * 1.24:1 was not. On a light background black is the ink rather than
           * the dim tone, so it takes the full floor like everything else.
           */
          const min = slot === "black" && polarity === "dark" ? 2.5 : FLOOR;
          expect(ratio, `${polarity}/${accent.id} ${slot} ${theme[slot]} on ${p.bg}`).toBeGreaterThanOrEqual(min);
        }
        if (polarity === "dark") {
          // The exception only earns itself by staying the dimmest thing there.
          expect(contrast(theme.black!, p.bg)).toBeLessThan(contrast(theme.brightBlack!, p.bg));
        }
      });
    }
  }
});

describe("sixteen slots hold sixteen colours", () => {
  for (const polarity of POLARITIES) {
    for (const accent of PHONE_ACCENTS) {
      test(`${polarity} + ${accent.id}`, () => {
        const theme = terminalTheme(paletteFor(polarity, accent.id));
        const hexes = ANSI.map((slot) => theme[slot]!.toLowerCase());
        expect(new Set(hexes).size, hexes.join(" ")).toBe(16);
      });
    }
  }

  test("the three the old map collapsed, by name", () => {
    // Named rather than left to the count above, because these three are what a
    // reader lost: a cyan directory listing that was blue, an emphasised line
    // that was the same white as the rest, and a black that was the background.
    for (const polarity of POLARITIES) {
      const p = paletteFor(polarity, "blue");
      const theme = terminalTheme(p);
      expect(theme.cyan).not.toBe(theme.blue);
      expect(theme.brightWhite).not.toBe(theme.white);
      expect(theme.black).not.toBe(p.bg3);
    }
  });
});

describe("one derivation, not a second copy of it", () => {
  test("the theme's sixteen are exactly what shared/ answers", () => {
    /*
     * The phone may not have its own idea of what red means in a terminal: the
     * desk and the phone are one product showing one machine's screens. This is
     * the assertion that keeps the rule in shared/ rather than beside it.
     */
    const p = paletteFor("dark", "violet");
    const theme = terminalTheme(p);
    const ansi = deriveAnsi({
      bg: p.bg, text: p.text, primary: p.primary,
      error: p.error, success: p.success, warning: p.warning, info: p.info,
    });
    for (const slot of ANSI) expect(theme[slot]).toBe(ansi[slot]);
  });
});

describe("the other surface, carried in the page beside this one", () => {
  test("the counter set is the opposite polarity wearing the same accent", () => {
    for (const polarity of POLARITIES) {
      const p = paletteFor(polarity, "amber");
      const other = paletteFor(polarity === "dark" ? "light" : "dark", "amber");
      const counter = counterTheme(p);
      expect(counter.background).toBe(other.bg);
      expect(counter.foreground).toBe(other.text);
      // The accent is this client's own furniture — the cursor and the
      // selection — and it does not flip with the surface underneath.
      expect(counter.cursor).toBe(p.primary);
    }
  });

  test("and it is readable on its own background", () => {
    for (const polarity of POLARITIES) {
      const counter = counterTheme(paletteFor(polarity, "blue"));
      for (const slot of ANSI) {
        const min = slot === "black" && luminance(counter.background!) < 0.4 ? 2.5 : FLOOR;
        expect(contrast(counter[slot]!, counter.background!), `${slot} ${counter[slot]}`).toBeGreaterThanOrEqual(min);
      }
    }
  });

  test("and it still reads on the background the desk actually paints", () => {
    /*
     * The set is derived against the phone's own base and then worn on whatever
     * the machine's tmux is painting, which is not the same colour: measured on
     * this machine, `window-style "bg=#1e1e1e"` — Graphite. So the numbers are
     * checked there too, at a lower bar for the two dim tones, because they are
     * dim by construction and this background is lighter than the one they were
     * derived for. Worst non-black at #1e1e1e is brightBlack at 4.78.
     */
    const dark = terminalTheme(paletteFor("dark", "blue"));
    for (const slot of ANSI) {
      const min = slot === "black" ? 2.2 : FLOOR;
      expect(contrast(dark[slot]!, "#1e1e1e"), `${slot} ${dark[slot]} on #1e1e1e`).toBeGreaterThanOrEqual(min);
    }
  });

  test("the document carries both sets, because the page can only wear what it has", () => {
    // Structural: the page picks between them by measuring the pane (see the
    // browser tests in pane-line.test.ts), and it cannot pick one it was never
    // given. Cheap, and it catches the counter being dropped on the way in.
    const doc = terminalDocument({ palette: paletteFor("light", "blue"), columns: 80 });
    expect(doc).toContain(JSON.stringify(terminalTheme(paletteFor("light", "blue"))));
    expect(doc).toContain(JSON.stringify(counterTheme(paletteFor("light", "blue"))));
    expect(doc).toContain("var OWN = ");
  });
});

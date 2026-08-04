import { describe, expect, it, beforeAll, beforeEach } from "bun:test";
import { ZwjWidthProvider } from "../src/lib/termUnicode.ts";

// The prefs read the browser's storage at module scope, so it has to exist
// before the module does — same shape as update-store's stub.
const mem = new Map<string, string>();
let prefs: typeof import("../src/lib/termPrefs.ts");
beforeAll(async () => {
  (globalThis as never as { localStorage: unknown }).localStorage ??= {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
  };
  prefs = await import("../src/lib/termPrefs.ts");
});

/*
 * The two things that made the terminal look broken next to a native one, held
 * where a regression would show: how tall a row is, and how wide a character
 * claims to be.
 */

const ZWJ = 0x200d;
const pack = (kind: number, width: number, join: boolean) =>
  ((kind & 0xffffff) << 3) | ((width & 0x3) << 1) | (join ? 1 : 0);
const widthOf = (p: number) => (p >> 1) & 0x3;

/** unicode11's answers for the handful of characters these tests turn on —
 *  enough to exercise the wrapper without pulling a browser in. */
const base = {
  version: "11",
  wcwidth: (c: number): 0 | 1 | 2 => (c === ZWJ || c === 0x0301 ? 0 : c > 0x1f000 || c === 0x2728 ? 2 : 1),
  charProperties: (c: number) => pack(c, base.wcwidth(c), false),
};

describe("character widths", () => {
  const p = new ZwjWidthProvider(base);
  it("keeps unicode11's answer for an ordinary character", () => {
    // The whole point of wrapping rather than replacing: emoji are two columns,
    // which is what every program drawing a box already assumes. Under the
    // table xterm ships with they were one, and a single emoji shifted the rest
    // of the line — that is the drift this fixes.
    expect(widthOf(p.charProperties(0x2728, 0))).toBe(2); // ✨
    expect(widthOf(p.charProperties(0x1f41b, 0))).toBe(2); // 🐛
    expect(widthOf(p.charProperties(0x2502, 0))).toBe(1); // │, the tmux divider
  });

  it("gives a joined sequence the width of what it started as", () => {
    // 👨‍💻 is drawn as one glyph, so it takes one glyph's room. unicode11 alone
    // counts each half and reports four, which is a worse drift than the one it
    // came to fix.
    const man = p.charProperties(0x1f468, 0);
    const joiner = p.charProperties(ZWJ, man);
    const laptop = p.charProperties(0x1f4bb, joiner);
    expect(widthOf(man)).toBe(2);
    expect(widthOf(joiner)).toBe(2);   // the joiner adds nothing of its own
    expect(widthOf(laptop)).toBe(2);   // and neither does what follows it
    expect(laptop & 1).toBe(1);        // marked as continuing the same glyph
  });

  it("does not let a stray joiner swallow the character after it", () => {
    // A ZWJ with nothing before it is malformed input, and inheriting a width of
    // zero from it would make the next character occupy no columns at all.
    const stray = p.charProperties(ZWJ, 0);
    expect(widthOf(p.charProperties(0x1f41b, stray))).toBe(2);
  });

  it("leaves a combining mark zero-width after a joiner", () => {
    const man = p.charProperties(0x1f468, 0);
    const joiner = p.charProperties(ZWJ, man);
    expect(widthOf(p.charProperties(0x0301, joiner))).toBe(0);
  });
});

describe("the fallback stack", () => {
  // The browser resolves a monospace stack per character, so the face that
  // draws `│` need not be the one the cell was measured from. Measured at 13px
  // on a real screen: DejaVu's rule is 17px of ink, Liberation's is 15, and the
  // cell is about 17 — so landing on Liberation puts a seam in every row of
  // every divider. Ordering is the whole fix, which makes it worth pinning.
  const boxDrawer = /"DejaVu Sans Mono"/;
  const shortRule = /"Liberation Mono"/;

  it("prefers a face whose box drawing fills the line box", () => {
    for (const f of prefs.TERM_FONTS) {
      const stack = f.stack || prefs.termOptions().fontFamily;
      expect(stack).toMatch(boxDrawer);
      // Ahead of the short one, or the short one wins and the rules dash again.
      expect(stack.search(boxDrawer)).toBeLessThan(stack.search(shortRule));
    }
  });

  it("covers the default, which every other choice falls through to", () => {
    expect(prefs.termOptions().fontFamily).toMatch(boxDrawer);
  });
});

describe("line height", () => {
  beforeEach(() => { mem.clear(); });

  it("defaults to 1, so box-drawing rules meet the row above", () => {
    // This was a hardcoded 1.2. On the DOM renderer — the default on Linux,
    // where the GPU renderer is deliberately off — the glyph comes from the
    // font at its natural height, so the extra fifth of a row is a gap through
    // every divider. Measured: 1.2 draws a dashed rule, 1 draws a solid one.
    expect(prefs.currentTermLineHeight()).toBe(1);
    expect(prefs.DEFAULT_LINE_HEIGHT).toBe(1);
    expect(prefs.termOptions().lineHeight).toBe(1);
  });

  it("never hands xterm a value below 1, which it throws on", () => {
    mem.set("agentglass-term-line-height", "0.4");
    expect(prefs.currentTermLineHeight()).toBe(prefs.LINE_HEIGHT_MIN);
    mem.set("agentglass-term-line-height", "nonsense");
    expect(prefs.currentTermLineHeight()).toBe(prefs.DEFAULT_LINE_HEIGHT);
    prefs.setTermLineHeight(-3);
    expect(prefs.currentTermLineHeight()).toBe(prefs.LINE_HEIGHT_MIN);
  });

  it("remembers a raised value, and clamps the top end", () => {
    prefs.setTermLineHeight(1.3);
    expect(prefs.currentTermLineHeight()).toBeCloseTo(1.3, 5);
    expect(prefs.termOptions().lineHeight).toBeCloseTo(1.3, 5);
    prefs.setTermLineHeight(99);
    expect(prefs.currentTermLineHeight()).toBe(prefs.LINE_HEIGHT_MAX);
  });

  it("stores the default as an absent key, so a later change of default is followed", () => {
    prefs.setTermLineHeight(1.4);
    prefs.setTermLineHeight(prefs.DEFAULT_LINE_HEIGHT);
    expect(mem.has("agentglass-term-line-height")).toBe(false);
    expect(prefs.currentTermLineHeight()).toBe(prefs.DEFAULT_LINE_HEIGHT);
  });
});

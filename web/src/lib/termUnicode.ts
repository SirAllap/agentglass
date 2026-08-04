/*
 * How wide is a character, and why the answer xterm ships with is wrong here.
 *
 * A terminal and the program drawing into it have to agree on how many columns
 * each character takes, or everything after a disagreement lands one column
 * out. That is not a cosmetic drift: it is the box rule of a TUI ending up
 * inside the text, panes that no longer line up, and a layout that looks
 * "broken" without anything having crashed.
 *
 * xterm defaults to the Unicode 6 width table, where emoji are one column wide.
 * Every program that draws these boxes — Claude Code, tmux, anything using a
 * modern wcwidth — has followed Unicode 9+ for years and counts them as two.
 * Measured against the terminal as it shipped: ✨ ⚡ ✅ 🐛 all came back as one
 * column instead of two, so a single emoji in a line of output shifted the rest
 * of that line left by one. The box characters themselves (│ ✳ ✻ ● ❯) were
 * always right; the emoji were the whole story.
 *
 * `unicode11` fixes those, and introduces a different disagreement of its own:
 * a ZWJ sequence — a run of emoji joined by U+200D, drawn as ONE glyph — gets
 * counted per component. Measured: 👨‍💻 came back as four columns under
 * unicode11 against the two everything else assumes, which trades one drift for
 * a worse one. So the provider below wraps unicode11 rather than replacing it:
 * every ordinary character keeps the v11 answer, and a joined sequence keeps the
 * width of the character it started with.
 */
import type { Terminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";

const ZWJ = 0x200d;
export const UNICODE_11 = "11";
/** Our own version id, so `activeVersion` says which table is really in use and
 *  activating twice is a no-op rather than a second registration. */
export const UNICODE_11_ZWJ = "11-zwj";

/*
 * xterm packs a character's kind, its width and whether it joins into one
 * integer, and hands the previous character's packed value to the next call.
 * These three are that packing, mirrored — there is no exported helper, and the
 * layout is what `charProperties` must return.
 */
const extractWidth = (p: number): number => (p >> 1) & 0x3;
const extractCharKind = (p: number): number => p >> 3;
const pack = (kind: number, width: number, join: boolean): number =>
  ((kind & 0xffffff) << 3) | ((width & 0x3) << 1) | (join ? 1 : 0);

/** Minimal shape of an xterm unicode provider — not exported by the package. */
type CharWidth = 0 | 1 | 2;
interface WidthProvider {
  version: string;
  wcwidth(codepoint: number): CharWidth;
  charProperties(codepoint: number, preceding: number): number;
}

/**
 * unicode11's widths, with joined sequences collapsed onto their base.
 *
 * Only two cases are handled specially, and both are the same idea: once a ZWJ
 * has been seen, the glyph being assembled keeps the width it already had.
 * Everything else — including which characters are wide in the first place —
 * is unicode11's answer, unchanged.
 */
export class ZwjWidthProvider implements WidthProvider {
  readonly version = UNICODE_11_ZWJ;
  constructor(private readonly base: WidthProvider) {}

  wcwidth(codepoint: number): CharWidth { return this.base.wcwidth(codepoint); }

  charProperties(codepoint: number, preceding: number): number {
    const prevWidth = extractWidth(preceding);
    // The joiner itself takes no room and marks what follows as part of this
    // glyph. Guarded on there being something to join to: a ZWJ with nothing
    // before it is a stray, and inheriting a width of zero from it would make
    // the next character disappear.
    if (codepoint === ZWJ && prevWidth > 0) return pack(ZWJ, prevWidth, true);
    // The character after a joiner continues the same glyph, so it adds nothing
    // to the width. Zero-width characters are left alone — a combining mark
    // after a ZWJ is still a combining mark.
    if (extractCharKind(preceding) === ZWJ && prevWidth > 0 && this.base.wcwidth(codepoint) > 0) {
      return pack(codepoint, prevWidth, true);
    }
    return this.base.charProperties(codepoint, preceding);
  }
}

/**
 * Put the terminal on the width table the rest of the world uses.
 *
 * Reaches through `_core` for unicode11's own provider, because xterm exposes
 * no way to read a registered provider back out — and falls back to plain
 * unicode11 if that internal ever moves. Plain v11 is still much closer to
 * right than v6: it fixes every ordinary emoji and only misses the joined ones.
 */
export function useModernWidths(term: Terminal): void {
  const uni = term.unicode;
  if (uni.activeVersion === UNICODE_11_ZWJ) return;
  if (!uni.versions.includes(UNICODE_11)) term.loadAddon(new Unicode11Addon());
  const base = (term as unknown as {
    _core?: { unicodeService?: { _providers?: Record<string, WidthProvider> } };
  })._core?.unicodeService?._providers?.[UNICODE_11];
  if (!base) { uni.activeVersion = UNICODE_11; return; }
  if (!uni.versions.includes(UNICODE_11_ZWJ)) uni.register(new ZwjWidthProvider(base));
  uni.activeVersion = UNICODE_11_ZWJ;
}

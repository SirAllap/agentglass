/*
 * The terminal document has to be valid JavaScript.
 *
 * It is a template literal several hundred lines long, assembled in TypeScript
 * and never executed by anything the build can see — Metro ships it as a
 * string, and the first thing that ever parses it is a WebView on a phone. So
 * a syntax error in it is invisible to `tsc`, invisible to the bundler, and
 * arrives as a blank black rectangle where the terminal should be.
 *
 * One backtick in a prose comment inside that literal already closed the string
 * once. That one `tsc` caught, because it broke the TypeScript around it; a
 * missing brace inside the script would not have been caught by anything.
 */
import { describe, expect, test } from "bun:test";
import { NERD_ICONS_RANGE } from "../src/terminal/nerdfont.generated.ts";
import { terminalDocument } from "../src/terminal/terminal-html.ts";

const PALETTE = {
  bg: "#0d1117", bg2: "#161b22", bg3: "#21262d", bg4: "#30363d",
  text: "#e6edf3", text2: "#c9d1d9", text3: "#8b949e", text4: "#6e7681",
  border: "#30363d", border2: "#444c56",
  primary: "#58a6ff", primaryHover: "#79c0ff",
  success: "#3fb950", warning: "#d29922", error: "#f85149", info: "#58a6ff",
};

const doc = terminalDocument({ palette: PALETTE, columns: 80 });

/** The app's own script, which is the last one in the document — the first is
 *  the bundled engine and is not what this file is about. */
function bridgeScript(): string {
  const scripts = doc.split("<script>").slice(1).map((s) => s.split("</script>")[0] ?? "");
  const last = scripts[scripts.length - 1];
  expect(last, "no script found in the terminal document").toBeTruthy();
  return last!;
}

describe("the document it hands the WebView", () => {
  test("its script parses", () => {
    // `new Function` compiles without running: it catches a syntax error and
    // does not care that `window` and `atob` are absent here.
    expect(() => new Function(bridgeScript())).not.toThrow();
  });

  test("the engine parses too", () => {
    const engine = doc.split("<script>")[1]?.split("</script>")[0] ?? "";
    expect(engine.length).toBeGreaterThan(100_000);
    expect(() => new Function(engine)).not.toThrow();
  });

  test("nothing in it is fetched", () => {
    /*
     * The page carries its own engine and its own stylesheet because a WebView
     * has no network here. A `src` or an `href` would be a terminal that can be
     * told to load something, on a screen that is showing a live shell.
     */
    const html = doc.replace(/<script>[\s\S]*?<\/script>/g, "");
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  test("the width it was asked for is the width it uses", () => {
    // The whole point of the option: a terminal that sizes itself to the phone
    // shows the left corner of a desktop pane.
    expect(bridgeScript()).toContain("var wanted = 80");
    expect(terminalDocument({ palette: PALETTE, columns: 200 })).toContain("var wanted = 200");
    // And it must not be fitting: `fit()` is the behaviour this replaced.
    expect(bridgeScript()).not.toMatch(/\bfit\.fit\(\)/);
  });

  test("the palette reaches the terminal rather than a default one", () => {
    // The phone wears the computer's theme; a hardcoded background here would
    // be the one surface that ignored it.
    expect(doc).toContain(PALETTE.bg);
    expect(bridgeScript()).toContain(PALETTE.error);
  });
});

/*
 * The icon font, and the two ways it has of quietly ruining the grid.
 *
 * Android has no Nerd Font, so the user's prompt drew as empty boxes and the
 * page now carries a subset of one. Everything below is a property that was
 * measured in the emulator's WebView and would be invisible in a diff.
 */
describe("the Nerd icon fallback", () => {
  /** The one @font-face in the document, as text. */
  function fontFace(): string {
    const face = doc.match(/@font-face\s*\{[^}]*\}/);
    expect(face, "no @font-face in the terminal document").toBeTruthy();
    return face![0];
  }

  /** The unicode-range descriptor, expanded into the codepoints it covers. */
  function covers(codepoint: number): boolean {
    const range = fontFace().match(/unicode-range:\s*([^;]+);/);
    expect(range, "the face declares no unicode-range").toBeTruthy();
    return range![1]!.split(",").some((token) => {
      const parts = token.trim().replace(/^U\+/i, "").split("-");
      const from = parseInt(parts[0]!, 16);
      const to = parts[1] === undefined ? from : parseInt(parts[1], 16);
      return codepoint >= from && codepoint <= to;
    });
  }

  test("the face travels inside the page", () => {
    // Same reason as the engine: this document is handed to a WebView on
    // about:blank, which has no network to fetch a font over. "d09GMg" is
    // base64 for the woff2 magic, so this also catches a data URI of the
    // wrong bytes — which a WebView drops in silence, leaving the boxes.
    expect(fontFace()).toContain("src: url(data:font/woff2;base64,d09GMg");
  });

  test("it is a fallback, never the primary family", () => {
    /*
     * xterm measures its cell from the first face that answers, and a whole
     * Nerd Font in front would re-metric every character of text on the screen
     * to fix seven symbols. The stack is also shared with the cold-start probe
     * — measuring one face and rendering another is measuring nothing.
     */
    const script = bridgeScript();
    const stack = script.match(/var FONT_STACK = '([^']+)'/);
    expect(stack, "the page no longer has a single font stack").toBeTruthy();
    const families = stack![1]!.split(",").map((f) => f.trim().replace(/"/g, ""));
    expect(families[0]).toBe("ui-monospace");
    expect(families.indexOf("NerdIcons")).toBeGreaterThan(0);
    expect(families[families.length - 1]).toBe("monospace");
    // Both users of it, so neither can drift onto a family of its own.
    expect(script).toContain("fontFamily: FONT_STACK");
    expect(script).toContain("font-family:' + FONT_STACK");
  });

  test("its range keeps it out of the line box", () => {
    /*
     * The measurement this exists for. On Android ui-monospace, Menlo and
     * Consolas are all absent, so this face is the first one in the stack that
     * EXISTS — which makes it the strut, whatever its position in the list.
     * Measured with no range: the line box went 9.905px to 11.429px and the
     * screen dropped from 56 rows to 47, which with fit on is also nine rows
     * off the desk's tmux window.
     *
     * A face whose unicode-range excludes U+0020 is skipped when the strut is
     * chosen. U+0057 is in here as well because it is the glyph xterm measures
     * the cell with.
     */
    expect(covers(0x20)).toBe(false);
    expect(covers(0x57)).toBe(false);
    // And it still has to answer for the icons, or none of this was worth it.
    expect(covers(0xe0b0)).toBe(true);
    expect(covers(0xe0a0)).toBe(true);
  });

  test("the range is the font's own coverage, not a list beside it", () => {
    /*
     * A range WIDER than the face is a second bug: a character inside it that
     * the face has not got, and that nothing on the device has either, draws
     * this face's .notdef — which in a subset is empty. Measured with the
     * ranges the woff2 was CUT with rather than the ones it ended up with:
     * U+23F5 in the user's prompt went from an empty box to nothing at all.
     *
     * So the build script reads the ranges out of the cmap, and U+23F5 is the
     * canary: it is inside the range the font was asked for and outside the
     * range it actually has.
     */
    expect(doc).toContain(`unicode-range: ${NERD_ICONS_RANGE};`);
    expect(covers(0x23f5)).toBe(false);
    // Malformed tokens invalidate the whole descriptor, which hands the face
    // every codepoint there is — the strut back, silently.
    for (const token of NERD_ICONS_RANGE.split(",")) {
      expect(token.trim()).toMatch(/^U\+[0-9A-F]{4,6}(-[0-9A-F]{4,6})?$/);
    }
  });
});

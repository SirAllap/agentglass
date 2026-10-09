/*
 * An icon is drawn, never typed.
 *
 * The app had over two hundred icons that were characters: emoji (`⚙ 💬 🔒 📌
 * ⏰`) that draw in colour at whatever size the system's emoji font picks, and
 * symbols (`⇄ ☑ ✳ ◍ ⌕ ✎ ⎇ ✦`) that paint about 60% of their font size — beside
 * the line icons of the rail, in the same row. On a desktop whose emoji font is
 * not the one this was built on, a menu of them read as a sticker sheet.
 *
 * Every one of these characters now has a line icon in lib/glyphIcons.tsx or
 * workspace/icons.tsx. This fails when one comes back as text in a component.
 *
 * What stays text, and why, is listed rather than guessed at:
 *   - GitHub's reactions and markdown emoji shortcodes are CONTENT the person
 *     wrote, not the app's chrome;
 *   - the diff's change column (`− → ± ⧉`) is a code, like a git status letter.
 * Keys in shortcut hints (`⌘ ⏎ ⌫`), arrows inside a sentence and status dots
 * are not in the set at all.
 */
import { describe, expect, it } from "bun:test";
import { Glob } from "bun";

const ICON_GLYPHS = [..."⚙⇄☑✳◍▤◆⌕⧉↻⟳↺⟲✎⚠★☆✦✨⎇⑂⑃⏰⏱⏳◷⚡💬🔒🔓⚿🔗⛶⤢⤡⊘⛔☐⊙⌗⏣◈◌⌬⌸⊟⊞⛁☰⎌⫴⚐⚑⌂▭▣◉🏷👤👁📁🗀🖥📌🛰🙋✋📱❌🔍🔎🔥✅🤖📎⌨🌙⋯✕＋－◎❞❊ℹ✓◯○"];

/** Content, not chrome — see the header. Matched against the line. */
const ALLOWED: Record<string, RegExp[]> = {
  "components/PrPanel.tsx": [
    /^\s*(tada|white_check_mark|pray|boom):/,            // markdown emoji shortcodes
    /content: "[A-Z_]+", glyph: "/,                        // GitHub's reactions
    /case "copied": return \{ ch: "⧉"/,                    // the diff's change column
  ],
  "lib/prBody.ts": [/^\s*[a-z_+"-]+: "/],                  // markdown emoji shortcodes
  "lib/emojiData.ts": [/./],                               // the emoji picker's table: the characters ARE the content
  "lib/useLive.ts": [/\.replace\(\/\^/],                   // stripping a server's emoji prefix
};

/** Comments say which glyph a thing replaced; only code is scanned. */
const code = (src: string) => src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, (m) => "\n".repeat(m.split("\n").length - 1))
  .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const root = new URL("../src/", import.meta.url).pathname;
const offenders: string[] = [];
for await (const f of new Glob("**/*.{ts,tsx}").scan(root)) {
  if (f === "lib/glyphIcons.tsx") continue;
  /* `"\u2713"` is a tick too: two of these were written as escapes, and one
     of those sat in JSX text, where an escape is not decoded at all. */
  const lines = code(await Bun.file(root + f).text())
    .replace(/\\u\{?([0-9A-Fa-f]{4,5})\}?/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .split("\n");
  lines.forEach((line, i) => {
    if (!ICON_GLYPHS.some((g) => line.includes(g))) return;
    if ((ALLOWED[f] ?? []).some((re) => re.test(line))) return;
    offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 80)}`);
  });
}

/** A close cross typed as `×` — the multiplication sign — alone in a control.
 *  `×3` as a count is a word, and stays. */
const loneTimes: string[] = [];
for await (const f of new Glob("**/*.tsx").scan(root)) {
  const src = code(await Bun.file(root + f).text());
  src.split("\n").forEach((line, i) => {
    if (/>\s*×\s*</.test(line) || /^\s*×\s*$/.test(line)) loneTimes.push(`${f}:${i + 1}`);
  });
}

describe("an icon is drawn, never typed", () => {
  it("a close is a CloseIcon in a box, not a × character", () => {
    expect(loneTimes).toEqual([]);
  });

  it("no icon glyph is left as text in the UI", () => {
    expect(offenders).toEqual([]);
  });
});

describe("an icon sits on its line", () => {
  it("in a row that aligns by baseline, it is centred instead", async () => {
    // An SVG's baseline is its bottom edge: in `items-baseline` the task rows'
    // flag rode 3px above the title it leads. Measured in the rendered app.
    const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
    expect(css).toMatch(/\.items-baseline > svg,\s*\n\.items-baseline > :is\(span, button, a\)\.flex:has\(> svg:only-child\) \{\s*align-self: center;/);
  });
});

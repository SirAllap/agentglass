/*
 * The icon font, turned into text so the terminal page can carry it.
 *
 * Same problem as the engine next door: the WebView is handed a document on
 * `about:blank`, with no bundler and no network, so anything the page needs
 * has to already be inside the string. A `url(...)` pointing anywhere would
 * simply not load — and a terminal that CAN fetch something is a terminal that
 * can be told to.
 *
 * What it is: JetBrainsMono Nerd Font, cut to the icon ranges — 261KB of a
 * 2.4MB face. Android carries no Nerd Font at all, so a prompt built out of
 * powerline separators, a branch, a penguin and a clock draws as a row of
 * empty boxes under every face the system has.
 *
 * Generated rather than committed, for the reason the engine is: the base64 is
 * 349KB of a single line, and a diff nobody can read is a diff nobody checks.
 * The woff2 it is made from sits next to it in `src/terminal/` and IS
 * committed — 261KB, once, changed only when the font is.
 *
 * ── regenerating the woff2 itself ─────────────────────────────────────────
 * Only needed when a glyph is missing. The ranges were measured against real
 * panes: they use 27 codepoints, but cutting to those 27 breaks the moment
 * anybody opens something else, so the small ranges go in whole (box drawing,
 * arrows, powerline, Font Awesome, Devicons, Octicons, Seti) and Material —
 * ~700KB for three glyphs — only where it was measured.
 *
 *   pyftsubset JetBrainsMonoNerdFontMono-Regular.ttf \
 *     --output-file=nerd-icons.woff2 --flavor=woff2 \
 *     --unicodes="U+2190-21FF,U+2300-23FF,U+2500-259F,U+25A0-25FF,U+2600-26FF,\
 * U+2700-27BF,U+E0A0-E0D4,U+E000-E00A,U+E200-E2A9,U+E300-E3E3,U+E5FA-E6B5,\
 * U+E700-E7C5,U+F000-F2FF,U+F400-F533,U+F0320,U+F0354" \
 *     --layout-features='' --no-hinting --desubroutinize --drop-tables+=DSIG,PfEd
 *
 * Four of the 27 measured codepoints (U+21E3 U+23AF U+23F5 U+273B) are not in
 * the source face either: they are ordinary Unicode symbols rather than Nerd
 * icons, so no subsetting brings them back. Three of them Android draws out of
 * its own fallback anyway; only U+23F5 has no glyph anywhere on the device and
 * stays an empty box.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const src = path.join(root, "src", "terminal", "nerd-icons.woff2");
const out = path.join(root, "src", "terminal", "nerdfont.generated.ts");

const font = await readFile(src);
/*
 * Checked here rather than discovered on a phone. A data URI of the wrong
 * bytes is not an error anywhere: the WebView drops the face without a word
 * and every icon quietly goes back to being a box, which is the exact symptom
 * this file exists to fix and would look like it had never been fixed.
 */
if (font.subarray(0, 4).toString("latin1") !== "wOF2") {
  throw new Error(`${src} is not a woff2 (magic ${font.subarray(0, 4).toString("hex")})`);
}

/*
 * The codepoints the face really has, read out of its own cmap.
 *
 * The page declares these as the @font-face's unicode-range, and both halves
 * of that matter — measured in the emulator's WebView, against the terminal:
 *
 *  - WITHOUT a range the face is the first one in the stack that exists at all
 *    on Android (ui-monospace, Menlo and Consolas are not there), so it sets
 *    the strut: the line box went 9.905px → 11.429px and the screen lost nine
 *    of its 56 rows. A range that excludes U+0020 takes it out of that
 *    decision. See the @font-face comment in terminal-html.ts.
 *  - With a range WIDER than the face, a character inside it that the face has
 *    not got, and that nothing on the device has either, draws this font's
 *    .notdef — which in a subset is empty. U+23F5 went from an empty box to
 *    nothing at all. Declaring the real coverage keeps the box.
 *
 * Which is why this is parsed rather than written down: a list maintained by
 * hand beside a font maintained by pyftsubset is a list that drifts, and both
 * failures above are silent.
 */
// Indices into woff2's table of known tags. 63 is the escape: the tag is
// spelled out in the four bytes that follow instead.
const TAG_CMAP = 0;
const TAG_GLYF = 10;
const TAG_LOCA = 11;
const TAG_CUSTOM = 63;

const uintBase128 = (buf, at) => {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = buf[at + i];
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return [value >>> 0, at + i + 1];
  }
  throw new Error("malformed UIntBase128 in the woff2 table directory");
};

function cmapOf(woff2) {
  const numTables = woff2.readUInt16BE(12);
  const totalCompressed = woff2.readUInt32BE(20);
  let at = 48;
  let offset = 0;
  let cmap = null;
  for (let i = 0; i < numTables; i++) {
    const flags = woff2[at++];
    const tagIndex = flags & 0x3f;
    if (tagIndex === TAG_CUSTOM) at += 4; // spelled out rather than indexed
    let origLength;
    [origLength, at] = uintBase128(woff2, at);
    /*
     * glyf and loca are transformed AT version 0 and left alone at version 3;
     * every other table is the other way round. Getting this backwards puts
     * every table after the first transformed one at the wrong offset, and the
     * cmap parse then reads glyph outlines as an encoding table.
     */
    const version = flags >> 6;
    const transformed = tagIndex === TAG_GLYF || tagIndex === TAG_LOCA ? version === 0 : version !== 0;
    let length = origLength;
    if (transformed) [length, at] = uintBase128(woff2, at);
    if (tagIndex === TAG_CMAP) cmap = { offset, length };
    offset += length;
  }
  if (!cmap) throw new Error("no cmap in the woff2 table directory");
  // cmap is never one of the transformed tables, so it comes out of the stream
  // as it went in.
  const tables = zlib.brotliDecompressSync(woff2.subarray(at, at + totalCompressed));
  return tables.subarray(cmap.offset, cmap.offset + cmap.length);
}

/** Every codepoint the cmap maps to a real glyph, from whichever of the two
 *  subtables is there — format 12 first, since it is the only one that can
 *  carry the Material icons up at U+F0320. */
function coverage(cmap) {
  const points = new Set();
  const count = cmap.readUInt16BE(2);
  let best4 = -1;
  let best12 = -1;
  for (let i = 0; i < count; i++) {
    const at = 4 + i * 8;
    const sub = cmap.readUInt32BE(at + 4);
    const format = cmap.readUInt16BE(sub);
    if (format === 12) best12 = sub;
    else if (format === 4 && best4 < 0) best4 = sub;
  }
  if (best12 >= 0) {
    const groups = cmap.readUInt32BE(best12 + 12);
    for (let g = 0; g < groups; g++) {
      const at = best12 + 16 + g * 12;
      const start = cmap.readUInt32BE(at);
      const end = cmap.readUInt32BE(at + 4);
      if (cmap.readUInt32BE(at + 8) === 0) continue;
      for (let c = start; c <= end; c++) points.add(c);
    }
    return points;
  }
  if (best4 < 0) throw new Error("cmap has neither a format 4 nor a format 12 subtable");
  const segs = cmap.readUInt16BE(best4 + 6) / 2;
  const ends = best4 + 14;
  const starts = ends + segs * 2 + 2;
  const deltas = starts + segs * 2;
  const rangeOffsets = deltas + segs * 2;
  for (let s = 0; s < segs; s++) {
    const end = cmap.readUInt16BE(ends + s * 2);
    const start = cmap.readUInt16BE(starts + s * 2);
    const delta = cmap.readInt16BE(deltas + s * 2);
    const rangeOffset = cmap.readUInt16BE(rangeOffsets + s * 2);
    if (start === 0xffff) continue;
    for (let c = start; c <= end; c++) {
      let glyph;
      if (rangeOffset === 0) glyph = (c + delta) & 0xffff;
      else {
        const at = rangeOffsets + s * 2 + rangeOffset + (c - start) * 2;
        glyph = cmap.readUInt16BE(at);
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph !== 0) points.add(c);
    }
  }
  return points;
}

const points = [...coverage(cmapOf(font))].sort((a, b) => a - b);
/*
 * The strut guard. U+0020 in the range would put this face back in front of
 * the line box — the nine-row loss above — and a subset built with a Latin
 * range in it would do exactly that without anything else going wrong.
 */
if (points.includes(0x20)) {
  throw new Error("the subset covers U+0020, which would make it the strut font on Android");
}

const hex = (c) => c.toString(16).toUpperCase().padStart(4, "0");
const ranges = [];
for (const c of points) {
  const last = ranges[ranges.length - 1];
  if (last && c === last[1] + 1) last[1] = c;
  else ranges.push([c, c]);
}
const unicodeRange = ranges.map(([a, b]) => (a === b ? `U+${hex(a)}` : `U+${hex(a)}-${hex(b)}`)).join(", ");

const b64 = font.toString("base64");
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, [
  "// Generated by scripts/build-terminal-font.mjs — do not edit by hand.",
  `// Source: src/terminal/nerd-icons.woff2 (${font.length} bytes).`,
  "// Regenerate with `npm run build:font`.",
  "",
  `export const NERD_ICONS_WOFF2_B64 = ${JSON.stringify(b64)};`,
  "",
  "/** The codepoints the face above actually maps, as the page's",
  " *  unicode-range. Read from its cmap — see the build script for what goes",
  " *  wrong when this is wider or narrower than the font. */",
  `export const NERD_ICONS_RANGE = ${JSON.stringify(unicodeRange)};`,
  "",
].join("\n"));

console.log(
  `wrote ${path.relative(root, out)} — ${Math.round(font.length / 1024)}KB of font, ` +
  `${Math.round(b64.length / 1024)}KB as base64, ` +
  `${points.length} codepoints in ${ranges.length} ranges`,
);

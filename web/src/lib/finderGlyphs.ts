/*
 * Which icon and which colour a file gets in the finder, decided by name, the
 * way Strata does: JSON is braces in amber, README and markdown are the info
 * mark in teal, code is angle brackets, a picture is a picture, an archive is a
 * box, and a folder is plain. The drawing is in finderIcons.tsx.
 */

export type Glyph =
  | "folder" | "braces" | "readme" | "markdown" | "code" | "image" | "video" | "audio" | "archive" | "key" | "sheet" | "package" | "disc" | "text";
export type Tone = "plain" | "amber" | "teal" | "green" | "violet" | "red" | "dim";

const EXT: Record<string, Glyph> = {};
const add = (g: Glyph, exts: string) => { for (const e of exts.split(" ")) EXT[e] = g; };
add("braces", "json jsonc json5 jsonl ndjson geojson");
add("markdown", "md markdown mdx");
add("code", "rs py js jsx mjs cjs ts tsx go java kt swift dart c h cc cpp hpp cs rb php lua sh bash zsh fish html htm css scss sass less vue svelte astro xml yaml yml toml ini conf cfg env sql sqlite db");
add("image", "png jpg jpeg gif webp svg bmp avif heic heif jxl tif tiff ico");
add("video", "mp4 mkv webm mov avi m4v mpeg mpg ogv 3gp flv wmv");
add("audio", "mp3 wav flac ogg m4a aac opus wma aiff");
add("archive", "zip 7z tar gz tgz bz2 xz zst rar lz lzma");
add("package", "deb rpm pkg appimage msi exe apk jar so dll dylib o obj");
add("disc", "iso img dmg vhd");
add("key", "pem crt key pub p12");
add("sheet", "csv tsv xls xlsx ods");

const TONE: Record<Glyph, Tone> = {
  folder: "plain", braces: "amber", readme: "teal", markdown: "teal", code: "green", image: "violet", video: "red", audio: "violet",
  archive: "amber", key: "dim", sheet: "green", package: "dim", disc: "dim", text: "dim",
};

/** `README`, `readme.md`, `README.rst`: the project's front page, which Strata marks apart from other markdown. */
const README = /^readme(\.[a-z0-9]+)?$/i;

export function glyphFor(name: string, isDir: boolean): { glyph: Glyph; tone: Tone } {
  if (isDir) return { glyph: "folder", tone: "plain" };
  if (README.test(name)) return { glyph: "readme", tone: "teal" };
  const dot = name.lastIndexOf(".");
  const base = name.toLowerCase();
  const g: Glyph = dot > 0 || base.startsWith(".") && dot === 0 ? EXT[base.slice(dot + 1)] ?? "text"
    : /^(makefile|dockerfile|rakefile|vagrantfile)$/.test(base) ? "code" : "text";
  return { glyph: g, tone: TONE[g] };
}

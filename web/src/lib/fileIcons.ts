// The glyph and the colour a file gets in the tree.
//
// This is the thing that makes nvim-tree readable at a glance and a plain list
// unreadable: you are not reading forty filenames, you are looking for the blue
// one. Extension → icon → colour is the whole mechanism, and it is worth having
// as data rather than as a chain of ifs inside a render.
//
// The glyphs are Nerd Font codepoints — the same set nvim-tree, lazygit and
// starship draw from, and the family this app already sets for everything (see
// --font-mono). On a machine with no patched font they come out as tofu boxes,
// which is why `ICONS` keeps every glyph in one place: swapping the whole set
// for letters is then one edit, not forty.

export type FileIcon = { glyph: string; tint: string };

/** Folders. Open and closed are different glyphs, the way every file tree since
 *  Norton Commander has drawn them. */
export const FOLDER: FileIcon = { glyph: "", tint: "var(--primary)" };       //
export const FOLDER_OPEN: FileIcon = { glyph: "", tint: "var(--primary)" };  //

/** A file with no rule of its own. */
export const FILE: FileIcon = { glyph: "", tint: "var(--text3)" };           //

/**
 * Extension → glyph and colour.
 *
 * The colours are the language's own, near enough that a Rust file and a Go
 * file are told apart without reading either name — which is the entire reason
 * to colour them. Kept close to what nvim-web-devicons uses, so a person who
 * lives in that editor does not have to learn a second palette.
 */
const BY_EXT: Record<string, FileIcon> = {
  ts: { glyph: "", tint: "#519aba" },      //  typescript
  tsx: { glyph: "", tint: "#519aba" },     //  react
  js: { glyph: "", tint: "#cbcb41" },      //  javascript
  jsx: { glyph: "", tint: "#519aba" },
  mjs: { glyph: "", tint: "#cbcb41" },
  cjs: { glyph: "", tint: "#cbcb41" },
  py: { glyph: "", tint: "#ffbc03" },      //  python
  rb: { glyph: "", tint: "#701516" },      //  ruby
  go: { glyph: "", tint: "#519aba" },      //  go
  rs: { glyph: "", tint: "#dea584" },      //  rust
  java: { glyph: "", tint: "#cc3e44" },    //
  c: { glyph: "", tint: "#599eff" },
  h: { glyph: "", tint: "#a074c4" },
  cpp: { glyph: "", tint: "#519aba" },
  cs: { glyph: "", tint: "#596706" },
  php: { glyph: "", tint: "#a074c4" },
  swift: { glyph: "", tint: "#e37933" },
  kt: { glyph: "", tint: "#7f52ff" },
  vue: { glyph: "﵂", tint: "#8dc149" },
  svelte: { glyph: "", tint: "#ff3e00" },

  html: { glyph: "", tint: "#e34c26" },    //
  css: { glyph: "", tint: "#563d7c" },     //
  scss: { glyph: "", tint: "#f55385" },
  json: { glyph: "", tint: "#cbcb41" },    //
  jsonc: { glyph: "", tint: "#cbcb41" },
  yml: { glyph: "", tint: "#6d8086" },     //
  yaml: { glyph: "", tint: "#6d8086" },
  toml: { glyph: "", tint: "#6d8086" },
  ini: { glyph: "", tint: "#6d8086" },
  xml: { glyph: "", tint: "#e37933" },
  sql: { glyph: "", tint: "#dad8d8" },

  md: { glyph: "", tint: "#dddddd" },      //  markdown
  mdx: { glyph: "", tint: "#519aba" },
  txt: { glyph: "", tint: "#89e051" },
  pdf: { glyph: "", tint: "#b30b00" },
  csv: { glyph: "", tint: "#89e051" },

  sh: { glyph: "", tint: "#4d5a5e" },      //  terminal
  bash: { glyph: "", tint: "#4d5a5e" },
  zsh: { glyph: "", tint: "#4d5a5e" },
  fish: { glyph: "", tint: "#4d5a5e" },

  png: { glyph: "", tint: "#a074c4" },
  jpg: { glyph: "", tint: "#a074c4" },
  jpeg: { glyph: "", tint: "#a074c4" },
  gif: { glyph: "", tint: "#a074c4" },
  svg: { glyph: "ﰟ", tint: "#ffb13b" },
  ico: { glyph: "", tint: "#cbcb41" },

  lock: { glyph: "", tint: "#bbbbbb" },    //
  log: { glyph: "", tint: "#81e043" },
  zip: { glyph: "", tint: "#eca517" },
  gz: { glyph: "", tint: "#eca517" },
};

/**
 * Whole filenames that mean more than their extension.
 *
 * `Makefile` has no extension at all, and `package.json` is not "some JSON" —
 * it is the thing you open when the build is wrong. Matched before the
 * extension, case-insensitively, because `README.md` and `readme.md` are the
 * same file to everyone except a lookup table.
 */
const BY_NAME: Record<string, FileIcon> = {
  "makefile": { glyph: "", tint: "#6d8086" },
  "dockerfile": { glyph: "", tint: "#458ee6" },
  "docker-compose.yml": { glyph: "", tint: "#458ee6" },
  "package.json": { glyph: "", tint: "#e8274b" },
  "package-lock.json": { glyph: "", tint: "#7a0d21" },
  "bun.lock": { glyph: "", tint: "#fbf0df" },
  "bun.lockb": { glyph: "", tint: "#fbf0df" },
  "cargo.toml": { glyph: "", tint: "#dea584" },
  "go.mod": { glyph: "", tint: "#519aba" },
  "readme.md": { glyph: "", tint: "#dddddd" },
  "license": { glyph: "", tint: "#d0bf41" },
  ".gitignore": { glyph: "", tint: "#f14c28" },
  ".gitattributes": { glyph: "", tint: "#f14c28" },
  ".env": { glyph: "", tint: "#faf743" },
  "claude.md": { glyph: "", tint: "#d97757" },
};

/** Directories whose contents are not yours — a build output, a cache, a
 *  dependency tree. Dimmed rather than hidden: you still need to see that
 *  node_modules is there, you just should not have to read past it. */
const NOISE = new Set([
  "node_modules", "dist", "build", "out", ".next", ".nuxt", ".turbo", "target",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".venv", "venv",
  "coverage", ".cache", ".gradle", "vendor", "dist-app", "staging", ".git",
]);

/** The icon for one entry. Directories answer by state, files by name first
 *  and extension second. */
export function iconFor(name: string, dir: boolean, open = false): FileIcon {
  if (dir) {
    const base = open ? FOLDER_OPEN : FOLDER;
    return NOISE.has(name.toLowerCase()) ? { ...base, tint: "var(--text4)" } : base;
  }
  const lower = name.toLowerCase();
  const byName = BY_NAME[lower];
  if (byName) return byName;
  const dot = lower.lastIndexOf(".");
  // A dotfile with no second dot (".gitignore") has no extension — its whole
  // name is the extension, and BY_NAME above is where it is answered.
  if (dot <= 0) return FILE;
  return BY_EXT[lower.slice(dot + 1)] ?? FILE;
}

/** Is this a directory whose contents are generated? Used to quiet the row, not
 *  to hide it. */
export function isNoise(name: string, dir: boolean): boolean {
  return dir && NOISE.has(name.toLowerCase());
}

/**
 * The `│  ├─ ` prefix in front of a row.
 *
 * `last` is one flag per level, from the root down: whether the ancestor at
 * that depth was the final child of its own parent. That is what decides
 * between a continuing pipe and blank space, and getting it wrong is what makes
 * a hand-drawn tree look like a hand-drawn tree.
 */
export function guides(last: boolean[]): string {
  if (!last.length) return "";
  const stem = last.slice(0, -1).map((l) => (l ? "   " : "│  ")).join("");
  return stem + (last[last.length - 1] ? "└─ " : "├─ ");
}

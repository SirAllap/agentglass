// Shiki syntax highlighting for the diff. One shared highlighter; themes and
// languages are loaded on demand (both are lazy dynamic imports so shiki's core
// + wasm + grammars + theme JSON stay out of the main dashboard bundle and only
// load when a diff is opened / a theme is picked).
//
// "nvim-style bold": most Neovim setups bold keywords / functions / types via
// treesitter. Shiki is TextMate-based and few themes bold those scopes, so when
// `bold` is on we clone the chosen theme and append a rule that bolds them —
// giving the same look on ANY theme. Themes' own italic/bold are always honored.
import type { Highlighter, ThemeRegistrationRaw } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

// Lazy handle to the shiki module — imported once, shared by every helper, so
// the whole library is a single on-demand chunk.
let modP: Promise<typeof import("shiki")> | null = null;
const shiki = () => (modP ??= import("shiki"));

let hp: Promise<Highlighter> | null = null;
/**
 * The one shared highlighter, tokenizing with shiki's **JavaScript** RegExp
 * engine rather than its default Oniguruma one.
 *
 * Oniguruma is WebAssembly, and the desktop shell serves the bundle under the
 * CSP in `src-tauri/tauri.conf.json`, whose `script-src 'self'` omits
 * `'wasm-unsafe-eval'` — so the webview refuses to instantiate the module and
 * `createHighlighter` rejects before a theme or a language is ever requested.
 * That is why the diff was monochrome in the app but coloured in a browser,
 * and why the theme picker showed no complaint: the theme step never ran.
 *
 * The engine swap is preferred over widening the CSP because it keeps the
 * desktop app's script policy as tight as it is today, and because relying on
 * `'wasm-unsafe-eval'` would put us at the mercy of whether the host's
 * WebKitGTK recognises that token — an unknown source expression is simply
 * ignored, which would silently leave wasm blocked on older systems.
 */
export function getHighlighter(): Promise<Highlighter> {
  if (!hp) hp = shiki().then((m) => m.createHighlighter({ themes: [], langs: [], engine: createJavaScriptRegexEngine() }));
  return hp;
}

// --- theme catalog (Shiki bundled ids), mirroring the user's Neovim themes ----
export type ThemeChoice = { id: string; label: string; dark: boolean };
export const THEMES: ThemeChoice[] = [
  { id: "github-dark", label: "GitHub Dark", dark: true },
  { id: "catppuccin-macchiato", label: "Catppuccin Macchiato", dark: true },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha", dark: true },
  { id: "catppuccin-frappe", label: "Catppuccin Frappé", dark: true },
  { id: "tokyo-night", label: "Tokyo Night", dark: true },
  { id: "kanagawa-wave", label: "Kanagawa Wave", dark: true },
  { id: "kanagawa-dragon", label: "Kanagawa Dragon", dark: true },
  { id: "rose-pine", label: "Rosé Pine", dark: true },
  { id: "rose-pine-moon", label: "Rosé Pine Moon", dark: true },
  { id: "everforest-dark", label: "Everforest Dark", dark: true },
  { id: "gruvbox-dark-medium", label: "Gruvbox Dark", dark: true },
  { id: "nord", label: "Nord", dark: true },
  { id: "dracula", label: "Dracula", dark: true },
  { id: "monokai", label: "Monokai", dark: true },
  { id: "one-dark-pro", label: "One Dark Pro", dark: true },
  { id: "vesper", label: "Vesper", dark: true },
  { id: "github-light", label: "GitHub Light", dark: false },
  { id: "catppuccin-latte", label: "Catppuccin Latte", dark: false },
  { id: "kanagawa-lotus", label: "Kanagawa Lotus", dark: false },
  { id: "rose-pine-dawn", label: "Rosé Pine Dawn", dark: false },
  { id: "everforest-light", label: "Everforest Light", dark: false },
  { id: "gruvbox-light-medium", label: "Gruvbox Light", dark: false },
];

// Scopes bolded when "bold" is on — keywords, function defs/calls, types/classes.
const BOLD_SCOPES = [
  "keyword", "keyword.control", "keyword.operator.new", "keyword.operator.expression",
  "storage.type", "storage.modifier",
  "entity.name.function", "entity.name.method", "support.function", "meta.function-call", "variable.function",
  "entity.name.type", "entity.name.class", "entity.other.inherited-class", "support.class", "support.type",
];

/** Clone a theme with a rule that bolds keyword/function/type scopes.
 *  Shiki reads `tokenColors` in preference to the legacy `settings` array, so
 *  we set tokenColors (seeded from whichever the theme provides) + our bold rule. */
function boldify(theme: ThemeRegistrationRaw, id: string): ThemeRegistrationRaw {
  const rules = theme.tokenColors ?? theme.settings ?? [];
  return {
    ...theme,
    name: `${id}-bold`,
    tokenColors: [...rules, { scope: BOLD_SCOPES, settings: { fontStyle: "bold" } }],
  };
}

const loadedThemes = new Set<string>();

/** Register one theme and return the name it was registered under. Rejects if
 *  the theme cannot be loaded — including for an id shiki doesn't bundle, which
 *  must not be papered over: recording a name that is not actually on the
 *  highlighter is the failure mode this whole module has to avoid. */
async function loadInto(hl: Highlighter, id: string, bold: boolean): Promise<string> {
  const name = bold ? `${id}-bold` : id;
  if (loadedThemes.has(name)) return name;
  if (!bold) {
    await hl.loadTheme(id as never); // shiki resolves the bundled id string
  } else {
    const m = await shiki();
    const loader = (m.bundledThemes as Record<string, () => Promise<{ default: ThemeRegistrationRaw }>>)[id];
    if (!loader) throw new Error(`"${id}" is not a bundled shiki theme`);
    await hl.loadTheme(boldify((await loader()).default, id) as never);
  }
  loadedThemes.add(name);
  return name;
}

/** Whichever theme a diff surface should actually tokenize with. `name` is
 *  always a theme that is registered on the highlighter, or null when nothing
 *  could be registered at all; `failed` carries the id we were asked for when
 *  it isn't the one we got. */
export type ResolvedTheme = { name: string | null; failed?: string };

// Falling back within the same light/dark family keeps the diff legible against
// the panel it sits on, rather than painting light-theme foregrounds onto a
// dark surface.
const FALLBACK = { dark: "github-dark", light: "github-light" } as const;

/**
 * Ensure a theme is registered on the highlighter and return the theme *name*
 * to pass to codeToTokens. When `bold`, a boldified variant is registered under
 * `${id}-bold`. Idempotent; safe to call on every render.
 *
 * Loading a theme fetches a chunk at runtime, so it can fail for reasons that
 * have nothing to do with the theme itself — offline, or a deploy whose hashed
 * chunks moved out from under a long-lived tab. This used to answer such a
 * failure by returning the requested name anyway, and `codeToTokens` then threw
 * on every single line: the diff rendered as unstyled monochrome text with
 * nothing logged, indistinguishable from "this language has no grammar". So a
 * failed load now resolves to a theme we have genuinely registered and reports
 * which id we could not honour, for the caller to put in front of the user.
 */
export async function ensureTheme(hl: Highlighter, id: string, bold: boolean): Promise<ResolvedTheme> {
  try {
    return { name: await loadInto(hl, id, bold) };
  } catch {
    const fallback = FALLBACK[THEMES.find((t) => t.id === id)?.dark === false ? "light" : "dark"];
    if (fallback !== id) {
      try { return { name: await loadInto(hl, fallback, bold), failed: id }; } catch { /* both gone — plain text below */ }
    }
    return { name: null, failed: id };
  }
}

/** The picker label for a name `ensureTheme` resolved to (it may carry the
 *  `-bold` suffix, which is an implementation detail users never chose). */
export function themeLabel(name: string): string {
  const id = name.endsWith("-bold") ? name.slice(0, -"-bold".length) : name;
  return THEMES.find((t) => t.id === id)?.label ?? id;
}

const EXT: Record<string, string> = {
  ts: "typescript", tsx: "tsx", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "jsonc",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
  kt: "kotlin", kts: "kotlin", swift: "swift", scala: "scala", dart: "dart",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", cs: "csharp",
  php: "php", css: "css", scss: "scss", sass: "sass", less: "less",
  html: "html", htm: "html", xml: "xml", svg: "xml", vue: "vue", svelte: "svelte", astro: "astro",
  md: "markdown", mdx: "mdx", markdown: "markdown",
  sh: "bash", bash: "bash", zsh: "bash", fish: "fish",
  yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini",
  sql: "sql", graphql: "graphql", gql: "graphql", proto: "proto",
  lua: "lua", r: "r", ex: "elixir", exs: "elixir", clj: "clojure",
  hs: "haskell", elm: "elm", ml: "ocaml", nim: "nim", zig: "zig",
};
export function langFromPath(path?: string): string | null {
  if (!path) return null;
  const base = (path.split("/").pop() || "").toLowerCase();
  if (base === "dockerfile") return "docker";
  if (base === "makefile") return "make";
  const dot = base.lastIndexOf(".");
  return (dot >= 0 ? EXT[base.slice(dot + 1)] : null) || null;
}

/** Resolve the "auto" theme from the app's current --bg luminance. */
export function shikiTheme(): "github-dark" | "github-light" {
  try {
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    const m = bg.match(/#?([0-9a-fA-F]{6})/);
    if (!m) return "github-dark";
    const n = parseInt(m[1], 16);
    const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
    return lum > 140 ? "github-light" : "github-dark";
  } catch {
    return "github-dark";
  }
}

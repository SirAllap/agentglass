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
import { onceOk } from "./onceOk.ts";

// Lazy handle to the shiki module — imported once, shared by every helper, so
// the whole library is a single on-demand chunk.
/*
 * A FAILED load is not remembered. That is the whole point of the two catches
 * below, and it was a real fault: a rejected promise cached here is cached for
 * the life of the page, so one failed chunk fetch left every code block in the
 * app flat grey until the app was restarted — reported exactly that way, "sometimes
 * the code blocks lose their colour… I restart the app and look".
 *
 * And the failure is ordinary rather than exotic. These are dynamic chunks
 * fetched from the local server at the moment a block first needs colour: a
 * server restarting under a long-lived window (which is what installing a build
 * does), a reload racing the first paint, a deploy whose hashed chunks moved.
 * Any of them, once, and the handle below was poisoned for good.
 */
const shiki = onceOk(() => import("shiki"));

/** Same rule as `shiki` above, and the same reason: the highlighter is worth
 *  sharing, the failure to build one is not. */
const highlighter = onceOk(() =>
  shiki().then((m) => m.createHighlighter({ themes: [], langs: [], engine: createJavaScriptRegexEngine() })));

/**
 * The one shared highlighter, tokenizing with shiki's **JavaScript** RegExp
 * engine rather than its default Oniguruma one.
 *
 * Oniguruma is WebAssembly, and a packaged desktop shell can serve the bundle
 * under a strict `script-src 'self'` CSP with no `'wasm-unsafe-eval'` — the
 * webview then refuses to instantiate the module and `createHighlighter`
 * rejects before a theme or a language is ever requested. That is what once
 * made the diff monochrome in the app but coloured in a browser, with no
 * complaint from the theme picker: the theme step never ran.
 *
 * The engine swap is preferred over widening the CSP because it keeps the
 * script policy as tight as possible and stays correct no matter how strict
 * the host's CSP is — the JavaScript engine needs no wasm eval at all, so a
 * hostile or minimal policy can never silently leave highlighting broken.
 */
export function getHighlighter(): Promise<Highlighter> {
  return highlighter();
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

/*
 * What has been loaded, PER HIGHLIGHTER.
 *
 * These were two plain module-level Sets, which is right exactly as long as there
 * is only ever one highlighter for the life of the page — and that stopped being
 * true the moment a failed build stopped being cached (see `onceOk`): the second
 * highlighter would be told "github-dark is already loaded", never load it, and
 * then throw `Theme not found` on every block. A note about one object kept in a
 * variable that outlives it is not a cache, it is a lie waiting for a retry.
 *
 * Caught by a suite that made two highlighters, which is also the only reason
 * anybody would notice.
 */
const loadedThemes = new WeakMap<Highlighter, Set<string>>();
const loadedLangs = new WeakMap<Highlighter, Set<string>>();

/** The set for this highlighter, made on first use. */
function seen(map: WeakMap<Highlighter, Set<string>>, hl: Highlighter): Set<string> {
  let set = map.get(hl);
  if (!set) { set = new Set<string>(); map.set(hl, set); }
  return set;
}

/** Register one theme and return the name it was registered under. Rejects if
 *  the theme cannot be loaded — including for an id shiki doesn't bundle, which
 *  must not be papered over: recording a name that is not actually on the
 *  highlighter is the failure mode this whole module has to avoid. */
async function loadInto(hl: Highlighter, id: string, bold: boolean): Promise<string> {
  const name = bold ? `${id}-bold` : id;
  const done = seen(loadedThemes, hl);
  if (done.has(name)) return name;
  if (!bold) {
    await hl.loadTheme(id as never); // shiki resolves the bundled id string
  } else {
    const m = await shiki();
    const loader = (m.bundledThemes as Record<string, () => Promise<{ default: ThemeRegistrationRaw }>>)[id];
    if (!loader) throw new Error(`"${id}" is not a bundled shiki theme`);
    await hl.loadTheme(boldify((await loader()).default, id) as never);
  }
  done.add(name);
  return name;
}

/**
 * Load a grammar and make it ready to tokenize *correctly on the first call*.
 *
 * The JavaScript engine above initialises a grammar lazily, on the first
 * `codeToTokens` for that language — and the first call's OUTPUT is what pays
 * for it. Measured on a fresh process: `const greeting = "hello"; // note`
 * comes back as ONE token, then eight, then ten, converging only after several
 * calls. The Oniguruma engine is right the first time; this is the price of not
 * needing wasm, and it is not a price anyone chose to pay because nobody knew
 * it was there.
 *
 * A diff tokenizes line by line, so what a user actually saw was the first line
 * of the first file of that language they opened all session rendering
 * under-highlighted, and every line after it fine. Nothing logged, nothing to
 * report, and it looked like the file simply had a dull first line. Three of
 * seventeen sampled languages were affected — typescript, css, haskell — and
 * which three moves.
 *
 * So the initialisation is paid here, with a throwaway single character, before
 * anything the user will look at goes through. It warms the grammar rather than
 * the theme pairing: warming with one theme and rendering with another is fine,
 * verified. The state lives in the engine for the life of the process, which is
 * also why this only ever bites once.
 */
export async function ensureLanguage(hl: Highlighter, lang: string): Promise<void> {
  const done = seen(loadedLangs, hl);
  if (done.has(lang)) return;
  await hl.loadLanguage(lang as never);
  try {
    // Any registered theme will do; register the dark fallback if the theme
    // step has not run yet, which it may not have — the two load in parallel.
    let theme = hl.getLoadedThemes()[0];
    if (!theme) { await hl.loadTheme(FALLBACK.dark as never); theme = FALLBACK.dark; }
    hl.codeToTokens("a", { lang: lang as never, theme });
  } catch {
    // A grammar that loaded but will not tokenize is the renderer's problem to
    // report, not this one's. Never let warming turn a working load into a
    // failed one.
  }
  done.add(lang);
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
/**
 * The language named on a fence, as a grammar id.
 *
 * A fence carries a word rather than a filename — ```python, ```sh, ```console
 * — so it needs its own table on top of the extension one. The aliases here are
 * the ones people actually type and the ones ClickUp writes when somebody picks
 * a language in its editor; anything unrecognised returns null and the block is
 * shown as plain text, which is what it was before.
 */
const TAGS: Record<string, string> = {
  py: "python", python: "python", py3: "python",
  shell: "bash", console: "bash", sh: "bash", "shell-session": "bash", bash: "bash", zsh: "bash",
  js: "javascript", node: "javascript", ts: "typescript",
  yml: "yaml", jsonc: "jsonc", plist: "xml",
  psql: "sql", postgres: "sql", postgresql: "sql", mysql: "sql",
  golang: "go", rs: "rust", "c++": "cpp", "c#": "csharp", cs: "csharp",
  dockerfile: "docker", docker: "docker", make: "make", makefile: "make",
  http: "http", diff: "diff", patch: "diff", text: "", txt: "", plain: "", "": "",
};
export function langFromTag(tag?: string): string | null {
  const t = (tag || "").trim().toLowerCase();
  if (!t) return null;
  if (t in TAGS) return TAGS[t] || null;
  return EXT[t] || (/^[a-z0-9+#-]{1,18}$/.test(t) ? t : null);
}

/**
 * What a fence with no language on it probably is.
 *
 * Most fenced blocks in the wild carry no tag at all — ClickUp's editor writes
 * one only when somebody picks a language from its menu, and pasted code
 * usually arrives bare. Guessing badly costs nothing here (a grammar that does
 * not fit a snippet produces dull-but-correct text, never wrong text), and
 * guessing right is the difference between a wall of grey and something you can
 * read, so the shapes below are the unmistakable ones only.
 */
export function guessLang(code: string): string | null {
  const c = code.slice(0, 1200);
  if (/^\s*[{[]["\s{[]/.test(c) && /[:,]\s*["{[\d]/.test(c)) return "json";
  if (/^\s*(def|class)\s+\w+|^\s*(from|import)\s+\w+|\bself\b|\belif\b|:=.*\bget\(/m.test(c)) return "python";
  if (/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE|ALTER TABLE)\b/i.test(c) && /\bFROM\b|\bSET\b|\bVALUES\b|\(/i.test(c)) return "sql";
  if (/^\s*(\$|#)\s+\S|^\s*(sudo|docker|git|make|npm|bun|yarn|curl|cd|export|kubectl)\s/m.test(c)) return "bash";
  // Before the JavaScript test, which `let mut` would otherwise answer first:
  // every keyword JavaScript owns is a keyword something else also uses, so the
  // narrower languages get asked before the broad one.
  if (/^\s*(func|package)\s+\w+/m.test(c)) return "go";
  if (/^\s*(fn|impl|pub fn)\s+\w+|\blet mut\b/m.test(c)) return "rust";
  if (/\b(interface|type)\s+\w+\s*[={]|:\s*(string|number|boolean)\b/.test(c)) return "typescript";
  if (/\b(const|let|function|=>|require\()/.test(c)) return "javascript";
  if (/^\s*<\w+[\s>/]/.test(c)) return "html";
  if (/^\s*\w[\w-]*:\s+\S/m.test(c) && !/[;{}]/.test(c)) return "yaml";
  return null;
}

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

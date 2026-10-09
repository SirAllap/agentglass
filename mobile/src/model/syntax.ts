/*
 * Colour for a file read on a phone: keywords, strings, numbers, comments and
 * the names being called — five classes, and nothing finer.
 *
 * The desk uses a full grammar (Shiki) and ships the grammars as chunks fetched
 * at runtime. A phone reading one file on a train wants the shape of the code,
 * not a parser, and a bundle of grammars is the wrong price for that. So this
 * is one small scanner with a keyword list per family of languages.
 *
 * ── the ceiling ──────────────────────────────────────────────────────────
 * It knows a block comment that spans lines and nothing else that does: a
 * Python triple-quoted string or a template literal with a newline in it is
 * coloured one line at a time, and the second line is read as code. Regexes,
 * heredocs and JSX text are not told apart either. A wrong colour is what that
 * costs; the text itself is never altered, and `tokens.map(t => t.text).join("")`
 * is always the line.
 */

export type TokenKind = "plain" | "keyword" | "string" | "number" | "comment" | "call";
export interface Token { text: string; kind: TokenKind }

interface Lang {
  keywords: ReadonlySet<string>;
  /** Line comment openers. */
  line: readonly string[];
  block: boolean;
  /** Quote characters that open a string. */
  quotes: string;
}

const words = (s: string): ReadonlySet<string> => new Set(s.split(" "));

const C_LIKE = words(
  "if else for while do switch case break continue return function class new this super import export from default const let var "
  + "async await try catch finally throw typeof instanceof in of void delete yield static extends implements interface type enum "
  + "public private protected readonly abstract namespace module declare as is keyof true false null undefined fn pub struct impl "
  + "trait use mod let mut match loop where func package go defer chan select range int string bool float double char long short "
  + "unsigned signed byte final override virtual operator template typename nil",
);
const PY = words(
  "def class return if elif else for while in not and or is import from as with try except finally raise pass break continue "
  + "lambda yield global nonlocal assert del async await None True False self",
);
const SH = words("if then else elif fi for while until do done case esac in function return exit export local readonly set unset true false");
const JSON_WORDS = words("true false null");

const JS: Lang = { keywords: C_LIKE, line: ["//"], block: true, quotes: "'\"`" };
const PYTHON: Lang = { keywords: PY, line: ["#"], block: false, quotes: "'\"" };
const SHELL: Lang = { keywords: SH, line: ["#"], block: false, quotes: "'\"" };
const JSON_LANG: Lang = { keywords: JSON_WORDS, line: [], block: false, quotes: "\"" };
const CSS: Lang = { keywords: new Set(), line: [], block: true, quotes: "'\"" };

const BY_EXT: Record<string, Lang> = {
  ts: JS, tsx: JS, js: JS, jsx: JS, mjs: JS, cjs: JS, java: JS, kt: JS, swift: JS, go: JS, rs: JS, c: JS, h: JS,
  cc: JS, cpp: JS, hpp: JS, cs: JS, php: JS, dart: JS, scala: JS,
  py: PYTHON, rb: PYTHON, yml: SHELL, yaml: SHELL, toml: SHELL, sh: SHELL, bash: SHELL, zsh: SHELL, conf: SHELL, env: SHELL,
  json: JSON_LANG, jsonc: JSON_LANG, css: CSS, scss: CSS,
};

/** The language a path is read as, or null for plain text (markdown, notes, unknown). */
export function langOf(path: string): Lang | null {
  const name = path.split("/").pop() ?? "";
  if (name === "Makefile" || name === "Dockerfile") return SHELL;
  const dot = name.lastIndexOf(".");
  return dot < 0 ? null : BY_EXT[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** A line this long is a minified bundle; scanning it buys nothing and costs a stall. */
const SCAN_MAX = 2000;

const isWord = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
const isStart = (c: string): boolean => /[A-Za-z_$]/.test(c);

/** One line. `inBlock` is whether a block comment carried in; the answer says whether one carries out. */
function scan(line: string, lang: Lang, inBlock: boolean): { tokens: Token[]; inBlock: boolean } {
  const out: Token[] = [];
  const push = (text: string, kind: TokenKind): void => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text; else out.push({ text, kind });
  };
  let i = 0;
  while (i < line.length) {
    if (inBlock) {
      const end = line.indexOf("*/", i);
      if (end < 0) { push(line.slice(i), "comment"); return { tokens: out, inBlock: true }; }
      push(line.slice(i, end + 2), "comment");
      i = end + 2; inBlock = false;
      continue;
    }
    const c = line.charAt(i);
    if (lang.block && line.startsWith("/*", i)) { inBlock = true; push("/*", "comment"); i += 2; continue; }
    const opener = lang.line.find((o) => line.startsWith(o, i));
    if (opener) { push(line.slice(i), "comment"); break; }
    if (lang.quotes.includes(c)) {
      let j = i + 1;
      while (j < line.length && line.charAt(j) !== c) j += line.charAt(j) === "\\" ? 2 : 1;
      push(line.slice(i, Math.min(j + 1, line.length)), "string");
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) && (i === 0 || !isWord(line.charAt(i - 1)))) {
      let j = i + 1;
      while (j < line.length && /[0-9A-Za-z_.]/.test(line.charAt(j))) j++;
      push(line.slice(i, j), "number");
      i = j;
      continue;
    }
    if (isStart(c)) {
      let j = i + 1;
      while (j < line.length && isWord(line.charAt(j))) j++;
      const word = line.slice(i, j);
      push(word, lang.keywords.has(word) ? "keyword" : line.charAt(j) === "(" ? "call" : "plain");
      i = j;
      continue;
    }
    push(c, "plain");
    i++;
  }
  return { tokens: out, inBlock };
}

/** The file as lines of tokens. Plain text is one token a line, so the caller draws one way. */
export function highlight(lines: readonly string[], path: string): Token[][] {
  const lang = langOf(path);
  let inBlock = false;
  return lines.map((line) => {
    if (!lang || line.length > SCAN_MAX) return line ? [{ text: line, kind: "plain" as const }] : [];
    const r = scan(line, lang, inBlock);
    inBlock = r.inBlock;
    return r.tokens;
  });
}

export interface Seg { text: string; kind: TokenKind; mark?: "hit" | "current" }
export interface Mark { at: number; len: number; current: boolean }

/** A line's tokens cut at the edges of find matches, so a match keeps its
 *  syntax colour and gains a background. Marks are in order and do not overlap
 *  (`findMatches` steps past each one). */
export function withMarks(tokens: readonly Token[], marks: readonly Mark[]): Seg[] {
  if (!marks.length) return tokens.slice();
  const out: Seg[] = [];
  let pos = 0, m = 0;
  for (const t of tokens) {
    let from = 0;
    while (from < t.text.length) {
      const mk = marks[m];
      const start = pos + from;
      if (!mk || mk.at >= pos + t.text.length) { out.push({ text: t.text.slice(from), kind: t.kind }); break; }
      if (mk.at > start) { out.push({ text: t.text.slice(from, mk.at - pos), kind: t.kind }); from = mk.at - pos; continue; }
      const to = Math.min(mk.at + mk.len - pos, t.text.length);
      out.push({ text: t.text.slice(from, to), kind: t.kind, mark: mk.current ? "current" : "hit" });
      from = to;
      if (pos + to >= mk.at + mk.len) m++;
    }
    pos += t.text.length;
  }
  return out;
}

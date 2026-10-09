/*
 * What the finder's centre pane does with a file, decided once.
 *
 * Opening a result used to be a decision made in App: prose to the reader, the
 * rest thrown at a bench tab — so looking at a `.py` in a search result cost you
 * the search. The finder now shows every file itself and the bench is a button.
 * The question "how is this shown, and which actions make sense" has one answer
 * here so the pane, the info rail and the tests cannot disagree about it.
 */
import type { PreviewKind } from "../../../shared/types.ts";

export type ViewerKind = "markdown" | "code" | "html" | "image" | "pdf" | "video" | "audio" | "binary" | "dir";

const MARKDOWN = /\.(md|markdown|mdx)$/i;
const HTML = /\.html?$/i;

/** How to show a file. The name decides for prose and pages (a `.md` is a
 *  document however the server sniffed it); the server's own reading of the
 *  bytes decides the rest. `factsKind` is absent until facts arrive, and then
 *  the name alone is the best guess. */
export function viewerKind(name: string, factsKind?: PreviewKind): ViewerKind {
  if (factsKind === "dir") return "dir";
  if (factsKind === "image" || factsKind === "image-convert") return "image";
  if (factsKind === "pdf" || factsKind === "video" || factsKind === "audio") return factsKind;
  if (factsKind === "binary") return "binary";
  if (MARKDOWN.test(name)) return "markdown";
  if (HTML.test(name)) return "html";
  return "code";
}

export interface ViewerActions {
  /** "To the bench" — a text file can be edited there; a picture cannot. */
  bench: boolean;
  /** "Open in browser" — pages, pictures and PDFs, as `canOpenInBrowser` says. */
  browser: boolean;
}

export function viewerActions(kind: ViewerKind): ViewerActions {
  return {
    bench: kind === "markdown" || kind === "code" || kind === "html",
    browser: kind === "html" || kind === "image" || kind === "pdf",
  };
}

/* ------------------------------------------------------------------ outline */

export interface OutlineItem { label: string; line: number; level: number }

const DEFS: Record<string, RegExp> = {
  py: /^(\s*)(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/,
  ts: /^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  go: /^()(?:func(?:\s+\([^)]*\))?|type)\s+([A-Za-z_]\w*)/,
  rs: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl)\s+([A-Za-z_]\w*)/,
  sh: /^()(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/,
};
const FAMILY: Record<string, string> = {
  py: "py", ts: "ts", tsx: "ts", js: "ts", jsx: "ts", mjs: "ts", cjs: "ts", go: "go", rs: "rs", sh: "sh", bash: "sh", zsh: "sh",
};

/** What a file is made of, to jump to: a document's headings, a program's
 *  definitions. Read from the text with a line regexp per language family, not
 *  parsed — it is a table of contents, and a wrong nesting is cheaper than a
 *  parser per language. Fenced code in markdown is skipped: a `# comment` in a
 *  shell block is not a heading. */
export function outline(text: string, kind: ViewerKind, name: string): OutlineItem[] {
  const lines = text.split("\n");
  const out: OutlineItem[] = [];
  if (kind === "markdown") {
    let fence = "";
    lines.forEach((l, i) => {
      const f = /^\s*(```+|~~~+)/.exec(l);
      if (f) { fence = fence ? (l.trim().startsWith(fence.slice(0, 3)) ? "" : fence) : f[1]!; return; }
      if (fence) return;
      const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
      if (h) out.push({ label: h[2]!, line: i + 1, level: h[1]!.length });
    });
    return out;
  }
  const re = DEFS[FAMILY[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? ""];
  if (!re) return out;
  lines.forEach((l, i) => {
    const m = re.exec(l);
    if (m) out.push({ label: m[2]!, line: i + 1, level: 1 + Math.min(3, Math.floor((m[1] ?? "").replace(/\t/g, "    ").length / 4)) });
  });
  return out;
}

/* --------------------------------------------------------------- type label */

const TYPES: Record<string, string> = {
  py: "Python", ts: "TypeScript", tsx: "TypeScript (JSX)", js: "JavaScript", jsx: "JavaScript (JSX)", mjs: "JavaScript", cjs: "JavaScript",
  md: "Markdown", markdown: "Markdown", mdx: "MDX", html: "HTML", htm: "HTML", css: "CSS", scss: "SCSS", json: "JSON", jsonc: "JSON",
  yml: "YAML", yaml: "YAML", toml: "TOML", xml: "XML", csv: "CSV", sql: "SQL", sh: "Shell", bash: "Shell", zsh: "Shell", go: "Go",
  rs: "Rust", rb: "Ruby", java: "Java", c: "C", h: "C header", cpp: "C++", txt: "Plain text", svg: "SVG image", pdf: "PDF document",
  png: "PNG image", jpg: "JPEG image", jpeg: "JPEG image", gif: "GIF image", webp: "WebP image", heic: "HEIC image",
};

/** What the FILE block of the rail calls the type: a language or format by
 *  extension, and for text the encoding, which is only ever UTF-8 here because
 *  the server reads it that way. Falls back to the sniffed MIME, then "File". */
export function typeLabel(name: string, kind: ViewerKind | null, mime = ""): string {
  const dot = name.lastIndexOf(".");
  const named = dot > 0 ? TYPES[name.slice(dot + 1).toLowerCase()] : name === "Makefile" ? "Makefile" : name === "Dockerfile" ? "Dockerfile" : undefined;
  const base = named ?? (mime.split(";")[0] || (kind === "dir" ? "Folder" : "File"));
  return kind === "markdown" || kind === "code" || kind === "html" ? `${base} \u00b7 UTF-8` : base;
}

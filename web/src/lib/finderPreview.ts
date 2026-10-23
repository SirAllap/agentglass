/*
 * What the Machine tab's preview panel does with a file, decided once and
 * testable: which viewer, which tabs, and the limits that keep a big file from
 * taking the pane with it.
 */
import type { PreviewKind } from "../../../shared/types.ts";

export type Viewer = "markdown" | "code" | "html" | "json" | "image" | "convert" | "pdf" | "audio" | "video" | "binary";
export type PreviewTab = "Reading" | "Source" | "Rendered" | "Tree" | "Graph";
/** What a tab shows, for the ones named by what they show rather than how. */

/** An HTML page is drawn in a frame up to this size. Past it the panel says so
 *  above the Source tab instead of handing the frame a file that stalls it. */
export const HTML_RENDER_MAX_BYTES = 16 * 1024 * 1024;
/** What the JSON tabs read: the tree is cheap per row, so it takes more than the graph. */
export const JSON_READ_CAP = 8 * 1024 * 1024;
/** The graph lays out every node, so it is for JSON under about a megabyte. */
export const GRAPH_MAX_BYTES = 1024 * 1024;
/** Lines drawn in the reading view. A wrapped line is several rows tall, so a
 *  few thousand is already many screens; the rest is one key away in nvim. */
export const READ_LINES = 2000;
/** Lines coloured. Tokenising more blocks the frame the selection changed in. */
export const COLOUR_LINES = 1500;

export const htmlRenderable = (bytes: number): boolean => bytes <= HTML_RENDER_MAX_BYTES;
export const graphAllowed = (bytes: number): boolean => bytes <= GRAPH_MAX_BYTES;

export function previewPlan(f: { name: string; kind: PreviewKind; bytes: number }): { viewer: Viewer; tabs: PreviewTab[] } {
  switch (f.kind) {
    case "image": return { viewer: "image", tabs: [] };
    case "image-convert": return { viewer: "convert", tabs: [] };
    case "pdf": case "audio": case "video": return { viewer: f.kind, tabs: [] };
    case "text": {
      const n = f.name.toLowerCase();
      if (/\.(md|markdown|mdx)$/.test(n)) return { viewer: "markdown", tabs: ["Rendered", "Source"] };
      if (/\.html?$/.test(n)) return { viewer: "html", tabs: ["Source", "Rendered"] };
      if (n.endsWith(".json")) return { viewer: "json", tabs: ["Reading", "Tree", "Graph"] };
      return { viewer: "code", tabs: ["Reading"] };
    }
    default: return { viewer: "binary", tabs: [] };
  }
}

/** The first `max` lines of a text, and how many were left. A trailing newline is not a line. */
export function readWindow(text: string, max: number): { lines: string[]; more: number } {
  const all = text.replace(/\n$/, "").split("\n");
  return { lines: all.slice(0, max), more: Math.max(0, all.length - max) };
}

/** The policy a rendered page is held to inside its frame, on top of `sandbox=""`:
 *  styles and pictures it carries in itself, nothing it has to fetch. */
export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/** The page as the frame is given it: a CSP meta first, after the doctype and
 *  `<head>` if there are any (before a doctype it would put the page in quirks
 *  mode). With the sandbox this is what makes "no scripts, no network" true in
 *  every host, not only where the app's own header policy happens to say it. */
export function isolatedDoc(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + meta + html.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return html.slice(0, doctype[0].length) + meta + html.slice(doctype[0].length);
  return meta + html;
}

/** Strata: a plain click on a file while the preview is closed opens it again. A folder opens as a column, and a modified click is a selection. */
export function reopensPreview(o: { open: boolean; folder: boolean; modified: boolean }): boolean {
  return !o.open && !o.folder && !o.modified;
}

/** The order of a markdown table's rows after a header click: numbers as numbers, text by locale, empty cells last. Returns indexes into `cells` (one text per row). */
export function sortedOrder(cells: readonly string[], dir: "asc" | "desc"): number[] {
  const num = (s: string) => (/^\s*[-+]?\d+(\.\d+)?\s*([kKMG]?B)?\s*$/.test(s) ? parseFloat(s) : NaN);
  const idx = cells.map((_, i) => i);
  idx.sort((a, b) => {
    const x = cells[a]!.trim(), y = cells[b]!.trim();
    if (!x || !y) return x === y ? a - b : !x ? 1 : -1;
    const nx = num(x), ny = num(y);
    const c = !isNaN(nx) && !isNaN(ny) ? nx - ny : x.localeCompare(y);
    return (dir === "asc" ? c : -c) || a - b;
  });
  return idx;
}

/** The reading column's width in characters for text and markdown, or the whole pane. The old palette's 66 / 80 / 100 / Full. */
export const READ_WIDTHS = [66, 80, 100, "full"] as const;
export type ReadWidth = (typeof READ_WIDTHS)[number];
export const READ_WIDTH_DEFAULT: ReadWidth = 80;

export const readWidthOf = (v: unknown): ReadWidth => (READ_WIDTHS as readonly unknown[]).includes(v) ? (v as ReadWidth) : READ_WIDTH_DEFAULT;
/** The next width when the control is pressed, wrapping round. */
export const nextReadWidth = (w: ReadWidth): ReadWidth => READ_WIDTHS[(READ_WIDTHS.indexOf(w) + 1) % READ_WIDTHS.length]!;
/** CSS max-width for the column; Full has none. */
export const readMaxWidth = (w: ReadWidth): string => (w === "full" ? "none" : `${w}ch`);
export const readWidthLabel = (w: ReadWidth): string => (w === "full" ? "Full" : String(w));

/** How the header's preview toggle looks: always at full strength (a dimmed one was the only way back and could not be seen), lit when the panel is open and outlined when it is closed. */
export const toggleLook = (open: boolean): { opacity: number; background?: string; border: string } => open
  ? { opacity: 1, background: "color-mix(in srgb, var(--primary) 16%, transparent)", border: "1px solid transparent" }
  : { opacity: 1, border: "1px solid color-mix(in srgb, var(--text) 28%, transparent)" };

/** A GIF animates by itself in an <img>; "Autoplay media previews" off has to hold it on its first frame. */
export const isGif = (name: string): boolean => /\.gif$/i.test(name) && name.length > 4;

/** The view a file opens on: for a document with a rendered view, the one "Render documents by default" says; otherwise the plan's first. */
export function defaultTab(tabs: readonly PreviewTab[], renderDocs: boolean): PreviewTab {
  if (tabs.includes("Rendered") && tabs.includes("Source")) return renderDocs ? "Rendered" : "Source";
  return tabs[0] ?? "Reading";
}

const NAME_WORDS = new Set("secret secrets token tokens password passwords passwd credential credentials apikey apikeys htpasswd netrc pgpass pypirc keystore".split(" "));
const NAME_EXT = new Set(["pem", "key", "p12", "pfx", "jks", "keystore", "kdbx", "gpg"]);
const NAME_PAIRS = new Set("api key,private key,access key,secret key,auth key,ssh key".split(","));
const NAME_EXACT = new Set(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".envrc", ".git-credentials", ".dockercfg"]);

/**
 * Whether a file's NAME says it may hold a secret, so the preview asks before it reads the content: the
 * name is the only thing known before the file is opened, and a preview that has to be asked is a
 * preview that never put a key on a screen somebody is sharing. A name, not a scan: `tokenizer.py` is
 * not `tokens.json` (words are whole words between `.`, `_`, `-` and spaces), a public key (`.pub`) and
 * `.env.example` carry nothing. It errs towards asking: Show is one click.
 */
export function looksSecret(name: string): boolean {
  const n = name.toLowerCase();
  if (NAME_EXACT.has(n)) return true;
  if (n === ".env" || (n.startsWith(".env.") && !/\.(example|sample|template|dist)$/.test(n))) return true;
  const dot = n.lastIndexOf(".");
  if (dot > 0 && NAME_EXT.has(n.slice(dot + 1))) return true;
  const words = n.replace(/^\.+/, "").split(/[._\-\s]+/).filter(Boolean);
  if (words.some((w) => NAME_WORDS.has(w))) return true;
  for (let i = 0; i + 1 < words.length; i++) if (NAME_PAIRS.has(`${words[i]} ${words[i + 1]}`)) return true;
  return false;
}

/** Whether a Markdown text has a raw HTML tag in it, which the rendered view shows as inert text: the note says so only then. A tag is `<name ...>` or `</name>`; `a < b` and an autolink `<https://x>` are not. */
export const hasRawHtml = (text: string | undefined): boolean => !!text && /<\/?[a-zA-Z][a-zA-Z0-9-]*(\s[^<>\n]*)?\/?>/.test(text);

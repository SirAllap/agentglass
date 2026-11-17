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

/*
 * The pictures a rendered page keeps beside itself.
 *
 * The frame may fetch nothing, so `<img src="01-shot.png">` drew as its alt
 * text: a report written as one page plus the screenshots next to it showed
 * no screenshot at all. The frame stays as closed as it was. The app, which
 * may already read that folder, reads the pictures and hands them to the page
 * as `data:` URIs, the one image source the policy above allows.
 *
 * Ceiling: `<img src>` only (no `srcset`, no CSS `url()`), files in the page's
 * own folder or below it, and the caps below. A picture past a cap, outside
 * the folder, or on the network keeps its alt text.
 */
export const PAGE_IMAGE_MAX = 40;
export const PAGE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const PAGE_IMAGES_TOTAL_BYTES = 32 * 1024 * 1024;

const IMG_SRC = /(<img\b[^>]*?\ssrc\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;

/** A page's `src` as a path under the page's own folder, or null: anything with a scheme, an absolute path, or a climb out of the folder is not ours to read. */
export function siblingPath(pagePath: string, src: string): string | null {
  const raw = src.split(/[?#]/)[0] ?? "";
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("/") || raw.startsWith("\\")) return null;
  let rel: string;
  try { rel = decodeURIComponent(raw); } catch { return null; }
  const out: string[] = [];
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    out.push(part);
  }
  if (!out.length) return null;
  const dir = pagePath.slice(0, pagePath.lastIndexOf("/"));
  return `${dir}/${out.join("/")}`;
}

/** The distinct picture sources of a page that sit beside it, in page order, capped. */
export function pageImages(html: string, pagePath: string): { src: string; path: string }[] {
  const seen = new Map<string, string>();
  for (const m of html.matchAll(IMG_SRC)) {
    const src = m[2] ?? m[3] ?? "";
    if (seen.has(src)) continue;
    const path = siblingPath(pagePath, src);
    if (path) seen.set(src, path);
    if (seen.size >= PAGE_IMAGE_MAX) break;
  }
  return [...seen].map(([src, path]) => ({ src, path }));
}

/** The page with each read picture in place of its file name; a source with no entry is left as written. */
export function withPageImages(html: string, data: ReadonlyMap<string, string>): string {
  return html.replace(IMG_SRC, (all, lead: string, a?: string, b?: string) => {
    const uri = data.get(a ?? b ?? "");
    return uri ? `${lead}"${uri}"` : all;
  });
}

/*
 * A page with its pictures in place is one string, and a heavy one: 22
 * screenshots of 0.6 MB beside a page are about 18 MB of base64 in the frame's
 * `srcdoc`, and the frame decodes every one at full size (the widest measured
 * 4774 by 1072, about 5 megapixels) to show it in a pane a fraction as wide.
 * It was rebuilt from 22 fetches each time the page was selected, and a
 * selection that had already moved on did not stop the reads.
 *
 * The frame's policy is `img-src data:` and stays that: a `blob:` URL would
 * mean widening it. So the string is made lighter and made once:
 *  - a large raster picture is drawn down to PAGE_IMAGE_EDGE before it is
 *    inlined, in its own format;
 *  - the finished page is kept, the last one only, for PAGE_MEMO_MS;
 *  - the reads are few at a time and stop when the selection leaves.
 *
 * Ceilings, chosen: one page is kept, so going between two pages rebuilds
 * both; the key is the PAGE's time and size, so a picture replaced beside an
 * unchanged page shows its old self until PAGE_MEMO_MS passes; an animated
 * GIF and an SVG are never drawn down.
 */
/** The longest side a page's picture is inlined at. Wider than any preview pane at 2x. */
export const PAGE_IMAGE_EDGE = 2000;
/** Under this a picture is inlined as it is: drawing it down would cost a decode to save little. */
export const PAGE_IMAGE_SHRINK_MIN_BYTES = 200 * 1024;
/** Pictures read at once for one page. */
export const PAGE_IMAGE_PARALLEL = 3;
/** How long the last built page is believed. */
export const PAGE_MEMO_MS = 2 * 60_000;
/** The page's text is on screen this long before its pictures start to be read. */
export const PAGE_IMAGES_AFTER_MS = 60;

/** The format a page's picture is drawn down in, or null when it is inlined as it is. */
export function pageImageShrink(mime: string, bytes: number): { type: string; quality?: number } | null {
  if (bytes < PAGE_IMAGE_SHRINK_MIN_BYTES) return null;
  if (mime === "image/png") return { type: "image/png" };
  if (mime === "image/jpeg") return { type: "image/jpeg", quality: 0.85 };
  if (mime === "image/webp") return { type: "image/webp", quality: 0.9 };
  return null;
}

/** Changes when the page file does. */
export function pageDocKey(path: string, mtime: number, bytes: number): string {
  return `${mtime}|${bytes}|${path}`;
}

/** The last built page, and only that one, while it is fresh. */
export function makePageMemo(ttl = PAGE_MEMO_MS) {
  let held: { key: string; doc: string; at: number } | null = null;
  return {
    get(key: string, now: number): string | undefined {
      if (!held || held.key !== key) return undefined;
      if (now - held.at > ttl) { held = null; return undefined; }
      return held.doc;
    },
    set(key: string, doc: string, now: number): void { held = { key, doc, at: now }; },
  };
}

/*
 * A selection that is passing through is not previewed. Holding an arrow key
 * down a folder of 22 screenshots asked for the facts of each one and then
 * mounted its picture: 22 whole files of 0.6 MB fetched and decoded at up to
 * 5 megapixels, each thrown away by the next key repeat (about 30 ms later).
 * A click, or one key press, is not held back: it waits only when the one
 * before it was this recent.
 */
/** Shorter than a person notices after a key is let go; longer than a key repeat. */
export const PREVIEW_SETTLE_MS = 110;
/** How long a new selection waits before its preview is read, given how long ago the last one was. */
export function previewWait(sinceLastMs: number): number {
  return sinceLastMs >= 0 && sinceLastMs < PREVIEW_SETTLE_MS ? PREVIEW_SETTLE_MS : 0;
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

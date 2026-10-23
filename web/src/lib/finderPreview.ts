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

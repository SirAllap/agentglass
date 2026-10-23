/*
 * The JSON tabs of the Machine preview: a tree you can fold and search, and a
 * graph of nodes. Both are decisions about data, so they live here and are
 * tested; the components only draw what these return. Own code, no dependency:
 * a viewer for a file the finder never edits does not earn a library.
 */

export type JsonKind = "object" | "array" | "string" | "number" | "boolean" | "null";
export const kindOfJson = (v: unknown): JsonKind =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v === "string" ? "string" : typeof v === "number" ? "number" : "boolean";

const IDENT = /^[A-Za-z_$][\w$]*$/;
/** `$.files[3].path`: what a person pastes into jq or a test. */
export function jsonPath(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  return IDENT.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

export const elide = (s: string, n: number): string => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);
const childrenOf = (v: unknown): [string | number, unknown][] =>
  Array.isArray(v) ? v.map((x, i) => [i, x] as [number, unknown]) : v && typeof v === "object" ? Object.entries(v as object) : [];
const summaryOf = (v: unknown): string => {
  const n = Array.isArray(v) ? v.length : Object.keys(v as object).length;
  return n === 0 ? "empty" : Array.isArray(v) ? `${n} ${n === 1 ? "item" : "items"}` : `${n} ${n === 1 ? "key" : "keys"}`;
};

/* ------------------------------------------------------------------- tree */

export interface TreeRow {
  path: string;
  depth: number;
  key: string | number | null;
  kind: JsonKind | "more";
  /** Containers: "3 keys". */
  summary?: string;
  /** Primitives: what to show. Strings are quoted and long ones are cut. */
  text?: string;
  open: boolean;
  hasKids: boolean;
  /** On a "more" row: how many entries this page left. */
  more?: number;
}

/** The rows on screen: only what is expanded, a page of any one container. */
export function visibleRows(root: unknown, expanded: ReadonlySet<string>, page = 200): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (v: unknown, key: string | number | null, path: string, depth: number) => {
    const kind = kindOfJson(v);
    if (kind === "object" || kind === "array") {
      const kids = childrenOf(v);
      const open = expanded.has(path) && kids.length > 0;
      out.push({ path, depth, key, kind, summary: summaryOf(v), open, hasKids: kids.length > 0 });
      if (!open) return;
      for (const [k, c] of kids.slice(0, page)) walk(c, k, jsonPath(path, k), depth + 1);
      if (kids.length > page) out.push({ path: `${path}#more`, depth: depth + 1, key: null, kind: "more", open: false, hasKids: false, more: kids.length - page });
    } else {
      const text = kind === "string" ? JSON.stringify(elide(v as string, 300)) : String(v);
      out.push({ path, depth, key, kind, text, open: false, hasKids: false });
    }
  };
  walk(root, null, "$", 0);
  return out;
}

/** Every node whose key or value contains the needle, and the folds that hold them. */
export function searchTree(root: unknown, needle: string, limit = 2000): { paths: Set<string>; open: Set<string> } {
  const paths = new Set<string>(), open = new Set<string>();
  const n = needle.trim().toLowerCase();
  if (!n) return { paths, open };
  let seen = 0;
  const walk = (v: unknown, key: string | number | null, path: string, trail: string[]): boolean => {
    if (++seen > 50_000 || paths.size >= limit) return false;
    const kind = kindOfJson(v);
    let hit = key !== null && String(key).toLowerCase().includes(n);
    let below = false;
    if (kind === "object" || kind === "array") {
      for (const [k, c] of childrenOf(v)) if (walk(c, k, jsonPath(path, k), [...trail, path])) below = true;
      if (below) open.add(path);
    } else if (String(v).toLowerCase().includes(n)) hit = true;
    if (hit) { paths.add(path); for (const t of trail) open.add(t); }
    return hit || below;
  };
  walk(root, null, "$", []);
  return { paths, open };
}

/* ------------------------------------------------------------------ graph */

export interface GraphNode { id: number; title: string; rows: string[]; x: number; y: number; w: number; h: number }
export interface Graph { nodes: GraphNode[]; edges: { from: number; to: number }[]; width: number; height: number; maxW: number; maxNodes: number; omitted: number }

const PAD = 10, TITLE_H = 24, ROW_H = 16, GAP_X = 56, GAP_Y = 14, MAX_W = 300, MAX_NODES = 300;

/**
 * Objects and arrays become boxes sized to their own text; what they nest
 * becomes a box to the right, joined by an edge. A value is cut to 28 characters
 * inside its box, so one long string cannot make a box a screen wide. The
 * drawing is capped at MAX_NODES boxes, breadth first, and says what it left.
 */
export function graphLayout(root: unknown, measure: (text: string) => number): Graph {
  interface Draft { node: GraphNode; kids: Draft[]; depth: number }
  const total = (v: unknown): number => { const k = kindOfJson(v); return k === "object" || k === "array" ? 1 + childrenOf(v).reduce((s, [, c]) => s + total(c), 0) : 0; };
  const all = total(root);
  const make = (v: unknown, title: string, id: number): GraphNode => {
    const kind = kindOfJson(v);
    const rows = kind === "object" || kind === "array"
      ? childrenOf(v).filter(([, c]) => { const k = kindOfJson(c); return k !== "object" && k !== "array"; })
        .map(([k, c]) => `${elide(String(k), 18)}: ${elide(typeof c === "string" ? c : String(c), 28)}`)
      : [elide(typeof v === "string" ? v : String(v), 28)];
    const shown = rows.length || kind === "object" || kind === "array" ? rows : [""];
    if (shown.length === 0) {
      const n = kind === "array" ? (v as unknown[]).length : kind === "object" ? Object.keys(v as object).length : 0;
      shown.push(n === 0 ? (kind === "array" ? "[]" : "{}") : `${n} ${kind === "array" ? "items" : "keys"} below`);
    }
    const w = Math.min(MAX_W, Math.ceil(Math.max(measure(title), ...shown.map(measure))) + PAD * 2);
    return { id, title, rows: shown, x: 0, y: 0, w, h: TITLE_H + shown.length * ROW_H + 4 };
  };
  const rootKind = kindOfJson(root);
  const rootTitle = rootKind === "array" ? `root [${(root as unknown[]).length}]` : "root";
  const drafts: Draft[] = [{ node: make(root, rootTitle, 0), kids: [], depth: 0 }];
  const queue: { d: Draft; v: unknown }[] = [{ d: drafts[0]!, v: root }];
  for (let q = 0; q < queue.length && drafts.length < MAX_NODES; q++) {
    const { d, v } = queue[q]!;
    for (const [k, c] of childrenOf(v)) {
      const ck = kindOfJson(c);
      if ((ck !== "object" && ck !== "array") || drafts.length >= MAX_NODES) continue;
      const title = ck === "array" ? `${elide(String(k), 18)} [${(c as unknown[]).length}]` : elide(String(k), 18);
      const kid: Draft = { node: make(c, title, drafts.length), kids: [], depth: d.depth + 1 };
      drafts.push(kid); d.kids.push(kid); queue.push({ d: kid, v: c });
    }
  }
  // Columns by depth.
  const colW: number[] = [];
  for (const d of drafts) colW[d.depth] = Math.max(colW[d.depth] ?? 0, d.node.w);
  const colX: number[] = [];
  colW.forEach((w, i) => { colX[i] = i === 0 ? 0 : colX[i - 1]! + colW[i - 1]! + GAP_X; });
  // Leaves stack, parents centre on their children.
  let cursor = 0;
  const place = (d: Draft) => {
    d.node.x = colX[d.depth]!;
    if (!d.kids.length) { d.node.y = cursor; cursor += d.node.h + GAP_Y; return; }
    d.kids.forEach(place);
    const top = d.kids[0]!.node.y, bottom = d.kids[d.kids.length - 1]!.node.y + d.kids[d.kids.length - 1]!.node.h;
    d.node.y = Math.round((top + bottom) / 2 - d.node.h / 2);
  };
  place(drafts[0]!);
  // A tall parent centred between short children can touch the box above it: push down.
  for (let c = 0; c < colW.length; c++) {
    let floor = -Infinity;
    for (const d of drafts.filter((x) => x.depth === c).sort((a, b) => a.node.y - b.node.y)) {
      if (d.node.y < floor) d.node.y = floor;
      floor = d.node.y + d.node.h + GAP_Y;
    }
  }
  const nodes = drafts.map((d) => d.node);
  const edges = drafts.flatMap((d) => d.kids.map((k) => ({ from: d.node.id, to: k.node.id })));
  const minY = Math.min(...nodes.map((n) => n.y));
  for (const n of nodes) n.y -= minY;
  return {
    nodes, edges, maxW: MAX_W, maxNodes: MAX_NODES, omitted: Math.max(0, all - nodes.length),
    width: Math.max(...nodes.map((n) => n.x + n.w)), height: Math.max(...nodes.map((n) => n.y + n.h)),
  };
}

/** Room around the drawing inside its frame, so a box on the edge is never cut by it. */
export const GRAPH_MARGIN = 12;
/** The frame the graph is drawn in: every box and the whole of its stroke fit inside. */
export function graphFrame(g: Graph): { w: number; h: number } {
  return { w: g.width + GRAPH_MARGIN * 2, h: g.height + GRAPH_MARGIN * 2 };
}

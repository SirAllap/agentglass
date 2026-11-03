// What the Log draws, decided without a DOM: the short time, the ref chips of a
// row, the pick bar's wording, the files of a commit and the little graph of
// its neighbourhood. The components only paint what these return.
import type { GitGraphLine } from "../../../shared/types.ts";
import type { GraphRow } from "./gitGraph.ts";

/** git's "3 hours ago" as the row shows it: "3h". Anything it does not know is returned as it came. */
export function shortAgo(rel: string | undefined): string {
  if (!rel) return "";
  const m = /^(\d+|an?)\s+(second|minute|hour|day|week|month|year)s?\b/.exec(rel.trim());
  if (!m) return /^(now|just now)/.test(rel.trim()) ? "now" : rel;
  const n = /^an?$/.test(m[1]!) ? 1 : Number(m[1]);
  const unit = { second: "s", minute: "m", hour: "h", day: "d", week: "w", month: "mo", year: "y" }[m[2] as "second"];
  return `${n}${unit}`;
}

export type RefKind = "branch" | "current" | "remote" | "tag";
export interface RefChip { kind: RefKind; name: string }

/**
 * `%D` ("HEAD -> main, origin/main, tag: v1.2.0") as one chip per ref.
 * A remote is a name that starts with a known remote and a slash; a local
 * branch may contain slashes too (`fix/login`), so the remotes are passed in.
 * `HEAD` alone (a detached checkout) is dropped: the dock already says so.
 */
export function parseRefs(refs: string | undefined, remotes: readonly string[] = ["origin", "upstream"]): RefChip[] {
  if (!refs) return [];
  const out: RefChip[] = [];
  for (const raw of refs.split(", ")) {
    const r = raw.trim();
    if (!r || r === "HEAD") continue;
    if (r.startsWith("tag: ")) out.push({ kind: "tag", name: r.slice(5) });
    else if (r.startsWith("HEAD -> ")) out.push({ kind: "current", name: r.slice(8) });
    else if (remotes.some((n) => r.startsWith(`${n}/`))) {
      if (!r.endsWith("/HEAD")) out.push({ kind: "remote", name: r });
    } else out.push({ kind: "branch", name: r });
  }
  return out;
}

/** The pick bar's sentence: the picked shas oldest first, the order they are applied in and numbered. */
export function pickedList(picked: ReadonlySet<string>, commits: readonly string[]): string[] {
  return commits.filter((h) => picked.has(h)).reverse();
}

/** Up to `max` shas, then "+N": a pick of forty must not push the buttons off the bar. */
export function pickedLabel(shas: readonly string[], max = 4): string {
  return shas.length <= max ? shas.join(", ") : `${shas.slice(0, max - 1).join(", ")} +${shas.length - (max - 1)}`;
}

/** A path under the repository root, or as it came when it is not under it. */
export function relativePath(root: string, abs: string): string {
  const base = root.endsWith("/") ? root : `${root}/`;
  return abs.startsWith(base) ? abs.slice(base.length) : abs;
}

export const splitPath = (rel: string): { dir: string; name: string } => {
  const at = rel.lastIndexOf("/");
  return at < 0 ? { dir: "", name: rel } : { dir: rel.slice(0, at + 1), name: rel.slice(at + 1) };
};

export const BAR_CELLS = 5;

/** Five cells, green for added and red for deleted in proportion; a side that exists never shows fewer than one cell. */
export function barCells(add: number, del: number): ("a" | "r" | "")[] {
  const total = add + del;
  if (total <= 0) return Array(BAR_CELLS).fill("");
  let a = add > 0 ? Math.max(1, Math.round((add / total) * BAR_CELLS)) : 0;
  let r = del > 0 ? Math.max(1, Math.round((del / total) * BAR_CELLS)) : 0;
  while (a + r > BAR_CELLS) { if (a >= r) a--; else r--; }
  return [...Array(a).fill("a"), ...Array(r).fill("r"), ...Array(BAR_CELLS - a - r).fill("")];
}

export interface FileRow { status: string; dir: string; name: string; add: number; del: number; cells: ("a" | "r" | "")[] }

export function fileRows(root: string, changes: readonly { file_path: string; status?: string; additions: number; deletions: number }[]): FileRow[] {
  return changes.map((c) => {
    const { dir, name } = splitPath(relativePath(root, c.file_path));
    return { status: (c.status ?? "modified")[0]!.toUpperCase(), dir, name, add: c.additions, del: c.deletions, cells: barCells(c.additions, c.deletions) };
  });
}

export const filesTotal = (rows: readonly FileRow[]) => ({
  files: rows.length, add: rows.reduce((n, r) => n + r.add, 0), del: rows.reduce((n, r) => n + r.del, 0),
});

/* ── the neighbourhood of a commit ──────────────────────────────────────── */

export interface MiniDot { x: number; y: number; hash: string; sel: boolean; lane: number }
export interface MiniEdge { x1: number; y1: number; x2: number; y2: number; lane: number }
export interface MiniLabel { x: number; y: number; text: string; lane: number }
export interface MiniCard { w: number; h: number; dots: MiniDot[]; edges: MiniEdge[]; labels: MiniLabel[] }

const LANES_SHOWN = 3;
const REACH = 3;

/** A ref's name as a label: no `HEAD ->`, no remote prefix, tags skipped. */
const labelOf = (refs: string | undefined): string | undefined => {
  const c = parseRefs(refs).find((r) => r.kind === "current" || r.kind === "branch") ?? parseRefs(refs).find((r) => r.kind === "remote");
  return c?.name.replace(/^(origin|upstream)\//, "");
};

/**
 * The selected commit and up to three commits either side of it, drawn old to
 * new left to right, one horizontal track per lane (the first three the window
 * touches). `layout` is the lane of each commit over the whole log. A parent
 * outside the window ends in a stub at the left edge; a lane with no ref in the
 * window carries no label, because a name that is not known is not drawn.
 * Ceiling: a fourth lane in the window is left out.
 */
export function miniCard(lines: readonly GitGraphLine[], layout: ReadonlyMap<string, GraphRow>, hash: string | undefined): MiniCard | null {
  const commits = lines.filter((l) => !!l.hash);
  const at = commits.findIndex((l) => l.hash === hash);
  if (at < 0) return null;
  const win = commits.slice(Math.max(0, at - REACH), at + REACH + 1).reverse(); // oldest first
  const laneOf = (h: string) => layout.get(h)?.dot ?? 0;
  const tracks = [...new Set(win.map((l) => laneOf(l.hash!)))].sort((a, b) => a - b).slice(0, LANES_SHOWN);
  const w = 320, left = 14, right = 306, rowH = 24, top = 16;
  const h = top + (tracks.length - 1) * rowH + 22;
  const step = (right - left - 24) / Math.max(1, win.length - 1);
  const pos = new Map<string, { x: number; y: number; lane: number }>();
  win.forEach((l, i) => {
    const t = tracks.indexOf(laneOf(l.hash!));
    if (t >= 0) pos.set(l.hash!, { x: left + 12 + i * step, y: top + t * rowH, lane: laneOf(l.hash!) });
  });
  const dots: MiniDot[] = [...pos].map(([k, p]) => ({ ...p, hash: k, sel: k === hash }));
  const edges: MiniEdge[] = [];
  for (const l of win) {
    const from = pos.get(l.hash!);
    if (!from) continue;
    (l.parents ?? []).forEach((p, i) => {
      const to = pos.get(p);
      if (to) edges.push({ x1: to.x, y1: to.y, x2: from.x, y2: from.y, lane: i === 0 ? from.lane : to.lane });
      else if (i === 0) edges.push({ x1: left, y1: from.y, x2: from.x, y2: from.y, lane: from.lane });
    });
  }
  const labels: MiniLabel[] = [];
  tracks.forEach((lane, t) => {
    const onLane = win.filter((l) => laneOf(l.hash!) === lane);
    const name = onLane.map((l) => labelOf(l.refs)).find(Boolean);
    if (!name) return;
    const n = onLane.length;
    // The first lane's name sits above its track, the others' below theirs: a bend arrives from above.
    labels.push({ x: left, y: top + t * rowH + (t === 0 ? -7 : 17), lane, text: t === 0 ? name : `${name} · ${n} commit${n === 1 ? "" : "s"}` });
  });
  return { w, h, dots, edges, labels };
}

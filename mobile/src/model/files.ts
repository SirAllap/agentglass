/*
 * The decisions of the Files screen, out of the screen.
 *
 * What a search box should ask the computer, where the hardware Back button
 * goes from each state, what "changed on this branch" lists and how a search
 * hit is cut around its match. None of it needs a renderer, and every one is a
 * thing that goes quietly wrong: a Back that leaves the screen from a file four
 * folders deep, a one-letter grep that matches the checkout, a highlight that
 * starts in the indentation.
 *
 * Read-only throughout: nothing here names a route that writes.
 */
import type { ChangeRow } from "../../../shared/types.ts";

export type SearchMode = "name" | "text" | "recent";

export const SEARCH_MODES: { id: SearchMode; label: string }[] = [
  { id: "name", label: "Name" },
  { id: "text", label: "Text" },
  { id: "recent", label: "Recent" },
];

/** The server's own floor for a content search (`grepFiles`): one letter
 *  matches every file, which is not a result. Said here so the phone does not
 *  send a request it knows comes back empty and then shows "no matches". */
export const TEXT_MIN = 2;

export type SearchPlan =
  | { kind: "idle" }
  | { kind: "short"; says: string }
  | { kind: "find"; path: string }
  | { kind: "grep"; path: string }
  | { kind: "recent"; needle: string };

/** What to ask for the text in the box. Recent asks nothing: it is what this
 *  phone opened, filtered by the same box. */
export function searchPlan(root: string, query: string, mode: SearchMode): SearchPlan {
  const q = query.trim();
  const at = `root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}`;
  if (mode === "recent") return { kind: "recent", needle: q.toLowerCase() };
  if (!q) return { kind: "idle" };
  if (mode === "name") return { kind: "find", path: `/files/find?${at}` };
  if (q.length < TEXT_MIN) return { kind: "short", says: `Type at least ${TEXT_MIN} characters to search inside files.` };
  return { kind: "grep", path: `/files/grep?${at}` };
}

/** Is the box doing anything? Recent shows with an empty box; the others do not. */
export function searching(query: string, mode: SearchMode): boolean {
  return mode === "recent" || query.trim() !== "";
}

// --- paths ---------------------------------------------------------------

export function nameOf(rel: string): string { return rel.split("/").pop() ?? rel; }
/** The folder a file is in; "" is the top of the checkout. */
export function dirOf(rel: string): string { return rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ""; }

export function sizeLabel(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// --- Back ---------------------------------------------------------------

export interface FilesState {
  /** The folder on screen; "" is the top. */
  rel: string;
  /** The file being read. */
  open: string | null;
  /** The file was reached from search results, so Back returns to them. */
  fromSearch: boolean;
  /** The file was opened by a link in (the diff's "Whole file"), so Back goes
   *  straight back to where it came from, not up through folders never visited. */
  arrived: boolean;
  query: string;
  mode: SearchMode;
  /** Find-in-file is showing. */
  finding: boolean;
}

export const START: FilesState = { rel: "", open: null, fromSearch: false, arrived: false, query: "", mode: "name", finding: false };

/**
 * Where the hardware Back button goes, closest first: the find bar, then the
 * file (to the results it came from, or to its folder), then the search, then
 * the parent folder — and only at the top of the checkout does it leave.
 * Null means leave.
 */
export function backTarget(s: FilesState): FilesState | null {
  if (s.finding) return { ...s, finding: false };
  if (s.open !== null && s.arrived) return null;
  if (s.open !== null) return { ...s, open: null, fromSearch: false, arrived: false, rel: s.fromSearch ? s.rel : dirOf(s.open) };
  if (searching(s.query, s.mode)) return { ...s, query: "", mode: "name" };
  if (s.rel !== "") return { ...s, rel: dirOf(s.rel) };
  return null;
}

// --- changed on this branch ---------------------------------------------

export interface Changed {
  /** Relative to the folder Files was opened on: what the tree and the viewer take. */
  path: string;
  /** The checkout it belongs to and the path inside it: what the diff takes. The
   *  two differ when Files was opened on a folder inside a checkout. */
  repoRoot: string;
  repoPath: string;
  status: ChangeRow["status"];
  added: number;
  removed: number;
  /** Not in the working tree any more: it is in a commit on the branch. */
  committed: boolean;
  /** The newest commit that changed it, when `committed`: its diff is the one to open. */
  hash?: string;
}

/**
 * The checkout's changes, working tree first and then what the branch already
 * committed. A file in both is listed once, as the working tree has it — that
 * is the copy on disk. Files can be opened on a folder inside a checkout (a
 * terminal's working directory is often `src/`), so a row is kept when it is at
 * or under that folder and its path is cut to be relative to it.
 */
export function changedFiles(root: string, working: readonly ChangeRow[], committed: readonly ChangeRow[]): Changed[] {
  const out = new Map<string, Changed>();
  for (const [rows, isCommitted] of [[working, false], [committed, true]] as const) {
    for (const r of rows) {
      if (r.ignored) continue;
      const cut = root === r.repoRoot ? "" : root.startsWith(`${r.repoRoot}/`) ? `${root.slice(r.repoRoot.length + 1)}/` : null;
      if (cut === null || !r.path.startsWith(cut)) continue;
      const path = r.path.slice(cut.length);
      if (out.has(path)) continue;
      out.set(path, {
        path, repoRoot: r.repoRoot, repoPath: r.path, status: r.status, added: r.additions, removed: r.deletions,
        committed: isCommitted, hash: isCommitted ? r.commit?.hash : undefined,
      });
    }
  }
  return [...out.values()];
}

/** What the diff screen is opened with for a changed file: the commit's own
 *  diff when the change is already committed, the working tree's otherwise. */
export function diffParams(c: Changed): { root: string; path: string; hash?: string } {
  return c.hash ? { root: c.repoRoot, path: c.repoPath, hash: c.hash } : { root: c.repoRoot, path: c.repoPath };
}

/** The changed files at or below a folder, so a folder's landing lists its own. */
export function changedUnder(list: readonly Changed[], rel: string): Changed[] {
  return rel ? list.filter((c) => c.path.startsWith(`${rel}/`)) : [...list];
}

/** `src/sync · +9 −3 · committed`, or `src/sync · new` for a file git has never seen. */
export function changedLine(c: Changed): string {
  const parts = [dirOf(c.path) || "top of the checkout"];
  if (c.status === "untracked") parts.push("new");
  else {
    parts.push(`+${c.added} −${c.removed}`);
    if (c.committed) parts.push("committed");
  }
  return parts.join(" · ");
}

/** What to say over a file that is one of the changed ones. */
export function changedNote(c: Changed | undefined): string | null {
  if (!c) return null;
  if (c.status === "untracked") return "New, not committed";
  return c.committed ? "Changed on this branch" : "Modified since last commit";
}

// --- search results ------------------------------------------------------

export interface Hit { rel: string; line: number; text: string; at: number; len: number }
export interface HitGroup { rel: string; name: string; dir: string; hits: Hit[] }

/** Hits gathered by file, in the order the server found them. */
export function groupHits(hits: readonly Hit[]): HitGroup[] {
  const by = new Map<string, HitGroup>();
  for (const h of hits) {
    let g = by.get(h.rel);
    if (!g) { g = { rel: h.rel, name: nameOf(h.rel), dir: dirOf(h.rel), hits: [] }; by.set(h.rel, g); }
    g.hits.push(h);
  }
  return [...by.values()];
}

/** `3 matches in 2 files`; `200+ matches` when the server stopped counting. */
export function hitSummary(hits: number, files: number, truncated: boolean): string {
  if (!hits) return "No matches";
  const n = `${hits}${truncated ? "+" : ""} ${hits === 1 && !truncated ? "match" : "matches"}`;
  return `${n} in ${files}${truncated ? "+" : ""} ${files === 1 && !truncated ? "file" : "files"}`;
}

/** The line as three runs, without its indentation, so the match is what a
 *  thumb-width row shows rather than six spaces of leading code. Clamped: a
 *  match the server reports past the end of a line it cut is not an error. */
export function hitParts(h: Pick<Hit, "text" | "at" | "len">): { before: string; match: string; after: string } {
  const lead = h.text.length - h.text.trimStart().length;
  const text = h.text.slice(lead);
  const at = Math.min(Math.max(h.at - lead, 0), text.length);
  const end = Math.min(at + Math.max(h.len, 0), text.length);
  return { before: text.slice(0, at), match: text.slice(at, end), after: text.slice(end) };
}

/** How the name results read: folders (places) first, then files, each by path. */
export function nameResults(files: readonly string[], dirs: readonly string[]): { rel: string; dir: boolean }[] {
  return [
    ...[...dirs].sort().map((rel) => ({ rel, dir: true })),
    ...files.map((rel) => ({ rel, dir: false })),
  ];
}

// --- recents -------------------------------------------------------------

export const RECENT_MAX = 30;

/** This file to the front, once, capped. */
export function remembered(list: readonly string[], rel: string): string[] {
  return [rel, ...list.filter((r) => r !== rel)].slice(0, RECENT_MAX);
}

export function recentMatching(list: readonly string[], needle: string): string[] {
  return needle ? list.filter((r) => r.toLowerCase().includes(needle)) : [...list];
}

// --- find in file --------------------------------------------------------

export interface Found { line: number; at: number; len: number }
export const FIND_MAX = 500;

/** Every case-insensitive match in the lines, in reading order, capped so a
 *  one-letter search in a large file does not build a list nobody steps through. */
export function findMatches(lines: readonly string[], query: string): Found[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const out: Found[] = [];
  for (let line = 0; line < lines.length && out.length < FIND_MAX; line++) {
    const hay = (lines[line] ?? "").toLowerCase();
    for (let at = hay.indexOf(q); at >= 0 && out.length < FIND_MAX; at = hay.indexOf(q, at + q.length)) {
      out.push({ line, at, len: q.length });
    }
  }
  return out;
}

/** Next or previous, round the ends: the last match's "next" is the first. */
export function stepMatch(index: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return 0;
  return (index + dir + count) % count;
}

export function findLabel(index: number, count: number, query: string, cutAt?: number): string {
  if (!query) return "";
  // `cutAt` is the character count the file was cut to: a miss in part of a
  // file is not a miss in the file, and "No match" would say it was.
  if (!count) return cutAt ? `No match in the first ${Math.round(cutAt / 1000)}k` : "No match";
  return `${index + 1} of ${count}${count >= FIND_MAX ? "+" : ""}`;
}

/** The matches gathered by line, for drawing a row without scanning the list. */
export function matchesByLine(found: readonly Found[]): Map<number, Found[]> {
  const out = new Map<number, Found[]>();
  for (const f of found) { const l = out.get(f.line); if (l) l.push(f); else out.set(f.line, [f]); }
  return out;
}

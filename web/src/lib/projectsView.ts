// What the Open projects modal lists: filter, group, flatten, count — pure.
//
// The list is one flat array of fixed-height items (a group header, a project,
// or a one-line "0 of 70 match"), so the window drawn on screen is arithmetic
// (see VirtualList). 130 projects and 13,000 cost the same.
import type { GitRepoRef } from "../../../shared/types.ts";

export type Source =
  | { kind: "all" }
  | { kind: "open" }
  | { kind: "gh" }
  | { kind: "agents" }
  | { kind: "folder"; root: string };

export const SOURCE_ALL: Source = { kind: "all" };

/** How many recently touched projects get their own "Recent" group. */
export const RECENT_MAX = 6;

/** Each whitespace-separated term has to match somewhere in name, path or
 *  branch, so "hdd orbit" finds a path whose two fragments are far apart. */
export const queryTerms = (q: string): string[] => q.trim().toLowerCase().split(/\s+/).filter(Boolean);

export const repoMatches = (r: GitRepoRef, terms: readonly string[]): boolean => {
  if (!terms.length) return true;
  const hay = (r.name + " " + r.root + " " + r.branch).toLowerCase();
  return terms.every((t) => hay.includes(t));
};

/** The added folder a project lives under — the deepest, when folders nest. */
export function folderOf(root: string, folders: readonly string[]): string | null {
  let best: string | null = null;
  for (const f of folders) {
    const d = f.replace(/\/+$/, "");
    if ((root === d || root.startsWith(d + "/")) && (!best || d.length > best.length)) best = d;
  }
  return best;
}

/** The group of projects found on the machine under no added folder. */
export const NOT_LISTED = "Not on your list";

export type GroupKind = "open" | "recent" | "folder" | "elsewhere";
export interface Group {
  key: string;
  kind: GroupKind;
  title: string;
  /** The folder's full path, for the header (folders only). */
  full?: string;
  items: GitRepoRef[];
  /** Projects in the group before the search narrowed it. */
  total: number;
}

export type Item =
  | { t: "head"; g: Group }
  | { t: "row"; r: GitRepoRef; g: Group };

export interface ViewInput {
  repos: readonly GitRepoRef[];
  folders: readonly string[];
  workspaces: readonly string[];
  hidden: readonly string[];
  showHidden: boolean;
  query: string;
  source: Source;
}

const byTouched = (a: GitRepoRef, b: GitRepoRef) => (b.touchedAt || 0) - (a.touchedAt || 0) || a.name.localeCompare(b.name);
const byName = (a: GitRepoRef, b: GitRepoRef) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root);

/**
 * The groups, in reading order. With no search, "Open now" and "Recent" come
 * first and the folders hold the rest, each project exactly once. With a
 * search, every folder is a group so the person sees which were searched, even
 * the ones with no match.
 */
export function buildGroups(v: ViewInput): Group[] {
  const terms = queryTerms(v.query);
  const hide = new Set(v.hidden);
  const isOpen = (r: GitRepoRef) => v.workspaces.includes(r.root);
  // An open project is never hidden by Forgotten: it is ticked, so it needs a row.
  const live = v.repos.filter((r) => v.showHidden || !hide.has(r.root) || isOpen(r));
  const out: Group[] = [];

  const folderGroups = (pool: readonly GitRepoRef[], only?: string): Group[] => {
    const shown = new Map<string, GitRepoRef[]>();
    const totals = new Map<string, number>();
    for (const r of live) {
      const f = folderOf(r.root, v.folders) ?? "";
      totals.set(f, (totals.get(f) ?? 0) + 1);
    }
    for (const r of pool) {
      const f = folderOf(r.root, v.folders) ?? "";
      if (only !== undefined && f !== only) continue;
      (shown.get(f) ?? shown.set(f, []).get(f)!).push(r);
    }
    const keys = only !== undefined ? [only] : [...v.folders.map((f) => f.replace(/\/+$/, "")), ""];
    const seen = new Set<string>();
    const gs: Group[] = [];
    for (const k of keys) {
      if (seen.has(k)) continue;
      seen.add(k);
      const items = (shown.get(k) ?? []).sort(byName);
      const total = totals.get(k) ?? 0;
      // Without a search an empty group is noise; with one it is information.
      if (!items.length && !(terms.length && total)) continue;
      gs.push({ key: "f:" + k, kind: k ? "folder" : "elsewhere", title: k || NOT_LISTED, full: k || undefined, items, total });
    }
    return gs;
  };

  const matching = live.filter((r) => repoMatches(r, terms));
  const s = v.source;
  if (s.kind === "open") {
    const items = matching.filter(isOpen).sort(byName);
    return items.length ? [{ key: "open", kind: "open", title: "Open now", items, total: live.filter(isOpen).length }] : [];
  }
  if (s.kind === "folder") return folderGroups(matching, s.root.replace(/\/+$/, ""));
  if (s.kind !== "all") return [];

  if (terms.length) {
    const open = matching.filter(isOpen).sort(byName);
    if (open.length) out.push({ key: "open", kind: "open", title: "Open now", items: open, total: open.length });
    // Folder groups below still hold the open ones: a search result group that
    // dropped a match because it was also open would miscount "4 of 6".
    return [...out, ...folderGroups(matching)];
  }
  const open = matching.filter(isOpen).sort(byName);
  const rest = matching.filter((r) => !isOpen(r));
  const recent = rest.filter((r) => r.touchedAt > 0).sort(byTouched).slice(0, RECENT_MAX);
  const inRecent = new Set(recent.map((r) => r.root));
  if (open.length) out.push({ key: "open", kind: "open", title: "Open now", items: open, total: open.length });
  if (recent.length) out.push({ key: "recent", kind: "recent", title: "Recent", items: recent, total: recent.length });
  return [...out, ...folderGroups(rest.filter((r) => !inRecent.has(r.root)))];
}

/** The flat list the virtual window draws. */
export function flatten(groups: readonly Group[]): Item[] {
  const out: Item[] = [];
  for (const g of groups) {
    out.push({ t: "head", g });
    for (const r of g.items) out.push({ t: "row", r, g });
  }
  return out;
}

/** Roots of the project rows in reading order — what the arrows walk. */
export const navRoots = (items: readonly Item[]): string[] => items.flatMap((i) => (i.t === "row" ? [i.r.root] : []));

/** A project can show in two groups (Open now and its folder, during a search). */
export const uniqueRoots = (groups: readonly Group[]): string[] => Array.from(new Set(groups.flatMap((g) => g.items.map((r) => r.root))));

/** Index in `items` of the first row with this root, or -1. */
export const indexOfRoot = (items: readonly Item[], root: string | null): number =>
  root ? items.findIndex((i) => i.t === "row" && i.r.root === root) : -1;

/** The rail's numbers. They count what the rail item would list, whatever the search says. */
export function railCounts(repos: readonly GitRepoRef[], folders: readonly string[], workspaces: readonly string[], hidden: readonly string[]) {
  const hide = new Set(hidden);
  const live = repos.filter((r) => !hide.has(r.root) || workspaces.includes(r.root));
  const perFolder: Record<string, number> = {};
  for (const f of folders) perFolder[f] = live.filter((r) => folderOf(r.root, [f]) === f.replace(/\/+$/, "")).length;
  return { all: live.length, open: live.filter((r) => workspaces.includes(r.root)).length, hidden: repos.length - live.length, perFolder };
}

/** "4 of 6 match" / "48 projects" — a group header's count. */
export function groupCount(g: Group, searching: boolean): string {
  if (searching && g.kind !== "open" && g.kind !== "recent") return `${g.items.length} of ${g.total} match`;
  return String(g.items.length);
}

/** Tick every project in a group, or untick them when they are all ticked. */
export function toggleGroup(ticked: readonly string[], g: Group): string[] {
  const roots = g.items.map((r) => r.root);
  const all = roots.every((r) => ticked.includes(r));
  return all ? ticked.filter((t) => !roots.includes(t)) : [...ticked, ...roots.filter((r) => !ticked.includes(r))];
}

const within = (dir: string | null | undefined, root: string) => !!dir && (dir === root || dir.startsWith(root + "/"));

/** Open tmux windows per project: a window counts once for a project when any
 *  of its panes sits in the project or an agent in it worked there. Read from
 *  the panes the app already lists; the server keeps no per-project tab count.
 *  A repo nested inside another repo is counted under both — the ceiling of a
 *  path-prefix match. */
export function tabsByRoot(panes: readonly { windowId: string; path: string; agentCwds?: readonly string[] }[], roots: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const root of roots) {
    const wins = new Set<string>();
    for (const p of panes) if (within(p.path, root) || p.agentCwds?.some((c) => within(c, root))) wins.add(p.windowId);
    if (wins.size) out[root] = wins.size;
  }
  return out;
}

/** Agent sessions per project, from the session list the app already has:
 *  a session belongs to the project it ran in (its checkout, else its root). */
export function sessionsByRoot(rows: readonly { project_path?: string | null; cwd_path?: string | null }[], roots: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const root of roots) {
    const n = rows.filter((s) => within(s.cwd_path, root) || within(s.project_path, root)).length;
    if (n) out[root] = n;
  }
  return out;
}

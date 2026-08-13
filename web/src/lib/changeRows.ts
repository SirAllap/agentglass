/*
 * The Diff view's data: the list, one file's diff, and how rows are grouped.
 *
 * Kept out of the component for the reason the old view proves: the same file
 * held the fetching, the merging, the grouping and 900 lines of JSX, and the
 * bugs that mattered were all in the first three — a poll that could not tell
 * that a file's CONTENT had changed, a merge that dropped rows, a grouping that
 * labelled sections with the literal string "unstaged". None of that needs a DOM
 * to be wrong, so none of it needs a DOM to be tested.
 *
 * Two rules run through everything here:
 *
 *   1. the list is cheap and the body is not, so the list is refreshed freely
 *      and a body is fetched only for the row that is open;
 *   2. nothing is replaced in state unless it actually differs, because this
 *      view sits under a poll and a re-render mid-read moves the diff the reader
 *      is looking at.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.ts";
import { subscribeGitChanged } from "./gitBus.ts";
import type { ChangeRow, ChangeRowsResult, FileDiff } from "../../../shared/types.ts";

export type DiffMode = "working" | "committed";

/**
 * How long after a git event before the list is re-read.
 *
 * A commit fires several of them (index, then HEAD, then the branch), and a
 * rebase fires dozens. Coalescing them into one read is the difference between a
 * refresh and a stampede across nineteen checkouts.
 */
const SETTLE_MS = 250;

/**
 * The safety net, not the mechanism.
 *
 * The server pushes a `git` frame whenever anything changes through the app, and
 * that is what actually keeps this fresh. This interval only covers what no
 * event can: a file saved by an editor, a `git` typed in a terminal outside the
 * app. The old view polled every 4s and paid 1.1 MB for each one; at this size a
 * quiet minute costs four small reads.
 */
const SAFETY_MS = 15_000;

/** True when two lists differ in anything a reader would see. Deliberately
 *  includes the counts and the times: the old view compared ids alone, and since
 *  its id did not depend on content, editing a file with the view open changed
 *  nothing on screen — the list, the numbers and the diff all stayed as they
 *  were until it was closed and reopened. */
export function rowsDiffer(a: ChangeRow[], b: ChangeRow[]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    if (x.key !== y.key || x.changedAt !== y.changedAt || x.additions !== y.additions ||
        x.deletions !== y.deletions || x.staged !== y.staged || x.status !== y.status) return true;
  }
  return false;
}

export type RowsState = {
  rows: ChangeRow[];
  truncated: number;
  failed: string[];
  /** Only before the first answer. A refresh keeps showing what is there —
   *  blanking a list you are reading to say "loading" is worse than a second of
   *  staleness. */
  loading: boolean;
  error: string | null;
};

export function useChangeRows(mode: DiffMode, active: boolean): RowsState & { refresh: () => void } {
  const [state, setState] = useState<RowsState>({ rows: [], truncated: 0, failed: [], loading: true, error: null });
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    if (inFlight.current) return; // a burst of git events is still one read
    inFlight.current = true;
    try {
      const r: ChangeRowsResult = await api.gitChangeRows(mode);
      if (!alive.current) return;
      setState((prev) => ({
        rows: rowsDiffer(prev.rows, r.rows) ? r.rows : prev.rows,
        truncated: r.truncated,
        failed: r.failed ?? [],
        loading: false,
        error: null,
      }));
    } catch (e) {
      if (!alive.current) return;
      setState((prev) => ({ ...prev, loading: false, error: e instanceof Error ? e.message : "could not read git" }));
    } finally {
      inFlight.current = false;
    }
  }, [mode]);

  // Switching mode is a different question, not a refresh of this one.
  useEffect(() => { setState((s) => ({ ...s, loading: true })); }, [mode]);

  useEffect(() => {
    if (!active) return;
    void load();
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = subscribeGitChanged(() => {
      if (t) clearTimeout(t);
      t = setTimeout(() => { void load(); }, SETTLE_MS);
    });
    const iv = setInterval(() => { void load(); }, SAFETY_MS);
    return () => { off(); clearInterval(iv); if (t) clearTimeout(t); };
  }, [active, load]);

  return { ...state, refresh: load };
}

/* ── one file's diff ──────────────────────────────────────────────────────── */

/** Bodies already read, so re-selecting a file paints before the network
 *  answers. Module-level and small: a diff is dropped as soon as its signature
 *  moves, and the map is cleared when it grows past a session's worth. */
const bodies = new Map<string, FileDiff>();
const CACHE_MAX = 60;

export type DiffState = { diff: FileDiff | null; loading: boolean; error: string | null };

export function useFileDiff(row: ChangeRow | null, mode: DiffMode): DiffState {
  const cacheKey = row ? `${mode}\0${row.key}` : "";
  const [state, setState] = useState<DiffState>({ diff: null, loading: false, error: null });

  useEffect(() => {
    if (!row) { setState({ diff: null, loading: false, error: null }); return; }
    let gone = false;
    /* Paint what we already have, then check. The alternative — a spinner on
       every selection — makes walking a list of forty files feel like forty page
       loads, when the answer is usually already in hand. */
    const cached = bodies.get(cacheKey) ?? null;
    setState({ diff: cached, loading: !cached, error: null });

    api.gitFileDiff(row.repoRoot, row.path, mode)
      .then((d) => {
        if (gone) return;
        if (bodies.size > CACHE_MAX) bodies.clear();
        bodies.set(cacheKey, d);
        setState({ diff: d, loading: false, error: d.error ?? null });
      })
      .catch((e) => {
        if (gone) return;
        setState((s) => ({ diff: s.diff, loading: false, error: e instanceof Error ? e.message : "could not read the diff" }));
      });
    return () => { gone = true; };
    // `changedAt` is in the deps on purpose: the same file, changed again, is a
    // different body — and that is exactly the case the old view could not see.
  }, [cacheKey, row?.repoRoot, row?.path, row?.changedAt, mode]);

  return state;
}

/* ── grouping ─────────────────────────────────────────────────────────────── */

export type GroupBy = "worktree" | "time" | "folder";

export type RowGroup = {
  key: string;
  /** What the section is called: a branch, a day, a directory. */
  label: string;
  /** The quieter second line — a folder name, a commit subject. */
  sub?: string;
  rows: ChangeRow[];
  add: number;
  del: number;
};

/**
 * "Today" / "Yesterday" / a weekday / a date.
 *
 * A weekday is how recent work is actually remembered; past a week it stops
 * being unambiguous and only a date is honest. `now` is a parameter so this can
 * be tested without owning the clock.
 */
export function dayLabel(ts: number, now = Date.now()): string {
  if (!ts) return "Unknown";
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const d = new Date(ts);
  const days = Math.round((startOf(new Date(now)) - startOf(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

/**
 * When it changed, in the shape a row has space for: the day, then the clock.
 *
 * The old row showed the time of day alone, so a file changed on Monday read
 * `09:14:02` on Thursday — which, on top of the stamps being the time of the
 * request, is how "the times are wrong" became one complaint instead of two.
 */
export function whenLabel(ts: number, now = Date.now()): string {
  if (!ts) return "—";
  const clock = new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const day = dayLabel(ts, now);
  return day === "Today" ? clock : `${day} ${clock}`;
}

/** The folder a path is in, short enough for a section heading. */
export function folderOf(path: string): string {
  const i = path.lastIndexOf("/");
  if (i <= 0) return "./";
  const dir = path.slice(0, i);
  const segs = dir.split("/");
  return segs.length <= 2 ? dir : "…/" + segs.slice(-2).join("/");
}

/**
 * Sections, in the order the rows arrive — which is newest first, and now means
 * something, because `changedAt` is finally the time the change happened.
 *
 * Grouping by worktree is the default because that is the unit of work here: a
 * checkout per ticket, and the question is almost always "what does this branch
 * have in it". Grouping by time answers the other one — "what did I touch this
 * morning" — and is only usable at all now that the times are real.
 */
export function groupRows(rows: ChangeRow[], by: GroupBy, now = Date.now()): RowGroup[] {
  const map = new Map<string, RowGroup>();
  const order: string[] = [];
  for (const r of rows) {
    let key: string, label: string, sub: string | undefined;
    if (by === "worktree") {
      key = r.repoRoot;
      // The branch is what the work is called; the folder is only where it sits.
      label = r.branch || r.repoRoot.split("/").filter(Boolean).pop() || r.repoRoot;
      sub = r.commit?.subject ?? r.repoRoot.split("/").filter(Boolean).pop();
    } else if (by === "time") {
      const d = new Date(r.changedAt);
      key = r.changedAt ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` : "unknown";
      label = dayLabel(r.changedAt, now);
    } else {
      key = `${r.repoRoot}\0${folderOf(r.path)}`;
      label = folderOf(r.path);
      sub = r.branch || undefined;
    }
    let g = map.get(key);
    if (!g) { g = { key, label, sub, rows: [], add: 0, del: 0 }; map.set(key, g); order.push(key); }
    g.rows.push(r);
    g.add += r.additions;
    g.del += r.deletions;
  }
  return order.map((k) => map.get(k)!);
}

/** The one-word summary a reader needs before the numbers: what happened to this
 *  file. Renames and binaries say so, because the old view showed both as an
 *  empty diff and left the reader to guess. */
export function statusWord(r: ChangeRow): string {
  if (r.status === "renamed") return "renamed";
  if (r.status === "untracked") return "new";
  if (r.status === "deleted") return "deleted";
  if (r.status === "added") return "added";
  if (r.status === "typechange") return "type";
  return r.binary ? "binary" : "";
}

/** Filter by path, case-insensitively, matching the folder as well as the name —
 *  the filter is how a worktree is picked out of nineteen. */
export function filterRows(rows: ChangeRow[], q: string): ChangeRow[] {
  const s = q.trim().toLowerCase();
  if (!s) return rows;
  return rows.filter((r) => r.path.toLowerCase().includes(s) || r.repoRoot.toLowerCase().includes(s) || (r.branch ?? "").toLowerCase().includes(s));
}

/** Rows the reader has asked not to see. Both flags are computed on the server
 *  now, so — unlike before — this actually hides anything. */
export function visibleRows(rows: ChangeRow[], showIgnored: boolean, showOutside: boolean): ChangeRow[] {
  if (showIgnored && showOutside) return rows;
  return rows.filter((r) => (showIgnored || !r.ignored) && (showOutside || !r.outside));
}

/** A stable identity for the reviewed-tick store. The key already is one; this
 *  exists so the storage format has a name and one place to change. */
export const reviewKeyOf = (r: ChangeRow): string => r.key;

/** Everything the header counts, from the SAME list the body renders — the old
 *  header summed a different array from the one on screen, so "N edits · +X −Y"
 *  and the review counter disagreed with the list and sometimes read 12/7. */
export function totalsOf(rows: ChangeRow[], reviewed: ReadonlySet<string>): { files: number; add: number; del: number; done: number } {
  let add = 0, del = 0, done = 0;
  for (const r of rows) {
    add += r.additions;
    del += r.deletions;
    if (reviewed.has(reviewKeyOf(r))) done++;
  }
  return { files: rows.length, add, del, done };
}

/** Convenience for the page: the row a key points at, or null. */
export function rowByKey(rows: ChangeRow[], key: string | null): ChangeRow | null {
  if (!key) return null;
  return rows.find((r) => r.key === key) ?? null;
}

/** Memoised grouping, so a poll that changed nothing does not rebuild sections
 *  and collapse state under the reader. */
export function useGroups(rows: ChangeRow[], by: GroupBy): RowGroup[] {
  return useMemo(() => groupRows(rows, by), [rows, by]);
}

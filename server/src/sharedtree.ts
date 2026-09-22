/**
 * Who is writing into each working tree — and where that is more than one.
 *
 * The Diff view groups its rows by checkout, and when every agent has a
 * worktree of its own that grouping is attribution: the section for
 * `orbit-WEB-1042` is that agent's work and nobody else's. When two agents
 * write into ONE checkout it stops being true without anything on screen
 * changing — the section is both of them, and a file both of them edited has a
 * single on-disk diff that no grouping can split by author. The view would
 * present a confident answer to a question the working tree cannot answer.
 *
 * So this says when it happens, and which files are the ones that cannot be
 * split: the overlap. A tree two sessions wrote to without sharing a file is
 * still flagged — the heading names two authors either way — but only the
 * overlap is genuinely approximate, and the two are reported apart so the
 * screen can be exact about which is which.
 *
 * The tree is decided by where a session WROTE, never by where it stands. An
 * agent commonly runs from the parent repo and reaches into its worktree with
 * absolute paths (see panewt.ts: every process in such a pane reports the
 * parent as its cwd), so "same cwd" would flag every agent in a fleet as
 * sharing the parent while each of them writes only to its own checkout. That
 * is a flag that is always on, which is a flag nobody reads.
 *
 * The ceiling, chosen: only Edit, Write and MultiEdit are counted — the tools
 * whose hooks name the file. A session that changes files through the shell
 * (`sed -i`, a code generator, a formatter) is not seen as an author here.
 */
import { deepest } from "./agentboard.ts";
import { db } from "./db.ts";

export interface TreeEdit { session_id: string; file_path: string; timestamp: number }

export interface TreeAuthors {
  /** The checkout, as git names its top level. */
  root: string;
  branch: string;
  /** The live sessions that wrote into it, newest writer first. One is the
   *  case the grouping is honest about; more than one is the flag. */
  sessions: string[];
  /** Paths, relative to `root`, that more than one of them edited — the files
   *  whose on-disk diff cannot be split by author. Sorted. */
  overlap: string[];
}

/** An id the hook sends when it had none to send. Not an author. */
const NOBODY = new Set(["", "unknown"]);

/**
 * Every checkout a live session wrote into, with its authors.
 *
 * Returned for the single-author trees as well, because that is the other half
 * of the same answer: a section heading that can say "this is what that agent
 * did" is what makes a per-worktree list read as per-agent at all.
 */
export function treeAuthors(
  edits: TreeEdit[],
  trees: { path: string; branch: string }[],
  isLive: (sessionId: string) => boolean,
): TreeAuthors[] {
  const byRoot = new Map<string, { branch: string; files: Map<string, Set<string>>; last: Map<string, number> }>();
  for (const e of edits) {
    if (NOBODY.has(e.session_id) || !isLive(e.session_id)) continue;
    const t = deepest(trees, e.file_path);
    if (!t) continue;
    let r = byRoot.get(t.path);
    if (!r) { r = { branch: t.branch, files: new Map(), last: new Map() }; byRoot.set(t.path, r); }
    const rel = e.file_path.slice(t.path.length + 1);
    let who = r.files.get(rel);
    if (!who) { who = new Set(); r.files.set(rel, who); }
    who.add(e.session_id);
    r.last.set(e.session_id, Math.max(r.last.get(e.session_id) ?? 0, e.timestamp));
  }
  const out: TreeAuthors[] = [];
  for (const [root, r] of byRoot) {
    out.push({
      root,
      branch: r.branch,
      sessions: [...r.last].sort((a, b) => b[1] - a[1]).map(([id]) => id),
      overlap: [...r.files].filter(([, who]) => who.size > 1).map(([f]) => f).sort(),
    });
  }
  return out;
}

/**
 * How long a session stays a live author after it was last heard from, when no
 * pane vouches for it.
 *
 * `ended_at` cannot answer this: it is stamped on every `Stop`, which is the end
 * of every turn, so a session waiting for its next prompt reads as ended. An
 * agent in tmux does not need the window — its pane says it is there — so this
 * only decides for agents running somewhere this app cannot see a pane, and
 * half an hour of silence is where those are more likely gone than thinking.
 */
export const LIVE_MS = 30 * 60_000;

export function liveSessions(
  rollups: { session_id: string; last_seen: number }[],
  paneHeld: Set<string>,
  now = Date.now(),
): Set<string> {
  const out = new Set(paneHeld);
  for (const r of rollups) if (r.last_seen >= now - LIVE_MS) out.add(r.session_id);
  return out;
}

/** The rollup's last-seen for these sessions — the input `liveSessions` wants,
 *  for the handful of ids that wrote something recently, never the table. */
export function lastSeenOf(ids: string[]): { session_id: string; last_seen: number }[] {
  if (!ids.length) return [];
  const holes = ids.map(() => "?").join(",");
  try {
    return db.query<{ session_id: string; last_seen: number }, string[]>(
      `SELECT session_id, last_seen FROM sessions WHERE session_id IN (${holes})`).all(...ids);
  } catch { return []; }
}

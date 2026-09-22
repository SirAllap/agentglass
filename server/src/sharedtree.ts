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
 * The ceilings, chosen:
 *
 *   * only Edit, Write and MultiEdit are counted — the tools whose hooks name
 *     the file. A session that changes files through the shell (`sed -i`, a
 *     code generator, a formatter) is not seen as an author here;
 *   * a pane vouches for an agent only on Linux, where its processes' cwds can
 *     be read (paneloc.ts). Elsewhere an agent quiet for LIVE_MS stops counting
 *     however long its pane stays open;
 *   * a pane note is keyed by pane id alone, and ids are per tmux server, so
 *     a same-numbered pane on a second server with an agent in the same
 *     directory can vouch for the wrong session. Inherited from `paneDirs`.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { deepest } from "./agentboard.ts";
import { db } from "./db.ts";

export interface TreeEdit { session_id: string; file_path: string; timestamp: number }

export interface TreeAuthors {
  /** The checkout, as git names its top level. */
  root: string;
  /** The live sessions that wrote into it, newest writer first. One is the
   *  case the grouping is honest about; more than one is the flag. */
  sessions: string[];
  /** The files, relative to `root`, that more than one of them edited — whose
   *  on-disk diff cannot be split by author — each with exactly the sessions
   *  that edited it, which with three authors is not always all of them. */
  overlap: { path: string; sessions: string[] }[];
}

/** An id the hook sends when it had none to send. Not an author. */
const NOBODY = new Set(["", "unknown"]);

/**
 * Every checkout a live session wrote into, with its authors.
 *
 * Returned for the single-author trees as well, because that is the other half
 * of the same answer: a section heading that can say which agent is writing
 * there is what makes a per-worktree list read as per-agent at all.
 *
 * An edit counts only while its file is still a row in that checkout's section
 * (`onDisk`). Being live is not enough: an agent that edited here, committed,
 * and moved on to a worktree of its own stays live for as long as its pane is
 * open, and the checkout it left read "shared" beside whoever works there now,
 * with none of its changes in the section. Once the file is committed there is
 * nothing of it left to be mixed with anybody's. The ceiling: a file it edited,
 * committed, and somebody else then edited again is a row once more, and still
 * counts it.
 */
export function treeAuthors(
  edits: TreeEdit[],
  trees: { path: string }[],
  isLive: (sessionId: string) => boolean,
  onDisk: (root: string, rel: string) => boolean,
): TreeAuthors[] {
  const byRoot = new Map<string, { files: Map<string, Set<string>>; last: Map<string, number> }>();
  for (const e of edits) {
    if (NOBODY.has(e.session_id) || !isLive(e.session_id)) continue;
    const t = deepest(trees, e.file_path);
    if (!t) continue;
    const rel = e.file_path.slice(t.path.length + 1);
    if (!onDisk(t.path, rel)) continue;
    let r = byRoot.get(t.path);
    if (!r) { r = { files: new Map(), last: new Map() }; byRoot.set(t.path, r); }
    let who = r.files.get(rel);
    if (!who) { who = new Set(); r.files.set(rel, who); }
    who.add(e.session_id);
    r.last.set(e.session_id, Math.max(r.last.get(e.session_id) ?? 0, e.timestamp));
  }
  const out: TreeAuthors[] = [];
  for (const [root, r] of byRoot) {
    const order = [...r.last].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    out.push({
      root,
      sessions: order,
      overlap: [...r.files].filter(([, who]) => who.size > 1)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([path, who]) => ({ path, sessions: order.filter((id) => who.has(id)) })),
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
 * agent in a pane on Linux does not need the window — its pane says it is there
 * — so this decides for the rest, and half an hour of silence is where those
 * are more likely gone than thinking.
 */
export const LIVE_MS = 30 * 60_000;

export interface SessionSeen {
  session_id: string;
  last_seen: number;
  /**
   * It is over, as a fact rather than a guess: its newest event is a
   * `SessionEnd`.
   *
   * That is what `/clear` sends. It ends one session and starts another in the
   * same pane and the same checkout, and without this the one that was cleared
   * stayed "live" for LIVE_MS — so the agent that replaced it, touching the same
   * files, was drawn as a second author sharing the tree with itself.
   *
   * The pane cannot say it instead: `pane_agent` keeps one row per pane, so the
   * new session's note overwrites the old one's and the cleared session is left
   * with no pane at all rather than a pane that names somebody else.
   */
  gone: boolean;
}

export function liveSessions(seen: SessionSeen[], paneHeld: Set<string>, now = Date.now()): Set<string> {
  const out = new Set(paneHeld);
  for (const r of seen) if (!r.gone && r.last_seen >= now - LIVE_MS) out.add(r.session_id);
  return out;
}

/** The sessions heard from inside the window, with whether they have ended.
 *  One indexed range on `sessions`, and a newest-event lookup per row. */
export function recentSessions(now = Date.now()): SessionSeen[] {
  try {
    return db.query<{ session_id: string; last_seen: number; last_type: string | null }, [number]>(`
      SELECT s.session_id, s.last_seen,
        (SELECT e.hook_event_type FROM events e WHERE e.session_id = s.session_id
          ORDER BY e.timestamp DESC, e.id DESC LIMIT 1) AS last_type
      FROM sessions s WHERE s.last_seen >= ?`).all(now - LIVE_MS)
      .map((r) => ({ session_id: r.session_id, last_seen: r.last_seen, gone: r.last_type === "SessionEnd" }));
  } catch { return []; }
}

/**
 * The files these sessions edited, newest first — read for the live sessions
 * themselves, not taken from the Diff list's own "last 300 edits of anybody".
 *
 * That list was the first source, and on a busy fleet it is less than an hour
 * deep: two sessions still sharing a checkout, the mixed file still dirty on
 * disk, and the flag went off because other agents had pushed their edits out
 * of the window. Only the path is read — no hunks, no diff.
 */
export function editsBy(ids: string[], cap = 4000): TreeEdit[] {
  if (!ids.length) return [];
  const holes = ids.map(() => "?").join(",");
  try {
    return db.query<{ session_id: string; timestamp: number; fp: string | null }, (string | number)[]>(`
      SELECT session_id, timestamp,
        COALESCE(json_extract(payload, '$.tool_response.filePath'), json_extract(payload, '$.tool_input.file_path'),
                 json_extract(payload, '$.tool_input.filePath')) AS fp
      FROM events
      WHERE hook_event_type = 'PostToolUse' AND tool_name IN ('Edit','Write','MultiEdit') AND session_id IN (${holes})
      ORDER BY timestamp DESC LIMIT ?`).all(...ids, cap)
      .filter((r): r is typeof r & { fp: string } => typeof r.fp === "string" && r.fp.startsWith("/"))
      .map((r) => ({ session_id: r.session_id, file_path: physical(r.fp), timestamp: r.timestamp }));
  } catch { return []; }
}

/**
 * The path as git will name it.
 *
 * `git rev-parse --show-toplevel` answers with the physical directory, and a
 * hook reports whatever path the agent used — through `~/code` when that is a
 * symlink, through `/tmp` where the system's is `/private/tmp`. Compared as
 * strings the two never meet and the edit is attributed to nothing, silently.
 * The directory is resolved rather than the file, which may have been deleted
 * since, and cached, because the same few directories come up on every poll.
 */
const physicalDirs = new Map<string, string>();
export function physical(path: string): string {
  const dir = dirname(path);
  let real = physicalDirs.get(dir);
  if (real === undefined) {
    try { real = realpathSync(dir); } catch { real = dir; }
    if (physicalDirs.size > 4000) physicalDirs.clear();
    physicalDirs.set(dir, real);
  }
  return real === dir ? path : join(real, basename(path));
}

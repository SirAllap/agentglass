/*
 * How long the terminal's chip keeps believing a worktree.
 *
 * The chip reads the pane's agent — its working directory and the transcript it
 * is writing (see panewt.ts). Between turns that evidence goes quiet: an agent
 * that has said nothing for ten minutes is still working in the same worktree,
 * so the chip was made sticky and only a NEW detection could replace it.
 *
 * Which is right until the agent is not the same agent. `/clear` starts a fresh
 * session with a fresh transcript, the pane goes back to standing in the parent
 * repo, and nothing about the new session names the old worktree — so the read
 * comes back empty and the chip went on naming a branch from a conversation
 * that no longer exists. MEASURED: after a clear the pane's own transcript had
 * zero tool calls in it and the server correctly answered with nothing, and the
 * chip still said the old branch. "What is it trusting" was exactly that.
 *
 * So stickiness is now tied to WHO is in the pane, not to time. Same agent and
 * no news: keep. Different agent, or no agent at all: forget. The pane's own
 * checkout is the fallback, which is the honest answer for a shell with nobody
 * working in it.
 */

/** What a pane last told us, and which agent told us. */
export interface PaneSeen {
  /** Absolute path of the worktree that pane's agent was working in. */
  root: string;
  /** The agent session that named it. Empty when the pane had no agent — which
   *  is a value, not a gap: it means "nothing to keep believing". */
  session: string;
}

/**
 * What to remember for this pane after a read.
 *
 * `null` means forget: the chip falls back to the panel's own checkout rather
 * than to the last thing anybody saw.
 */
export function nextSeen(prev: PaneSeen | undefined, found: string | null, session: string, read = true): PaneSeen | null {
  /* A read that did not happen is not news. The server was busy or offline,
     and forgetting on that dropped the chip to the panel's own checkout on
     every hiccup — for a pane whose agent has no hooked session most of all,
     because nothing else could keep it: an opencode or a qwen has no session
     id here, so its memory lives only as long as every poll succeeds. */
  if (!read && !found) return prev ?? null;
  if (found) return { root: found, session };
  // Nothing found, and the same agent is still there: it has simply not
  // mentioned the worktree since. This is the case stickiness exists for.
  if (prev && session && prev.session === session) return prev;
  // Either the agent changed (a /clear, a new session, another agent taking
  // the pane) or there is none. Whatever was remembered belonged to somebody
  // else's conversation.
  return null;
}

/**
 * A worktree the candidate list has not caught up with.
 *
 * The list is read when the view opens, and a worktree cut after that — by an
 * agent, in another tab — is not in it: the pane's agent stands in a directory
 * no candidate names, so the chip cannot name it and falls back to the panel's
 * own checkout until the view is reopened. That directory is the one to ask
 * the list about again. Asked about ONCE: a directory that is no worktree at
 * all (a home directory, a scratch folder) would otherwise be asked about on
 * every poll.
 */
export function unlistedWorktree(dirs: string[], cands: { root: string }[], asked: Map<string, number>, now = Date.now()): string | null {
  const dir = dirs[0];
  if (!dir) return null;
  if (cands.some((r) => dir === r.root || dir.startsWith(r.root + "/"))) return null;
  /* Asked again after a while, not never: the server keeps its own list for
     some seconds, so the first read after a worktree is cut can still be the
     old one. A minute is longer than that cache and shorter than a person's
     patience. */
  const last = asked.get(dir);
  if (last !== undefined && now - last < ASK_AGAIN_MS) return null;
  asked.set(dir, now);
  return dir;
}
const ASK_AGAIN_MS = 60_000;

/*
 * The memory, across restarts.
 *
 * It lived in the panel, so every relaunch started with a grid of unknown panes
 * and each one had to be discovered again as the pointer reached it: "it takes
 * ages… especially after a restart… it gets stuck on Reading this pane".
 *
 * What makes writing it down safe is `nextSeen` above: an entry is kept only
 * while the SAME agent is still in that pane, so a `/clear`, a new session or
 * another agent taking the pane throws it away on the first read — a stale
 * answer cannot outlive the conversation it came from, whether it was in memory
 * or on disk.
 *
 * Capped, because pane ids are recycled and windows come and go: this is a
 * warm start, not a record.
 */
const SEEN_KEY = "agentglass.term.paneSeen";
const SEEN_MAX = 60;

export function readPaneSeen(): [string, PaneSeen][] {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) || "null");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((e): e is [string, PaneSeen] =>
        Array.isArray(e) && typeof e[0] === "string"
        && !!e[1] && typeof e[1].root === "string" && typeof e[1].session === "string")
      .slice(0, SEEN_MAX);
  } catch { return []; }
}

export function writePaneSeen(seen: Map<string, PaneSeen>): void {
  try {
    // Newest last in insertion order, so the cap drops the oldest panes.
    const all = [...seen.entries()];
    localStorage.setItem(SEEN_KEY, JSON.stringify(all.slice(-SEEN_MAX)));
  } catch { /* private mode, or a full quota — the memory still works this run */ }
}

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
 * What a pane's memory may show before the pane has been read again.
 *
 * Only what the pane's CURRENT agent vouches for. The memory is keyed by
 * `@window:%pane` and kept across restarts, and the next tmux server hands the
 * same ids out again: unchecked, a shell on main wore an ended session's
 * worktree, PR and card. The conversation id is the identity nothing reuses.
 */
export function vouchedSeen(remembered: PaneSeen | undefined, agentNow: string | undefined): PaneSeen | undefined {
  return remembered?.session && agentNow === remembered.session ? remembered : undefined;
}

/**
 * What the chip names: the pane's own answer, and the panel's checkout only for
 * a shell that is not a tmux pane.
 *
 * In a tmux window the server reads the pane itself, and its answer is the
 * whole answer. The two fallbacks this used to reach for were both memories:
 * the panel's `root` is whatever checkout it was last pointed at, kept in
 * localStorage across restarts, and the scrollback scan reads whatever text is
 * still in the buffer. MEASURED: a pane on main, in the parent repo, whose
 * read came back with no directories, wore an ENDED session's worktree, PR and
 * card — the server was right and the chip was not, because `root` still named
 * that worktree. A plain (non-tmux) shell was started at `root`, so there it
 * is the truth. The ceiling: an agent the server cannot see (no hook, no
 * process cwd in a worktree) shows nothing in a tmux pane rather than a guess.
 */
export function chipWorktree<T>(detected: T | null, detecting: boolean, tmuxPane: boolean, here: T | null): T | null {
  return detected ?? (detecting || tmuxPane ? null : here);
}

/**
 * The checkout the pane's session is WORKING in, and how many other checkouts it
 * worked in lately.
 *
 * `work` is what the session edited, wrote, committed, built or tested (see
 * panewt.ts), newest first, subagents included. It decides first: a session
 * that stands in the main checkout and has a subagent editing a PR's worktree
 * is on that worktree. A read never reaches `work`, so looking at another
 * checkout leaves the chip where the pane stands. `dirs` answers only when the
 * session has done no work anywhere we know.
 *
 * `more` is the honest part: two checkouts in `work` is not a tie to break
 * silently, so the newest is shown and the count of the rest comes with it.
 */
export function pickWorktree<T extends { root: string }>(work: string[], dirs: string[], cands: T[]): { hit: T | null; more: number } {
  const own = (p: string) => cands.find((r) => p === r.root || p.startsWith(r.root + "/"));
  const seen: T[] = [];
  for (const p of work) { const r = own(p); if (r && !seen.includes(r)) seen.push(r); }
  if (seen.length) return { hit: seen[0]!, more: seen.length - 1 };
  for (const p of dirs) { const r = own(p); if (r) return { hit: r, more: 0 }; }
  return { hit: null, more: 0 };
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
/* `.v2` since the scrollback scan stopped feeding tmux panes: an entry it wrote
   carries the CURRENT agent's id, so `vouchedSeen` lets it through and
   `nextSeen` keeps it forever. Nothing in an old entry says where it came
   from, so the old key is dropped whole on the first read. */
const SEEN_KEY = "agentglass.term.paneSeen.v2";
const OLD_SEEN_KEY = "agentglass.term.paneSeen";
const SEEN_MAX = 60;

export function readPaneSeen(): [string, PaneSeen][] {
  try {
    localStorage.removeItem(OLD_SEEN_KEY);
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

/**
 * The checkouts a pane's directory may be matched against: the project's main
 * checkout AND its linked worktrees. The filter once required `worktreeOf`,
 * which only a linked worktree carries, so a pane standing in the main checkout
 * (an agent on the default branch) matched nothing and the chip said there was
 * no repo behind it.
 */
export function paneCandidates<T extends { root: string; worktreeOf?: string | null }>(repos: T[], project: string): T[] {
  return repos.filter((r) => (r.worktreeOf || r.root) === project);
}

/** What the bar says when a pane has no chip. A checkout the server named but
 *  the window's scope dropped is said to be another project's, not absent. */
export function paneNote(detecting: boolean, dir: string | null, outside: string, project: string, cwd = ""): string {
  if (detecting) return "Reading this pane…";
  if (dir) return `${dir.split("/").pop()} — no repo scanned here`;
  if (outside) return `${outside} · outside this project${project ? ` (${project})` : ""}`;
  // A plain shell has no agent process to name a checkout, but it does have a
  // folder, and saying so reads right where "no checkout" read as a fault.
  if (cwd) return `${cwd.replace(/\/+$/, "").split("/").pop() || cwd} · plain shell`;
  return "No checkout behind this pane";
}

export type PaneBookEntry = { dirs: string[]; work?: string[]; outside: string; agent: string };

/**
 * The window's panes by id, plus the active one under "".
 *
 * The panel only learns pane ids while a window is split, so an unsplit window
 * looks its pane up as "". Without that entry the book never answered and every
 * 4 s tick paid a second, single-pane request for what the first had returned.
 */
export function bookPanes(panes: { pane: string; active?: boolean; dirs?: string[]; work?: string[]; outside?: string; agent?: string }[]): Map<string, PaneBookEntry> {
  const book = new Map<string, PaneBookEntry>();
  for (const p of panes) {
    const e = { dirs: p.dirs ?? [], work: p.work ?? [], outside: p.outside ?? "", agent: p.agent ?? "" };
    book.set(p.pane, e);
    if (p.active) book.set("", e);
  }
  return book;
}

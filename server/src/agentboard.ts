/*
 * WHO IS WORKING ON WHAT, IN ONE PLACE.
 *
 * The deputy has a screen. The agents in the terminals do not, and the cost of
 * that came back as a question nobody should have to ask: "suddenly they are
 * doing lots of tasks and I don't even know which ones, since there is no list
 * I can look at".
 *
 * Six of the seven things such a list needs are already read by this app —
 * the tmux panes it opens, the Claude Code sessions on disk, the worktrees git
 * knows, the transcript clock behind the tab's green dot, and the deputy's own
 * run table. The seventh is what an agent is working ON, which only the agent
 * knows, so it says so through `POST /agents/status` and this joins the two.
 *
 * Nothing here starts, stops or queues anything. It is a screen you read and
 * close; the controls live where the work does.
 */
import { db } from "./db.ts";

export interface AgentRow {
  name: string;
  /** What it said it is doing, and when it said so. Absent for an agent that
   *  has never written a status — the other columns still describe it. */
  doing?: string;
  saidAt?: number;
  worktree?: string;
  branch?: string;
  left?: string;
  /** The hooked session that said it, when it said which. Absent for a
   *  status written by hand or by an agent with no hook. */
  session?: string;
  /** How this row was assembled, so a reader can tell a claim from an
   *  observation: `said` is the agent's own words, `seen` is this machine's. */
  from: "said" | "seen";
}

const put = db.query<never, [string, string, string, string, string, number, string]>(
  `INSERT INTO agent_status (name, doing, worktree, branch, left_behind, at, session_id)
   VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(name) DO UPDATE SET
     doing = excluded.doing, worktree = excluded.worktree, branch = excluded.branch,
     left_behind = excluded.left_behind, at = excluded.at,
     session_id = CASE WHEN excluded.session_id = '' THEN agent_status.session_id ELSE excluded.session_id END`,
);
const all = db.query<
  { name: string; doing: string; worktree: string; branch: string; left_behind: string; at: number; session_id: string }, []
>("SELECT name, doing, worktree, branch, left_behind, at, session_id FROM agent_status ORDER BY at DESC LIMIT 40");
const lastBySession = db.query<{ at: number }, [string]>(
  "SELECT MAX(at) AS at FROM agent_status WHERE session_id = ?",
);
const drop = db.query<never, [string, string]>("DELETE FROM agent_status WHERE name = ? AND session_id = ?");
const dropOld = db.query<never, [number]>("DELETE FROM agent_status WHERE at < ?");

/**
 * The longest a path or a branch is stored at.
 *
 * `doing` and `left` had caps from the start; `worktree` and `branch` did not,
 * and the route that feeds them is tokenless on loopback under a 32 MB body
 * limit — so any local process could park megabytes in one row of a table the
 * board reads on every tick. Nothing legitimate is anywhere near this: PATH_MAX
 * is 4096 and a git ref name is refused by git itself well before 512.
 */
const PATH_CAP = 512;

/** What an agent says about itself. Replaces its previous line: this is a
 *  status, not a log. */
export function saidBy(a: {
  name: string; doing?: string; worktree?: string; branch?: string; left?: string; at?: number; session?: string;
}): boolean {
  const name = (a.name || "").trim().slice(0, 60);
  if (!name) return false;
  try {
    put.run(name, (a.doing ?? "").trim().slice(0, 300), (a.worktree ?? "").trim().slice(0, PATH_CAP),
      (a.branch ?? "").trim().slice(0, PATH_CAP), (a.left ?? "").trim().slice(0, 200), a.at || Date.now(),
      (a.session ?? "").trim().slice(0, 120));
    return true;
  } catch { return false; }
}

/** When this hooked session last said what it was doing, or 0. What the Lantern
 *  reminder checks before asking again: a session that answered is left alone
 *  for the whole interval, whatever name it chose. */
export function lastSaidAt(sessionId: string): number {
  if (!sessionId) return 0;
  try { return lastBySession.get(sessionId)?.at ?? 0; } catch { return 0; }
}

/**
 * An agent that has finished saying anything at all — cleared by the session
 * that wrote the line, and by nobody else.
 *
 * The route behind this is tokenless on loopback (LOCAL_SINKS in auth.ts): a
 * hooked session has no credential to carry, and this is the one thing it is
 * asked to post. With the name as the only key, `{name, done: true}` from ANY
 * local process erased another agent's line — a curl from a shell, an agent
 * that read a name off the board — and the board showed the agent as gone
 * while it was still working. So the delete is keyed on the session too: the
 * hook bakes its session id into the reminder it answers, and the status it
 * posted carries the same id, so the one caller that can clear a line is the
 * one whose line it is.
 *
 * Returns whether a row went, so the route can say "not yours" rather than
 * "cleared" to a caller whose session does not match.
 */
export function forgetAgent(name: string, session: string): boolean {
  const n = (name || "").trim();
  const s = (session || "").trim();
  if (!n || !s) return false;
  try { return drop.run(n, s).changes > 0; } catch { return false; }
}

/**
 * How long a status line outlives the agent that wrote it.
 *
 * Deliberately long. A row going quiet is information — see `board` — and the
 * board says how long ago it spoke, so a day-old line is answerable rather
 * than wrong. This is only the far end, where a row stops being a stale fact
 * about somebody's afternoon and becomes a table nothing prunes.
 */
export const KEEP_MS = 14 * 24 * 60 * 60_000;

/** Drop status lines older than `KEEP_MS`. Returns how many went. */
export function sweepAgents(now = Date.now()): number {
  try { return dropOld.run(now - KEEP_MS).changes; } catch { return 0; }
}

/**
 * Every agent that has said something, newest first.
 *
 * Stale rows are NOT hidden: an agent that stopped writing an hour ago is
 * exactly what a person wants to see, and the timestamp says which. Hiding it
 * would turn "nobody is on this" into "there is nothing to know".
 */
let sweptAt = 0;
export function board(): AgentRow[] {
  /* Once an hour, not once a tick: the board is read every five seconds while
     the view is open, and a DELETE that finds nothing 719 times out of 720 is
     720 writes' worth of lock for one row's worth of work. */
  if (Date.now() - sweptAt > 60 * 60_000) { sweptAt = Date.now(); sweepAgents(); }
  try {
    return all.all().map((r) => ({
      name: r.name,
      ...(r.doing ? { doing: r.doing } : null),
      saidAt: r.at,
      ...(r.worktree ? { worktree: r.worktree } : null),
      ...(r.branch ? { branch: r.branch } : null),
      ...(r.left_behind ? { left: r.left_behind } : null),
      ...(r.session_id ? { session: r.session_id } : null),
      from: "said" as const,
    }));
  } catch { return []; }
}

/* ── everything else the app already knows ─────────────────────────────── */

/** A pane this app opened, as tmux reports it. */
export interface PaneSeen { paneId: string; name: string; cwd: string }
/** A checkout on disk, as git reports it. */
export interface TreeSeen { path: string; branch: string }
/** A deputy run in flight. */
export interface RunSeen { title: string; worktree: string; branch: string; startedAt: number }

/**
 * A pane a hook reported from, straight out of `pane_agent`.
 *
 * The difference from `PaneSeen` is who is talking. `PaneSeen` is tmux being
 * asked what panes exist; this is an AGENT'S OWN hook saying "I am in %4, in
 * this directory, and here is my transcript". tmux cannot tell those apart —
 * a pane running an editor looks the same — so a row is only ever made from
 * this one.
 */
export interface HookSeen {
  paneId: string;
  sessionId: string;
  cwd: string;
  /** When the hook fired. The freshest sighting per pane decides its state. */
  at: number;
}

export interface BoardRow extends AgentRow {
  /** What this machine can see about it, whoever said what. */
  paneId?: string;
  /**
   * WHAT THIS SESSION USED TO CALL ITSELF, newest first, when it has posted
   * under more than one name.
   *
   * `agent_status` is keyed by name, so a rename leaves the old row behind
   * rather than replacing it. The board draws one card per session now; this
   * is the rest of the names, kept so the fold is legible rather than silent
   * — a person who saw "readme-diet" on this screen an hour ago can still
   * find out where it went.
   */
  wasCalled?: string[];
  /** What this session is to the app, when it is not a person's agent: the
   *  Lantern's own chat. Set by lantern.ts from the session's hooks; never
   *  counted as needing anybody. */
  role?: "lantern";
  startedAt?: number;
  /** working: something is running. waiting: it asked and nobody answered.
   *  idle: it is there and has said nothing lately. */
  state: "working" | "waiting" | "idle";
  /*
   * WHETHER THE WORK IS ALREADY IN.
   *
   * Two rows that look identical — same branch, same checkout, both quiet —
   * mean opposite things depending on one fact this screen is the only place
   * to learn it: whether anybody merged it. Without this a finished branch and
   * an abandoned one are the same row, and the abandoned one is the whole
   * reason to look.
   *
   * Absent, not false, when nobody asked git: "not merged" and "unknown" are
   * different answers and the screen must not print the first for the second.
   */
  landed?: boolean;
  /** WHICH ref it is merged into — "merged" alone is not a fact, it is half of
   *  one, and the half that changes depending on where you stand. */
  landedInto?: string;
  /**
   * WHY IT IS STOPPED ON A PERSON, when it is.
   *
   * Lantern's "who needs you", read off the facts rather than the pane text:
   * a permission the agent asked for and nobody answered, a turn that ended
   * and is waiting to be told what next, or a tool call held at this app's
   * own gate. Present only when the wait is the newest thing the session did
   * — a session that ran anything since is not waiting, whatever it said.
   */
  needsYou?: { kind: "permission" | "input" | "gate"; why: string; since: number };
}

/** A line said this recently is a claim about NOW; older than this it is a
 *  claim about earlier, and the screen says so rather than pretending. */
export const FRESH_MS = 10 * 60_000;

/**
 * One row per agent, from every source at once.
 *
 * The readers are injected because each of them needs a different part of the
 * machine — a tmux socket, a git repository, the deputy's table — and a test
 * that needed all three would be a test nobody runs. What is worth pinning is
 * the JOIN: which source wins, what happens when only one of them knows about
 * something, and what a row says when they disagree.
 */
export function merged(p: {
  said?: AgentRow[];
  /**
   * WHAT THE HOOKS SAW, and the reason the Lantern was empty until it had them.
   *
   * Rows used to come from two places: `agent_status`, which an agent writes
   * by calling `POST /agents/status`, and the deputy's runs. Nothing on this
   * machine calls that route — `grep -rn -E 'agents/(say|status|board)' bin
   * hooks skills README.md docs` returns nothing — so no agent surface knows
   * it exists, and the board showed the deputy beside an empty list while six
   * agents worked in tmux.
   *
   * The sighting was already being recorded. `send_event.py` posts
   * `session_id`, `tmux_pane` and `cwd` on every hook and `notePaneFromHook`
   * persists them: 296 rows on this machine the day this was written, none of
   * them drawn.
   */
  hooks?: HookSeen[];
  panes?: PaneSeen[];
  trees?: TreeSeen[];
  runs?: RunSeen[];
  /**
   * What git said about each branch, by branch name: whether it is already in,
   * and WHICH ref it was measured against.
   *
   * Keyed by branch and not a flat list because the answer is per REPOSITORY.
   * The first version asked one repository — the configured workspace root —
   * for every row, and on this machine that root is the employer's checkout,
   * whose HEAD is a `master` none of these branches has ever been near. Every
   * row read "not in master", which is true, meaningless, and the exact shape
   * of an answer that sends somebody looking.
   *
   * Absent for a branch nobody asked about, which is not the same as "not
   * merged" and must not be drawn as if it were.
   */
  landedBy?: Record<string, { landed: boolean; into: string }>;
  /**
   * The checkouts this machine LOOKED FOR AND DID NOT FIND, by path.
   *
   * Passed in rather than read here so this stays a join over facts, and so a
   * missing entry means "nobody asked" instead of "not there" — the same
   * distinction `landed` keeps, and for the same reason. Only a path in this
   * set is treated as gone; every other row is believed.
   */
  gone?: Set<string>;
  /** A session's own name, by `sessionId` — a rename, a generated title, or
   *  the first thing typed (see `sessionNames` in db.ts). A "seen" row falls
   *  back to its bare pane id when its session has none of the three, which
   *  is still every row on a machine before this existed. */
  names?: Map<string, string>;
  /** Which sessions are stopped on a person, by `sessionId` — see
   *  `latestWaits` in db.ts and the gate. Applies to a seen row and to a said
   *  row whose hook this machine has placed. */
  waiting?: Map<string, { kind: "permission" | "input" | "gate"; why: string; since: number }>;
  now?: number;
}): BoardRow[] {
  const now = p.now ?? Date.now();
  const said = p.said ?? board();
  const panes = p.panes ?? [];
  const trees = p.trees ?? [];
  const runs = p.runs ?? [];
  const isLanded = (branch: string) => {
    const said = branch ? p.landedBy?.[branch.trim()] : undefined;
    return said ? { landed: said.landed, ...(said.into ? { landedInto: said.into } : null) } : null;
  };

  const branchOf = (path: string) => trees.find((t) => t.path && path.startsWith(t.path))?.branch ?? "";
  const rows = new Map<string, BoardRow>();

  /*
   * THE SEEN ROWS FIRST, so a claim can overwrite an observation and never the
   * other way round.
   *
   * A hook knows the pane and the directory; only the agent knows the task. If
   * these ran second they would replace `doing` with nothing, and the board
   * would get quieter the more it knew.
   *
   * Keyed by pane rather than by session: a pane is what a person can go and
   * look at, and one pane running two sessions in turn is still one place.
   *
   * `name` used to be the pane — "%32" — because a hook carries a
   * `sessionId` and nothing an eye can read, and there was nothing else
   * honest to call something that has not said its name. It has one anyway:
   * `names` is that same session's own title, wherever this machine already
   * knows it, so the row reads as the session it is rather than the tmux
   * accident it happens to be sitting in. Falls back to the pane id for a
   * session this machine has not named yet — still honest, just rarer now.
   */
  const freshest = new Map<string, HookSeen>();
  for (const h of p.hooks ?? []) {
    if (!h.paneId || !h.cwd) continue;
    const prev = freshest.get(h.paneId);
    if (!prev || h.at > prev.at) freshest.set(h.paneId, h);
  }
  /*
   * A PANE THAT IS GONE IS NOT AN AGENT.
   *
   * `pane_agent` keeps every sighting a hook ever made; tmux recycles pane ids
   * across reboots and keeps none of them. Measured on this machine the day
   * this was written: 304 rows, 290 of whose panes no longer exist. The 24-hour
   * window in `recentPaneAgents` narrows it to twelve and still let two dead
   * ones through — `%36` and `%38` — each drawn as an idle agent somebody could
   * click Go on.
   *
   * Only applied when tmux actually answered. An empty pane list is a socket
   * that did not reply, and deleting the board on the strength of a failed
   * read is the one outcome worse than a stale row.
   */
  const alive = new Set(panes.map((x) => x.paneId));
  const seenBySession = new Map<string, Set<string>>();
  for (const h of freshest.values()) {
    /*
     * AND A PANE ID IS ONLY MEANINGFUL ON THE SERVER THAT ISSUED IT.
     *
     * `panes` is ONE tmux server's list; `hooks` are whatever fired, on any
     * server on the machine, and `%3` exists on all of them. So "not in the
     * list" is not proof of death — it is also what a live agent on a second
     * tmux server looks like from here, and dropping those would empty the
     * board of exactly the agents somebody started somewhere else.
     *
     * The freshness gate is what makes it safe: a hook that fired in the last
     * ten minutes is an agent that was running ten minutes ago, wherever it
     * is, and it stays. Only a stale sighting whose pane this machine cannot
     * find is dropped — which is the case that was drawing `%36` and `%38`,
     * quiet for hours, as idle agents somebody could click Go on.
     */
    if (alive.size > 0 && !alive.has(h.paneId) && h.at <= now - FRESH_MS) continue;
    const tree = trees.find((t) => t.path && h.cwd.startsWith(t.path));
    const branch = tree?.branch ?? "";
    const wait = p.waiting?.get(h.sessionId);
    if (h.sessionId) {
      const had = seenBySession.get(h.sessionId) ?? new Set<string>();
      had.add(h.paneId);
      seenBySession.set(h.sessionId, had);
    }
    rows.set(h.paneId, {
      name: p.names?.get(h.sessionId) || h.paneId,
      worktree: tree?.path ?? h.cwd,
      branch,
      paneId: h.paneId,
      session: h.sessionId,
      saidAt: h.at,
      ...isLanded(branch),
      ...(wait ? { needsYou: wait } : null),
      from: "seen",
      /* Waiting outranks working: a hook fired seconds ago is exactly what a
         permission prompt looks like from here, and "working" would be the
         one wrong word for an agent that is stopped. */
      state: wait ? "waiting" : h.at > now - FRESH_MS ? "working" : "idle",
    });
  }

  /*
   * ONE CARD PER SESSION, NOT PER NAME.
   *
   * `agent_status` is keyed by name, so an agent that renames itself between
   * tasks leaves a row behind every time. Measured: session one session posted
   * under five names in three hours and got five cards, all reading the same
   * session's stats — same calls, same turns, same cost, same ASKED line —
   * because the numbers are looked up by session id. Five cards, one agent,
   * and nothing on screen saying so.
   *
   * `said` arrives newest first, so the first row for a session is its current
   * name and the rest are what it used to be called. They are kept as history
   * on the row rather than dropped: "this is the one that was posting as
   * readme-diet" is the sentence that makes the fold legible.
   */
  const claimedSession = new Map<string, string>();
  const alsoKnownAs = new Map<string, string[]>();
  for (const s of said) {
    if (!s.session) continue;
    const first = claimedSession.get(s.session);
    if (first === undefined) claimedSession.set(s.session, s.name);
    else alsoKnownAs.set(first, [...(alsoKnownAs.get(first) ?? []), s.name]);
  }

  for (const s of said) {
    /* A later name for a session already drawn under its newest one. */
    if (s.session && claimedSession.get(s.session) !== s.name) continue;
    /* The pane whose working directory is inside the worktree it named. A
       name match would be neater and is not available: tmux renames a window
       when the program inside sets a title, which is the bug that cost a
       morning of the deputy's runs. */
    const pane = s.worktree ? panes.find((x) => x.cwd && x.cwd.startsWith(s.worktree!)) : undefined;
    const fresh = (s.saidAt ?? 0) > now - FRESH_MS;
    /*
     * A CLAIM THIS MACHINE CANNOT SEE ANY MORE IS NOT "WORKING".
     *
     * The word is ten minutes fresh; the checkout it named was removed two
     * minutes ago and the pane went with it. Freshness alone would keep the
     * row green for the remaining eight, which is the reading that made the
     * deputy look alive while its worktree was being swept out from under it.
     *
     * Only demoted when this machine actually looked: with no trees and no
     * panes read, there is nothing to contradict the claim, and inventing a
     * contradiction out of an empty list is worse than believing the agent.
     */
    const couldSee = trees.length > 0 || panes.length > 0;
    const stillThere = !s.worktree || !couldSee
      || !!pane || trees.some((t) => t.path === s.worktree);
    /*
     * AND A CLAIM ABOUT A CHECKOUT THAT HAS BEEN GONE FOR A DAY IS NOT A ROW.
     *
     * `stillThere` above demotes it from working to idle, which is right for
     * the afternoon it stopped — the line is a fact with a time on it and a
     * person can still answer it. It is not right a week later:
     * `race-condition-fix-measurement` sat on this board for five days and
     * eighteen hours naming `~/code/orbit-zoom`, a worktree that no
     * longer exists, on a screen whose whole job is who to go and talk to.
     *
     * Dropping a row needs the directory to have been LOOKED FOR AND NOT
     * FOUND — `gone`, which lantern.ts fills in by asking the filesystem.
     * `stillThere` is not that test and must not stand in for it: it is false
     * whenever tmux did not answer and git does not list the path, and the
     * first thing that combination erased in testing was
     * `laptop-lid-closed-remote`, whose directory is `~` and has been there
     * the whole time. Absence of evidence had deleted an agent.
     *
     * Both halves are still required. Gone but recent stays — a worktree
     * swapped mid-task, with the agent still there to say so; old but present
     * stays, because a quiet checkout is exactly the row worth seeing.
     */
    const GONE_MS = 24 * 60 * 60_000;
    if (s.worktree && p.gone?.has(s.worktree) && (s.saidAt ?? 0) < now - GONE_MS) continue;
    const branch = s.branch || branchOf(s.worktree ?? "");
    /*
     * THE HOOK BEHIND THIS CLAIM — ITS OWN, AND NOBODY ELSE'S.
     *
     * `panes` is every pane on the machine, `hooks` is only the ones an agent
     * fired from, so a hook knows the pane when tmux does not. It has to be
     * the RIGHT hook. This used to take the first sighting whose cwd started
     * with the named worktree, which on this machine meant every session in
     * `~/code/shop-api` — four of them — borrowing one pane, `%40`, that belonged
     * to a fifth. Four cards whose Go button opened somebody else's agent, and
     * one (`laptop-lid-closed-remote`, really in `%7`) sent to `%0`, a live
     * pane of an unrelated session. A wrong pane is worse than none: no pane
     * draws no button, a wrong one moves the person's screen.
     *
     * So the session it named decides, and only when it named none does the
     * checkout get a say — by exact path rather than by prefix, taking the
     * freshest sighting, and only when that checkout has exactly one session
     * in it. Two agents in one directory cannot be told apart from here, and
     * guessing between them is how the last four wrong buttons happened.
     */
    const hook = s.session
      ? [...freshest.values()].filter((h) => h.sessionId === s.session)
        .sort((a, b) => b.at - a.at)[0]
      : s.worktree
      ? (() => {
        const here = [...freshest.values()].filter((h) => h.cwd === s.worktree)
          .sort((a, b) => b.at - a.at);
        return new Set(here.map((h) => h.sessionId)).size === 1 ? here[0] : undefined;
      })()
      : undefined;
    /*
     * tmux's pane only when the hook has none AND the checkout holds one
     * agent: the hook is an agent saying where it is, the pane list is a
     * directory match that two agents in one checkout answer identically —
     * the same ambiguity as above, arriving by the other door.
     */
    const oneAgentHere = new Set(
      [...freshest.values()].filter((h) => s.worktree && h.cwd.startsWith(s.worktree)).map((h) => h.sessionId),
    ).size <= 1;
    const paneId = hook?.paneId ?? (s.session || !oneAgentHere ? undefined : pane?.paneId);
    /* The session behind this claim: the one it named, else the hook this
       machine placed in the same checkout. Both are how the wait is looked up
       and how the reminder knows it has been answered. */
    const session = s.session || hook?.sessionId;
    const wait = session ? p.waiting?.get(session) : undefined;
    const wasCalled = alsoKnownAs.get(s.name);
    rows.set(s.name, {
      ...s,
      branch,
      ...(paneId ? { paneId } : null),
      ...(session ? { session } : null),
      ...(wasCalled?.length ? { wasCalled } : null),
      ...isLanded(branch),
      ...(wait ? { needsYou: wait } : null),
      state: wait ? "waiting" : fresh && stillThere ? "working" : "idle",
    });
    /*
     * And the anonymous rows for that session go: it is the same agent, now
     * with a name and a task.
     *
     * EVERY pane of it, not the one pane this row landed on. A session that
     * has been through a reboot has a sighting per pane it ever ran in, and
     * deleting one left the rest on the board under whatever `names` called
     * them — which is where "Ayudame a instalar…" and "que son estos??" came
     * from: the same session as a named card, drawn a second time titled with
     * the first thing its person had typed into it.
     */
    for (const dead of session ? seenBySession.get(session) ?? [] : []) rows.delete(dead);
    if (paneId) rows.delete(paneId);
  }

  /* The deputy is not asked to announce itself: its runs ARE its status, and
     a run in flight outranks anything anybody said. */
  for (const r of runs) {
    rows.set("the deputy", {
      name: "the deputy",
      doing: r.title,
      worktree: r.worktree,
      branch: r.branch,
      startedAt: r.startedAt,
      ...isLanded(r.branch),
      from: "seen",
      state: "working",
    });
  }

  /*
   * WHO NEEDS YOU FIRST — Lantern's order, and the only order that makes a
   * list of twenty worth opening: the ones stopped on a person, then the
   * ones moving, then the ones that have gone quiet. Within a group, newest
   * first, except the waiting ones, where the longest wait goes on top — it
   * has been costing the most for the longest.
   */
  const RANK: Record<BoardRow["state"], number> = { waiting: 0, working: 1, idle: 2 };
  const stamp = (r: BoardRow) => r.saidAt ?? r.startedAt ?? 0;
  return [...rows.values()].sort((a, b) => {
    const d = RANK[a.state] - RANK[b.state];
    if (d) return d;
    if (a.state === "waiting") return (a.needsYou?.since ?? 0) - (b.needsYou?.since ?? 0);
    return stamp(b) - stamp(a);
  });
}

/* ── the reminder ───────────────────────────────────────────────────────── */

/**
 * THE ASK, in the words a session reads.
 *
 * Translated from Herdr's Lantern, whose board is full because every agent it
 * seats is handed a rule to narrate `Goal: … Next: …` into its own output.
 * Scraping a tmux pane for that text does not work here — panewt.ts measured
 * it against a live fleet and found nothing (no scrollback on the alternate
 * screen, the paths folded into collapsed tool calls). What works is asking
 * directly, through the same channel the memory-save reminder already uses
 * successfully: the hook's stdout on a prompt.
 *
 * The session id is baked in so the answer can be tied back to this hook —
 * the agent does not know its own id, and the reminder is the one moment
 * that knows both. `$PWD` is left to the shell that runs it: it is the one
 * thing here the server should not guess.
 */
export function lanternReminder(o: { session: string; server: string }): string {
  const body = `{"name":"<short-kebab-slug-a-person-would-recognize>","doing":"<one line: what you are working on right now>","worktree":"'"$PWD"'","session":"${o.session}"}`;
  return (
    "AGENTGLASS LANTERN: this session shows on the Lantern as a bare id until it says what it is doing. "
    + "Post it once, now, then keep going: "
    + `curl -s -X POST "\${AGENTGLASS_SERVER:-${o.server}}/agents/status" -H 'Content-Type: application/json' -d '${body}' `
    + "— name it after the task (a card id, a PR, a short slug), never something generic like 'agent'. "
    + "Post again when the task changes; when you finish, post once more with "
    + `{"name":"<same slug>","done":true}.`
  );
}

/**
 * Whether it is time to ask this session again.
 *
 * Two clocks, and both have to agree. The session's own answer: one that has
 * said what it is doing inside the interval is left alone, whatever name it
 * chose — that is what `session_id` on the status row is for. And the last
 * ask: a session that was reminded and chose not to answer is not reminded on
 * its very next prompt either, or the board's one question becomes the thing
 * it is remembered for. In memory rather than on disk: a restart asking once
 * more is a small cost, and a file would be the fourth place this state lives.
 */
const lastNudge = new Map<string, number>();
export function nudgeDue(sessionId: string, intervalMs: number, now = Date.now()): boolean {
  if (!sessionId || sessionId === "unknown") return false;
  if (now - lastSaidAt(sessionId) < intervalMs) return false;
  if (now - (lastNudge.get(sessionId) ?? 0) < intervalMs) return false;
  lastNudge.set(sessionId, now);
  if (lastNudge.size > 500) {
    for (const [k, v] of lastNudge) if (now - v > 24 * 60 * 60_000) lastNudge.delete(k);
  }
  return true;
}

/** For a test that needs a clean clock. */
export function __resetNudges(): void { lastNudge.clear(); }

/*
 * A run: one question, asked in several checkouts at once, and tracked as one
 * thing.
 *
 * The obvious half of this is fan-out — cut N worktrees, start N agents, keep
 * the best. That half is not what this file is for, and it is worth being blunt
 * about why: everybody ships it. It is Orca's headline feature, Cursor has
 * best-of-n across eight agents, and Claude Code itself will spawn a worktree
 * per agent from a flag. Arriving fourth at a race that is already run is not a
 * reason to write anything.
 *
 * The half nobody else can do is ADOPTION, and it is the reason this exists.
 * A person opens a terminal, cuts a worktree by hand, and starts a different
 * vendor's CLI in it — codex, gemini, whatever they were already using. Nothing
 * in the app spawned it, nothing in the app configured it, and every tool that
 * manages agents can only manage what it started: they hold a handle they were
 * given at spawn time, and there is no handle here to hold. Even a vendor's own
 * cross-session registry misses it, because a session appears there when it
 * binds an inbox socket and a codex pane never binds one.
 *
 * This app is in a different position, and only because of what it already
 * measures. It can see every tmux pane on the machine, it can see which
 * DIRECTORY the agent inside a pane is genuinely running in (paneloc.ts, and
 * note that this is not the shell's directory — that distinction is the whole
 * reason that file exists), and it can ask git which of those directories is a
 * checkout of the repository in question. Those three facts are enough to say
 * "that pane, over there, that we did not start, is working on this" — which is
 * what a leg of a run is.
 *
 * So a run has legs of two origins and they are deliberately not equal:
 *
 *   spawned   we cut the worktree and started the agent, so we may tear both
 *             down again when the run is over.
 *   adopted   somebody else's pane in somebody else's checkout. Tracked, shown
 *             beside the others, counted in the run — and NEVER torn down.
 *             Deleting a checkout a person made by hand because they let us
 *             watch it is the single worst thing this feature could do, and a
 *             tool that does it once is a tool nobody adopts a pane into twice.
 *
 * On grouping. A run does not get a column in the events table and nothing is
 * tagged at write time. What ties a leg's stored history to the run is its
 * DIRECTORY: db.ts already generates `cwd_path` — a virtual generated column on
 * `events`, a backfilled real one on `sessions` — so asking "what happened in
 * this set of directories" answers over rows that were written long before any
 * of this existed. That is what makes a pane adoptable an hour after the fact
 * rather than only at the moment it starts: the history is already there, under
 * the only key that was ever going to be common to an agent we started and one
 * we did not.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { git, repoRootOf, safeAbs } from "./git.ts";
import { addWorktree, removeWorktree, worktrees } from "./gitwork.ts";
import { inScope, isWithin } from "./config.ts";
import { engineWindowRunning } from "./tmuxpane.ts";
import { listPanes as livePanes } from "./tmuxctl.ts";
import { ROSTER } from "./agentprobe.ts";
import { agentBin, launchArgv } from "./agents/launch.ts";
import { db, UNKNOWN_PROVIDER } from "./db.ts";

/** Re-exported because this is where a caller looks for it and because the
 *  reasoning that put it on the roster is the reasoning a run depends on. It
 *  lives in agents/launch.ts now, beside the flags each of those binaries
 *  takes — the two answers are about the same table and drifted apart the
 *  moment a leg could name a vendor. */
export { agentBin };

/**
 * Where a leg is in its life.
 *
 * `gone` is the one that is not a decision anybody made: the worktree is not on
 * disk any more, which happens because somebody removed it by hand. It is kept
 * as a state rather than dropped so a finished run still reads as a run that
 * had four legs, instead of one that mysteriously had two.
 */
/*
 * `released` is the terminal state for a leg the app never owned.
 *
 * A spawned leg ends `won`, `lost`, or `gone` once its checkout is removed, and
 * a run retires when every leg has reached one of those. An adopted leg has no
 * such ending: finishRun deliberately does not delete a checkout the user made,
 * so its leg stayed `lost` forever, currentRuns never retired the run, and a
 * directory somebody adopted for one afternoon went on being claimed by it for
 * good. `released` says the run has let go while the checkout is untouched —
 * which is the honest version of what already happens, rather than reusing
 * `gone` and telling a reader a directory disappeared when it is still there.
 */
export type LegState = "running" | "won" | "lost" | "gone" | "released";

/** Who started it, which decides what `finishRun` is allowed to do to it. */
export type LegOrigin = "spawned" | "adopted";

export interface RunLeg {
  /** The checkout this leg works in. The join key for everything stored. */
  worktree: string;
  /** What is checked out there. `(detached)` when git says so — an adopted
   *  pane is under no obligation to be on a branch. */
  branch: string;
  /** The agent, by the id agentprobe.ts's roster uses. Empty when nothing on
   *  this machine could tell us — which is honest, and better than a guess
   *  that would make a run claim a vendor comparison it did not make. */
  agent: string;
  /** The tmux pane it is in. Empty for a spawned leg whose window would not
   *  open, so the leg is still recorded rather than silently missing. */
  paneId: string;
  state: LegState;
  origin: LegOrigin;
  startedAt: number;
}

export interface Run {
  id: string;
  /** The repository the run is about. Every leg is a checkout of it. */
  root: string;
  prompt: string;
  legs: RunLeg[];
  startedAt: number;
}

/** The roster id for a process name, so an observed `codex` becomes the same
 *  id the caller would have sent. Empty for anything not on the roster. */
function rosterIdFor(comm: string): string {
  return ROSTER.find((a) => a.bin === comm || a.match === comm)?.id ?? "";
}

// ------------------------------------------------------------- the state ----

/*
 * Persisted exactly the way issues.ts persists started work, and for the same
 * reasons: one JSON file under the config directory, written best-effort, and
 * reconciled against the filesystem on every read. Deliberately not the
 * database — the database is telemetry that retention prunes on a schedule, and
 * a run outliving its own events would then read as a run that never happened.
 */
const STATE_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass");
const STATE_FILE = join(STATE_DIR, "runs.json");

type StateFile = Record<string, Run>;

function readState(): StateFile {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")) as StateFile; } catch { return {}; }
}

function writeState(s: StateFile): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n");
  } catch { /* remembering is a nicety; failing to start a run over it is not */ }
}

/**
 * Every run, with each leg checked against the disk it claims to be on.
 *
 * The file is a record of intent and the filesystem is the truth — the rule
 * issues.ts states and this follows. The difference is what happens to a leg
 * whose directory has gone: issues.ts drops the entry, because an issue with no
 * worktree is simply not in progress. A run is a comparison, and a comparison
 * that quietly loses one of the things being compared is worse than useless, so
 * the leg is marked `gone` and stays visible. A run whose legs have ALL gone has
 * nothing left to point at and is dropped.
 */
export function currentRuns(root?: string): Run[] {
  const s = readState();
  const live: StateFile = {};
  let changed = false;
  for (const [id, run] of Object.entries(s)) {
    const legs = run.legs.map((l) => {
      if (l.state === "gone" || l.state === "released" || existsSync(l.worktree)) return l;
      changed = true;
      return { ...l, state: "gone" as LegState };
    });
    // Retired when nothing is left to track: the checkouts we cut are gone, and
    // the ones we borrowed have been handed back.
    if (legs.every((l) => l.state === "gone" || l.state === "released")) { changed = true; continue; }
    live[id] = { ...run, legs };
  }
  if (changed) writeState(live);
  return Object.values(live).filter((r) => !root || r.root === root);
}

export function runById(id: unknown): Run | null {
  return currentRuns().find((r) => r.id === String(id ?? "")) ?? null;
}

function saveRun(run: Run): Run {
  const s = readState();
  s[run.id] = run;
  writeState(s);
  return run;
}

/** For a suite that must not inherit the run before it. */
export function __clearRuns(): void { writeState({}); }

// -------------------------------------------------------------- the names ----

/**
 * The branch a leg gets, and by extension where its worktree goes.
 *
 * `run-8f2a1c-claude`: the run first so `git branch` sorts a run's legs
 * together, the agent last because that is the word that tells them apart at a
 * glance — which is the entire point of running the same prompt through two
 * vendors. A numeric suffix appears only when it has to, because two legs of
 * the same run may be the same agent with different starting points.
 *
 * Derived here rather than accepted from the caller for the reason issues.ts
 * derives its own: a branch name reaches `git worktree add -b`, and a name is
 * not a thing a socket reachable from the UI gets to choose.
 */
export function legBranch(runId: string, agent: string, taken: Set<string>): string {
  const stem = `run-${runId}-${agent || "agent"}`;
  if (!taken.has(stem)) { taken.add(stem); return stem; }
  for (let n = 2; ; n++) {
    const tried = `${stem}-${n}`;
    if (!taken.has(tried)) { taken.add(tried); return tried; }
  }
}

/**
 * Where a leg's worktree goes: beside the repository, named after its branch.
 *
 * The same rule `worktreePathFor` in issues.ts applies, with the branch given
 * rather than derived from an issue number. Calling that function instead would
 * mean inventing an issue number for work that has none, and `issue-0-…`
 * checkouts sitting in a directory listing is a lie told for the sake of reuse.
 * The shape is what `addWorktree` insists on — `<repo>-<name>` beside the repo —
 * so a path built any other way is refused there anyway.
 */
export function legPath(root: string, branch: string): string {
  const name = basename(root).replace(/\.git$/, "");
  return join(dirname(root), `${name}-${branch}`);
}

// -------------------------------------------------------------- starting ----

export interface RunLegSpec {
  /** Which agent, by roster id. */
  agent?: unknown;
  /** What the branch is cut from. Absent means HEAD, which is what "try this
   *  four ways from where I am" means. */
  from?: unknown;
  /** Permission prompts off for this leg. A boolean; the flag it buys belongs
   *  to agentArgv, not to whoever sent this. */
  yolo?: unknown;
}

export interface StartRunResult {
  ok: boolean;
  run?: Run;
  error?: string;
  detail?: string;
}

/**
 * The four things starting a leg needs, injectable so the burst below can be
 * exercised without a git repository or a tmux server.
 *
 * They are the same four calls the terminal socket already makes once each when
 * a card is sent to an agent — cut the worktree, work out the path, build the
 * argv, open a window running it. Nothing here is new machinery; what is new is
 * that all four happen on the server, in a loop, with every result awaited.
 */
export interface RunDeps {
  cut: (root: string, path: string, branch: string, from?: string) => { ok: boolean; error?: string };
  open: (root: string, name: string, argv: string[], cwd: string) => Promise<{ paneId: string; windowId: string } | null>;
  bin: (agent: string) => string | null;
  exists: (path: string) => boolean;
}

const REAL: RunDeps = {
  cut: (root, path, branch, from) => addWorktree(root, path, branch, true, from),
  open: (root, name, argv, cwd) => engineWindowRunning(root, name, argv, cwd),
  bin: agentBin,
  exists: existsSync,
};

/**
 * Start a run: N checkouts, N agents, one record.
 *
 * All of it happens HERE, which is the point of the route rather than an
 * implementation detail. The path this replaces went through the browser: the
 * panel left a request in a one-slot mailbox (web/src/lib/termIssue.ts, where
 * `requestTermIssue` assigns to a single `pending` and increments a counter),
 * the terminal view noticed and sent it over the socket, and the server opened
 * one window. Asking for four legs meant four assignments to that one slot
 * inside a frame — the last one wins, three are gone, and nothing anywhere
 * reports a loss, because overwriting a variable is not an error. That mailbox
 * is right for what it was built for, which is one press whose destination view
 * may not be mounted yet. It cannot carry a burst, and a run IS a burst.
 *
 * Sequential rather than `Promise.all`, deliberately. Each leg cuts a worktree
 * from the same repository, and `git worktree add` writes shared state under
 * `.git`; four of those racing is how you get a half-registered checkout. Four
 * spawns in a row is a fraction of a second, and nobody is typing behind it.
 *
 * A leg that fails does not fail the run. Three good checkouts and one refusal
 * is a comparison with three arms, which is worth having; throwing all of it
 * away because the fourth branch name collided is not.
 */
export async function startRun(
  rootIn: unknown,
  promptIn: unknown,
  legsIn: unknown,
  deps: RunDeps = REAL,
): Promise<StartRunResult> {
  const asked = safeAbs(rootIn);
  if (!asked || !deps.exists(asked)) return { ok: false, error: "invalid request" };
  // The repository, not wherever the caller happened to be standing. Every leg
  // is named `<repo>-<branch>` beside the repo — the shape addWorktree insists
  // on — so a root that is really a subdirectory would build paths git then
  // refuses, one leg at a time and with a confusing message.
  const root = repoRootOf(asked) ?? asked;
  const prompt = typeof promptIn === "string" ? promptIn.trim() : "";
  if (!inScope(root)) return { ok: false, error: "outside the open project" };
  if (!prompt) return { ok: false, error: "a run needs something to ask" };
  const specs = Array.isArray(legsIn) ? (legsIn as RunLegSpec[]) : [];
  if (!specs.length) return { ok: false, error: "a run needs at least one leg" };
  // A ceiling, because this cuts checkouts on somebody's disk. Far above what a
  // comparison is worth reading — past a handful of arms nobody looks at the
  // last ones — and low enough that a bug upstream cannot fill a filesystem.
  if (specs.length > 8) return { ok: false, error: "a run is capped at 8 legs" };

  const id = randomBytes(4).toString("hex");
  const taken = new Set<string>();
  const legs: RunLeg[] = [];
  const failed: string[] = [];

  for (const spec of specs) {
    const agent = ROSTER.find((a) => a.id === spec.agent)?.id ?? "";
    const branch = legBranch(id, agent, taken);
    const path = legPath(root, branch);
    if (deps.exists(path)) { failed.push(`${branch}: ${path} already exists`); continue; }
    const from = typeof spec.from === "string" && spec.from ? spec.from : undefined;
    const cut = deps.cut(root, path, branch, from);
    if (!cut.ok) { failed.push(`${branch}: ${cut.error ?? "could not cut the worktree"}`); continue; }

    // No agent for this leg is not a reason to open nothing: a shell in the
    // right checkout is still most of what was asked for, and it is the answer
    // every other spawner in this server gives. The leg records what it really
    // got, so a run does not later claim an agent compared anything.
    const bin = agent ? deps.bin(agent) : null;
    /*
     * And the command line is that agent's, not Claude Code's.
     *
     * This is the line the whole heterogeneous half turns on. A leg already
     * named its vendor and the binary was already resolved from it — but the
     * argv was built by the Claude path, so a codex leg got
     * `--dangerously-skip-permissions`, which codex does not know. An unknown
     * flag is not a degradation: the CLI prints usage and exits, so the window
     * opens and closes and the leg reads as tmux misbehaving. `launchArgv`
     * keeps the Claude path byte-identical and gives every other roster entry
     * its own spelling — see agents/launch.ts, where each one is quoted from
     * the module in this server that already drives that CLI.
     */
    const argv = launchArgv(agent, bin, { prompt, yolo: spec.yolo === true, title: "" });
    const opened = await deps.open(root, branch, argv, path);
    legs.push({
      worktree: path,
      branch,
      agent: bin ? agent : "",
      paneId: opened?.paneId ?? "",
      state: "running",
      origin: "spawned",
      startedAt: Date.now(),
    });
  }

  if (!legs.length) return { ok: false, error: failed[0] ?? "no leg could be started" };
  const run = saveRun({ id, root, prompt, legs, startedAt: Date.now() });
  return {
    ok: true,
    run,
    detail: failed.length
      ? `Started ${legs.length} of ${specs.length} legs — ${failed.join("; ")}`
      : `Started ${legs.length} leg${legs.length === 1 ? "" : "s"}`,
  };
}

// -------------------------------------------------------------- adopting ----

/**
 * What is running in a directory, and what it is called.
 *
 * Deliberately the opposite direction from paneloc.ts, which walks DOWN from a
 * pane's pid to answer "which directories are under this pane" — the question
 * the pane-to-session join asks, and where that file stays the single authority
 * on the join key. This asks "who is in THIS directory", which adoption needs
 * for a different fact: the vendor. A run whose legs cannot name their agents
 * is not recording the thing it exists to record.
 *
 * Asking it this way also survives the case the downward walk does not: reading
 * `/proc/<pid>/task/<pid>/children` needs a kernel built with
 * CONFIG_PROC_CHILDREN, and without it every pane reports no agent at all. A
 * scan of `/proc` costs a couple of hundred cheap reads and happens once, on a
 * button press, not on a poll.
 *
 * Linux only, stated rather than worked around, exactly as paneloc.ts states
 * it: `/proc` is where this answer lives. Elsewhere it comes back empty and the
 * caller's own label is used instead.
 */
export function agentIn(dir: string, proc = "/proc"): string {
  if (process.platform !== "linux") return "";
  let pids: string[];
  try { pids = readdirSync(proc); } catch { return ""; }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let comm: string;
    try { comm = readFileSync(join(proc, pid, "comm"), "utf8").trim(); } catch { continue; }
    const id = rosterIdFor(comm);
    if (!id) continue;
    try { if (readlinkSync(join(proc, pid, "cwd")) === dir) return id; } catch { /* it exited between the two reads */ }
  }
  return "";
}

/** The shape adoption needs out of the live pane list — the fields tmuxctl's
 *  `listPanes` already returns, named here so a test can hand over four rows
 *  without a tmux server. */
export interface AdoptablePane {
  paneId: string;
  /** The SHELL's directory. Kept because it is the only answer on a machine
   *  where the agent cannot be seen, and used only then — see below. */
  path: string;
  /** Every agent found under this pane, by the directory it is running in. */
  agentCwds: string[];
}

export interface AdoptResult {
  ok: boolean;
  run?: Run;
  leg?: RunLeg;
  error?: string;
  detail?: string;
}

/** The two things adoption learns from outside the process, injectable so the
 *  decisions below can be exercised without a tmux server or a machine that
 *  happens to have a codex running on it. */
export interface AdoptDeps {
  panes: () => AdoptablePane[];
  agentIn: (dir: string) => string;
}

const REAL_ADOPT: AdoptDeps = { panes: livePanes, agentIn: (dir) => agentIn(dir) };

/**
 * Attach a pane this app never started to a run.
 *
 * The differentiating half, and the whole of it is deciding WHICH DIRECTORY the
 * pane is working in. Everything else follows from that answer, and getting it
 * wrong attaches a leg to the wrong checkout — which is invisible, because a
 * leg that points somewhere plausible looks exactly like one that points
 * somewhere right.
 *
 * The order the answer is looked for in:
 *
 *   1. The agent process's own directory. Authoritative, and the reason
 *      paneloc.ts exists: `pane_current_path` is the SHELL's directory, and on
 *      a real machine several panes share one while the agent inside is off in
 *      a worktree. Measured there: three panes all reporting the repo root with
 *      the session in question running somewhere else entirely.
 *   2. Nothing, when a pane holds two agents. Two agents under one pane is an
 *      ordinary day, and picking one of them would be a confident wrong answer
 *      with no way to notice. Declining is the honest end of the question, and
 *      the caller has a sentence for it.
 *   3. The shell's directory, only when no agent is visible at all — a machine
 *      without `/proc`, or a CLI nobody has heard of. It is the weak answer, so
 *      it is only allowed through if git confirms it is a checkout of this
 *      run's repository, which is a much harder test than "it is a directory".
 *
 * Then git decides whether it belongs here. `worktrees(root)` lists every
 * checkout of this repository — the main one, the ones we cut, and the ones
 * somebody cut by hand years ago, which is precisely the case this feature is
 * for. A directory git does not list is not part of this repository, whatever
 * it looks like.
 */
export async function adoptPane(
  runIdIn: unknown,
  paneIdIn: unknown,
  agentHint: unknown,
  deps: AdoptDeps = REAL_ADOPT,
): Promise<AdoptResult> {
  const run = runById(runIdIn);
  if (!run) return { ok: false, error: "no such run" };
  const paneId = typeof paneIdIn === "string" ? paneIdIn.trim() : "";
  if (!paneId) return { ok: false, error: "which pane?" };

  // Already a leg: a second press on the same pane is somebody making sure, not
  // an error, and answering `ok` keeps a double click from reading as a fault.
  const had = run.legs.find((l) => l.paneId === paneId && l.state !== "gone");
  if (had) return { ok: true, run, leg: had, detail: "that pane is already in this run" };

  const row = deps.panes().find((p) => p.paneId === paneId);
  if (!row) return { ok: false, error: "that pane is not on this machine" };

  if (row.agentCwds.length > 1) {
    return { ok: false, error: "two agents are running under that pane — I cannot tell which one to track" };
  }
  const observed = row.agentCwds[0] ?? "";
  const where = safeAbs(observed || row.path);
  if (!where || !existsSync(where)) return { ok: false, error: "could not tell which directory that pane is working in" };
  // Owed even though nothing here came from us: this is reachable from the UI,
  // and a pane in another project is another project's business.
  if (!inScope(where)) return { ok: false, error: "that pane is outside the open project" };

  /*
   * The checkout it sits in, which is not always the directory itself: an agent
   * started in a monorepo subdirectory reports that subdirectory, and the leg
   * is about the checkout. Longest match wins, because `.worktrees/` lives
   * under the root and a shorter prefix would claim every one of them.
   */
  const list = await worktrees(run.root);
  const holder = list
    .filter((w) => w.path === where || isWithin(where, w.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!holder) {
    return { ok: false, error: `that pane is not in a checkout of ${basename(run.root)}` };
  }
  if (run.legs.some((l) => l.worktree === holder.path && l.state !== "gone")) {
    return { ok: false, error: "this run already has a leg in that checkout" };
  }
  /*
   * And no OTHER run may hold it either. A leg is an exclusive claim on a
   * directory, which is what lets the dashboard draw each session exactly once:
   * Fleet removes a claimed session from its project group and lets the run's
   * lane draw it instead. Remove it once, draw it twice, and one agent appears
   * as two — moving in step, in two places, and counted twice by anyone reading
   * the wall.
   *
   * Refused here rather than de-duplicated on the client, because the client
   * would have to pick a winner and the two lanes would then disagree about
   * whose leg it is. There is a right answer and it is "the one that claimed
   * it".
   */
  const elsewhere = currentRuns().find(
    (o) => o.id !== run.id && o.legs.some((l) => l.worktree === holder.path && l.state !== "gone" && l.state !== "released"),
  );
  if (elsewhere) {
    return { ok: false, error: `another run is already working in that checkout (${elsewhere.prompt.slice(0, 60)})` };
  }

  // What the machine can see beats what the caller believes, and the caller's
  // belief is only a label — it never reaches a command line, so a roster id is
  // all it is allowed to be.
  const seen = deps.agentIn(observed || holder.path);
  const agent = seen || (ROSTER.find((a) => a.id === agentHint)?.id ?? "");

  const leg: RunLeg = {
    worktree: holder.path,
    branch: holder.branch,
    agent,
    paneId,
    state: "running",
    origin: "adopted",
    startedAt: Date.now(),
  };
  const next = saveRun({ ...run, legs: [...run.legs, leg] });
  return { ok: true, run: next, leg, detail: `Adopted ${basename(holder.path)}` };
}

// ------------------------------------------------------------- finishing ----

export interface FinishRunResult {
  ok: boolean;
  run?: Run;
  error?: string;
  detail?: string;
  /** Uncommitted paths that stopped a teardown, so the refusal names them. */
  dirty?: string[];
}

/**
 * Call the run: one leg won, the rest lost, and the losers we made go away.
 *
 * The reason issues.ts has a `finishIssue` at all applies here several times
 * over — starting four checkouts without a way to put three of them back is how
 * somebody ends up with fourteen and no idea which is which. So the teardown is
 * the same one, with the same refusal on uncommitted work unless told twice.
 *
 * ADOPTED legs are never touched, and this is the load-bearing line in the
 * file. We did not cut that worktree, we do not know what else is in it, and
 * the person who let us watch their pane did not agree to us deleting their
 * afternoon. They are marked `lost` and left exactly where they are.
 */
export async function finishRun(
  runIdIn: unknown,
  winnerIn: unknown,
  force = false,
): Promise<FinishRunResult> {
  const run = runById(runIdIn);
  if (!run) return { ok: false, error: "no such run" };
  const winner = typeof winnerIn === "string" ? winnerIn.trim() : "";
  if (winner && !run.legs.some((l) => l.worktree === winner)) {
    return { ok: false, error: "that checkout is not a leg of this run" };
  }

  const losers = run.legs.filter(
    (l) => l.origin === "spawned" && l.state !== "gone" && l.worktree !== winner,
  );

  // Every dirty loser named at once, before anything is removed. Checking as we
  // go would delete the first two and then refuse over the third, which leaves
  // a run half torn down and a person with no way to tell what happened.
  const dirty: string[] = [];
  if (!force) {
    for (const l of losers) {
      const st = git(l.worktree, ["status", "--porcelain"]);
      const changed = st.stdout.split("\n").filter(Boolean).length;
      if (changed) dirty.push(`${basename(l.worktree)} (${changed})`);
    }
    if (dirty.length) {
      return { ok: false, error: `uncommitted work in ${dirty.length} of the losing checkouts`, dirty };
    }
  }

  const kept: string[] = [];
  for (const l of losers) {
    const rm = removeWorktree(run.root, l.worktree, force);
    if (!rm.ok) { kept.push(l.worktree); continue; }
    // `-d` refuses a branch that is not merged, which is exactly the check
    // wanted: a losing arm that turned out to contain something is not worth
    // deleting to tidy up. Forced, `-D` is what the second press bought.
    git(run.root, ["branch", force ? "-D" : "-d", l.branch]);
  }

  /*
   * Every non-winner is `lost`, including the ones just removed. `gone` is not
   * written here on purpose: it means "the directory is not there", and the
   * read reconciles that against the filesystem on the very next call. Deciding
   * it twice, in two places, is how the two answers start disagreeing about a
   * removal that half worked.
   */
  const legs = run.legs.map((l) => {
    if (l.state === "gone") return l;
    if (winner && l.worktree === winner) return { ...l, state: "won" as LegState };
    // An adopted leg that did not win is handed back rather than recorded as a
    // loser. It was never ours to lose, its checkout is untouched, and calling
    // it `lost` is what kept the run — and its claim on that directory — alive
    // for ever, since only `gone` and `released` legs let a run retire.
    if (l.origin === "adopted") return { ...l, state: "released" as LegState };
    return { ...l, state: "lost" as LegState };
  });
  const next = saveRun({ ...run, legs });

  const adopted = run.legs.filter((l) => l.origin === "adopted" && l.worktree !== winner).length;
  const parts = [`Removed ${losers.length - kept.length} of ${losers.length} losing checkouts`];
  if (kept.length) parts.push(`kept ${kept.map((p) => basename(p)).join(", ")}`);
  if (adopted) parts.push(`left ${adopted} adopted ${adopted === 1 ? "checkout" : "checkouts"} alone`);
  return { ok: true, run: next, detail: parts.join("; ") };
}

// -------------------------------------------------------- what it produced ----

/** One vendor's share of a bill. `provider` is the coarse vendor name the rest
 *  of this app files spend under — Anthropic, OpenAI, Google — derived from the
 *  MODEL each event carried, not from what anybody said they were running. */
export interface ProviderSpend {
  provider: string;
  events: number;
  costUsd: number;
}

export interface LegActivity {
  worktree: string;
  branch: string;
  agent: string;
  origin: LegOrigin;
  state: LegState;
  /** Sessions the database has recorded in this checkout. */
  sessions: number;
  events: number;
  toolCalls: number;
  errors: number;
  costUsd: number;
  /** What this leg cost, split by the vendor that charged for it. Usually one
   *  row; more than one when a session changed model mid-way, which is a thing
   *  that happens and which a single number cannot say. */
  providers: ProviderSpend[];
  /** Epoch millis of the last event seen there, or 0 for a leg that has not
   *  produced one — an agent that has not finished a turn, or a vendor whose
   *  events this machine does not collect. */
  lastSeen: number;
}

/**
 * What each leg has actually done, grouped by the set of directories it ran in.
 *
 * No column was added for this and nothing is tagged at write time, which is
 * the property worth having: `cwd_path` is a VIRTUAL generated column over the
 * event payload — see db.ts, where it is added with `GENERATED ALWAYS AS
 * (json_extract(payload, '$.cwd')) VIRTUAL` — so it applies to rows written
 * before this file existed, with no backfill pass over a multi-gigabyte table.
 * On `sessions` it is a real column that the same migration backfills from
 * those events.
 *
 * That is what makes ADOPTION retroactive rather than a subscription. A pane
 * somebody started three hours ago has three hours of history in there already,
 * filed under the directory it ran in; adopting it does not start collecting,
 * it starts LOOKING. A run tagged at write time could only ever have shown what
 * happened after somebody pressed a button.
 *
 * `IN (…)` over the leg set rather than a query per leg: one statement, and the
 * index db.ts builds on `cwd_path` is what it plans against.
 *
 * The BILL is asked for separately, and from `events` rather than `sessions`,
 * because a run with two vendors in it has to report two bills and the sessions
 * table cannot say that. `sessions.provider` is one column set
 * first-non-null-wins — db.ts says so where it adds the per-event column — so a
 * session that ran Opus and then GPT reports all of its money under whichever
 * of the two was seen first. A run exists to compare vendors, so a total that
 * silently attributes one vendor's spend to another is not a rounding problem,
 * it is the answer being wrong. Each event carries its own `provider`, derived
 * from the model that produced it, and `idx_events_provider_ts` is the index
 * that makes asking cheap.
 */
export function runActivity(run: Run): LegActivity[] {
  const dirs = run.legs.map((l) => l.worktree);
  const holes = dirs.map(() => "?").join(",");
  /*
   * Money, per checkout and per vendor, in one pass.
   *
   * `COALESCE(provider, …)` rather than dropping the NULLs: an event whose
   * model never resolved is stored with a NULL provider, and leaving those out
   * would make the per-vendor rows add up to less than the leg spent — the
   * exact reconciliation failure db.ts describes where it names this sentinel.
   * A bill that does not add up is worse than one with an "unknown" line in it.
   */
  const spend = dirs.length
    ? db
      .query<{ cwd: string; provider: string; events: number; cost: number }, string[]>(
        `SELECT cwd_path AS cwd,
                COALESCE(provider, ?) AS provider,
                COUNT(*) AS events,
                COALESCE(SUM(cost_usd), 0) AS cost
           FROM events
          WHERE cwd_path IN (${holes})
          GROUP BY cwd_path, provider`,
      )
      .all(UNKNOWN_PROVIDER, ...dirs)
    : [];
  const bills = new Map<string, ProviderSpend[]>();
  for (const r of spend) {
    const list = bills.get(r.cwd) ?? [];
    list.push({ provider: r.provider, events: r.events, costUsd: r.cost });
    bills.set(r.cwd, list);
  }
  // Dearest first. A comparison is read top down, and the line somebody is
  // looking for is the one that cost the money.
  for (const list of bills.values()) list.sort((a, b) => b.costUsd - a.costUsd || b.events - a.events);
  const rows = dirs.length
    ? db
      .query<{ cwd: string; sessions: number; events: number; tools: number; errors: number; cost: number; last: number }, string[]>(
        `SELECT cwd_path AS cwd,
                COUNT(*) AS sessions,
                COALESCE(SUM(event_count), 0) AS events,
                COALESCE(SUM(tool_count), 0) AS tools,
                COALESCE(SUM(error_count), 0) AS errors,
                COALESCE(SUM(cost_usd), 0) AS cost,
                COALESCE(MAX(last_seen), 0) AS last
           FROM sessions
          WHERE cwd_path IN (${holes})
          GROUP BY cwd_path`,
      )
      .all(...dirs)
    : [];
  const by = new Map(rows.map((r) => [r.cwd, r]));
  return run.legs.map((l) => {
    const r = by.get(l.worktree);
    return {
      worktree: l.worktree,
      branch: l.branch,
      agent: l.agent,
      origin: l.origin,
      state: l.state,
      sessions: r?.sessions ?? 0,
      events: r?.events ?? 0,
      toolCalls: r?.tools ?? 0,
      errors: r?.errors ?? 0,
      costUsd: r?.cost ?? 0,
      providers: bills.get(l.worktree) ?? [],
      lastSeen: r?.last ?? 0,
    };
  });
}

/**
 * The run's bills — one line per vendor it actually paid.
 *
 * A fold rather than a second query, so the numbers on the run cannot disagree
 * with the numbers on its legs: they are the same rows added up one level
 * higher. This is the sentence a heterogeneous run exists to produce — "the
 * same question, asked of two vendors, cost this much here and that much there"
 * — and it is the one thing a per-leg list does not say on its own once a run
 * has four legs across two vendors.
 *
 * Takes the activity rather than the run because the caller already has it: a
 * pane that draws the legs and the totals should pay for one query, not two.
 */
export function runSpend(legs: LegActivity[]): ProviderSpend[] {
  const total = new Map<string, ProviderSpend>();
  for (const leg of legs) {
    for (const p of leg.providers) {
      const held = total.get(p.provider) ?? { provider: p.provider, events: 0, costUsd: 0 };
      held.events += p.events;
      held.costUsd += p.costUsd;
      total.set(p.provider, held);
    }
  }
  return [...total.values()].sort((a, b) => b.costUsd - a.costUsd || b.events - a.events);
}

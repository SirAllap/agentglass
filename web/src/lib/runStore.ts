// Keeping a run current, without inventing a clock for it.
//
// A run is one prompt tried in several checkouts at once, and the half worth
// having is the leg this app never started: a pane the user opened by hand,
// running whatever agent they chose, tracked beside the ones we cut. See
// server/src/runs.ts, which is where that decision is written down.
//
// So the data behind a run moves for two quite different reasons, and they want
// two different answers:
//
//   the LIST of runs and their legs changes when a checkout appears or goes
//   away. Every one of those goes through the server's git layer, which already
//   broadcasts `{type:"git"}` on the socket the client is holding — see
//   server/src/gitwork.ts's afterMutation, and gitBus.ts on this side. Starting
//   a run cuts worktrees, finishing one removes them, and both therefore
//   announce themselves. Nothing new is polled for that.
//
//   what each leg has PRODUCED — turns, tool calls, errors, money — changes
//   because an agent did something, and nothing pushes that. The live event
//   feed carries the events themselves, but it is a React hook with no bus
//   behind it, so there is no non-component way to hear them from here. That
//   one is a poll, and the interval below is chosen rather than inherited.
//
// Written as a module-level store rather than a hook for the reason
// prBehindStore.ts is: no suite in this project has a DOM, so anything living
// inside `useEffect` can only be tested by reading it.

import { api, type Run, type LegActivity } from "./api.ts";
import { subscribeGitChanged } from "./gitBus.ts";

/**
 * How long after a git event before the list is re-read.
 *
 * Starting a run cuts up to eight worktrees, each of which fires its own
 * mutation, and finishing one removes them the same way. Coalescing is the
 * difference between one read and eight — the number changeRows.ts settles for
 * the same reason, and for the same length of time.
 */
const SETTLE_MS = 250;

/**
 * The safety net for the list, not the mechanism.
 *
 * The `git` frame covers everything that happens THROUGH the app. What it
 * cannot cover: an adoption made from another window (adopting touches no
 * checkout, so git never hears about it), and a worktree somebody removed by
 * hand in a terminal, which is what turns a leg `gone`. Neither is urgent —
 * both are somebody else's action arriving late — and `/runs` is a JSON file
 * plus one `stat` per leg, no git and no database. Half a minute is well inside
 * the time it takes to notice, and two reads a minute of that is nothing.
 */
const LIST_SAFETY_MS = 30_000;

/**
 * How often an OPEN run's activity is re-read.
 *
 * A poll, deliberately, because there is nothing to subscribe to: the numbers
 * come from the events table and the only push that would carry them is the
 * live socket's per-event frame, which this module cannot reach.
 *
 * Five seconds, and the number is a judgement about what the panel is for. It
 * exists to watch two agents race, so a cost that updates once a minute makes
 * the comparison useless; and each read is a single indexed query over
 * `cwd_path` returning a few hundred bytes per leg, so it is not the megabyte
 * poll the old diff view was punished for. It runs only while a lane is open
 * and only while the document is visible — the rule usePoll.ts states, honoured
 * here rather than borrowed, because this is not a hook.
 */
const ACTIVITY_MS = 5_000;

/** True when two lists differ in anything a reader would see.
 *
 *  Compared field by field rather than by id, because the ids do not move: a
 *  leg going `gone`, an adopted pane arriving, or a run being called leaves the
 *  same run with the same id and a different story. Comparing ids alone is the
 *  exact bug the Diff view shipped — see rowsDiffer in changeRows.ts. */
export function runsDiffer(a: Run[], b: Run[]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    if (x.id !== y.id || x.root !== y.root || x.prompt !== y.prompt || x.startedAt !== y.startedAt) return true;
    if (x.legs.length !== y.legs.length) return true;
    for (let j = 0; j < x.legs.length; j++) {
      const p = x.legs[j]!, q = y.legs[j]!;
      if (p.worktree !== q.worktree || p.branch !== q.branch || p.agent !== q.agent ||
          p.paneId !== q.paneId || p.state !== q.state || p.origin !== q.origin) return true;
    }
  }
  return false;
}

/** True when two activity readings differ. `lastSeen` is in it on purpose: a
 *  leg whose agent produced one more event has moved even when the counts
 *  round to the same thing. */
export function activityDiffers(a: LegActivity[], b: LegActivity[]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    if (x.worktree !== y.worktree || x.state !== y.state || x.sessions !== y.sessions ||
        x.events !== y.events || x.toolCalls !== y.toolCalls || x.errors !== y.errors ||
        x.costUsd !== y.costUsd || x.lastSeen !== y.lastSeen ||
        (x.providers?.length ?? 0) !== (y.providers?.length ?? 0)) return true;
    /* `?? []` on both sides: an older server, or one answering from a version
       of the row written before providers existed, sends the field absent rather
       than empty — and this runs inside a promise nobody is awaiting. */
    const xs = x.providers ?? [], ys = y.providers ?? [];
    for (let j = 0; j < xs.length; j++) {
      const p = xs[j]!, q = ys[j]!;
      if (p.provider !== q.provider || p.events !== q.events || p.costUsd !== q.costUsd) return true;
    }
  }
  return false;
}

/**
 * What is known about one repository's runs.
 *
 * `loading` is only ever true before the FIRST answer. A refresh keeps showing
 * what is on screen: blanking a list somebody is reading in order to say
 * "loading" is worse than a second of staleness.
 */
export type RunsState = { runs: Run[]; loading: boolean; error: string | null };

const EMPTY: RunsState = { runs: [], loading: true, error: null };

const lists = new Map<string, RunsState>();
const activity = new Map<string, { legs: LegActivity[]; loading: boolean; error: string | null }>();
const listeners = new Set<() => void>();

function tell(): void {
  // One bad listener must not stop the rest — the rule gitBus.ts states.
  for (const fn of listeners) { try { fn(); } catch { /* keep going */ } }
}

/** Subscribe to anything in here changing. Returns the unsubscribe. */
export function subscribeRuns(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** This repository's runs as last read. Never null, so a caller can draw a list
 *  and an empty state without a branch — and empty is what day one looks like. */
export function runsOf(root: string): RunsState {
  return lists.get(root) ?? EMPTY;
}

/** One run's per-leg activity as last read, or nothing while it is unknown. */
export function activityOf(id: string): { legs: LegActivity[]; loading: boolean; error: string | null } {
  return activity.get(id) ?? { legs: [], loading: true, error: null };
}

/** One run out of the list, by id. */
export function runOf(root: string, id: string): Run | null {
  return runsOf(root).runs.find((r) => r.id === id) ?? null;
}

const listInFlight = new Set<string>();

/**
 * Read the list now.
 *
 * Called on every write this client makes, because that is the one change the
 * `git` frame is not reliably enough for: adoption cuts nothing, so it
 * announces itself to nobody. Awaited, so a caller can chain a redraw off it.
 */
export async function refreshRuns(root: string): Promise<void> {
  if (listInFlight.has(root)) return; // a burst of git events is still one read
  listInFlight.add(root);
  try {
    const r = await api.runs(root);
    const prev = lists.get(root);
    const next = r.runs ?? [];
    lists.set(root, {
      // Held rather than replaced when nothing a reader would see has changed,
      // so an open lane does not re-render under somebody's cursor twice a
      // minute for no reason.
      runs: prev && !runsDiffer(prev.runs, next) ? prev.runs : next,
      loading: false,
      error: null,
    });
  } catch (e) {
    const prev = lists.get(root);
    lists.set(root, {
      runs: prev?.runs ?? [],
      loading: false,
      error: e instanceof Error ? e.message : "could not read the runs",
    });
  } finally {
    listInFlight.delete(root);
    tell();
  }
}

const activityInFlight = new Set<string>();

/** Read one run's activity now. A run finished from another window answers
 *  `ok:false` with the server's own reason rather than throwing — see
 *  api.runActivity, which reads the 404's body for exactly this. */
export async function refreshActivity(id: string): Promise<void> {
  if (activityInFlight.has(id)) return;
  activityInFlight.add(id);
  try {
    const r = await api.runActivity(id);
    const prev = activity.get(id);
    activity.set(id, {
      legs: prev && !activityDiffers(prev.legs, r.legs) ? prev.legs : r.legs,
      loading: false,
      error: r.ok ? null : (r.error ?? "that run is gone"),
    });
  } catch (e) {
    /*
     * Caught here rather than left to the caller, because both callers discard
     * the promise — the effect in RunLane and the interval in watchActivity
     * both `void` it. A throw from either is an unhandled rejection with no
     * component anywhere near it, which in a browser is a console entry nobody
     * reads and, under a test runner, a failure attributed to whatever happened
     * to be running at the time.
     *
     * The screen keeps the numbers it already had and says why they stopped
     * moving. Stale-and-labelled beats blank, and it beats a zero.
     */
    activity.set(id, {
      legs: activity.get(id)?.legs ?? [],
      loading: false,
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    activityInFlight.delete(id);
    tell();
  }
}

/* ── watching ─────────────────────────────────────────────────────────────── */

/*
 * Both watchers are reference counted.
 *
 * A run appears in more than one place — a lane, a chip, whatever else grows
 * later — and each of those mounting its own subscription and its own interval
 * is how a panel ends up asking the same question four times a second. The
 * first caller starts the machinery, the last one to let go stops it.
 */

type Watch = { count: number; stop: () => void };
const listWatch = new Map<string, Watch>();
const activityWatch = new Map<string, Watch>();

/** Whether the document is somewhere a person can see. Guarded because these
 *  modules are imported by suites that have no DOM. */
const visible = (): boolean => typeof document === "undefined" || !document.hidden;

/**
 * Keep this repository's run list current for as long as the returned function
 * has not been called.
 *
 * The subscription is the mechanism and the interval is the net — see the two
 * constants at the top of this file for which change each of them catches.
 */
export function watchRuns(root: string): () => void {
  const had = listWatch.get(root);
  if (had) { had.count++; return () => release(listWatch, root); }

  void refreshRuns(root);
  let settle: ReturnType<typeof setTimeout> | null = null;
  const off = subscribeGitChanged(() => {
    if (settle) clearTimeout(settle);
    settle = setTimeout(() => { void refreshRuns(root); }, SETTLE_MS);
  });
  const iv = setInterval(() => { if (visible()) void refreshRuns(root); }, LIST_SAFETY_MS);
  listWatch.set(root, {
    count: 1,
    stop: () => { off(); clearInterval(iv); if (settle) clearTimeout(settle); },
  });
  return () => release(listWatch, root);
}

/** Keep one run's activity current while a lane is open. */
export function watchActivity(id: string): () => void {
  const had = activityWatch.get(id);
  if (had) { had.count++; return () => release(activityWatch, id); }

  void refreshActivity(id);
  const iv = setInterval(() => { if (visible()) void refreshActivity(id); }, ACTIVITY_MS);
  activityWatch.set(id, { count: 1, stop: () => clearInterval(iv) });
  return () => release(activityWatch, id);
}

function release(where: Map<string, Watch>, key: string): void {
  const w = where.get(key);
  if (!w) return;
  w.count--;
  if (w.count > 0) return;
  w.stop();
  where.delete(key);
}

/** Forget everything and stop watching — for a test, or a repository that has
 *  just changed under the panel. */
export function forgetRuns(): void {
  for (const w of listWatch.values()) w.stop();
  for (const w of activityWatch.values()) w.stop();
  listWatch.clear();
  activityWatch.clear();
  lists.clear();
  activity.clear();
  listInFlight.clear();
  activityInFlight.clear();
}

/**
 * Forget everything — caches, listeners, and every live watcher's clock.
 *
 * For tests, and named like server/src/runs.ts's `__clearRuns` because it is
 * the same problem. This is a module-level store and a whole test suite runs in
 * one process, so a watcher a previous FILE forgot to stop is still subscribed
 * when the next one starts: its reads land in the next file's counters and a
 * test asserting "eight events caused one read" sees two. That failure is not
 * flakiness — it is deterministic, and it points at the wrong file.
 *
 * Every watcher is dropped rather than paused. A test that wants one says so.
 */
export function __resetRunStore(): void {
  // `stop` is each watcher's own teardown — it clears its interval and drops
  // its git subscription. Calling it is what makes this a reset rather than a
  // leak with the map emptied on top of it.
  for (const w of [...listWatch.values(), ...activityWatch.values()]) w.stop();
  listWatch.clear();
  activityWatch.clear();
  lists.clear();
  activity.clear();
  listeners.clear();
  listInFlight.clear();
  activityInFlight.clear();
}

/*
 * WHAT A FLOW CARD MEANS BY "NOW", read off the board's rows and nothing else.
 *
 * One reader of `/agents/board` already exists for the whole app
 * (`lib/lanternStore.ts`, 20 s slow / 5 s fast); this is the arithmetic on top
 * of it, so the worker cards and the orchestrator's hero print one count from
 * one answer. It adds no request and no second poller, and it is pure — no
 * React, no fetch — because every case below is the shape of a row, and a row
 * is easier to state than a screen.
 *
 * What it cannot do, and a card must not pretend otherwise: `wait` is "waiting
 * on a person", not a queue. Nothing in the app queues a worker except a
 * launched flight-plan builder (`flightPlan.maxFlying`), so "2 queued" (which
 * the mockup draws) would be an invented number. `cost` is what the board's
 * rows carry, not a date-ranged ledger: a row that has left the board takes
 * its cost with it. `of` is the project's own `limits.maxWorkers` (1–12,
 * default 3), never the mockup's 6.
 *
 * A flow belongs to one project, so every count takes that project's folder
 * and reads only the rows whose checkout rolls up to it: another project's
 * builder is not this flow's builder.
 */
import type { Flow } from "../../../shared/flow.ts";

export interface RoleCounts {
  /** Rows of this role that are working right now. */
  run: number;
  /** Rows stopped on a person: a permission, a gate, or a turn that ended. */
  wait: number;
  /** What the board's rows of this role carry in `facts.cost`, in USD. */
  cost: number;
}

/**
 * The fields of a board row this reads, no more.
 *
 * `LanternRow` is the shape the app actually has, and the hook that feeds this
 * is where the two meet, so a field this stops reading disappears from the
 * contract and one the row loses fails to compile there. Declared here so a
 * test can hand two rows and no renderer.
 */
export interface LiveRow {
  name: string;
  /** The Lantern's own chat, or the project's seat. Neither is a worker. */
  role?: "lantern" | "orchestrator";
  state: "working" | "waiting" | "idle";
  needsYou?: { kind: "permission" | "input" | "gate"; why: string; since: number };
  /** The role the registry started it as: `startedBy.role` on the server, or
   *  the engine's kind when a person's own tab was adopted. */
  worker?: { role: string; since?: number };
  /** The same answer on the raw stamp, for a caller that has not dropped it.
   *  `engine` is here so the stamp the board really hands (`Origin`, which
   *  drops `role`) still satisfies this shape. */
  startedBy?: { engine?: string; role?: string };
  session?: string;
  /** Names this session used before, newest first — see `BoardRow.wasCalled`. */
  wasCalled?: string[];
  /** The project its worktree rolls up to, as the server read it off git. */
  project?: string;
  /** The checkout itself, for a row the server could not roll up to a project. */
  worktree?: string;
  saidAt?: number;
  startedAt?: number;
  doing?: string;
  facts?: { cost?: number };
}

/**
 * The role a row runs as, or null when it runs as none: the app's own readers
 * (the Lantern's chat, the project's seat), a person's own tab, or a worker
 * whose registry row only knew its engine. Nothing is read off the name — the
 * registry already answers this from `startedBy.role`, and a window's title is
 * somebody's words.
 */
export function roleOf(row: LiveRow): string | null {
  if (row.role) return null;
  const role = row.worker?.role?.trim() || row.startedBy?.role?.trim();
  return role || null;
}

/**
 * Which flow role a board role is: its own id, or the policy role a built-in
 * role answers to (`planner` runs as `scout`, `inspector` as `reviewer`). Two
 * flow roles on one policy role are one screen with no way to tell them apart,
 * so the first in the roster owns it.
 */
function roleIds(flow: Flow): Map<string, string> {
  const by = new Map<string, string>();
  for (const r of flow.roster) {
    if (!by.has(r.id)) by.set(r.id, r.id);
    if (r.policyRole && !by.has(r.policyRole)) by.set(r.policyRole, r.id);
  }
  return by;
}

/**
 * The project a row's checkout belongs to: the roll-up the server did, or the
 * worktree when it could not, as `starboardScope.projectOf` states over the
 * fields this module reads. `""` is no project, and a row with neither field
 * reads as `""` — so an empty `project` counts those rows; the hook refuses one.
 */
function projectOf(row: LiveRow): string {
  return row.project ?? row.worktree ?? "";
}

/**
 * One entry per role of the flow's roster — zeros, never a missing key, so a
 * card can ask for any role it draws. A row of another project is not this
 * flow's, and a row whose role the flow does not have (a role removed from the
 * roster) is counted nowhere: neither is an error.
 */
export function liveByRole(rows: readonly LiveRow[], flow: Flow, project: string): Record<string, RoleCounts> {
  const counts: Record<string, RoleCounts> = {};
  for (const r of flow.roster) counts[r.id] = { run: 0, wait: 0, cost: 0 };
  const by = roleIds(flow);
  // The fold is this project's, or a rename elsewhere would swallow this
  // project's row of the same name.
  const mine = rows.filter((r) => projectOf(r) === project);
  const folded = new Set<string>();
  for (const r of mine) for (const n of r.wasCalled ?? []) folded.add(n);
  for (const row of mine) {
    // One session, once: a row still drawn under a name another row folds in
    // is the same session, and its cost would be counted twice.
    if (folded.has(row.name)) continue;
    const role = roleOf(row);
    const id = role ? by.get(role) : undefined;
    if (!id) continue;
    const c = counts[id];
    // One row is one thing: stopped on a person outranks running.
    if (row.needsYou || row.state === "waiting") c.wait++;
    else if (row.state === "working") c.run++;
    c.cost += row.facts?.cost ?? 0;
  }
  return counts;
}

/**
 * The workers of the whole flow in flight, against the project's own ceiling:
 * `of` is `policy.limits.maxWorkers`, whatever it is.
 */
export function inFlight(counts: Record<string, RoleCounts>, limits: { maxWorkers: number }): { n: number; of: number } {
  let n = 0;
  for (const c of Object.values(counts)) n += c.run;
  return { n, of: limits.maxWorkers };
}

export interface LastDecision {
  /** The flow role that settled. */
  role: string;
  /** What it said it did, in its own words. */
  line: string;
  /** When it last said so — the board's stamp, for "12 m ago". */
  at: number;
}

/**
 * The most recent line a worker of this flow settled on: what the
 * orchestrator's card prints as its last decision.
 *
 * Settled means its turn is over (`state: "idle"`) and it is not stopped on a
 * person; one still running has decided nothing yet. A worker that settled
 * without saying anything is skipped, so the line is the newest one that
 * exists. Null when nothing has settled, or when no row of this project's
 * roles is this flow's.
 */
export function lastDecision(rows: readonly LiveRow[], flow: Flow, project: string): LastDecision | null {
  const by = roleIds(flow);
  let best: LastDecision | null = null;
  for (const row of rows) {
    if (projectOf(row) !== project) continue;
    if (row.state !== "idle" || row.needsYou) continue;
    const role = roleOf(row);
    const id = role ? by.get(role) : undefined;
    const line = row.doing?.trim();
    if (!id || !line) continue;
    const at = row.saidAt ?? row.startedAt ?? 0;
    if (!best || at > best.at) best = { role: id, line, at };
  }
  return best;
}

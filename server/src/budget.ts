import type { Budget, BudgetPeriod, BudgetStatus } from "../../shared/types.ts";
import { spendBetween } from "./db.ts";
import { readBudgets, inScope } from "./config.ts";
import { paneForSession, paneAgentNote } from "./panewt.ts";

/**
 * A number you chose, instead of one this app picked.
 *
 * The spend insights fired on constants — $15 in fifteen minutes is "burning
 * fast", $60 an hour is a warning — which means they are noise on a project
 * that genuinely costs that, and silent on one where a tenth of it would be
 * alarming. There was no way to say "this should not cost more than X a day"
 * and be told when it does.
 *
 * A budget is deliberately three things: how much, over what period, for what.
 * Not a rate, not a forecast, not a per-session cap. "£40 a month on this
 * repository" is a sentence somebody can say about their own work; "$0.94 an
 * hour averaged over a trailing window" is not, and the second kind of setting
 * is the kind that gets set once and never understood again.
 *
 * Evaluated against the rollup as well as live events, which is what #292 made
 * possible: on a default install raw events are kept for eight days, so before
 * that a monthly budget was a weekly budget wearing a monthly label.
 */

/** Fraction of the limit at which a budget starts warning.
 *
 *  Before the limit rather than only at it: a budget you are told about the
 *  moment you cross it is a receipt, not a control. Four fifths leaves room to
 *  do something and is late enough not to fire on an ordinary Tuesday. */
export const WARN_AT = 0.8;

/** A budget with nothing filled in, for a UI that is adding one. */
export const emptyBudget = (): Budget => ({ root: "", model: "", limit: 0, period: "month" });

/** UTC, and the same UTC the rollup's days are in. A budget evaluated in local
 *  time against days recorded in UTC would jump at whichever midnight came
 *  first, which on the last day of a month is a whole period out. */
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The window a period covers, ending today.
 *
 * Calendar periods, not trailing windows. "This month" is what somebody means
 * by a monthly budget — it resets, and the reset is the thing that makes the
 * number feel like a budget rather than a rolling average. A trailing 30 days
 * never resets, so it can only ever creep towards the limit and stay there.
 *
 * The week starts on Monday, which is what most of the world means by a week
 * and what every calendar the user is also looking at will agree with.
 */
export function periodWindow(period: BudgetPeriod, now = Date.now()): { fromDay: string; toDay: string } {
  const d = new Date(now);
  const toDay = dayOf(now);
  if (period === "day") return { fromDay: toDay, toDay };
  if (period === "week") {
    // getUTCDay: 0 is Sunday, so Monday-start means Sunday counts as six days in.
    const back = (d.getUTCDay() + 6) % 7;
    return { fromDay: dayOf(now - back * 86_400_000), toDay };
  }
  return { fromDay: `${toDay.slice(0, 7)}-01`, toDay };
}

/** Human words for a period, used in the insight's own title. */
export const periodLabel = (p: BudgetPeriod): string =>
  p === "day" ? "today" : p === "week" ? "this week" : "this month";

/**
 * A budget worth acting on.
 *
 * Anything without a positive limit is ignored rather than treated as zero: a
 * half-filled row in the settings pane must not start reporting every project
 * as infinitely over budget.
 */
export const usable = (b: Budget): boolean => Number.isFinite(b.limit) && b.limit > 0;

/**
 * What each budget has spent, and whether that is a problem yet.
 *
 * `spend` is injected so the evaluation can be driven without a database — the
 * arithmetic and the boundaries are what is worth testing here, and they are
 * the part that is wrong in ways nobody notices for a month.
 */
export function budgetStatus(
  budgets: Budget[] = readBudgets(),
  now = Date.now(),
  spend: typeof spendBetween = spendBetween,
): BudgetStatus[] {
  return budgets.filter(usable).map((b) => {
    const { fromDay, toDay } = periodWindow(b.period, now);
    const spent = spend({ fromDay, toDay, root: b.root || null, model: b.model || null });
    // Guarded even though `usable` already rejects a zero limit: this is a
    // denominator, and the one thing worse than a wrong budget is an Infinity
    // rendered as a percentage on somebody's dashboard.
    const pct = b.limit > 0 ? spent / b.limit : 0;
    return {
      budget: b,
      fromDay,
      toDay,
      spent,
      pct,
      level: pct >= 1 ? "over" : pct >= WARN_AT ? "warn" : "ok",
    };
  });
}

/** What a status is about, in the words the insight will use. */
export function budgetScopeLabel(b: Budget): string {
  const where = b.root ? b.root.split("/").filter(Boolean).pop() || b.root : "everything";
  return b.model ? `${where} · ${b.model}` : where;
}

/**
 * Which budget a tool call running in `cwd` has already blown, or null.
 *
 * Everything else in this file answers "how are we doing"; this one answers
 * "should somebody be told before the next call runs", which is the question a
 * gate can act on and a progress bar cannot. See budgetHoldReason() and the
 * caller in gate.ts.
 *
 * The one thing it must never do is invent a limit. A project with no budget, a
 * budget whose limit never parsed, a session whose directory could not be
 * recovered — all of those answer null, because the alternative is a cost
 * tracker that stops somebody's agents over a number nobody chose, and that is
 * a worse product than one that only reports.
 *
 * `inScope` decides whether a budget covers this directory, rather than a
 * prefix test written here. A budget on ~/code/orbit has to cover the linked
 * worktree at ~/code/orbit-WEB-1042 — which is where the work actually happens
 * and which no prefix test will ever match — and that is exactly the rule
 * inScope already implements for the workspace scope. It also gives both edges
 * for free: a budget with no root is "everything" and therefore covers a
 * directory we could not place, and a budget WITH a root does not cover an
 * unknown directory, because guessing which project an agent is in is how the
 * wrong fleet gets stopped.
 *
 * When several are over, the one furthest past its limit wins: somebody who is
 * about to be shown a single number wants the worst one.
 */
export function overBudgetFor(
  cwd: string,
  statuses: BudgetStatus[] = budgetStatus(),
): BudgetStatus | null {
  let worst: BudgetStatus | null = null;
  for (const s of statuses) {
    if (s.level !== "over") continue;
    if (!inScope(cwd, s.budget.root)) continue;
    if (!worst || s.pct > worst.pct) worst = s;
  }
  return worst;
}

/**
 * The sentence a person reads while an agent is held at the gate.
 *
 * Three facts, and the third is the one every spend warning leaves out: the
 * limit, what has gone through it, and what happens if they put the phone down.
 * The gate is fail-open by default — the hold expires and the call proceeds —
 * so a line that stops after the first two reads like a block, and somebody
 * would go scrambling to approve a call that was never going to be stopped.
 * Under AGENTGLASS_GATE_FAILCLOSED the same silence denies it instead, which is
 * the opposite mistake to make, so the policy in force is what gets said.
 *
 * Opens with the same words as the dashboard insight ("Over budget · $x of $y
 * this month") on purpose: the red bar and the held call are one fact, and two
 * phrasings of it read as two problems.
 */
export function budgetHoldReason(s: BudgetStatus, failClosed = false): string {
  const head = `Over budget · $${s.spent.toFixed(2)} of $${s.budget.limit.toFixed(2)} ${periodLabel(s.budget.period)} for ${budgetScopeLabel(s.budget)}`;
  return failClosed
    ? `${head} — agentglass is fail-closed, so if you do nothing this call is denied when the hold expires.`
    : `${head} — nothing is blocked by the budget itself: if you do nothing this call proceeds when the hold expires.`;
}

/**
 * The budget reason for a gated call, or undefined when there is none.
 *
 * It lives here rather than in gate.ts because reaching budget.ts from there
 * adds the edge gate → budget → config, and the gate is imported by a great
 * many modules. Bun keeps a `require()` of a local module as a static
 * dependency, so deferring does not undo it: the edge changes WHEN config.ts
 * and the database layer first initialise for every consumer of the gate, and
 * the server suite runs in one process — which cost ten tests in a file the
 * budget work never touched. Holding a call is what the gate is; deciding which
 * policies are worth holding one for belongs out here.
 *
 * Never throws. It reads config.json and queries SQLite, and a throw on this
 * path would leave /gate answering 500 — allowed by a fail-open hook and DENIED
 * by a fail-closed one. An annotation must not be able to block a tool call by
 * crashing.
 */
export function budgetHoldFor(session: string, failClosed: boolean): string | undefined {
  try {
    // The gate payload carries no cwd. The hook records a pane note that does,
    // which is how describeSession recovers it too. No pane note means no
    // project, and no project means no project budget — overBudgetFor refuses
    // to guess one.
    const pane = paneForSession(session);
    const over = overBudgetFor(pane ? paneAgentNote(pane)?.cwd ?? "" : "");
    return over ? budgetHoldReason(over, failClosed) : undefined;
  } catch (e) {
    console.warn("[gate] budget check skipped:", e instanceof Error ? e.message : e);
    return undefined;
  }
}

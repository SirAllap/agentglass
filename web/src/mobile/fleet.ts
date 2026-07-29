import type { Insight, CostByModel, AppUsage, SessionRollup } from "../../../shared/types.ts";

/**
 * What the fleet is costing and where it is going wrong.
 *
 * The server has computed all of this from the beginning — `/insights` names
 * the session stuck in a loop, the one burning tokens, the one throwing errors;
 * `/stats` breaks spend down by model and by app. The phone showed three
 * numbers in a Settings sheet (spend, sessions, tool errors) and had no route
 * to any of the rest. "Which agent is the expensive one" and "is anything
 * looping right now" were unanswerable from the device you are holding when
 * you are away from the desk, which is the only time it matters.
 *
 * The two decisions worth testing are here: which insight to read first, and
 * how to get from an insight back to the conversation it is about.
 */

/**
 * From an insight to a session you can open.
 *
 * The server labels an insight `"<app>:<first 8 of the uuid>"` — enough for a
 * human to recognise and not enough to open. Matching it back is a prefix
 * lookup, and it has to be anchored on both halves: eight hex characters
 * collide often enough on a busy machine, and opening the wrong conversation
 * from an alert about a runaway agent is worse than opening none.
 */
export function sessionForInsight(
  label: string | null | undefined,
  sessions: readonly SessionRollup[],
): SessionRollup | null {
  if (!label) return null;
  const cut = label.lastIndexOf(":");
  if (cut < 1) return null;
  const app = label.slice(0, cut);
  const prefix = label.slice(cut + 1);
  if (!prefix) return null;
  const hits = sessions.filter((s) => s.source_app === app && s.session_id.startsWith(prefix));
  // Exactly one, or nothing. Two matches means the prefix is not an identity
  // here, and picking either is a coin toss dressed up as an answer.
  return hits.length === 1 ? hits[0]! : null;
}

const SEVERITY: Record<Insight["severity"], number> = { bad: 0, warn: 1, info: 2 };

/** Worst first, then newest. Same shape as the Now queue, for the same reason:
 *  the top of the list has to be the thing to look at. */
export function orderInsights(insights: readonly Insight[]): Insight[] {
  return [...insights].sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || b.ts - a.ts);
}

export interface SpendRow {
  name: string;
  cost: number;
  /** Of the total, 0–1. */
  share: number;
  sessions: number;
  /** The model reported no price, so its cost is not a cost — it is a blank. */
  unpriced: boolean;
}

/**
 * Spend by model, biggest first, with each one's share of the total.
 *
 * A bar needs a denominator, and the denominator has to be the sum of what is
 * drawn rather than the fleet's total spend: `by_model` can omit a model whose
 * price is unknown, and dividing by a larger total would draw every bar short
 * and quietly understate all of them.
 */
export function spendByModel(rows: readonly CostByModel[]): SpendRow[] {
  const total = rows.reduce((n, r) => n + (r.cost_usd || 0), 0);
  return [...rows]
    .sort((a, b) => (b.cost_usd || 0) - (a.cost_usd || 0))
    .map((r) => ({
      name: r.model_name || "unknown",
      cost: r.cost_usd || 0,
      // No division by zero, and no bar at all when nothing has been spent —
      // a full-width bar for $0.00 is the wrong answer to "where did it go".
      share: total > 0 ? (r.cost_usd || 0) / total : 0,
      sessions: r.sessions || 0,
      unpriced: !!r.unpriced,
    }));
}

/** The same, per agent runtime. */
export function spendByApp(rows: readonly AppUsage[]): SpendRow[] {
  const total = rows.reduce((n, r) => n + (r.cost_usd || 0), 0);
  return [...rows]
    .sort((a, b) => (b.cost_usd || 0) - (a.cost_usd || 0))
    .map((r) => ({
      name: r.source_app || "unknown",
      cost: r.cost_usd || 0,
      share: total > 0 ? (r.cost_usd || 0) / total : 0,
      sessions: r.sessions || 0,
      unpriced: false,
    }));
}

/**
 * The share of tool calls that failed.
 *
 * `errors` counts LLM spans and notifications too, so dividing it by
 * `tool_calls` is comparing two different populations — see the note on
 * `tool_errors` in shared/types.ts. Null when the server did not send the
 * narrower figure, because a wrong rate is worse than no rate.
 */
export function errorRate(totals: {
  tool_calls?: number; tool_errors?: number;
} | null | undefined): number | null {
  if (!totals) return null;
  const calls = totals.tool_calls ?? 0;
  const errs = totals.tool_errors;
  if (errs == null || calls <= 0) return null;
  return errs / calls;
}

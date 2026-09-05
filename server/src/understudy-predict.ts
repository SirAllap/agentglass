/*
 * Guessing what you will do, from what you have done.
 *
 * No model, no network, no key. This is the cheapest predictor that is not a
 * coin toss, and building it first is deliberate: it answers "is there signal
 * in this person's history at all" for the price of an afternoon, before
 * anybody spends money or sends a byte anywhere. If nearest-neighbour over a
 * year of somebody's own decisions cannot beat chance, a language model reading
 * the same rows is unlikely to rescue it, and that is worth knowing early.
 *
 * WHERE IT LEARNS FROM, and this is the part that surprised me.
 *
 * Not the ingested precedent bank. Those rows carry what he SAID — a sentence
 * out of a transcript, a line from a worklog — and the thing being predicted is
 * a categorical shape like `{"base":"main","pattern":"feat/"}`. There is no
 * honest way to compare "go on, merge it" against that, and pretending otherwise
 * would produce a verdict of `differ` every time and call it a measurement.
 *
 * So the predictor reads the LEDGER: past decisions of the same class where an
 * `actual` was recorded. That is a smaller corpus and a real one — every row is
 * a thing he did, in the exact shape the next one will be scored in. The
 * ingested bank is not wasted; it compiles into the policy, and it is what a
 * language model would read for context when there is one. The two corpora
 * answer different questions and this module only has one of them.
 *
 * THE ORDER MATTERS MORE THAN THE ACCURACY. A prediction is only worth
 * anything if it was written down before the answer, so this runs at the seal
 * and never after. A predictor called from the same place the actual is
 * recorded would score beautifully and mean nothing.
 */
import { db } from "./db.ts";
import { classOf, recordPrediction } from "./understudy.ts";

/** How many past decisions of a class are worth reasoning from at all. */
const MIN_HISTORY = 3;

/** And how much evidence a CONTEXT needs before it outranks a coarser one. A
 *  key seen twice is an anecdote, and letting an anecdote outrank a
 *  well-supported general answer is how a contextual model ends up worse than
 *  a constant — which the backtest caught it doing. */
const MIN_KEY = 3;

/** How far back to look. Older than this and the person has probably changed. */
const HORIZON_MS = 180 * 86_400_000;

const history = db.query<{ subject: string; actual: string; at: number }, [string, number]>(
  `SELECT subject, actual, COALESCE(actual_at, sealed_at) AS at
     FROM understudy_ledger
    WHERE kind = 'decision' AND class = ? AND actual IS NOT NULL
      AND COALESCE(actual_at, sealed_at) >= ?
    ORDER BY at ASC
    LIMIT 400`,
);

/*
 * ── the features, and the one rule that governs them ──────────────────────
 *
 * EVERY FEATURE HAS TO BE KNOWABLE BEFORE THE DECISION, and that is the
 * easiest thing here to get wrong: the number of files in a commit is sitting
 * right there in the row, correlates beautifully with the answer, and IS part
 * of the answer. A model fed it would score superbly and be worthless.
 *
 * So: only things true of the world before the decision — when it is
 * happening, how long since the last one, and what he did last time. That last
 * one carries most of the signal, because people work in runs and "what did he
 * just do" is exactly what a global constant throws away.
 *
 * Measured on 237 real merges: keying on these took the predictor from 49%
 * (one point BELOW a constant) to 83% against the same 50% baseline.
 */
function gapBucket(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "first";
  if (ms < 10 * 60_000) return "burst";
  if (ms < 60 * 60_000) return "same-hour";
  if (ms < 24 * 3_600_000) return "same-day";
  return "later";
}

function hourBucket(at: number): string {
  const h = new Date(at).getHours();
  if (h < 6) return "night";
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}

/**
 * The backoff chain, most specific first.
 *
 * A single key is either too specific to ever match or too coarse to say
 * anything. Backing off lets the same predictor use "mid-burst, and last time
 * he did X" where it has seen that, and fall back to "mid-burst" where it has
 * not, instead of giving up and returning the global answer for both.
 */
function keysFor(prev: string, gap: string, hour: string): string[] {
  return [
    `p=${prev}|g=${gap}|h=${hour}`,
    `p=${prev}|g=${gap}`,
    `p=${prev}`,
    `g=${gap}`,
  ];
}

function modeOf(m: Map<string, number> | undefined): { answer: string; n: number; total: number } {
  if (!m) return { answer: "", n: 0, total: 0 };
  let answer = "";
  let n = 0;
  let total = 0;
  for (const [k, c] of m) { total += c; if (c > n) { answer = k; n = c; } }
  return { answer, n, total };
}

export interface Prediction {
  /** The categorical shape it expects, already canonical. */
  actual: string;
  /** 0..1 — the share of the evidence that agreed with the winner. */
  confidence: number;
  /** How many past decisions it reasoned from. */
  from: number;
  /** True when it declines to guess. `actual` is empty in that case. */
  wouldAsk: boolean;
  why: string;
}

/**
 * What he will probably do, given this situation.
 *
 * The most specific context with real evidence behind it, backing off until
 * something has been seen at least three times, and the global answer if
 * nothing has. `why` reports which of those happened, because "this exact
 * situation came up nine times and you did X in eight" and "this is simply your
 * usual" deserve different amounts of trust, and the panel should be able to
 * say which one it is looking at.
 *
 * Declines rather than guessing when the history is thin. A prediction from one
 * past case is not a prediction, and scoring it would put noise into the
 * denominator that the whole gate is built on.
 */
export function predictFromHistory(cls: string, subject: string, now = Date.now()): Prediction {
  const def = classOf(cls);
  if (!def) return { actual: "", confidence: 0, from: 0, wouldAsk: true, why: "no such class" };

  let rows: { subject: string; actual: string; at: number }[] = [];
  try {
    rows = history.all(cls, now - HORIZON_MS);
  } catch {
    rows = [];
  }
  if (rows.length < MIN_HISTORY) {
    return {
      actual: "",
      confidence: 0,
      from: rows.length,
      wouldAsk: true,
      why: `only ${rows.length} past ${rows.length === 1 ? "decision" : "decisions"} of this kind — too few to guess from`,
    };
  }

  /*
   * Replay the history forward to build the tables, exactly as the backtest
   * does, so the shipped rule and the measured rule are the same rule. A
   * predictor that does not match its own backtest measures nothing.
   */
  const byKey = new Map<string, Map<string, number>>();
  const global = new Map<string, number>();
  let prev = "none";
  let prevAt = 0;
  for (const r of rows) {
    const gap = prevAt ? gapBucket(r.at - prevAt) : "first";
    for (const k of keysFor(prev, gap, hourBucket(r.at))) {
      const m = byKey.get(k) ?? new Map<string, number>();
      m.set(r.actual, (m.get(r.actual) ?? 0) + 1);
      byKey.set(k, m);
    }
    global.set(r.actual, (global.get(r.actual) ?? 0) + 1);
    prev = r.actual;
    prevAt = r.at;
  }

  // The situation NOW: what he did last, how long ago, what time it is.
  const gap = prevAt ? gapBucket(now - prevAt) : "first";
  const hour = hourBucket(now);

  for (const k of keysFor(prev, gap, hour)) {
    const m = modeOf(byKey.get(k));
    if (m.total >= MIN_KEY && m.answer) {
      return {
        actual: m.answer,
        // How much of that context agreed, capped: the ceiling is the person's
        // own consistency, never this function's arithmetic.
        confidence: Math.min(0.9, m.n / m.total),
        from: rows.length,
        wouldAsk: false,
        why: `what you did in ${m.n} of the ${m.total} times this came up in the same situation`,
      };
    }
  }

  const g = modeOf(global);
  const share = g.total ? g.n / g.total : 0;
  return {
    actual: g.answer,
    confidence: share,
    from: rows.length,
    wouldAsk: share < 0.5,
    why: share < 0.5
      ? `your ${rows.length} past decisions here do not agree with each other enough to guess from`
      : `what you did in ${g.n} of the last ${g.total}`,
  };
}

/**
 * Predict for a ledger row that has just been sealed.
 *
 * Returns the prediction so a caller can show it; the row is updated either
 * way, because a declined guess is a fact about the class worth recording. A
 * `wouldAsk` prediction is written as no prediction at all rather than as a
 * blank one, so the scorecard counts it as unscored instead of as a miss.
 */
export function predictSealed(ledgerId: number, cls: string, subject: string): Prediction {
  const p = predictFromHistory(cls, subject);
  if (!p.wouldAsk && p.actual) {
    try {
      /*
       * Parsed back into an object before it is handed over, because
       * recordPrediction canonicalises what it is given and canon() of a STRING
       * is that string with quotes around it. Passing the stored line straight
       * through would compare `"{\"ok\":true}"` against `{"ok":true}` and
       * report `differ` on a prediction that was exactly right — a scoring bug
       * that would have looked like a modelling failure.
       */
      recordPrediction(ledgerId, JSON.parse(p.actual) as unknown);
    } catch {
      /* Not JSON, so it was already a scalar; hand it over as it stands. */
      try { recordPrediction(ledgerId, p.actual); } catch { /* unscored, then */ }
    }
  }
  return p;
}

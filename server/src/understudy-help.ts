/**
 * Where the understudy raises its hand.
 *
 * The behaviour this replaces is silence. Measured over 108 runs: 80 finished
 * and delivered a branch, and 26 ended without delivering anything — not one of
 * which said what it needed. Six died because the server restarted underneath
 * them, five sat unfinished for over 45 minutes, and the worst sat for 513,
 * because the only thing that ever noticed was the next server start.
 *
 * A loop that stops silently is worse than one that stops loudly: the second
 * costs a person a minute, the first costs them a shift they thought was
 * running. So anything that cannot finish writes a question here, addressed to
 * a person, carrying what it already tried.
 *
 * This is deliberately NOT the queue. The queue is work; this is a question.
 * Answering one usually means putting something back on the queue by hand,
 * with the missing piece filled in — and that is a decision for a person.
 */
import { db } from "./db.ts";

export type HelpRequest = {
  id: number;
  runId: number | null;
  title: string;
  question: string;
  tried: string;
  repo: string;
  at: number;
  answeredAt: number | null;
  kind: string | null;
};

const addQ = db.query<{ id: number }, [number | null, string, string, string, string, number, string | null]>(
  "INSERT INTO understudy_help (run_id, title, question, tried, repo, at, kind) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
);
const openQ = db.query<
  { id: number; run_id: number | null; title: string; question: string; tried: string; repo: string; at: number; answered_at: number | null; kind: string | null },
  []
>("SELECT * FROM understudy_help WHERE answered_at IS NULL ORDER BY id DESC");
const allQ = db.query<
  { id: number; run_id: number | null; title: string; question: string; tried: string; repo: string; at: number; answered_at: number | null; kind: string | null },
  [number]
>("SELECT * FROM understudy_help ORDER BY id DESC LIMIT ?");
const triedQ = db.query<{ tried: string }, [number]>(
  "SELECT tried FROM understudy_help WHERE id = ?",
);
const answerQ = db.query<never, [number, number]>(
  "UPDATE understudy_help SET answered_at = ? WHERE id = ? AND answered_at IS NULL",
);
/* Same title, still open: the run that keeps failing the same way should read
   as one question asked once, not as a counter climbing while nobody looks. */
const dupQ = db.query<{ id: number }, [string]>(
  "SELECT id FROM understudy_help WHERE answered_at IS NULL AND title = ? LIMIT 1",
);
/* ...but one question asked once is not the same as the FIRST wording kept for
   ever. The second time a run raises the same hand it usually knows more: it
   has failed again and has more to say about how. "The deputy cannot start
   work" sat all night with its first, vaguest sentence while later runs threw
   better ones away. So the open row keeps its id and its date — a person still
   sees one question, raised when it was first raised — and takes the newest
   text. */
const refreshQ = db.query<never, [string, string, number]>(
  "UPDATE understudy_help SET question = ?, tried = ? WHERE id = ?",
);
/* Cleared not by a person but by the code that proves the reason for it is
   gone — see raiseHand's `kind` for why this cannot be a title match. */
const clearKindQ = db.query<never, [number, string]>(
  "UPDATE understudy_help SET answered_at = ? WHERE kind = ? AND answered_at IS NULL",
);
const openKindQ = db.query<{ id: number }, [string]>(
  "SELECT id FROM understudy_help WHERE kind = ? AND answered_at IS NULL LIMIT 1",
);

/**
 * Ask for help. Returns the row id, or the id of the open question with the
 * same title, whose text is refreshed with what this caller now knows.
 *
 * Never throws: a loop that cannot even file its own distress signal should
 * still finish tearing down cleanly, and a lost question is not worth taking
 * the process down for.
 */
export function raiseHand(p: {
  title: string;
  question: string;
  tried?: string;
  repo?: string;
  runId?: number | null;
  kind?: string;
}): number | null {
  try {
    const existing = dupQ.get(p.title.slice(0, 300));
    if (existing) {
      /* An empty `tried` is not an update — it is a caller with nothing to add,
         and overwriting the evidence with it would lose the only thing a person
         can act on. */
      const tried = (p.tried ?? "").slice(0, 8000);
      refreshQ.run(p.question.slice(0, 2000), tried || triedQ.get(existing.id)?.tried || "", existing.id);
      return existing.id;
    }
    return addQ.get(
      p.runId ?? null,
      p.title.slice(0, 300),
      p.question.slice(0, 2000),
      (p.tried ?? "").slice(0, 8000),
      p.repo ?? "",
      Date.now(),
      p.kind ?? null,
    )?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Close every open hand of a kind, from code rather than a person.
 *
 * `kind` and not a title: the caller here is proving a CONDITION is over —
 * "a run is actually going" — and that proof has nothing to do with which
 * words a particular hand happened to be raised with. Returns how many it
 * closed, so a caller can tell "nothing was open" from "one was cleared".
 */
export function clearHandsOfKind(kind: string): number {
  try {
    return clearKindQ.run(Date.now(), kind).changes;
  } catch {
    return 0;
  }
}

/** Is a hand of this kind currently open? For a caller deciding whether to
 *  say something again rather than counting how many times it has said it. */
export function hasOpenKind(kind: string): boolean {
  try { return !!openKindQ.get(kind); } catch { return false; }
}

const toRequest = (r: {
  id: number; run_id: number | null; title: string; question: string;
  tried: string; repo: string; at: number; answered_at: number | null; kind: string | null;
}): HelpRequest => ({
  id: r.id, runId: r.run_id, title: r.title, question: r.question,
  tried: r.tried, repo: r.repo, at: r.at, answeredAt: r.answered_at, kind: r.kind,
});

/** Questions still waiting on a person. */
export function openRequests(): HelpRequest[] {
  try { return openQ.all().map(toRequest); } catch { return []; }
}

/** Every question, newest first — answered ones included. */
export function helpHistory(limit = 50): HelpRequest[] {
  try { return allQ.all(Math.max(1, Math.min(200, limit))).map(toRequest); } catch { return []; }
}

/** A person has dealt with it. */
export function markAnswered(id: number): void {
  try { answerQ.run(Date.now(), id); } catch { /* already answered, or gone */ }
}

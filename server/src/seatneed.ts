/*
 * WHAT THE SEAT ASKS OF THE PERSON.
 *
 * The tray (seatreport.ts) is workers saying what THEY need. This is the other
 * direction: the seat saying what it needs from the one person who can give
 * it. The orchestrator running a real project here named the gap after a day
 * of it living nowhere but a chat — "pushed, re-upload gif-4", "the bot is
 * clean, ask for a reviewer", "three branches with no conflict, push?" — every
 * one of them something finished, waiting on a single action only a person can
 * take, and every one of them lost the moment the conversation moved on.
 *
 * The difference is the direction: `asked` is what the agents want from the
 * person, `ready` is what the seat wants back from them.
 *
 * WHY THE THREE EXTRA FIELDS. A decision handed over as a bare sentence is a
 * decision the person has to go and research before they can make it, which is
 * how a queue of them becomes a queue nobody drains. So each one carries what
 * it costs, what the seat would do, and what would prove it settled — the last
 * being the same rule the work queue already keeps, pointed the other way.
 */
import { randomBytes } from "node:crypto";
import { db } from "./db.ts";

export interface SeatNeed {
  id: string;
  root: string;
  /** The ask, in one line: what the person is being asked to do. */
  text: string;
  /** What it costs them — "one click", "five minutes", "a review round". */
  cost: string;
  /** What the seat would do. Absent is allowed; a seat with no opinion says so
   *  rather than inventing one. */
  recommend: string;
  /** What would show this is settled: a reviewer requested, a GIF in the body,
   *  a push landed. */
  proof: string;
  created: number;
  doneAt: number | null;
  outcome: string;
}

interface Row {
  id: string; root: string; text: string; cost: string; recommend: string; proof: string;
  created: number; done_at: number | null; outcome: string;
}

const toNeed = (r: Row): SeatNeed => ({
  id: r.id, root: r.root, text: r.text, cost: r.cost, recommend: r.recommend, proof: r.proof,
  created: r.created, doneAt: r.done_at, outcome: r.outcome,
});

const insert = db.query<never, [string, string, string, string, string, string, number]>(`
  INSERT INTO seat_need (id, root, text, cost, recommend, proof, created)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const forRoot = db.query<Row, [string]>(
  `SELECT * FROM seat_need WHERE root = ? ORDER BY done_at IS NOT NULL, created ASC LIMIT 100`);
const oneQ = db.query<Row, [string]>(`SELECT * FROM seat_need WHERE id = ?`);
const finishQ = db.query<never, [number, string, string]>(
  `UPDATE seat_need SET done_at = ?, outcome = ? WHERE id = ? AND done_at IS NULL`);
const dropQ = db.query<never, [string]>(`DELETE FROM seat_need WHERE id = ?`);

const line = (s: unknown, cap = 300) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, cap);

export const MAX_OPEN = 20;

export function addNeed(p: { root: string; text: unknown; cost?: unknown; recommend?: unknown; proof?: unknown; now?: number }):
{ ok: true; need: SeatNeed } | { ok: false; error: string } {
  const text = line(p.text);
  if (!text) return { ok: false, error: "a need says what you are asking for" };
  const open = forRoot.all(p.root).filter((r) => r.done_at === null);
  /*
   * A CEILING, because a list of twenty things to decide is not a list.
   * Its own rule for the queue it hands the person: one at a time, cheapest
   * first. Twenty is where "one at a time" has stopped being true and the seat
   * should be closing some rather than adding more.
   */
  if (open.length >= MAX_OPEN) return { ok: false, error: `${MAX_OPEN} decisions are already waiting — close some before adding another` };
  const id = `sn_${randomBytes(8).toString("hex")}`;
  const now = p.now ?? Date.now();
  insert.run(id, p.root, text, line(p.cost, 80), line(p.recommend), line(p.proof), now);
  const made = oneQ.get(id);
  return made ? { ok: true, need: toNeed(made) } : { ok: false, error: "it was not written down" };
}

/** Everything for a project, open first and oldest first inside that: the one
 *  that has been waiting longest is the one that has cost the most. */
export const needsFor = (root: string): SeatNeed[] => forRoot.all(root).map(toNeed);
export const openNeeds = (root: string): SeatNeed[] => needsFor(root).filter((n) => !n.doneAt);
export const needById = (id: string): SeatNeed | null => { const r = oneQ.get(id); return r ? toNeed(r) : null; };

export function finishNeed(id: string, outcome: string, now = Date.now()): boolean {
  return finishQ.run(now, line(outcome), id).changes > 0;
}

export function dropNeed(id: string): boolean {
  return dropQ.run(id).changes > 0;
}

/** How the open ones read in the seat's own prompt: what it is still waiting
 *  on, so a round does not ask the person for the same thing twice. */
export function needReadout(root: string): string {
  const open = openNeeds(root);
  if (!open.length) return "You have asked for nothing that is still waiting.";
  return [`${open.length} thing${open.length === 1 ? "" : "s"} you have asked for and not had an answer to:`,
    ...open.map((n) => [
      `- ${n.text}`,
      n.cost ? `    costs: ${n.cost}` : "",
      n.recommend ? `    you said: ${n.recommend}` : "",
      n.proof ? `    settled when: ${n.proof}` : "",
    ].filter(Boolean).join("\n"))].join("\n");
}

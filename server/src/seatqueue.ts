/*
 * THE SEAT'S QUEUE — the work a project's orchestrator has been asked to see
 * done, and who is carrying each piece.
 *
 * Small on purpose. This is NOT a second work loop: the clone already has one
 * (understudy-work.ts) with sources, scoring and worktrees, and two things
 * that decide what to work on is how a run gets lost. This is a list a person
 * writes and a seat hands out — the seat picks who, opens the agent, and the
 * queue records that it did.
 *
 * THE CLAIM IS STAMPED WHEN THE WORK STARTS, never when it finishes. The
 * clone's queue was written the other way round once and the bug was not
 * theoretical: a run that failed left its row looking untouched, so the next
 * round picked the same item straight back up — against the checkout the
 * failure had deliberately left behind, which the loop then refused. Marking
 * at the start costs one honest state ("taken, and nothing came back") and
 * saves that whole class.
 *
 * PAST A CEILING IT STOPS BEING OFFERED. Two goes; after that the item is
 * still on the list but `next()` will not hand it out, because an item that
 * has beaten two agents is an item that needs a person to read it, and a queue
 * that keeps feeding it burns a turn every time the seat wakes.
 */
import { randomBytes } from "node:crypto";
import { db } from "./db.ts";

/** The same number the clone uses, for the same reason: how many unattended
 *  goes before a person is asked, as one number and not two that drift. */
export const MAX_ATTEMPTS = 2;

export interface SeatTask {
  id: string;
  root: string;
  title: string;
  detail: string;
  weight: number;
  created: number;
  takenAt: number | null;
  takenBy: string;
  doneAt: number | null;
  outcome: string;
  attempts: number;
}

interface Row {
  id: string; root: string; title: string; detail: string; weight: number; created: number;
  taken_at: number | null; taken_by: string; done_at: number | null; outcome: string; attempts: number;
}

const toTask = (r: Row): SeatTask => ({
  id: r.id, root: r.root, title: r.title, detail: r.detail, weight: r.weight, created: r.created,
  takenAt: r.taken_at, takenBy: r.taken_by, doneAt: r.done_at, outcome: r.outcome, attempts: r.attempts,
});

const insert = db.query<never, [string, string, string, string, number, number]>(`
  INSERT INTO seat_task (id, root, title, detail, weight, created) VALUES (?, ?, ?, ?, ?, ?)
`);
const byRoot = db.query<Row, [string]>(`SELECT * FROM seat_task WHERE root = ? ORDER BY done_at IS NOT NULL, weight DESC, created ASC`);
const byId = db.query<Row, [string]>(`SELECT * FROM seat_task WHERE id = ?`);
/* The next one to hand out: never done, never already claimed, and not one
   that has already beaten MAX_ATTEMPTS agents. Heaviest first, then oldest. */
const nextQ = db.query<Row, [string, number]>(`
  SELECT * FROM seat_task
   WHERE root = ? AND done_at IS NULL AND taken_at IS NULL AND attempts < ?
   ORDER BY weight DESC, created ASC LIMIT 1
`);
const claimQ = db.query<Row, [number, string, string]>(`
  UPDATE seat_task SET taken_at = ?, taken_by = ?, attempts = attempts + 1
   WHERE id = ? AND taken_at IS NULL AND done_at IS NULL
  RETURNING *
`);
const finishQ = db.query<never, [number, string, string]>(`UPDATE seat_task SET done_at = ?, outcome = ? WHERE id = ?`);
const releaseQ = db.query<never, [string]>(`UPDATE seat_task SET taken_at = NULL, taken_by = '' WHERE id = ? AND done_at IS NULL`);
const dropQ = db.query<never, [string]>(`DELETE FROM seat_task WHERE id = ?`);

export function addTask(p: { root: string; title: string; detail?: string; weight?: number; now?: number }):
{ ok: true; task: SeatTask } | { ok: false; error: string } {
  const title = String(p.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!title) return { ok: false, error: "a task needs a title" };
  const id = `st_${randomBytes(8).toString("hex")}`;
  insert.run(id, p.root, title, String(p.detail ?? "").slice(0, 4000), Math.max(0, Math.min(10, Math.round(p.weight ?? 0))), p.now ?? Date.now());
  return { ok: true, task: toTask(byId.get(id)!) };
}

export const tasksFor = (root: string): SeatTask[] => byRoot.all(root).map(toTask);
export const taskById = (id: string): SeatTask | null => { const r = byId.get(id); return r ? toTask(r) : null; };

/** What the seat should hand out next, or null when there is nothing to hand. */
export function nextTask(root: string): SeatTask | null {
  const r = nextQ.get(root, MAX_ATTEMPTS);
  return r ? toTask(r) : null;
}

/**
 * Claim one for an agent. Returns null when somebody got there first — the
 * UPDATE carries the condition, so two seats waking at once cannot both take
 * the same row.
 */
export function claimTask(id: string, agent: string, now = Date.now()): SeatTask | null {
  const r = claimQ.get(now, agent, id);
  return r ? toTask(r) : null;
}

export function finishTask(id: string, outcome: string, now = Date.now()): void {
  finishQ.run(now, String(outcome ?? "").replace(/\s+/g, " ").trim().slice(0, 500), id);
}

/** Put a claimed one back on the list — the agent it was handed to is gone and
 *  never reported. The attempt it already cost is kept, which is what makes
 *  the ceiling mean anything. */
export function releaseTask(id: string): void { releaseQ.run(id); }

export function dropTask(id: string): void { dropQ.run(id); }

/**
 * Rows whose agent has vanished, released in one pass.
 *
 * Liveness is the same fact it is everywhere else in this app: a named agent
 * exists while its pane does. A row pointing at a name nobody can find is work
 * nobody is doing, and leaving it claimed hides it from the queue for ever —
 * which is the failure the clone's watchdog was written for.
 */
export function releaseVanished(root: string, aliveNames: Set<string>): string[] {
  const freed: string[] = [];
  for (const t of tasksFor(root)) {
    if (t.doneAt !== null || t.takenAt === null) continue;
    if (t.takenBy && aliveNames.has(t.takenBy)) continue;
    releaseTask(t.id);
    freed.push(t.id);
  }
  return freed;
}

/** The queue as a paragraph for the seat's prompt: what is waiting, what is
 *  out, and what has stopped being offered. */
export function queueReadout(root: string): string {
  const all = tasksFor(root);
  const open = all.filter((t) => !t.doneAt && !t.takenAt && t.attempts < MAX_ATTEMPTS);
  const out = all.filter((t) => !t.doneAt && t.takenAt);
  const stuck = all.filter((t) => !t.doneAt && !t.takenAt && t.attempts >= MAX_ATTEMPTS);
  const lines: string[] = [];
  lines.push(open.length ? `Waiting (${open.length}):` : "Nothing is waiting to be handed out.");
  lines.push(...open.map((t) => `- ${t.title}${t.detail ? ` — ${t.detail.slice(0, 120)}` : ""}`));
  if (out.length) {
    lines.push("", `Out with somebody (${out.length}):`);
    lines.push(...out.map((t) => `- ${t.title} → ${t.takenBy || "unnamed"}`));
  }
  if (stuck.length) {
    lines.push("", `Beaten ${MAX_ATTEMPTS} times — do NOT hand these out again, say they need a person:`);
    lines.push(...stuck.map((t) => `- ${t.title}`));
  }
  return lines.join("\n");
}

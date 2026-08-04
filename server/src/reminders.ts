/*
 * The part of a task list that is ours: when to tell somebody.
 *
 * Taskwarrior has nowhere to put a reminder, and — measured — loses 21 of 25
 * concurrent writes, so it is the wrong place to keep the one thing that must
 * not be lost. This lives in agentglass's own database, which agentglass alone
 * writes. The consequence is the point: reminders keep working when Taskwarrior
 * is missing, unconfigured, or in the middle of being edited from Neovim.
 *
 * There is no `arm()` and no `setTimeout`. A tick claims what is due in one
 * transactional statement and delivers what it claimed. That single decision
 * removes, at once: the boot storm (restore is just the first tick), the
 * cancelled-reminder-fires-anyway bug (cancellation is in the claim predicate),
 * the timer-and-sweep double claim (there is one claimer), the suspend gap (a
 * laptop that slept through 09:00 fires at 09:03 rather than never), and the
 * bookkeeping of a scheduling horizon.
 */
import { randomUUID } from "node:crypto";
import { db } from "./db.ts";
import { pushReminder } from "./alerts.ts";
import { entered } from "./loopwatch.ts";
import type { Reminder } from "../../shared/types.ts";

type Row = {
  id: string; task_uuid: string | null; title: string; root: string | null;
  civil: string; zone: string; due: number; created: number;
  fired_at: number | null; acked_at: number | null; cancelled_at: number | null; snooze_of: string | null;
};

const toReminder = (r: Row): Reminder => ({
  id: r.id,
  taskUuid: r.task_uuid,
  title: r.title,
  root: r.root,
  civil: r.civil,
  zone: r.zone,
  due: r.due,
  created: r.created,
  firedAt: r.fired_at,
  ackedAt: r.acked_at,
  cancelledAt: r.cancelled_at,
  snoozeOf: r.snooze_of,
});

/**
 * A civil time in a named zone, as an instant.
 *
 * "Monday 9:00" is not an instant until you say where. Resolving it at creation
 * and storing only the epoch is what makes a reminder fire an hour wrong after
 * a daylight-saving change, so the civil string and the zone are what we keep
 * and this is recomputed whenever they are read back.
 *
 * The arithmetic: format the candidate instant in the target zone, measure how
 * far that lands from the civil time asked for, and correct. Two passes,
 * because the offset can itself change across the correction — which is exactly
 * what happens in the hour a clock goes back.
 */
export function resolveCivil(civil: string, zone: string): number {
  const m = civil.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/);
  if (!m) return NaN;
  const want = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, 0);
  let guess = want;
  for (let i = 0; i < 2; i++) {
    const seen = zonedParts(guess, zone);
    if (seen === null) return want; // unknown zone: treat the civil time as UTC
    guess += want - seen;
  }
  return guess;
}

/** What wall clock a given instant shows in a zone, as a UTC-epoch of those
 *  same wall-clock numbers — the shape `resolveCivil` needs to difference. */
function zonedParts(at: number, zone: string): number | null {
  try {
    const f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const p: Record<string, string> = {};
    for (const { type, value } of f.formatToParts(new Date(at))) p[type] = value;
    return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +(p.hour === "24" ? "0" : p.hour!), +p.minute!, +p.second!);
  } catch { return null; }
}

/** The zone this machine is in, for a client that did not say. */
export const localZone = (): string => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
};

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

export function addReminder(input: {
  taskUuid?: string | null; title: string; civil: string; zone?: string; root?: string | null; snoozeOf?: string | null;
}): { ok: boolean; reminder?: Reminder; error?: string } {
  const title = (input.title || "").trim();
  if (!title) return { ok: false, error: "a reminder needs something to say" };
  const zone = input.zone || localZone();
  const due = resolveCivil(input.civil, zone);
  if (!Number.isFinite(due)) return { ok: false, error: "that is not a time I can read" };
  const row: Row = {
    id: randomUUID(), task_uuid: input.taskUuid ?? null, title: title.slice(0, 400),
    root: input.root ?? null, civil: input.civil, zone, due, created: Date.now(),
    fired_at: null, acked_at: null, cancelled_at: null, snooze_of: input.snoozeOf ?? null,
  };
  db.run(
    `INSERT INTO reminders (id, task_uuid, title, root, civil, zone, due, created, snooze_of)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.task_uuid, row.title, row.root, row.civil, row.zone, row.due, row.created, row.snooze_of],
  );
  return { ok: true, reminder: toReminder(row) };
}

/** Idempotent: acknowledging twice is what a double click is. */
export function ackReminder(id: string): { ok: boolean } {
  db.run(`UPDATE reminders SET acked_at = ? WHERE id = ? AND acked_at IS NULL`, [Date.now(), id]);
  return { ok: true };
}

/** Cancellation is in the claim predicate, so a cancelled reminder cannot fire
 *  on the next tick — or the next boot. */
export function cancelReminder(id: string): { ok: boolean } {
  db.run(`UPDATE reminders SET cancelled_at = ? WHERE id = ? AND cancelled_at IS NULL`, [Date.now(), id]);
  return { ok: true };
}

/**
 * Snooze closes the old row and opens a new one.
 *
 * `due` is never mutated, so the ledger is append-only and "did this fire?" has
 * one answer forever. It is also why there is nothing to un-schedule: with no
 * timers, a snooze cannot leave a stale one behind to fire twice.
 */
export function snoozeReminder(id: string, minutes: number): { ok: boolean; reminder?: Reminder; error?: string } {
  const row = db.query<Row, [string]>(`SELECT * FROM reminders WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: "no such reminder" };
  const mins = Math.max(1, Math.min(60 * 24 * 30, Math.round(minutes)));
  const at = new Date(Date.now() + mins * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  const civil = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}T${p(at.getHours())}:${p(at.getMinutes())}`;
  ackReminder(id);
  return addReminder({ taskUuid: row.task_uuid, title: row.title, civil, zone: localZone(), root: row.root, snoozeOf: id });
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

export type Window = "live" | "upcoming" | "history";

export function listReminders(window: Window = "live"): Reminder[] {
  const sql = window === "live"
    ? `SELECT * FROM reminders WHERE fired_at IS NOT NULL AND acked_at IS NULL AND cancelled_at IS NULL ORDER BY due DESC`
    : window === "upcoming"
    ? `SELECT * FROM reminders WHERE fired_at IS NULL AND acked_at IS NULL AND cancelled_at IS NULL ORDER BY due ASC LIMIT 200`
    : `SELECT * FROM reminders ORDER BY due DESC LIMIT 200`;
  return db.query<Row, []>(sql).all().map(toReminder);
}

/** What the rail pip counts: things shouting at you, not the size of a backlog. */
export const firedUnacked = (): number =>
  db.query<{ n: number }, []>(
    `SELECT COUNT(*) AS n FROM reminders WHERE fired_at IS NOT NULL AND acked_at IS NULL AND cancelled_at IS NULL`,
  ).get()?.n ?? 0;

/** Reminders attached to a task, so a row can show its own without a join per row. */
export function remindersFor(uuids: string[]): Record<string, Reminder> {
  if (!uuids.length) return {};
  const out: Record<string, Reminder> = {};
  const q = db.query<Row, [string]>(
    `SELECT * FROM reminders WHERE task_uuid = ? AND acked_at IS NULL AND cancelled_at IS NULL ORDER BY due ASC LIMIT 1`,
  );
  for (const u of uuids) { const r = q.get(u); if (r) out[u] = toReminder(r); }
  return out;
}

// ---------------------------------------------------------------------------
// firing
// ---------------------------------------------------------------------------

/**
 * How many are delivered individually before the rest become one line.
 *
 * Close the lid on Friday and open it on Monday and eight reminders are due at
 * once. Eight notifications is not eight times as useful as one; it is how a
 * feature gets turned off. Three, and then a count.
 */
const BUDGET = 3;

let onFire: (() => void) | null = null;
/** A hook, not an import of the HTTP layer — the same reason gitwork.ts gives. */
export function setReminderHook(fn: (() => void) | null): void { onFire = fn; }

/**
 * Claim everything due, in one statement, then deliver what was claimed.
 *
 * The claim is the transaction. Two ticks overlapping — or a tick and a manual
 * drain — cannot both take the same row, because `fired_at IS NULL` is part of
 * the predicate and the update is atomic. Everything downstream is delivery,
 * which is allowed to fail.
 */
export function drainDue(now = Date.now()): Reminder[] {
  const claimed = db.query<Row, [number, number]>(
    `UPDATE reminders SET fired_at = ?
      WHERE fired_at IS NULL AND acked_at IS NULL AND cancelled_at IS NULL AND due <= ?
      RETURNING *`,
  ).all(now, now).map(toReminder);
  if (!claimed.length) return [];

  const when = (r: Reminder) => {
    const d = new Date(r.due);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  for (const r of claimed.slice(0, BUDGET)) {
    try { pushReminder(r.id, r.title, when(r)); } catch { /* delivery is allowed to fail; the row is already claimed */ }
  }
  const rest = claimed.length - BUDGET;
  if (rest > 0) {
    try {
      pushReminder(`digest:${claimed[BUDGET]!.id}`, `and ${rest} more reminder${rest === 1 ? "" : "s"}`, "waiting for you");
    } catch { /* same */ }
  }
  try { onFire?.(); } catch { /* a broken listener must not fail a drain */ }
  return claimed;
}

/**
 * The tick.
 *
 * Ten seconds, and deliberately not load-shed by `backoff()`. That idiom exists
 * for sweeps that fork eighteen subprocesses; this is one indexed read over
 * tens of rows, and shedding the one loop whose entire job is to be on time
 * would be the wrong trade.
 *
 * Boot is just the first tick — there is no separate restore path with its own
 * semantics, which is where a scheduled design usually breaks.
 */
let ticker: ReturnType<typeof setInterval> | null = null;
let ticking = false;
export function startReminderTick(): void {
  if (ticker) return;
  const tick = () => {
    if (ticking) return;
    ticking = true;
    entered("reminder tick");
    try { drainDue(); } catch { /* the next tick tries again */ } finally { ticking = false; }
  };
  tick();
  ticker = setInterval(tick, 10_000);
  (ticker as unknown as { unref?: () => void }).unref?.();
}
export function stopReminderTick(): void { if (ticker) clearInterval(ticker); ticker = null; ticking = false; }

/*
 * SCHEDULED AGENTS — "at 08:00 start this agent, with this prompt, in this
 * checkout".
 *
 * Two halves already existed and were not married: the reminders' tick, which
 * claims what is due in one transaction and never sleeps on a timer that a
 * restart forgets; and the named agents, which seat a CLI in a checkout by
 * name. A schedule is a reminder whose firing is a start.
 *
 * The rules are the named agents' rules — the name, the checkout inside the
 * open project, yolo as a permission Settings grants — checked when the row
 * is written AND again when it fires, because Settings can change overnight
 * and a row is not a way around them. A name already alive at firing time
 * gets a `-2`, the worker's own convention, rather than a refusal nobody is
 * awake to read. What happened is written back on the row: the agent's pane,
 * or the reason it did not start.
 *
 * The machine has to be awake to fire. The shell's `agent` power mode keeps
 * it awake while something works and not before; a schedule for eight in the
 * morning on a laptop that sleeps at midnight fires when the lid opens — late,
 * and said so on the row, rather than lost.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { db } from "./db.ts";
import { inScope, workspaceRoot, chatBypassAllowed } from "./config.ts";
import { safeAbs } from "./git.ts";
import { agentKind } from "../../shared/agentKinds.ts";
import * as AgentOps from "./agentops.ts";
import { pushLantern } from "./alerts.ts";
import { resolveCivil, localZone } from "./reminders.ts";

export interface AgentSchedule {
  id: string;
  name: string;
  cwd: string;
  kind: string;
  prompt: string;
  yolo: boolean;
  due: number;
  created: number;
  firedAt: number | null;
  cancelledAt: number | null;
  /** What firing did: "started as <name> in pane %N" or the refusal. */
  result: string;
}

interface Row {
  id: string; name: string; cwd: string; kind: string; prompt: string; yolo: number;
  due: number; created: number; fired_at: number | null; cancelled_at: number | null; result: string;
}
const toSchedule = (r: Row): AgentSchedule => ({
  id: r.id, name: r.name, cwd: r.cwd, kind: r.kind, prompt: r.prompt, yolo: r.yolo === 1,
  due: r.due, created: r.created, firedAt: r.fired_at, cancelledAt: r.cancelled_at, result: r.result,
});

const insert = db.query<never, [string, string, string, string, string, number, number, number]>(
  `INSERT INTO agent_schedule (id, name, cwd, kind, prompt, yolo, due, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const pendingCount = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM agent_schedule WHERE fired_at IS NULL AND cancelled_at IS NULL`);
const cancel = db.query<never, [number, string]>(`UPDATE agent_schedule SET cancelled_at = ? WHERE id = ? AND fired_at IS NULL AND cancelled_at IS NULL`);
const listQ = db.query<Row, []>(`SELECT * FROM agent_schedule WHERE cancelled_at IS NULL ORDER BY (fired_at IS NOT NULL), due ASC LIMIT 60`);
const claim = db.query<Row, [number, number]>(
  `UPDATE agent_schedule SET fired_at = ? WHERE fired_at IS NULL AND cancelled_at IS NULL AND due <= ? RETURNING *`);
const writeResult = db.query<never, [string, string]>(`UPDATE agent_schedule SET result = ? WHERE id = ?`);

const MAX_PENDING = 50;
const MAX_AHEAD_MS = 31 * 24 * 60 * 60_000;

/**
 * "When", in the three shapes a person types: a clock time today or tomorrow
 * ("08:00"), a civil date-time ("2026-09-06 08:00"), or a delay ("+30m",
 * "+2h"). Returns the epoch, or null for anything else.
 */
export function whenFrom(text: string, now = Date.now(), zone = localZone()): number | null {
  const t = (text || "").trim();
  let m = /^\+(\d+)\s*(m|min|h|hr|d)?$/i.exec(t);
  if (m) {
    const n = Number(m[1]);
    const unit = (m[2] ?? "m").toLowerCase();
    const ms = unit.startsWith("h") ? n * 3_600_000 : unit === "d" ? n * 86_400_000 : n * 60_000;
    return n > 0 ? now + ms : null;
  }
  m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})$/.exec(t);
  if (m) { const at = resolveCivil(`${m[1]} ${m[2]}:${m[3]}`, zone); return Number.isFinite(at) ? at : null; }
  m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (m) {
    const h = Number(m[1]), min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    let at = d.getTime();
    if (at <= now) at += 86_400_000;
    return at;
  }
  const asDate = Date.parse(t);
  return Number.isFinite(asDate) && asDate > now ? asDate : null;
}

export type AddResult = { ok: true; schedule: AgentSchedule } | { ok: false; error: string };

export function addSchedule(p: { name: unknown; cwd: unknown; kind?: unknown; prompt?: unknown; yolo?: unknown; when: unknown }, now = Date.now()): AddResult {
  if (!AgentOps.validName(p.name)) return { ok: false, error: "name: letters, digits, dot, dash or underscore, 64 at most" };
  const cwd = safeAbs(p.cwd);
  if (!cwd || !inScope(cwd) || !existsSync(cwd)) return { ok: false, error: "that directory is not in the open project" };
  const kind = typeof p.kind === "string" && p.kind ? p.kind : "claude";
  if (!agentKind(kind)) return { ok: false, error: "no such agent" };
  const prompt = typeof p.prompt === "string" ? p.prompt : "";
  if (prompt.length > 20_000) return { ok: false, error: "the prompt is too long (20k characters at most)" };
  const yolo = p.yolo === true;
  if (yolo && !chatBypassAllowed()) return { ok: false, error: "skipping permissions is off in Settings (chatBypass)" };
  const due = typeof p.when === "number" ? p.when : whenFrom(String(p.when ?? ""), now);
  if (due === null || !Number.isFinite(due)) return { ok: false, error: 'when: "08:00", "2026-09-06 08:00", or "+30m"' };
  if (due <= now) return { ok: false, error: "that time has passed" };
  if (due > now + MAX_AHEAD_MS) return { ok: false, error: "a month ahead at most" };
  if ((pendingCount.get()?.n ?? 0) >= MAX_PENDING) return { ok: false, error: `${MAX_PENDING} schedules are already waiting` };
  const id = randomBytes(9).toString("base64url");
  insert.run(id, p.name, cwd, kind, prompt, yolo ? 1 : 0, Math.floor(due), now);
  return { ok: true, schedule: { id, name: p.name, cwd, kind, prompt, yolo, due: Math.floor(due), created: now, firedAt: null, cancelledAt: null, result: "" } };
}

export function cancelSchedule(id: string, now = Date.now()): boolean {
  cancel.run(now, String(id));
  return db.query<{ c: number }, []>(`SELECT changes() AS c`).get()?.c === 1;
}

export function listSchedules(): AgentSchedule[] { return listQ.all().map(toSchedule); }

/** The two things firing touches on the engine, injected so a test can fire
 *  without tmux: who is alive, and the start itself. */
export interface FireDeps {
  alive: () => Promise<{ name: string }[]>;
  start: typeof AgentOps.startAgent;
}
const LIVE: FireDeps = { alive: () => AgentOps.reconcile(), start: AgentOps.startAgent };

/** A name that is not alive on the engine right now: the one asked for, or
 *  the worker's own `-2`, `-3`. */
async function freeName(name: string, deps: FireDeps): Promise<string> {
  const alive = new Set((await deps.alive()).map((a) => a.name));
  if (!alive.has(name)) return name;
  for (let n = 2; n < 100; n++) if (!alive.has(`${name}-${n}`)) return `${name}-${n}`;
  return `${name}-${Date.now() % 1000}`;
}

/** Everything due, claimed in one statement and started one by one. */
export async function drainDueSchedules(now = Date.now(), deps: FireDeps = LIVE): Promise<AgentSchedule[]> {
  const claimed = claim.all(now, now).map(toSchedule);
  for (const s of claimed) {
    const late = now - s.due > 90_000 ? ` (${Math.round((now - s.due) / 60_000)} min late — the machine was not awake)` : "";
    let result: string;
    try {
      if (!inScope(s.cwd) || !existsSync(s.cwd)) throw new Error("its checkout is no longer in the open project");
      const name = await freeName(s.name, deps);
      const r = await deps.start({
        root: workspaceRoot() || s.cwd, name, cwd: s.cwd, kind: s.kind, prompt: s.prompt,
        yolo: s.yolo, yoloAllowed: chatBypassAllowed(), now,
      });
      result = r.ok ? `started as ${r.agent.name} in pane ${r.agent.paneId}${late}` : `did not start: ${r.error}${late}`;
    } catch (e) {
      result = `did not start: ${String((e as Error)?.message ?? e).slice(0, 200)}${late}`;
    }
    writeResult.run(result, s.id);
    s.result = result;
    try { pushLantern(`⏰ ${s.name}`, `${result} · ${s.cwd.split("/").pop()}`); } catch { /* delivery may fail; the row has it */ }
  }
  return claimed;
}

let ticker: ReturnType<typeof setInterval> | null = null;
let ticking = false;
export function startScheduleTick(): void {
  if (ticker) return;
  const tick = () => {
    if (ticking) return;
    ticking = true;
    void drainDueSchedules().catch(() => { /* the next tick tries again */ }).finally(() => { ticking = false; });
  };
  tick();
  ticker = setInterval(tick, 10_000);
  (ticker as unknown as { unref?: () => void }).unref?.();
}
export function stopScheduleTick(): void { if (ticker) clearInterval(ticker); ticker = null; ticking = false; }

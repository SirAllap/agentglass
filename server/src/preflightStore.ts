/*
 * Preflight runs and the Flight plan settings, as stored: the server's own
 * database, never the repository. A run is one request to review something with
 * a reader that has no context (preflight.ts), the moment it was asked at, who
 * asked, where it stands, and the certificate once it is done.
 */
import { randomBytes } from "node:crypto";
import { db } from "./db.ts";
import type { Certificate, FindingAction, PreflightInput } from "./preflight.ts";

db.exec(`
CREATE TABLE IF NOT EXISTS preflight_run (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  root TEXT NOT NULL,
  moment TEXT NOT NULL,
  state TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  input TEXT NOT NULL,
  certificate TEXT,
  error TEXT,
  task_id TEXT
);
CREATE INDEX IF NOT EXISTS preflight_run_root ON preflight_run (root, created_at);
CREATE TABLE IF NOT EXISTS flight_plan_setting (
  root TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (root, key)
);
`);
try { db.exec(`ALTER TABLE preflight_run ADD COLUMN spent_usd REAL`); } catch { /* already there */ }
/* A run that was executing when the server stopped will never finish; what it spent is unknown, so it is billed at its cap. */
db.run(`UPDATE preflight_run SET state = 'failed', error = 'the server restarted while it ran', spent_usd = json_extract(input, '$.budgetUsd') WHERE state = 'running'`);

export const MOMENTS = ["before-launch", "task-done", "pr", "manual"] as const;
export type Moment = (typeof MOMENTS)[number];
export type RunState = "awaiting-go" | "running" | "done" | "failed" | "declined";
export const ACTIONS: readonly FindingAction[] = ["fix", "contest", "ask", "dismiss"];

export interface Run {
  id: string; createdAt: number; root: string; moment: Moment; state: RunState; requestedBy: string;
  input: PreflightInput; certificate: Certificate | null; error: string | null; taskId: string | null;
}
interface Row { id: string; created_at: number; root: string; moment: string; state: string; requested_by: string; input: string; certificate: string | null; error: string | null; task_id: string | null }

const toRun = (r: Row): Run => ({
  id: r.id, createdAt: r.created_at, root: r.root, moment: r.moment as Moment, state: r.state as RunState, requestedBy: r.requested_by,
  input: JSON.parse(r.input), certificate: r.certificate ? JSON.parse(r.certificate) : null, error: r.error, taskId: r.task_id,
});

export function createRun(p: { root: string; moment: Moment; state: "awaiting-go" | "running"; by: string; input: PreflightInput; taskId?: string | null }): Run {
  const id = `pf_${randomBytes(8).toString("hex")}`;
  db.query(`INSERT INTO preflight_run (id, created_at, root, moment, state, requested_by, input, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, Date.now(), p.root, p.moment, p.state, p.by, JSON.stringify({ ...p.input, id }), p.taskId ?? null);
  return getRun(id)!;
}
export const getRun = (id: string): Run | null => { const r = db.query<Row, [string]>(`SELECT * FROM preflight_run WHERE id = ?`).get(id); return r ? toRun(r) : null; };
export function listRuns(f: { state?: string; root?: string } = {}): Run[] {
  const rows = db.query<Row, [string | null, string | null, string | null, string | null]>(
    `SELECT * FROM preflight_run WHERE (? IS NULL OR state = ?) AND (? IS NULL OR root = ?) ORDER BY created_at DESC, rowid DESC LIMIT 200`,
  ).all(f.state ?? null, f.state ?? null, f.root ?? null, f.root ?? null);
  return rows.map(toRun);
}

/** Moves a run only from `from`; false when it was not in that state. */
export function setState(id: string, from: RunState, to: RunState): boolean {
  return db.query(`UPDATE preflight_run SET state = ? WHERE id = ? AND state = ?`).run(to, id, from).changes > 0;
}
export function finish(id: string, cert: Certificate): void {
  db.query(`UPDATE preflight_run SET state = 'done', certificate = ?, error = NULL WHERE id = ?`).run(JSON.stringify(cert), id);
}
/** `spentUsd`: what the failed run cost, when it is known; the budget counts it. */
export function fail(id: string, error: string, spentUsd?: number): void {
  db.query(`UPDATE preflight_run SET state = 'failed', error = ?, spent_usd = ? WHERE id = ?`).run(String(error).slice(0, 500), Number.isFinite(spentUsd) ? spentUsd! : null, id);
}

export function setFindingAction(runId: string, findingId: string, action: FindingAction | null, note: string | null, by: string, bySeat = false):
{ ok: true; run: Run } | { ok: false; error: string; status: number } {
  const run = getRun(runId);
  if (!run) return { ok: false, error: "no such run", status: 404 };
  const f = run.certificate?.findings.find((x) => x.id === findingId);
  if (!run.certificate || !f) return { ok: false, error: "no such finding in that run", status: 404 };
  if (action !== null && !ACTIONS.includes(action)) return { ok: false, error: "action: fix, contest, ask, dismiss or null", status: 400 };
  // What lifts a stop is the person's. A coordinator answers findings (that is Autopilot), but it cannot take an Ask away or dismiss a blocker.
  if (bySeat && f.action === "ask" && action !== "ask") return { ok: false, error: "an Ask finding is the person's to change: the coordinator raised it, it cannot take it back", status: 403 };
  if (bySeat && action === "dismiss" && f.severity === "blocker") return { ok: false, error: "a coordinator does not dismiss a blocker: fix it, contest it with the evidence, or ask the person", status: 403 };
  const text = String(note ?? "").trim().slice(0, 2000);
  if ((action === "contest" || action === "dismiss") && !text) return { ok: false, error: `${action} needs a note saying why`, status: 400 };
  f.action = action; f.note = text || null;
  if (action) f.by = by; else delete f.by;
  db.query(`UPDATE preflight_run SET certificate = ? WHERE id = ?`).run(JSON.stringify(run.certificate), runId);
  return { ok: true, run: getRun(runId)! };
}

/**
 * Where a task's review stands, from its run. Declined is a review that never happened, so it reads as failed.
 * Advisory: the number of findings still open (blocker or major, unanswered or "ask") is a note beside the
 * status, never a status of its own, and nothing refuses or waits because of it.
 */
export type PreflightStatus = "pending" | "checked" | "failed";
export function flagOf(run: Run): { status: PreflightStatus; openFindings: number } {
  if (run.state === "failed" || run.state === "declined") return { status: "failed", openFindings: 0 };
  if (run.state !== "done" || !run.certificate) return { status: "pending", openFindings: 0 };
  const openFindings = run.certificate.findings.filter((f) => (f.severity === "blocker" || f.severity === "major") && (f.action === null || f.action === "ask")).length;
  return { status: "checked", openFindings };
}

/* ── per-project settings ── */
/** The three things a Preflight can review. `plan` is the plan before Go, `taskDone` a finished task, `pr` a pull request. */
export const REVIEWS = ["plan", "taskDone", "pr"] as const;
export type Review = (typeof REVIEWS)[number];
/** Which Review a run's moment asks for. `manual` is the person pressing Run, and always runs. */
export const REVIEW_OF: Record<string, Review | undefined> = { "before-launch": "plan", "task-done": "taskDone", pr: "pr" };
export const PILOT_VALUES = ["manual", "copilot", "autopilot"] as const;

export const DEFAULTS = {
  "flightPlan.pilot": "copilot",
  // Per project: a project the person left out of Flight plan. Unset means in.
  "flightPlan.project.enabled": true,
  "flightPlan.preflight.reviews": ["plan"] as string[],
  "flightPlan.preflight.sizes": "ML",
  "flightPlan.preflight.secondLooks": 1,
  "flightPlan.preflight.model": "sonnet",
  "flightPlan.preflight.costCapUsd": 0.5,
  // Not per project: the master switch, the house mockup guide, the budget are one value for the app, kept under the root "*".
  "flightPlan.enabled": false,
  "flightPlan.mockupGuide": "",
  "flightPlan.budget.dailyUsd": 5,
  "flightPlan.budget.weeklyUsd": 20,
  "flightPlan.maxFlying": 2,
  // Per project, falling back to the app value (then true): one project may stop asking while another keeps asking.
  "flightPlan.autopilot.askOnLarge": true,
  "flightPlan.autopilot.askOnSensitive": true,
  // Per project, never inherited from the app: a hold on one project does not stop another.
  "flightPlan.held": false,
  // The permission mode a launched builder starts in: one value for the app. Auto, because bypass is the person's to turn on.
  "flightPlan.builder.permissions": "auto",
  // Where a builder worktree is cut from: the local trunk (local), or origin/<trunk> (remote). Local, because a project whose merges stay local runs far ahead of its remote.
  "flightPlan.builderBase": "local",
  // Per project: the post-merge cleanup's settings (cleanup.ts CleanupConfig) as JSON text; empty is "nothing configured".
  "cleanup.config": "",
  // Per project: what happens when a pull request ends (off | ask | atMerge | auto), the age in days after which a merged one is cleaned by itself (0 = never), and which kinds of leftover a plan holds.
  "cleanup.mode": "ask",
  "cleanup.autoCleanDays": 0,
  "cleanup.include": ["docker", "worktree", "branch", "stashes", "evidence", "notes", "tab", "agent-scratch"] as string[],
  // Per project: folders that hold a card's evidence folder (`<root>/ORBIT-1042-...`); empty finds nothing.
  "cleanup.evidenceRoots": [] as string[],
  // Per project: patterns (`~/code/orbit-pol-master-{number}*`) for a card's leftovers that do not start with its id; empty finds nothing.
  "cleanup.otherFolders": [] as string[],
} as const;
export type SettingKey = keyof typeof DEFAULTS;
type Value = string | number | boolean | string[];
const rootKey = (root: string) => root.replace(/\/+$/, "") || "/";

export const APP = "*";
const rowAt = (root: string, key: string) =>
  db.query<{ value: string }, [string, string]>(`SELECT value FROM flight_plan_setting WHERE root = ? AND key = ?`).get(rootKey(root), key);
/** Set once for the app (under APP) and a project may differ. */
export const PER_PROJECT: readonly string[] = ["flightPlan.pilot", "flightPlan.preflight.reviews", "flightPlan.project.enabled", "flightPlan.autopilot.askOnLarge", "flightPlan.autopilot.askOnSensitive"];

/*
 * Before Pilot, three keys each said off / ask / auto for one moment. They are
 * not read as settings any more, but a stored one still says what the project
 * wanted: off is not reviewed, ask and auto are. A project that never set any
 * has the default (the plan is reviewed). Never deleted, so a downgrade finds them.
 */
const LEGACY_MOMENT: Record<Review, string> = { plan: "flightPlan.preflight.beforeLaunch", taskDone: "flightPlan.preflight.onTaskDone", pr: "flightPlan.preflight.onPr" };
function legacyReviews(root: string): string[] | null {
  const seen = REVIEWS.map((r) => {
    const row = rowAt(root, LEGACY_MOMENT[r]) ?? (root !== APP ? rowAt(APP, LEGACY_MOMENT[r]) : null);
    return row ? (JSON.parse(row.value) as string) : null;
  });
  return seen.every((v) => v === null) ? null : REVIEWS.filter((_, i) => seen[i] === "ask" || seen[i] === "auto");
}

/**
 * The project's own value, else the app-wide one, else the shipped default.
 * Falling straight to the shipped default made a project the screen labels
 * "default" answer "off" while the global said "ask", so its first plan could
 * not be reviewed. The global lives under APP and not under the open project:
 * keyed on a project, setting that project to Off also changed "everyone".
 */
export function getSetting(root: string, key: SettingKey): Value {
  const own = rowAt(root, key) ?? (root !== APP && PER_PROJECT.includes(key) ? rowAt(APP, key) : null);
  if (own) return JSON.parse(own.value);
  if (key === "flightPlan.preflight.reviews") return legacyReviews(root) ?? DEFAULTS[key];
  return DEFAULTS[key];
}
/** True when this project says it itself, false when the value is the default (so "off" can be told from "not set"). */
export const hasSetting = (root: string, key: SettingKey): boolean =>
  !!rowAt(root, key) || (key === "flightPlan.preflight.reviews" && legacyReviews(root) !== null);
export function putSetting(root: string, key: SettingKey, value: Value): void {
  db.query(`INSERT INTO flight_plan_setting (root, key, value) VALUES (?, ?, ?) ON CONFLICT (root, key) DO UPDATE SET value = excluded.value`)
    .run(rootKey(root), key, JSON.stringify(value));
}

/**
 * What Preflight runs created since `since` have cost, whatever the project: a finished run its certificate's
 * cost, a failed one what it spent (a run stopped at its cap spent the cap), and a run still reading its cap,
 * held in advance so presses made while it reads cannot spend past the budget. A run that failed before it
 * was billed counts for nothing.
 */
export const preflightCostSince = (since: number): number =>
  db.query<{ usd: number | null }, [number]>(`SELECT SUM(COALESCE(json_extract(certificate, '$.costUsd'), spent_usd, CASE WHEN state = 'running' THEN json_extract(input, '$.budgetUsd') END)) AS usd FROM preflight_run WHERE created_at >= ?`).get(since)?.usd ?? 0;

/** Who held a project and when, beside the `held` flag: the flag is a setting anyone may flip, so `by` is null when the door did it without saying who. */
export interface HeldMeta { by: string | null; at: number }
export function markHeld(root: string, held: boolean, by: string | null): void {
  if (!held) { db.query(`DELETE FROM flight_plan_setting WHERE root = ? AND key = 'flightPlan.heldMeta'`).run(rootKey(root)); return; }
  db.query(`INSERT INTO flight_plan_setting (root, key, value) VALUES (?, 'flightPlan.heldMeta', ?) ON CONFLICT (root, key) DO UPDATE SET value = excluded.value`)
    .run(rootKey(root), JSON.stringify({ by, at: Date.now() } satisfies HeldMeta));
}
export const heldMeta = (root: string): HeldMeta | null => { const r = rowAt(root, "flightPlan.heldMeta"); return r ? JSON.parse(r.value) : null; };

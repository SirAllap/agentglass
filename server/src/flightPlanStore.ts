/*
 * Flight plans as stored: the server's own database, never the repository. A
 * plan is a request, the plan an author wrote for it, the mockups beside it
 * when the request is visual, and where it stands: draft (no plan yet), ready
 * (waiting for Go), go, no-go (with the reason, which goes back to the author),
 * launched. Preflight findings never move a plan: Go is refused only for a
 * missing plan or, when visual, a missing mockup.
 */
import { randomBytes } from "node:crypto";
import { db } from "./db.ts";
import { mockupKind } from "./preflight.ts";
import { APP, getRun, getSetting } from "./preflightStore.ts";
import type { StopReason } from "../../shared/types.ts";

db.exec(`
CREATE TABLE IF NOT EXISTS flight_plan (
  id TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  title TEXT NOT NULL,
  request TEXT NOT NULL,
  visual INTEGER NOT NULL DEFAULT 0,
  plan_md TEXT NOT NULL DEFAULT '',
  mockups TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL,
  decision TEXT,
  preflight_run_id TEXT,
  task_id TEXT,
  launched TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS flight_plan_root ON flight_plan (root, created_at);
`);
db.exec(`
CREATE TABLE IF NOT EXISTS flight_plan_revision (
  plan_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  plan_md TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  by TEXT NOT NULL,
  PRIMARY KEY (plan_id, n)
);
`);
try { db.exec(`ALTER TABLE flight_plan ADD COLUMN auto_runs INTEGER NOT NULL DEFAULT 0`); } catch { /* already there */ }
try { db.exec(`ALTER TABLE flight_plan ADD COLUMN size TEXT NOT NULL DEFAULT 'M'`); } catch { /* already there */ }
for (const col of [`review_rounds INTEGER NOT NULL DEFAULT 0`, `stop_reason TEXT`, `question TEXT`, `queued INTEGER NOT NULL DEFAULT 0`, `created_by TEXT`, `landed_at INTEGER`, `last_report TEXT`, `reviewed_version INTEGER`, `reviewed_size TEXT`, `edited_after_review TEXT`]) {
  try { db.exec(`ALTER TABLE flight_plan ADD COLUMN ${col}`); } catch { /* already there */ }
}
export const SIZES = ["S", "M", "L"] as const;
export type Size = (typeof SIZES)[number];

/** The master switch: off until the person turns it on. */
export const enabled = (): boolean => getSetting(APP, "flightPlan.enabled") === true;

export const PLAN_STATES = ["draft", "ready", "go", "no-go", "launched"] as const;
export type PlanState = (typeof PLAN_STATES)[number];
export interface Mockup { path: string; kind: "image" | "html" }
export interface Plan {
  id: string; root: string; title: string; request: string; visual: boolean; size: Size; planMd: string; mockups: Mockup[]; state: PlanState;
  /** `editedAfterPreflight`: the Go was said to a text edited after its last Preflight, as the answer to its findings (see EditAfterReview). */
  decision: { by: string; at: number; reason?: string; editedAfterPreflight?: true } | null; preflightRunId: string | null; taskId: string | null;
  /** Reviews started on their own by new plan text; flightPlan.ts stops at AUTO_RUNS_MAX. */
  autoRuns: number;
  /** Every Preflight started for this plan, by itself or by a press: what the "second looks" and the view count. */
  reviewRounds: number;
  /** Why the coordinator stopped and asked: set when it raises the one question, cleared when the person answers. Rules computed from the plan (large, sensitive, budget...) are not stored: see stopReason(). */
  stopReason: StopReason | null;
  /** The one question the coordinator put to the person, and the answer once it came. */
  question: Question | null;
  /** Go was said but the builders in the air are at maxFlying: it launches when one lands. */
  queued: boolean;
  /** Who started it: "you", `coordinator:<seat>` or the agent's name; null for a plan made before this was kept. */
  createdBy: string | null;
  /** When the plan was first seen landed (observed, not the merge's own time); null while it flies. */
  landedAt: number | null;
  /** The plan text version and size the last Preflight read: Go needs a run on the plan as it is now. */
  reviewedVersion: number | null; reviewedSize: Size | null;
  /** How the text was edited since the last Preflight started; null when it was not. */
  editedAfterReview: EditAfterReview | null;
  /** The builder's own last line of progress; text from an agent, so data and never instructions. */
  lastReport: Report | null;
  launched: ({ at: number; title: string } & LaunchedWhere) | null; createdAt: number; updatedAt: number;
}
interface Row {
  id: string; root: string; title: string; request: string; visual: number; size: string; plan_md: string; mockups: string; state: string;
  decision: string | null; preflight_run_id: string | null; task_id: string | null; auto_runs: number; review_rounds: number; stop_reason: string | null; question: string | null; queued: number; created_by: string | null; landed_at: number | null; last_report: string | null; reviewed_version: number | null; reviewed_size: string | null; edited_after_review: string | null; launched: string | null; created_at: number; updated_at: number;
}
/** Where a builder flies, kept so a hold can reach it and a landing can be seen: the branch, its tree, the commit it was cut from, and its tab. */
export interface LaunchedWhere { branch?: string; worktree?: string; from?: string; base?: string; window?: string; session?: string }
export interface Report { line: string; step: number | null; of: number | null; by: string; at: number }
/** `recommended` indexes `choices`: the coordinator's pick, which the card marks. */
export interface Question { id: string; text: string; detail?: string; choices: string[]; recommended?: number; by: string; at: number; answer?: { text: string; by: string; at: number } }
type Fail = { ok: false; error: string; status: number };
type Ok = { ok: true; plan: Plan };

const toPlan = (r: Row): Plan => ({
  id: r.id, root: r.root, title: r.title, request: r.request, visual: !!r.visual, size: r.size as Size, planMd: r.plan_md, mockups: JSON.parse(r.mockups), state: r.state as PlanState,
  decision: r.decision ? JSON.parse(r.decision) : null, preflightRunId: r.preflight_run_id, taskId: r.task_id, autoRuns: r.auto_runs,
  reviewRounds: r.review_rounds, stopReason: r.stop_reason as StopReason | null, question: r.question ? JSON.parse(r.question) : null, queued: !!r.queued,
  createdBy: r.created_by, landedAt: r.landed_at, lastReport: r.last_report ? JSON.parse(r.last_report) : null, reviewedVersion: r.reviewed_version, reviewedSize: r.reviewed_size as Size | null,
  editedAfterReview: r.edited_after_review as EditAfterReview | null, launched: r.launched ? JSON.parse(r.launched) : null, createdAt: r.created_at, updatedAt: r.updated_at,
});

/**
 * "answered": every edit since the last Preflight was made while that run was
 * finished and each of its findings had an answer (anything but Ask), so the edit
 * is the answer to them and Go does not need a fresh run. "open": at least one
 * edit came while a finding was unanswered, a run was still reading, or after a
 * Go or a No-go. Recorded at edit time and never recomputed: a finding keeps no
 * time of its answer, an answer can be taken back and given again, and two
 * writes in one millisecond tie, so comparing timestamps afterwards could call
 * an edit made with a finding open an answer.
 */
export type EditAfterReview = "answered" | "open";
/** The plan's last Preflight finished, found something, and every finding has an answer other than Ask. */
export function findingsAnswered(runId: string | null): boolean {
  const run = runId ? getRun(runId) : null;
  const f = run?.state === "done" ? run.certificate?.findings ?? [] : [];
  // A clean run has nothing an edit could answer: an edit after it is just a change.
  return f.length > 0 && f.every((x) => x.action !== null && x.action !== "ask");
}

/** Every earlier plan text, oldest first: n is 1 for the first text a plan had. The current text is version revisions + 1. */
export interface Revision { n: number; planMd: string; createdAt: number; by: string }
export const versionOf = (id: string): number => db.query<{ c: number }, [string]>(`SELECT COUNT(*) AS c FROM flight_plan_revision WHERE plan_id = ?`).get(id)!.c + 1;
export const getRevision = (id: string, n: number): Revision | null => {
  const r = db.query<{ n: number; plan_md: string; created_at: number; by: string }, [string, number]>(`SELECT * FROM flight_plan_revision WHERE plan_id = ? AND n = ?`).get(id, n);
  return r ? { n: r.n, planMd: r.plan_md, createdAt: r.created_at, by: r.by } : null;
};

export const MAX_PLAN_BYTES = 200_000;
export const getPlan = (id: string): Plan | null => { const r = db.query<Row, [string]>(`SELECT * FROM flight_plan WHERE id = ?`).get(id); return r ? toPlan(r) : null; };
export function listPlans(f: { root?: string; state?: string } = {}): Plan[] {
  return db.query<Row, [string | null, string | null, string | null, string | null]>(
    `SELECT * FROM flight_plan WHERE (? IS NULL OR root = ?) AND (? IS NULL OR state = ?) ORDER BY created_at DESC, rowid DESC LIMIT 200`,
  ).all(f.root ?? null, f.root ?? null, f.state ?? null, f.state ?? null).map(toPlan);
}

export function createPlan(p: { root: string; title: string; request: string; visual: boolean; size?: Size; taskId?: string | null; by?: string }): Plan {
  const id = `fp_${randomBytes(8).toString("hex")}`, now = Date.now();
  db.query(`INSERT INTO flight_plan (id, root, title, request, visual, size, state, task_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`)
    .run(id, p.root, p.title, p.request, p.visual ? 1 : 0, p.size ?? "M", p.taskId ?? null, p.by ?? null, now, now);
  return getPlan(id)!;
}

/**
 * Title, plan, visual flag and mockups. A launched plan is history and is not
 * edited. Any change to a plan that was at Go or No-go sends it back to ready
 * (or draft with no plan): a Go belongs to the plan the person saw. A No-go's
 * reason stays, for the author to read, until the next decision.
 */
export function patchPlan(id: string, p: { title?: string; planMd?: string; visual?: boolean; size?: Size; mockups?: string[] }, by = "person"): Ok | Fail {
  const cur = getPlan(id);
  if (!cur) return { ok: false, error: "no such flight plan", status: 404 };
  if (cur.state === "launched") return { ok: false, error: "a launched plan is history; start a new flight plan", status: 409 };
  if (p.planMd !== undefined && Buffer.byteLength(p.planMd) > MAX_PLAN_BYTES) return { ok: false, error: `the plan is over ${MAX_PLAN_BYTES / 1000} KB`, status: 413 };
  if (p.title !== undefined && !p.title.trim()) return { ok: false, error: "title: not empty", status: 400 };
  const mockups: Mockup[] = [];
  for (const path of p.mockups ?? []) {
    const kind = mockupKind(path);
    if (!kind) return { ok: false, error: `mockups: a .png, .jpg, .webp or .html file, not ${path.slice(0, 200)}`, status: 400 };
    mockups.push({ path, kind });
  }
  const planMd = p.planMd ?? cur.planMd;
  const moved = !!cur.planMd.trim() && planMd !== cur.planMd;
  const edited: EditAfterReview | null = !moved ? cur.editedAfterReview
    : cur.editedAfterReview !== "open" && cur.state === "ready" && findingsAnswered(cur.preflightRunId) ? "answered" : "open";
  // The text being replaced is kept, so the person can compare what Go was said to with what came after.
  if (moved) {
    db.query(`INSERT INTO flight_plan_revision (plan_id, n, plan_md, created_at, by) VALUES (?, ?, ?, ?, ?)`).run(id, versionOf(id), cur.planMd, Date.now(), by);
  }
  const state: PlanState = planMd.trim() ? "ready" : "draft";
  db.query(`UPDATE flight_plan SET title = ?, plan_md = ?, visual = ?, size = ?, mockups = ?, state = ?, decision = ?, queued = 0, edited_after_review = ?, updated_at = ? WHERE id = ?`).run(
    p.title?.trim().slice(0, 200) ?? cur.title, planMd, (p.visual ?? cur.visual) ? 1 : 0, p.size ?? cur.size, JSON.stringify(p.mockups ? mockups : cur.mockups), state,
    cur.state === "no-go" ? JSON.stringify(cur.decision) : null, edited, Date.now(), id,
  );
  return { ok: true, plan: getPlan(id)! };
}

export function countAutoRun(id: string): void {
  db.query(`UPDATE flight_plan SET auto_runs = auto_runs + 1 WHERE id = ?`).run(id);
}

export function setPreflightRun(id: string, runId: string): void {
  db.query(`UPDATE flight_plan SET preflight_run_id = ?, review_rounds = review_rounds + 1, reviewed_version = ?, reviewed_size = size, edited_after_review = NULL, updated_at = ? WHERE id = ?`).run(runId, versionOf(id), Date.now(), id);
}

export const QUESTION_STOPS: readonly StopReason[] = ["ask-finding", "builder-blocked", "sensitive-diff"];
/** The coordinator raises the one question a plan waits on. A plan has one at a time; the person's answer clears it. */
export function raiseQuestion(id: string, q: { text: string; detail?: string; choices: string[]; recommended?: number; reason: StopReason }, by: string): Ok | Fail {
  const cur = getPlan(id);
  if (!cur) return { ok: false, error: "no such flight plan", status: 404 };
  if (cur.question && !cur.question.answer) return { ok: false, error: "this plan already waits on a question: merge them into one", status: 409 };
  const text = q.text.trim().slice(0, 1000), choices = q.choices.map((c) => c.trim().slice(0, 200)).filter(Boolean).slice(0, 4);
  if (!text) return { ok: false, error: "question: say it in one sentence", status: 400 };
  if (q.recommended !== undefined && !(Number.isInteger(q.recommended) && q.recommended >= 0 && q.recommended < choices.length)) return { ok: false, error: "recommended: the number of one of the choices", status: 400 };
  const detail = q.detail?.trim().slice(0, 2000);
  if (!QUESTION_STOPS.includes(q.reason)) return { ok: false, error: `reason: ${QUESTION_STOPS.join(" or ")}`, status: 400 };
  db.query(`UPDATE flight_plan SET question = ?, stop_reason = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify({ id: `q_${randomBytes(4).toString("hex")}`, text, ...(detail ? { detail } : {}), choices, ...(q.recommended !== undefined ? { recommended: q.recommended } : {}), by, at: Date.now() } satisfies Question), q.reason, Date.now(), id);
  return { ok: true, plan: getPlan(id)! };
}
export function answerQuestion(id: string, text: string, by: string): Ok | Fail {
  const cur = getPlan(id);
  if (!cur) return { ok: false, error: "no such flight plan", status: 404 };
  if (!cur.question || cur.question.answer) return { ok: false, error: "this plan waits on no question", status: 409 };
  const answer = text.trim().slice(0, 1000);
  if (!answer) return { ok: false, error: "answer: not empty", status: 400 };
  db.query(`UPDATE flight_plan SET question = ?, stop_reason = NULL, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify({ ...cur.question, answer: { text: answer, by, at: Date.now() } }), Date.now(), id);
  return { ok: true, plan: getPlan(id)! };
}
/** The builder's line of progress. Only a launched plan has a builder; the text is capped and is data. */
export function reportProgress(id: string, r: { line: string; step?: number; of?: number }, by: string): Ok | Fail {
  const cur = getPlan(id);
  if (!cur) return { ok: false, error: "no such flight plan", status: 404 };
  if (cur.state !== "launched") return { ok: false, error: "only a launched plan has a builder to report", status: 409 };
  const line = r.line.replace(/\s+/g, " ").trim().slice(0, 200);
  if (!line) return { ok: false, error: "line: one line of what is done or what comes next", status: 400 };
  const n = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 999 ? v : null);
  const step = n(r.step), of = n(r.of);
  if (step !== null && of !== null && step > of) return { ok: false, error: "step: not more than the number of steps", status: 400 };
  db.query(`UPDATE flight_plan SET last_report = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify({ line, step, of, by, at: Date.now() } satisfies Report), Date.now(), id);
  return { ok: true, plan: getPlan(id)! };
}
/** Takes a launch back when the builder's tab did not open: the plan is at Go again, as if no press had happened. */
export function unlaunch(id: string): void {
  db.query(`UPDATE flight_plan SET state = 'go', launched = NULL, updated_at = ? WHERE id = ? AND state = 'launched'`).run(Date.now(), id);
}
/** Where the builder's tab is, known once it opened. */
export function setLaunchedTab(id: string, tab: { window: string; session?: string }): void {
  const p = getPlan(id);
  if (p?.launched) db.query(`UPDATE flight_plan SET launched = ? WHERE id = ?`).run(JSON.stringify({ ...p.launched, ...tab }), id);
}
/** Remembers the first time a launched plan was seen landed: "landed today" needs a time and git keeps none for a fast-forward. */
export function markLanded(id: string): void {
  db.query(`UPDATE flight_plan SET landed_at = ? WHERE id = ? AND landed_at IS NULL`).run(Date.now(), id);
}
export function setQueued(id: string, queued: boolean): void {
  db.query(`UPDATE flight_plan SET queued = ? WHERE id = ?`).run(queued ? 1 : 0, id);
}

/** What stops Go: no plan yet, or a visual request with no mockup. Never a finding. */
export const goBlock = (p: Plan): string | null =>
  !p.planMd.trim() ? "there is no plan to say Go to yet" : p.visual && !p.mockups.length ? "this request is visual: the plan needs a mockup before Go" : null;

export function decide(id: string, verdict: "go" | "no-go", by: string, reason?: string): Ok | Fail {
  const cur = getPlan(id);
  if (!cur) return { ok: false, error: "no such flight plan", status: 404 };
  if (cur.state !== "ready" && !(cur.state === "go" && verdict === "no-go")) return { ok: false, error: `a ${cur.state} plan cannot be told ${verdict === "go" ? "Go" : "No-go"}`, status: 409 };
  if (verdict === "go") { const b = goBlock(cur); if (b) return { ok: false, error: b, status: 409 }; }
  const why = reason?.trim().slice(0, 1000);
  if (verdict === "no-go" && !why) return { ok: false, error: "No-go needs a reason: it goes back to the author", status: 400 };
  // The Go record says when it went to a text Preflight did not read: reviewBlock let it through as the answer to the findings.
  const editedAfter = verdict === "go" && cur.reviewedVersion !== null && cur.reviewedVersion !== versionOf(id);
  db.query(`UPDATE flight_plan SET state = ?, decision = ?, updated_at = ? WHERE id = ? AND state = ?`)
    .run(verdict, JSON.stringify({ by, at: Date.now(), ...(why ? { reason: why } : {}), ...(editedAfter ? { editedAfterPreflight: true } : {}) }), Date.now(), id, cur.state);
  return { ok: true, plan: getPlan(id)! };
}

/** go to launched, once: false when another press got there first. */
export function markLaunched(id: string, where: LaunchedWhere = {}): boolean {
  const p = getPlan(id);
  return !!p && db.query(`UPDATE flight_plan SET state = 'launched', queued = 0, launched = ?, updated_at = ? WHERE id = ? AND state = 'go'`)
    .run(JSON.stringify({ at: Date.now(), title: p.title, ...where }), Date.now(), id).changes > 0;
}

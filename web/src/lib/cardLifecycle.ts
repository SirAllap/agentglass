/*
 * One card, one lifecycle: what agentglass already records about a card, joined into the stage strip, the metric tiles, the timeline
 * and the next action the Jira card's first tab draws. Pure and request-free, so the join is asserted without a renderer.
 *
 * Sources, and only these: the card's moves (Jira's changelog as the detail read carries it), the flight plans and their review
 * runs, the sessions of the fleet whose title or folder names the card, the pull request the board already found for it and the
 * last reading of its checks. A tile or a stage nothing here can fill is left out of the answer and named in `gaps`; there is no
 * default number.
 */
import type { CardEvent } from "../../../shared/providers.ts";
import { ROLES, type Role } from "./cardRoles.ts";

export { ROLES };
export type { Role };

export type StageId = "picked" | "plan" | "session" | "branch" | "pr" | "qa" | "merge" | "deploy";
export const STAGE_LABEL: Record<StageId, string> = {
  picked: "Picked", plan: "Plan", session: "Session", branch: "Branch", pr: "PR", qa: "QA", merge: "Merge", deploy: "Deploy",
};
/** The strip's order. `deploy` is listed so the gap is named; nothing records a deploy, so it is never drawn. */
export const STAGES: readonly StageId[] = ["picked", "plan", "session", "branch", "pr", "qa", "merge", "deploy"];

/** The site names its statuses, so the QA stage is the statuses the workflow map's hand-off step moves a card to; none mapped, no QA stage. */
const inQa = (names: readonly string[], status: string | undefined): boolean => {
  const s = (status ?? "").trim().toLowerCase();
  return !!s && names.some((n) => n.trim().toLowerCase() === s);
};

export interface PlanLite {
  id: string; title: string; state: string; size?: string | null; createdAt: number; createdBy?: string | null;
  decision?: { by: string; at: number; reason?: string } | null;
  reviewRounds: number; landedAt?: number | null;
  launched?: { at: number; branch?: string; window?: string; session?: string } | null;
  lastReport?: { line: string; at: number } | null;
  question?: { text: string; answer?: unknown } | null;
  stopReason?: unknown;
}
export interface RunLite {
  id: string; createdAt: number; state: string;
  certificate?: { costUsd: number; costKnown?: boolean; findings: { severity: string }[] } | null;
}
export interface SessionLite { sessionId: string; title: string; status: string; cost: number; model: string | null; lastSeen: number; live: boolean; /** For the row's tooltip, and (cwd) for finding its tab. */ cwd?: string | null; tools?: number; errors?: number; doing?: string | undefined }
export interface PrLite { number: number; state: string; draft?: boolean; url: string }
export interface ChecksLite { total: number; success: number; failure: number; pending: number; skipped?: number; allDone: boolean; at: number }

export interface LifecycleInput {
  now: number;
  status: string;
  statusKind: "open" | "done" | "other";
  /** The status names the workflow map says are QA (the hand-off step's move). Empty: the QA stage is not drawn. */
  qaStatuses?: readonly string[];
  moves: readonly CardEvent[];
  plans: readonly PlanLite[];
  runs: readonly RunLite[];
  sessions: readonly SessionLite[];
  pr: PrLite | null;
  checks: ChecksLite | null;
}

export type Tone = "ok" | "bad" | "warn" | "info" | "dim";
export interface StageView { id: StageId; label: string; state: "done" | "current" | "todo" | "skipped"; at: number | null }
export interface Tile { id: "cycle" | "cost" | "rounds" | "checks" | "stage"; value: string; label: string; tone?: Tone }
export interface TimelineRow { id: string; at: number | null; role: Role | null; title: string; detail: string; tone: Tone; plan?: string }
export type NextKind = "open-worker" | "open-plan" | "open-pr" | "send" | "none";
export interface NextAction { title: string; body: string; kind: NextKind; label: string; tone: Tone }
export interface Lifecycle { stages: StageView[]; tiles: Tile[]; timeline: TimelineRow[]; next: NextAction; gaps: string[]; /** The tracker status as the tracker spells it, and the pull request number, for the work block's pill and chip. */ status: string; prNumber: number | null }

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "17h", "2d 3h", "12m"; under a minute "now". */
export function spanOf(ms: number): string {
  if (!(ms > 0)) return "0m";
  if (ms < MIN) return "now";
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  return h ? `${d}d ${h}h` : `${d}d`;
}
export const usd = (n: number): string => `$${n.toFixed(2)}`;

const isMerged = (pr: PrLite | null): boolean => !!pr && /^merged$/i.test(pr.state);

/** The moves that took the card somewhere, oldest first; the creation is not a move. */
export function movesOf(events: readonly CardEvent[]): CardEvent[] {
  return events.filter((e) => e.kind === "status" && e.at > 0 && !!e.status).sort((a, b) => a.at - b.at);
}

export function stagesOf(i: LifecycleInput): StageView[] {
  const moves = movesOf(i.moves);
  const approved = i.plans.filter((p) => p.decision && p.state !== "no-go");
  const launched = i.plans.filter((p) => p.launched);
  const qa = i.qaStatuses ?? [];
  const qaMove = moves.find((m) => inQa(qa, m.status));
  const mergedAt = i.plans.map((p) => p.landedAt ?? 0).filter(Boolean).sort((a, b) => a - b)[0] ?? null;
  const evidence: Record<StageId, { has: boolean; at: number | null }> = {
    picked: { has: moves.length > 0 || i.plans.length > 0 || i.sessions.length > 0, at: moves[0]?.at ?? i.plans[0]?.createdAt ?? null },
    plan: { has: approved.length > 0 || launched.length > 0, at: approved[0]?.decision?.at ?? launched[0]?.launched?.at ?? null },
    session: { has: launched.length > 0 || i.sessions.length > 0, at: launched[0]?.launched?.at ?? null },
    branch: { has: launched.some((p) => !!p.launched?.branch) || !!i.pr, at: launched.find((p) => p.launched?.branch)?.launched?.at ?? null },
    pr: { has: !!i.pr, at: null },
    qa: { has: !!qaMove || inQa(qa, i.status), at: qaMove?.at ?? null },
    merge: { has: isMerged(i.pr) || mergedAt !== null, at: mergedAt },
    deploy: { has: false, at: null },
  };
  const order = STAGES.filter((s) => s !== "deploy" && (s !== "qa" || qa.length > 0));
  let last = -1;
  order.forEach((s, n) => { if (evidence[s].has) last = n; });
  return order.map((id, n): StageView => {
    const e = evidence[id];
    if (n > last) return { id, label: STAGE_LABEL[id], state: "todo", at: null };
    if (!e.has) return { id, label: STAGE_LABEL[id], state: "skipped", at: null };
    return { id, label: STAGE_LABEL[id], state: n === last && id !== "merge" ? "current" : "done", at: e.at };
  });
}

function planCost(runs: readonly RunLite[]): number {
  return runs.reduce((n, r) => n + (r.certificate && r.certificate.costKnown !== false ? r.certificate.costUsd : 0), 0);
}

export function tilesOf(i: LifecycleInput, stages: readonly StageView[], gaps: string[]): Tile[] {
  const out: Tile[] = [];
  const moves = movesOf(i.moves);
  const picked = stages.find((s) => s.id === "picked");
  const start = picked?.at ?? null;
  const landed = stages.find((s) => s.id === "merge")?.at ?? null;
  const doneMove = i.statusKind === "done" ? moves[moves.length - 1]?.at ?? null : null;
  if (start) out.push({ id: "cycle", value: spanOf((landed ?? doneMove ?? i.now) - start), label: landed || doneMove ? "Cycle time" : "Cycle time so far" });
  else gaps.push("Cycle time: nothing says when the card was picked");

  // Each session's cost once, however many ways it was tied to the card.
  const once = [...new Map(i.sessions.map((s) => [s.sessionId, s])).values()];
  const spent = once.reduce((n, s) => n + s.cost, 0) + planCost(i.runs);
  if (i.sessions.length || planCost(i.runs) > 0) out.push({ id: "cost", value: usd(spent), label: "Cost so far" });
  else gaps.push("Cost: no session or review run is tied to this card");

  const rounds = i.plans.reduce((n, p) => n + p.reviewRounds, 0);
  if (i.plans.length) out.push({ id: "rounds", value: String(rounds), label: "Review rounds" });
  else gaps.push("Review rounds: the card has no flight plan");

  if (i.checks && i.checks.total > 0) out.push({ id: "checks", value: `${i.checks.success + (i.checks.skipped ?? 0)}/${i.checks.total}`, label: "Checks passing", tone: i.checks.failure > 0 ? "bad" : i.checks.allDone ? "ok" : "warn" });
  else gaps.push("Checks: no reading of the pull request's checks");

  const cur = stages.find((s) => s.state === "current");
  if (cur && cur.at) out.push({ id: "stage", value: spanOf(i.now - cur.at), label: `In ${cur.label}` });
  else gaps.push("Time in stage: the current stage has no recorded start");
  return out;
}

const countSev = (r: RunLite, sev: string): number => r.certificate?.findings.filter((f) => f.severity === sev).length ?? 0;

export function timelineOf(i: LifecycleInput): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const e of i.moves) {
    if (e.kind === "created") rows.push({ id: `c${e.at}`, at: e.at, role: null, title: "Card created", detail: "", tone: "dim" });
  }
  for (const m of movesOf(i.moves)) {
    rows.push({ id: `m${m.at}`, at: m.at, role: null, title: `Moved to ${m.status}`, detail: m.from ? `From ${m.from}` : "", tone: "info" });
  }
  for (const p of i.plans) {
    rows.push({ id: `p${p.id}`, at: p.createdAt, role: "planner", title: "Plan drafted", detail: [p.size ? `Size ${p.size}` : "", p.title].filter(Boolean).join(" · "), tone: "info", plan: p.id });
    if (p.decision) {
      const no = p.state === "no-go";
      rows.push({ id: `d${p.id}`, at: p.decision.at, role: "planner", title: no ? "Plan declined" : "Plan approved", detail: no ? p.decision.reason ?? "" : `By ${p.decision.by}`, tone: no ? "bad" : "ok", plan: p.id });
    }
    if (p.launched) rows.push({ id: `l${p.id}`, at: p.launched.at, role: "builder", title: "Session launched", detail: p.launched.branch ? `Branch ${p.launched.branch}` : "", tone: "info", plan: p.id });
    if (p.lastReport) rows.push({ id: `r${p.id}`, at: p.lastReport.at, role: "builder", title: "Builder report", detail: p.lastReport.line, tone: "info", plan: p.id });
    if (p.landedAt) rows.push({ id: `g${p.id}`, at: p.landedAt, role: "landing", title: "Landed on the main branch", detail: "", tone: "ok", plan: p.id });
  }
  for (const r of i.runs) {
    if (r.state === "running" || r.state === "awaiting-go") rows.push({ id: `u${r.id}`, at: r.createdAt, role: "reviewer", title: "Preflight review running", detail: "", tone: "warn" });
    else if (r.certificate) {
      const blockers = countSev(r, "blocker");
      rows.push({ id: `u${r.id}`, at: r.createdAt, role: "reviewer", title: "Preflight review", detail: `${r.certificate.findings.length} findings, ${blockers} blocking`, tone: blockers ? "bad" : "ok" });
    }
  }
  for (const s of i.sessions) {
    rows.push({ id: `s${s.sessionId}`, at: null, role: "builder", title: s.live ? "Session live" : "Session ended", detail: [s.title, s.model, usd(s.cost)].filter(Boolean).join(" · "), tone: s.live ? "ok" : "dim" });
  }
  if (i.pr) rows.push({ id: `pr${i.pr.number}`, at: null, role: isMerged(i.pr) ? "landing" : "builder", title: `Pull request #${i.pr.number} ${isMerged(i.pr) ? "merged" : i.pr.draft ? "draft" : i.pr.state.toLowerCase()}`, detail: "", tone: isMerged(i.pr) ? "ok" : "info" });
  if (i.checks && i.checks.total > 0) {
    rows.push({ id: `k${i.checks.at}`, at: i.checks.at, role: "verifier", title: `Checks ${i.checks.success} of ${i.checks.total} passing`, detail: i.checks.failure ? `${i.checks.failure} failing` : i.checks.allDone ? "All done" : `${i.checks.pending} pending`, tone: i.checks.failure ? "bad" : i.checks.allDone ? "ok" : "warn" });
  }
  // Rows with a time in order; rows that only know "now" (a live session, a pull request's state) after them.
  return rows
    .map((r, n) => ({ r, n }))
    .sort((a, b) => (a.r.at === null ? 1 : 0) - (b.r.at === null ? 1 : 0) || (a.r.at ?? 0) - (b.r.at ?? 0) || a.n - b.n)
    .map((x) => x.r);
}

export function nextOf(i: LifecycleInput): NextAction {
  const live = i.sessions.find((s) => s.live);
  const asking = i.plans.find((p) => p.question && !p.question.answer);
  if (asking) return { title: "A plan is asking you", body: asking.question!.text, kind: "open-plan", label: "Open plan", tone: "warn" };
  const ready = i.plans.find((p) => p.state === "ready");
  if (ready) return { title: "A plan waits for your Go", body: `${ready.title} is written and reviewed.`, kind: "open-plan", label: "Open plan", tone: "warn" };
  if (live) {
    const needs = live.status === "waiting" || live.status === "stalled" || live.status === "errored";
    return { title: needs ? "The worker needs you" : "A worker is on it", body: `${live.title} is ${live.status}.${needs ? "" : " Nothing needed from you."}`, kind: "open-worker", label: "Open live worker", tone: needs ? "warn" : "ok" };
  }
  if (i.pr && !isMerged(i.pr)) {
    if (i.checks && i.checks.failure > 0) return { title: "Checks are failing", body: `${i.checks.failure} of ${i.checks.total} checks fail on #${i.pr.number}.`, kind: "open-pr", label: "Open pull request", tone: "bad" };
    return { title: "Pull request open", body: `#${i.pr.number} is ${i.pr.draft ? "a draft" : "waiting for review and merge"}.`, kind: "open-pr", label: "Open pull request", tone: "info" };
  }
  if (isMerged(i.pr) || i.statusKind === "done") return { title: "Nothing left to do", body: i.pr && isMerged(i.pr) ? `#${i.pr.number} is merged.` : `The card is ${i.status}.`, kind: "none", label: "", tone: "ok" };
  return { title: "No worker on this card", body: "Send it to a terminal to start one.", kind: "send", label: "Send to terminal", tone: "dim" };
}

export function cardLifecycle(i: LifecycleInput): Lifecycle {
  const gaps: string[] = ["Deploy: nothing records a deploy"];
  const stages = stagesOf(i);
  const tiles = tilesOf(i, stages, gaps);
  if (!i.qaStatuses?.length) gaps.push("QA: no status is mapped to QA in the workflow map");
  else if (!stages.some((s) => s.id === "qa" && s.state !== "todo")) gaps.push("QA: the card has not been in a QA status");
  return { stages, tiles, timeline: timelineOf(i), next: nextOf(i), gaps, status: i.status, prNumber: i.pr?.number ?? null };
}

/** The role chips that have at least one row, in the strip's order. */
export function rolesWithRows(rows: readonly TimelineRow[]): Role[] {
  return ROLES.filter((r) => rows.some((x) => x.role === r));
}

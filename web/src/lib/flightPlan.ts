/*
 * FLIGHT PLAN — the decisions behind the view, as plain functions.
 *
 * There is no renderer in this project, so everything the Flight plan screen
 * decides lives here and is tested here: which station of the trajectory a plan
 * is at, which group a plan sits in, how many findings are open, whether Go is
 * available. The view only lays them out.
 *
 * Findings are advisory. Nothing in this file lets a finding switch Go off: Go
 * wants a written plan (and a mockup when the plan is visual), and nothing else.
 */
import type { BuilderState, StopReason } from "../../../shared/types.ts";
/* A cycle with flightPilot, safe because each side uses the other only inside functions. */
import { flightGroups, flightItems } from "./flightPilot.ts";

export type PlanState = "draft" | "ready" | "go" | "no-go" | "launched";
export type Size = "S" | "M" | "L";
export type FindingAction = "fix" | "contest" | "ask" | "dismiss";
export type Severity = "blocker" | "major" | "nit";
export type RunState = "awaiting-go" | "running" | "done" | "failed" | "declined";

export interface Finding {
  id: string; severity: Severity; title: string; quote: string; evidence: string;
  action: FindingAction | null; note: string | null; by?: string;
}
export interface Certificate {
  id: string; createdAt: number; model: string; costUsd: number; capUsd?: number;
  files: { path: string; sha256: string; bytes: number; part?: string }[];
  mockups: { path: string; sha256: string; bytes: number; kind: "image" | "html" }[];
  skipped: { path: string; reason: string }[];
  sawConversation: false; isolation: string; findings: Finding[];
}
export interface Run {
  id: string; createdAt: number; root: string; moment: string; state: RunState; requestedBy: string;
  input: { budgetUsd?: number; model?: string; files?: string[] }; certificate: Certificate | null; error: string | null; taskId: string | null;
}
export interface Plan {
  id: string; root: string; title: string; request: string; visual: boolean; planMd: string; planBytes: number;
  mockups: { path: string; kind: string }[]; state: PlanState;
  decision: { by: string; at: number; reason?: string } | null;
  preflightRunId: string | null; taskId: string | null;
  /** Reviews the server started on its own after new plan text; at 2 it stops and waits to be asked. */
  autoRuns: number;
  /** Where the builder flies once launched (the engine keeps the branch, its tree and its tab). */
  launched: { at: number; ticket?: string; title: string; branch?: string; worktree?: string; window?: string; session?: string; from?: string; base?: string } | null;
  /** Preflights started for this plan, by itself or by a press. */
  reviewRounds: number;
  /** Why the coordinator stops and asks the person; null when nothing does. Computed by the engine on every read. */
  stopReason: StopReason | null;
  /** The one question the coordinator put to the person, with the answer once it came. */
  question: PlanQuestion | null;
  /** Go was said but the builders in the air are at the cap: it launches when one lands. */
  queued: boolean;
  /** The project's flying mode and hold, as the list read carries them; who held and when ride beside it. */
  pilot?: "manual" | "copilot" | "autopilot"; held?: boolean; heldBy?: string | null; heldAt?: number | null;
  /** "you", `coordinator:<seat>` or an agent's name; null for a plan made before the engine kept it. */
  createdBy: string | null;
  /** When the plan was first seen merged into main; null while it flies. */
  landedAt: number | null;
  /** The builder's own last line of progress and where it says it is. */
  lastReport: { line: string; step: number | null; of: number | null; by: string; at: number } | null;
  size: Size | null; createdAt: number; updatedAt: number;
  /** The version the last Preflight read; null before any. The plan is edited after Preflight when this is set and differs from `version`. */
  reviewedVersion?: number | null;
  /** What the plans list says about a launched plan's builder tab; absent from a read that does not carry it. */
  builder?: BuilderState;
  /** When the tab was first seen closed (the server's memory, so a restart restamps it), and when the plan entered its state. */
  goneAt?: number | null; stateSince?: number | null;
  /** Queued only: the builders holding the slots Go waits for. */
  slotHolders?: { id: string; title: string }[];
  /** 1 for the first text the plan had, +1 each time the text was replaced. Only the open plan's read carries it. */
  version?: number;
}
export interface PlanQuestion { id?: string; text: string; detail?: string; choices: string[]; recommended?: number; by: string; at: number; answer?: { text: string; by: string; at: number } }
export interface PlanDetail { plan: Plan; run: Run | null }

type Raw = Record<string, unknown>;
const pick = (o: Raw, ...ks: string[]): unknown => { for (const k of ks) if (o[k] !== undefined && o[k] !== null) return o[k]; return null; };
const parse = (v: unknown): unknown => { if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return null; } };

/** A plan from the wire. The server stores snake_case columns and the rest of its
 *  routes speak camelCase, so both spellings are read. */
export function toPlan(r: Raw): Plan {
  const size = String(pick(r, "size") ?? "");
  return {
    id: String(r.id), root: String(r.root ?? ""), title: String(r.title ?? ""), request: String(r.request ?? ""),
    visual: r.visual === true || r.visual === 1,
    planMd: String(pick(r, "planMd", "plan_md") ?? ""),
    planBytes: Number(pick(r, "planBytes") ?? String(pick(r, "planMd", "plan_md") ?? "").length),
    mockups: (parse(r.mockups) as Plan["mockups"] | null) ?? [],
    state: (String(r.state ?? "draft") as PlanState),
    decision: parse(r.decision) as Plan["decision"],
    preflightRunId: (pick(r, "preflightRunId", "preflight_run_id") as string | null),
    taskId: (pick(r, "taskId", "task_id") as string | null),
    autoRuns: Number(pick(r, "autoRuns", "auto_runs") ?? 0),
    launched: (parse(r.launched) as Plan["launched"] | undefined) ?? null,
    reviewRounds: Number(pick(r, "reviewRounds", "review_rounds") ?? 0),
    stopReason: (pick(r, "stopReason", "stop_reason") as StopReason | null),
    question: (parse(r.question) as PlanQuestion | null | undefined) ?? null,
    queued: r.queued === true || r.queued === 1,
    ...(r.pilot === "manual" || r.pilot === "copilot" || r.pilot === "autopilot" ? { pilot: r.pilot } : {}),
    ...(typeof r.held === "boolean" ? { held: r.held } : {}),
    ...(typeof r.heldBy === "string" || r.heldBy === null ? { heldBy: r.heldBy as string | null } : {}),
    ...(typeof r.heldAt === "number" || r.heldAt === null ? { heldAt: r.heldAt as number | null } : {}),
    createdBy: (pick(r, "createdBy", "created_by") as string | null),
    landedAt: Number(pick(r, "landedAt", "landed_at")) || null,
    lastReport: (parse(pick(r, "lastReport", "last_report")) as Plan["lastReport"] | null) ?? null,
    size: size === "S" || size === "M" || size === "L" ? size : null,
    createdAt: Number(pick(r, "createdAt", "created_at") ?? 0), updatedAt: Number(pick(r, "updatedAt", "updated_at") ?? 0),
    reviewedVersion: typeof pick(r, "reviewedVersion", "reviewed_version") === "number" ? (pick(r, "reviewedVersion", "reviewed_version") as number) : null,
    ...(r.builder === "live" || r.builder === "gone" || r.builder === "none" || r.builder === "unknown" ? { builder: r.builder } : {}),
    ...(typeof r.goneAt === "number" ? { goneAt: r.goneAt } : {}),
    ...(typeof r.stateSince === "number" ? { stateSince: r.stateSince } : {}),
    ...(Array.isArray(r.slotHolders) ? { slotHolders: (r.slotHolders as { id: string; title: string }[]).filter((h) => typeof h?.id === "string").map((h) => ({ id: h.id, title: String(h.title ?? "") })) } : {}),
  };
}

export interface DiffRow { kind: "same" | "add" | "del"; text: string }
/**
 * What changed between two plan texts, line by line (longest common run of
 * lines). A plan is a few hundred lines at most, so the quadratic table is
 * fine; past 2 000 lines on either side it says everything changed rather
 * than build a table of millions of cells.
 */
export function lineDiff(before: string, after: string): DiffRow[] {
  const a = before.split("\n"), b = after.split("\n");
  if (a.length > 2000 || b.length > 2000) return [...a.map((text) => ({ kind: "del" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))];
  const w = b.length + 1, t = new Uint16Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
  const out: DiffRow[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push({ kind: "same", text: a[i]! }); i++; j++; }
    else if (i < a.length && (j === b.length || t[(i + 1) * w + j]! >= t[i * w + j + 1]!)) out.push({ kind: "del", text: a[i++]! });
    else out.push({ kind: "add", text: b[j++]! });
  }
  return out;
}

/** A finding still waiting on the person: not answered, or answered "ask me". */
export const isOpen = (f: Finding): boolean => f.action === null || f.action === "ask";
export const findingsOf = (run: Run | null): Finding[] => run?.certificate?.findings ?? [];
export const openCount = (run: Run | null): number => findingsOf(run).filter(isOpen).length;
export const askedCount = (run: Run | null): number => findingsOf(run).filter((f) => f.action === "ask").length;
export const bySeverity = (run: Run | null): Record<Severity, number> => {
  const c = { blocker: 0, major: 0, nit: 0 };
  for (const f of findingsOf(run)) c[f.severity]++;
  return c;
};

/** The author has saved a plan. The list is read without the text, so its size says it. */
export const written = (p: Plan): boolean => p.planMd.trim().length > 0 || p.planBytes > 0;

/** Go is about the plan, never about the findings. */
export function goBlocker(p: Plan): string | null {
  if (!written(p)) return "The plan is not written yet.";
  if (p.visual && p.mockups.length === 0) return "This plan is visual and has no mockup yet.";
  if (p.state === "launched") return "Already launched.";
  if (p.state === "no-go") return "Sent back with a No-go.";
  return null;
}
export const canGo = (p: Plan): boolean => goBlocker(p) === null;

/** What the Go route answers: the plan and either where the builder went, that it waits for a slot, or why it could not start (the plan then stays at Go). */
export interface GoWire { ok: boolean; error?: string; queued?: boolean; launchError?: string }
export type GoOutcome = { kind: "launched" } | { kind: "queued" } | { kind: "retry"; error: string } | { kind: "refused"; error: string };
/** The person's Go launches at once; the coordinator's waits for a free builder slot. A launch error leaves Go said and the Launch button as the retry. */
export function goOutcome(r: GoWire): GoOutcome {
  if (!r.ok) return { kind: "refused", error: r.error ?? "Go was refused" };
  if (r.launchError) return { kind: "retry", error: r.launchError };
  return r.queued ? { kind: "queued" } : { kind: "launched" };
}

/** What the person types for a No-go has to say something. */
export const nogoReason = (s: string): string | null => { const t = s.trim(); return t ? t.slice(0, 500) : null; };

export type Station = "done" | "cur" | "skip" | "todo";
/** Mirrors AUTO_RUNS_MAX in server/src/flightPlan.ts. */
export const AUTO_RUNS_MAX = 2;
export const STATIONS = ["Request", "Flight plan", "Mockup", "Preflight", "Findings", "Go / No-go", "Launch"] as const;

/**
 * The seven stations of the trajectory. The current one is the first that is
 * neither done nor skipped: it is the only thing that moves.
 */
export function stationStates(p: Plan, run: Run | null, preflightOn: boolean): Station[] {
  const wrote = written(p);
  const decided = p.state === "go" || p.state === "no-go" || p.state === "launched";
  const ran = run?.state === "done";
  const flags: (Station | null)[] = [
    "done",
    wrote ? "done" : null,
    !p.visual ? "skip" : p.mockups.length > 0 ? "done" : wrote ? null : "todo",
    ran ? "done" : !run && !preflightOn ? "skip" : run?.state === "declined" ? "skip" : null,
    ran ? (openCount(run) === 0 || decided ? "done" : null) : (!run && !preflightOn) || run?.state === "declined" ? "skip" : "todo",
    decided ? "done" : null,
    p.state === "launched" ? "done" : null,
  ];
  let cur = false;
  return flags.map((f) => {
    if (f) return f;
    if (!cur) { cur = true; return "cur"; }
    return "todo";
  });
}

export type Group = "awaiting" | "progress" | "launched";
/** Where a plan sits in the list. A plan said No-go to is in History, not here. */
export function groupOf(p: Plan, run: Run | null): Group | null {
  if (p.state === "no-go") return null;
  if (p.state === "launched") return "launched";
  if (p.state === "draft" || (p.state === "go" && p.queued)) return "progress";
  if (run && (run.state === "running" || run.state === "awaiting-go")) return "progress";
  return "awaiting";
}

export interface Grouped { awaiting: PlanDetail[]; progress: PlanDetail[]; launched: PlanDetail[] }
export function groupPlans(ds: PlanDetail[]): Grouped {
  const g: Grouped = { awaiting: [], progress: [], launched: [] };
  for (const d of ds) { const k = groupOf(d.plan, d.run); if (k) g[k].push(d); }
  return g;
}

/** The list's filter box: shown from this many plans on, matches title, project and task. */
export const FILTER_AT = 12;
export const matches = (p: Plan, q: string): boolean => {
  const s = q.trim().toLowerCase();
  return !s || `${p.title} ${p.root} ${p.taskId ?? ""}`.toLowerCase().includes(s);
};
/** Groups past the first stay folded until opened, once the list is long. */
export const foldedByDefault = (g: Group, total: number): boolean => total >= FILTER_AT && g !== "awaiting" && g !== "progress";

/** The one line under a plan in the list. */
export function subline(p: Plan, run: Run | null, now: number): string {
  if (p.state === "launched") return `Go · ${when(p.launched?.at ?? p.updatedAt, now)}`;
  if (p.state === "draft") return "writing the plan";
  if (run?.state === "running") return `Preflight running · ${Math.max(1, Math.round((now - run.createdAt) / 1000))} s`;
  if (run?.state === "awaiting-go") return "Preflight waits for your go";
  if (run?.state === "failed") return "Preflight stopped";
  const open = askedCount(run);
  const bits = [p.taskId, p.size, open ? `${open} ${open === 1 ? "asks" : "ask"} you` : openCount(run) ? `${openCount(run)} open` : ""].filter(Boolean);
  return bits.join(" · ") || "ready for Go";
}

const DAY = 86_400_000;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "today", "yesterday", then "Fri 24" for the rest of the month-ish. */
export function when(at: number, now: number): string {
  const d = new Date(at), n = new Date(now);
  const day0 = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day0(n) - day0(d)) / DAY);
  if (diff <= 0) return "today";
  if (diff === 1) return "yesterday";
  return `${DAYS[d.getDay()]} ${d.getDate()}`;
}

export const kb = (bytes: number): string => (bytes >= 1000 ? `${(bytes / 1000).toFixed(1)} KB` : `${bytes} B`);
export const usd = (n: number): string => `$${n.toFixed(2)}`;

/**
 * A run the cost cap stopped, in the numbers the error note speaks in: what it
 * spent, the cap it ran under (its own, which a one-off may have raised), what
 * it had to read, and the one-off cap to offer (double, at most the server's $5).
 * Which of those files it had reached is not known: the reviewer's reply is one
 * JSON line at the end, so the note names what it was given, never "2 of 6".
 */
export function capStop(run: Run | null, cap: number): { spent: number | null; cap: number; files: number; once: number } | null {
  if (run?.state !== "failed" || !/stopped at the cap|budget/i.test(run.error ?? "")) return null;
  const runCap = run.input.budgetUsd ?? cap;
  const spent = /spent \$(\d+(?:\.\d+)?)/.exec(run.error ?? "");
  return { spent: spent ? Number(spent[1]) : null, cap: runCap, files: run.input.files?.length ?? 0, once: Math.min(5, Math.round(runCap * 200) / 100) };
}
export const projectName = (root: string): string => root.split("/").filter(Boolean).slice(-2).join("/") || root;
export const lastName = (root: string): string => root.split("/").filter(Boolean).pop() ?? root;

/** A title from what the person typed: its first line, trimmed to a sentence. */
export function titleFrom(request: string): string {
  const first = request.trim().split(/\n/)[0]?.trim() ?? "";
  const cut = first.length > 80 ? first.slice(0, 79).replace(/\s+\S*$/, "") + "…" : first;
  return cut || "New flight plan";
}

export type Verdict = "go" | "no-go" | "checked";
/** "1 file", "3 files". */
export const filesWord = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

export interface HistoryRow {
  key: string; at: number; title: string; sub: string; dots: Severity[]; verdict: Verdict; cost: number; planId: string | null; runId: string | null;
}
/** Every plan that reached Go or No-go, and every task or pull request a Preflight checked. Newest first. */
export function historyRows(ds: PlanDetail[], runs: Run[]): HistoryRow[] {
  const used = new Set(ds.map((d) => d.run?.id).filter(Boolean));
  const dots = (r: Run | null) => findingsOf(r).map((f) => f.severity);
  /* A plan's own text is read too, though the certificate lists only the files beside it; a task or pull request has no plan text. */
  const files = (r: Run | null, plan: boolean) => (r?.certificate ? r.certificate.files.length + r.certificate.mockups.length + (plan ? 1 : 0) : 0);
  const rows: HistoryRow[] = ds.filter((d) => d.plan.state === "go" || d.plan.state === "no-go" || d.plan.state === "launched").map(({ plan: p, run }) => ({
    key: p.id, at: p.decision?.at ?? p.launched?.at ?? p.updatedAt, title: p.title,
    sub: [lastName(p.root), p.size, run ? `${filesWord(files(run, true))} read` : "no Preflight"].filter(Boolean).join(" · "),
    dots: dots(run), verdict: p.state === "no-go" ? "no-go" : "go", cost: run?.certificate?.costUsd ?? 0, planId: p.id, runId: run?.id ?? null,
  }));
  for (const r of runs) {
    if (used.has(r.id) || r.state !== "done" || (r.moment !== "task-done" && r.moment !== "pr")) continue;
    rows.push({
      key: r.id, at: r.createdAt, title: r.certificate?.files[0] ? lastName(r.certificate.files[0].path) : r.moment,
      sub: [lastName(r.root), r.moment === "pr" ? "pull request" : "task done", filesWord(files(r, false))].join(" · "),
      dots: dots(r), verdict: "checked", cost: r.certificate?.costUsd ?? 0, planId: null, runId: r.id,
    });
  }
  return rows.sort((a, b) => b.at - a.at);
}

export const monthSpend = (rows: HistoryRow[], now: number): number => {
  const m = new Date(now);
  return rows.filter((r) => { const d = new Date(r.at); return d.getFullYear() === m.getFullYear() && d.getMonth() === m.getMonth(); }).reduce((s, r) => s + r.cost, 0);
};

/** Every plan in the Waiting on you group: a Go owed, an open question, a stop rule that fired. The one definition the list and the top bar share. */
const waitingOn = (ds: PlanDetail[], now: number): PlanDetail[] => {
  const ids = new Set(flightGroups(flightItems(ds), now).waiting.map((it) => it.plan.id));
  return ds.filter((d) => ids.has(d.plan.id));
};
/** The top bar's "needs you" reason, or null when no plan waits on a person. */
export function needsYou(ds: PlanDetail[], now = Date.now()): string | null {
  const n = waitingOn(ds, now).length;
  if (n === 0) return null;
  const allGo = groupPlans(ds).awaiting.length === n;
  return n === 1 ? (allGo ? "flight plan awaiting Go" : "flight plan needs you") : allGo ? `${n} flight plans awaiting Go` : `${n} flight plans need you`;
}
/** The plan the "needs you" chip opens: the one waiting longest. */
export const needsYouPlan = (ds: PlanDetail[], now = Date.now()): string | null => waitingOn(ds, now).sort((a, b) => a.plan.updatedAt - b.plan.updatedAt)[0]?.plan.id ?? null;

/** What the person sees on the Go poll, one row per station. `skip` is the dashed "advisory" light. */
export interface PollRow { k: string; v: string; light: "go" | "skip" | "hold" }
export function pollRows(p: Plan, run: Run | null, capUsd: number): PollRow[] {
  const cert = run?.certificate ?? null;
  const open = openCount(run), all = findingsOf(run).length;
  const rows: PollRow[] = [{ k: "Flight plan", v: `written by the author · ${kb(p.planBytes)}`, light: written(p) ? "go" : "hold" }];
  if (p.visual) rows.push({ k: "Mockup", v: p.mockups.length ? `${p.mockups.length} ${p.mockups.length === 1 ? "screen" : "screens"}` : "none yet", light: p.mockups.length ? "go" : "hold" });
  if (cert) {
    rows.push({ k: "Preflight", v: "fresh reviewer · saw no conversation", light: "go" });
    rows.push(open ? { k: "Findings", v: `${all - open} of ${all} answered · they never block Go`, light: "skip" } : { k: "Findings", v: `${all} of ${all} answered`, light: "go" });
    rows.push({ k: "Cost", v: `${usd(cert.costUsd)} of the ${usd(capUsd)} cap`, light: "go" });
    if (p.autoRuns >= AUTO_RUNS_MAX) rows.push({ k: "Re-review", v: "on request", light: "skip" });
  } else rows.push({ k: "Preflight", v: run?.state === "running" ? "reading now" : run?.state === "awaiting-go" ? "waits for your go" : "not run for this plan", light: "skip" });
  return rows;
}

/** How many sections of a plan are shown before the fold. */
export const SHOWN_SECTIONS = 2;
/**
 * A plan, split at its headings: the first sections to read at once, and the
 * titles of the rest for the fold ("Out of scope, tests, rollback · 3 more sections").
 * A plan with no headings is one section and has nothing to fold.
 */
export function splitPlan(md: string, shown = SHOWN_SECTIONS): { head: string; rest: { title: string; body: string }[] } {
  const parts: { title: string; body: string }[] = [];
  let cur: { title: string; lines: string[] } | null = null;
  let fence = false;
  const push = () => { if (cur) parts.push({ title: cur.title, body: cur.lines.join("\n") }); };
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && /^#{1,3}\s+(.*\S)\s*$/.exec(line);
    if (h) { push(); cur = { title: h[1]!, lines: [line] }; continue; }
    if (!cur) cur = { title: "", lines: [] };
    cur.lines.push(line);
  }
  push();
  const real = parts.filter((p) => p.body.trim());
  return { head: real.slice(0, shown).map((p) => p.body).join("\n"), rest: real.slice(shown).map((p) => ({ title: p.title || "More", body: p.body })) };
}

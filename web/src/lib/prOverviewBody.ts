// What the Overview body shows, decided away from React so it can be tested.
//
// Blockers ("What is in the way"), the checks summary, the latest of the
// conversation and the rail's detail rows. All of it comes from data the panel
// already holds; nothing here fetches.

import type { PathRow } from "../../../shared/mergePath.ts";
import type { PrCheck, PrDetail } from "../../../shared/types.ts";

export type NeedAct = "rerun" | "checks" | "nudge" | "ask-review" | "update-branch" | "threads" | "mark-ready" | "fix-conflicts" | "unstick";
export type NeedTone = "bad" | "warn";
export type NeedIcon = "merge" | "bolt" | "user" | "clock" | "update" | "thread" | "lock" | "draft" | "info";

export interface Need {
  id: string;
  tone: NeedTone;
  icon: NeedIcon;
  /** The bold opening of the sentence. */
  lead: string;
  /** Names printed in the machine face after the lead. */
  mono: string[];
  /** How many more there were than `mono` shows. */
  more: number;
  rest: string;
  act?: { id: NeedAct; label: string };
}

const MONO_MAX = 3;

function names(rows: PathRow[]): { mono: string[]; more: number } {
  const all = rows.map((r) => r.title);
  return { mono: all.slice(0, MONO_MAX), more: Math.max(0, all.length - MONO_MAX) };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The reviewer's login, from a row titled "login · what they did". */
function loginOf(r: PathRow): string {
  return r.person?.login ?? r.title.split(" · ")[0] ?? r.title;
}

const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

export function needsFrom(rows: PathRow[], o: { canFixConflicts: boolean; /** The open pull request this one is stacked on. */ stackBase?: number }): Need[] {
  const out: Need[] = [];
  if (o.stackBase !== undefined) {
    out.push({ id: "stack-base", tone: "bad", icon: "lock", lead: `#${o.stackBase} is not merged yet.`, mono: [], more: 0, rest: "This pull request is stacked on it and lands after it." });
  }
  const counted = rows.filter((r) => r.counted && r.kind !== "note" && r.kind !== "approved");
  const of = (...k: PathRow["kind"][]) => counted.filter((r) => k.includes(r.kind));
  for (const r of counted) {
    switch (r.kind) {
      case "draft":
        out.push({ id: r.id, tone: "warn", icon: "draft", lead: "It is a draft.", mono: [], more: 0, rest: "Mark it ready for review before it can merge.", act: { id: "mark-ready", label: "Ready for review" } });
        break;
      case "locked": case "no-permission": case "restricted":
        out.push({ id: r.id, tone: r.mover === "fyi" ? "warn" : "bad", icon: "lock", lead: sentence(r.title), mono: [], more: 0, rest: r.why });
        break;
      case "conflicts":
        out.push({ id: r.id, tone: "bad", icon: "merge", lead: sentence(r.title), mono: [], more: 0, rest: r.why,
          ...(o.canFixConflicts ? { act: { id: "fix-conflicts" as const, label: "Fix in terminal" } } : null) });
        break;
      case "changes": {
        const login = loginOf(r);
        out.push({ id: r.id, tone: "bad", icon: "user", lead: `${login} asked for changes.`, mono: [], more: 0, rest: r.sub ?? "", act: { id: "ask-review", label: "Ask again" } });
        break;
      }
      case "review-required":
        out.push({ id: r.id, tone: "warn", icon: "user", lead: sentence(r.title), mono: [], more: 0, rest: r.sub ?? r.why,
          act: r.person && (r.mover === "reviewer" || r.mover === "team") ? { id: "nudge", label: "Nudge" } : { id: "ask-review", label: "Ask for review" } });
        break;
      case "threads":
        out.push({ id: r.id, tone: "warn", icon: "thread", lead: sentence(r.title), mono: [], more: 0, rest: r.why, act: { id: "threads", label: "Open threads" } });
        break;
      case "behind":
        out.push({ id: r.id, tone: "warn", icon: "update", lead: sentence(r.title), mono: [], more: 0, rest: "", act: { id: "update-branch", label: "Update branch" } });
        break;
      case "unexplained": case "checking": case "computing": case "awaiting":
        out.push({ id: r.id, tone: "warn", icon: "info", lead: sentence(r.title), mono: [], more: 0, rest: r.why, ...(r.action?.id === "unstick" ? { act: { id: "unstick" as const, label: r.action.label } } : null) });
        break;
      default:
        break; // checks are grouped below, one sentence for all of them
    }
  }
  const failed = of("check-failing", "check-cancelled");
  if (failed.length) {
    const cancelled = failed.every((r) => r.kind === "check-cancelled");
    out.push({ id: "checks-failed", tone: "bad", icon: "bolt", lead: `${plural(failed.length, "check", "checks")} ${cancelled ? "cancelled" : "failed"}:`, ...names(failed), rest: "", act: { id: "rerun", label: cancelled ? "Re-run" : "Re-run failed" } });
  }
  const missing = of("required-missing");
  if (missing.length) {
    out.push({ id: "checks-missing", tone: "warn", icon: "clock", lead: `${plural(missing.length, "required check has", "required checks have")} not reported:`, ...names(missing), rest: "", act: { id: "checks", label: "Open checks" } });
  }
  const running = of("check-running", "check-queued");
  if (running.length) {
    out.push({ id: "checks-running", tone: "warn", icon: "clock", lead: `${plural(running.length, "check is", "checks are")} still running.`, mono: [], more: 0, rest: "", act: { id: "checks", label: "Open checks" } });
  }
  // Worst first: what blocks, then what waits. Stable inside each group.
  return out.map((n, i) => ({ n, i })).sort((a, b) => (a.n.tone === b.n.tone ? a.i - b.i : a.n.tone === "bad" ? -1 : 1)).map((x) => x.n);
}

export function needsHeading(needs: Need[]): string {
  return needs.some((n) => n.tone === "bad") ? "What is in the way" : "What it is waiting for";
}

// ---- checks summary ----

export interface CheckRow { name: string; tone: "ok" | "bad" | "warn"; dur: string; url?: string }
export interface ChecksSummary {
  ok: number; bad: number; run: number; total: number;
  /** "14 of 14", "12 of 14". */
  label: string;
  /** Bar segments in order ok, bad, run; flex weight, zero when absent. */
  bar: { ok: number; bad: number; run: number };
  rows: CheckRow[];
}

export const CHECK_ROWS_MAX = 5;

export function checkTone(c: Pick<PrCheck, "state" | "done" | "cancelled">): "ok" | "bad" | "warn" {
  if (!c.done) return "warn";
  if (c.state === "failure" || c.cancelled) return "bad";
  return "ok";
}

export function durationText(c: Pick<PrCheck, "startedAt" | "completedAt" | "done">): string {
  if (!c.done) return "running";
  const a = Date.parse(c.startedAt ?? "");
  const b = Date.parse(c.completedAt ?? "");
  if (!(a > 0) || !(b >= a)) return "";
  const s = Math.round((b - a) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

export function checksSummary(checks: PrCheck[]): ChecksSummary {
  const tones = checks.map((c) => ({ c, t: checkTone(c) }));
  const ok = tones.filter((x) => x.t === "ok").length;
  const bad = tones.filter((x) => x.t === "bad").length;
  const run = tones.filter((x) => x.t === "warn").length;
  const rank = { bad: 0, warn: 1, ok: 2 } as const;
  const rows = tones
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => rank[a.t] - rank[b.t] || a.i - b.i)
    .slice(0, CHECK_ROWS_MAX)
    .map(({ c, t }): CheckRow => ({ name: c.name, tone: t, dur: durationText(c), ...(c.url ? { url: c.url } : null) }));
  return { ok, bad, run, total: checks.length, label: `${ok} of ${checks.length}`, bar: { ok, bad, run }, rows };
}

// ---- latest in the conversation ----

export interface ActivityItem { id: string; author: string; verb: string; at: string; body: string }
export const ACTIVITY_N = 2;
export const ACTIVITY_CHARS = 240;

const REVIEW_VERB: Record<string, string> = {
  APPROVED: "approved", CHANGES_REQUESTED: "asked for changes", COMMENTED: "reviewed", DISMISSED: "had a review dismissed", PENDING: "",
};

export function clip(s: string, n = ACTIVITY_CHARS): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
}

/** The newest `n` things a person wrote, oldest first so they read in order. Bots only when no person wrote anything. */
export function latestActivity(d: Pick<PrDetail, "comments" | "reviews">, n = ACTIVITY_N): ActivityItem[] {
  const all: (ActivityItem & { bot: boolean })[] = [
    ...d.comments.map((c) => ({ id: `c${c.id}`, author: c.author, verb: "commented", at: c.createdAt, body: clip(c.body), bot: c.isBot })),
    ...d.reviews.filter((r) => r.state !== "PENDING" && (r.body.trim() || r.state !== "COMMENTED")).map((r, i) => ({
      id: `r${r.nodeId ?? i}`, author: r.author, verb: REVIEW_VERB[r.state] ?? "reviewed", at: r.submittedAt, body: clip(r.body), bot: r.isBot,
    })),
  ];
  const people = all.filter((x) => !x.bot);
  const pool = people.length ? people : all;
  return pool.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, n).reverse().map(({ bot: _b, ...x }) => x);
}

// ---- rail details ----

export interface DetailRow { key: "assignee" | "milestone" | "closes" | "auto-merge" | "spend"; label: string; value: string; none?: boolean; editable?: "assignees" | "milestone" }

/** Always shows Assignee and Milestone (with a way to set them); the rest appear only when they have something to say. */
export function detailRows(d: Pick<PrDetail, "assignees" | "milestone" | "linkedIssues" | "state">, o: { spend?: string | null; autoMerge?: boolean }): DetailRow[] {
  const rows: DetailRow[] = [
    { key: "assignee", label: d.assignees.length > 1 ? "Assignees" : "Assignee", value: d.assignees.join(", ") || "None", none: d.assignees.length === 0, editable: "assignees" },
    { key: "milestone", label: "Milestone", value: d.milestone || "None", none: !d.milestone, editable: "milestone" },
  ];
  if (d.linkedIssues.length) rows.push({ key: "closes", label: "Closes", value: d.linkedIssues.map((i) => `#${i.number}`).join(", ") });
  if (d.state === "OPEN" && o.autoMerge !== undefined) rows.push({ key: "auto-merge", label: "Auto-merge", value: o.autoMerge ? "On" : "Off" });
  if (o.spend) rows.push({ key: "spend", label: "Local spend", value: o.spend });
  return rows;
}

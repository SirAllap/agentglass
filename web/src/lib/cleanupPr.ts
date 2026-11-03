/*
 * Cleaning up one pull request from the PR view: the decisions pulled out of
 * the components (CleanupPrAction, CleanupDialog) so they can be tested; there
 * is no renderer in this project. The plan and the report are the server's
 * (GET /cleanup/plan, POST /cleanup/run, docs/CLEANUP.md): nothing here
 * decides what is safe, it only draws the answer and sends back which items
 * the person unticked.
 */
import { humanSize } from "../../../shared/dockerSize.ts";
import { CLEANUP_KIND_ROWS, DEFAULT_INCLUDE, type CleanupKind, type CleanupMode } from "./cleanupSettings.ts";
import { whenWord } from "./housekeeping.ts";

export interface PlanItem { id: string; kind: string; target: string; detail: string; bytes?: number }
export interface PlanBlock { kind: string; why: string; files?: string[] }
export interface Plan {
  id: string; repo: string; pr: number; title: string; url: string;
  state: "OPEN" | "MERGED" | "CLOSED"; mergedAt: number | null; notMerged: boolean;
  branch: string; slug: string | null; items: PlanItem[]; blocks: PlanBlock[]; notes: string[];
}
export interface ItemResult { id: string; kind: string; target: string; status: "done" | "failed" | "warn" | "skipped"; detail: string; bytes?: number }
export interface Report {
  ok: boolean; planId: string; items: ItemResult[]; freedBytes: number; failed: number; summary: string;
  /** A plan read again the moment the run ended: what is still there. No items = cleaned up; null = the re-read failed, which says nothing about the leftovers. */
  remaining?: { items: PlanItem[]; bytes: number; blocks: PlanBlock[] } | null;
}

/** The server's own mapping (GROUP_OF in cleanup.ts). Bookkeeping rows (own-state, worklog) are not leftovers: no group, never listed or counted. */
const GROUP: Record<string, CleanupKind> = {
  "docker-container": "docker", "docker-volume": "docker", "docker-image": "docker", "test-db": "docker",
  worktree: "worktree", branch: "branch", "fetch-prune": "branch", stash: "stashes", evidence: "evidence", note: "notes", brief: "notes", tab: "tab",
  "agent-scratch": "agent-scratch", "agent-history": "agent-history", "other-folder": "worktree",
};
export const groupOf = (kind: string): CleanupKind | null => GROUP[kind] ?? null;

export interface ViewGroup { group: CleanupKind; name: string; items: PlanItem[]; bytes: number }

/** The listed items in the inventory's order (Docker first, Tab last), each kind once. */
export function groupsOf(plan: Pick<Plan, "items">): ViewGroup[] {
  return CLEANUP_KIND_ROWS.flatMap((k) => {
    const items = plan.items.filter((i) => groupOf(i.kind) === k.id);
    return items.length ? [{ group: k.id, name: k.name, items, bytes: sumBytes(items) }] : [];
  });
}

const sumBytes = (items: readonly { bytes?: number }[]): number => items.reduce((n, i) => n + Math.max(0, i.bytes ?? 0), 0);
export const listed = (plan: Pick<Plan, "items">): PlanItem[] => plan.items.filter((i) => groupOf(i.kind));

/* ---- ticks: the set of unticked ids is what the run sends as `exclude` ---- */

export const toggleItem = (off: readonly string[], id: string): string[] => (off.includes(id) ? off.filter((x) => x !== id) : [...off, id]);

/** A group box ticks or unticks its whole group; a half-ticked group becomes fully ticked. */
export function toggleGroup(off: readonly string[], g: Pick<ViewGroup, "items">): string[] {
  const ids = g.items.map((i) => i.id);
  const allOn = ids.every((id) => !off.includes(id));
  return allOn ? [...off, ...ids.filter((id) => !off.includes(id))] : off.filter((id) => !ids.includes(id));
}
export const groupTick = (off: readonly string[], g: Pick<ViewGroup, "items">): "none" | "some" | "all" => {
  const n = g.items.filter((i) => !off.includes(i.id)).length;
  return n === 0 ? "none" : n === g.items.length ? "all" : "some";
};

/** What the run would do with these ticks. */
export function ticked(plan: Plan, off: readonly string[]): { items: PlanItem[]; count: number; of: number; bytes: number } {
  const all = listed(plan);
  const items = all.filter((i) => !off.includes(i.id));
  return { items, count: items.length, of: all.length, bytes: sumBytes(items) };
}

/** The ids sent as `exclude`: only unticked ones that this plan lists (the bookkeeping rows have no box). */
export const excludeOf = (plan: Plan, off: readonly string[]): string[] => listed(plan).filter((i) => off.includes(i.id)).map((i) => i.id);

/* ---- the dry-run dialog's words ---- */

export const sizeWord = (bytes: number): string => (bytes > 0 ? humanSize(bytes) : "0 KB");
export const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
export const name = (plan: Pick<Plan, "slug" | "pr">): string => plan.slug || `#${plan.pr}`;

/** A PR title past this is the header itself (clamped to three lines with Show full title); a short one is left to the sub line. */
export const LONG_TITLE = 80;
/** The dialog's title before the run: the card, or the PR's own title when that is long enough to need the clamp. */
export const headline = (plan: Pick<Plan, "slug" | "pr" | "title">): string =>
  plan.title.length > LONG_TITLE ? `Clean up ${plan.title}` : `Clean up ${name(plan)}'s local leftovers`;

export function confirmLabel(plan: Pick<Plan, "notMerged">, t: { count: number; bytes: number }): string {
  if (t.count === 0) return "Nothing ticked";
  return plan.notMerged ? "Clean up anyway" : "Clean up";
}

/** The confirm button is on when nothing blocks, something is ticked, and a not-merged PR has its box ticked. */
export const canConfirm = (plan: Plan, t: { count: number }, gate: boolean): boolean =>
  plan.blocks.length === 0 && t.count > 0 && (!plan.notMerged || gate);

/** owner/repo from the PR's address, the way the PR view names a repository; the folder's name when the address is not GitHub's. */
export const repoLabel = (plan: Pick<Plan, "url" | "repo">): string =>
  /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\//.exec(plan.url)?.[1] ?? (plan.repo.split("/").filter(Boolean).pop() ?? plan.repo);

export function subLine(plan: Plan, now: number): string {
  const when = plan.state === "MERGED" ? (plan.mergedAt ? `merged ${whenWord(plan.mergedAt, now)}` : "merged") : plan.state === "OPEN" ? "open" : "closed, never merged";
  return `#${plan.pr} · ${when} · ${repoLabel(plan)}`;
}

/* ---- blocks: the reason is shown, in the mockup's words, with the server's detail ---- */

const BLOCK_TITLE: Record<string, string> = {
  dirty: "Uncommitted changes in the worktree",
  unpushed: "Commits that are not in the merged PR",
  "open-pr-on-branch": "Another open PR uses this branch",
  "stacked-pr": "Another open PR is stacked on this branch",
  "live-session": "A live session is working in this worktree",
  "main-checkout": "This is the main checkout",
  "default-branch": "This is the default branch",
  unreadable: "GitHub or git could not be read",
  "pr-open": "This PR is still open",
};
/** What to do about each block, one sentence under the server's reason (the mockup's blocked frame: what is wrong, why, what to do). */
const BLOCK_DO: Record<string, string> = {
  dirty: "Commit or discard the changes, then run Clean up again.",
  unpushed: "Push the commits or discard them, then run Clean up again.",
  "open-pr-on-branch": "Merge or close that PR first, then come back.",
  "stacked-pr": "Merge or retarget the stacked PR first, then come back.",
  "live-session": "Stop that session, then run Clean up again.",
  "pr-open": "Cleanup only runs on a PR that was merged or closed, so no work is lost. Merge or close it first, then come back.",
  unreadable: "Check that gh and git work in this repository, then try again.",
};
export interface BlockView { kind: string; title: string; why: string; todo: string; files: string[]; tone: "warn" | "error" }
export const blockViews = (plan: Pick<Plan, "blocks">): BlockView[] =>
  plan.blocks.map((b) => ({
    kind: b.kind, title: BLOCK_TITLE[b.kind] ?? "Something is in the way", why: b.why, todo: BLOCK_DO[b.kind] ?? "", files: b.files ?? [],
    tone: b.kind === "pr-open" ? "warn" : "error",
  }));

/* ---- the button and badge on the PR ---- */

/** Off means no offer; every other mode shows the button on a merged or closed PR. */
export const showsAction = (mode: CleanupMode, state: Plan["state"] | undefined): boolean => mode !== "off" && state !== undefined && state !== "OPEN";

export interface ActionView {
  /** Badge text: the size, or that there is nothing; null while the plan is not read yet. */
  badge: string | null;
  tone: "lo" | "warn" | "none";
  /** Why the button is off, in a few words; empty when it is on. */
  blocked: string;
  /** Closed without merge: the button wears the warning look. */
  strong: boolean;
}
/** `freed`: bytes a run of this view just removed; with nothing left the badge says "Cleaned up" instead of "No leftovers". */
export function actionView(plan: Plan | null, freed: number | null = null): ActionView {
  if (!plan) return { badge: null, tone: "none", blocked: "", strong: false };
  const bytes = sumBytes(listed(plan));
  const first = blockViews(plan)[0];
  return {
    badge: listed(plan).length ? (bytes > 0 ? `Leftovers ${sizeWord(bytes)}` : `Leftovers: ${plural(listed(plan).length, "item")}`)
      : freed !== null ? (freed > 0 ? `Cleaned up \u00b7 ${sizeWord(freed)} freed` : "Cleaned up") : "No leftovers",
    tone: !listed(plan).length ? "none" : first ? "warn" : "lo",
    blocked: first ? first.title : "",
    strong: plan.notMerged,
  };
}

/* ---- the tick in the merge dialog ---- */

/** The tick is drawn only when the project's mode is "Offer at merge time"; in any other mode the PR view's button is the offer. */
export const offersAtMerge = (mode: CleanupMode): boolean => mode === "atMerge";

/** A run that ended says what is left from its own re-read; null when it cannot say (the caller then reads the plan again). */
export const leftAfter = (r: Pick<Report, "remaining">): number | null => (r.remaining ? listed({ items: r.remaining.items }).length : null);

/* ---- how much of the flow the person sees (docs/CLEANUP.md, "The flow") ---- */

/** Who asked: the tick in the merge dialog, the Ask offer, or the PR's own Leftovers button / the toast's Details. */
export type CleanupVia = "merge-tick" | "ask" | "button";
export type CleanupStep = "never" | "dialog" | "direct" | "nothing";

/** An item is "outside the default kinds" when its group is not one a new project would include (the session history, ticked on purpose). */
const outsideDefault = (i: PlanItem): boolean => { const g = groupOf(i.kind); return !!g && !DEFAULT_INCLUDE.includes(g); };

/** One item this much of the size: the person should see it before it goes (the dialog flags it too, from half). */
export const DOMINANT_SHARE = 90;

/** Why a plan needs a look before it runs, or "" when the default selection can go as it is. */
export function needsLook(plan: Plan): "block" | "not-merged" | "dominant" | "outside" | "" {
  if (plan.blocks.length) return "block";
  if (plan.notMerged) return "not-merged";
  const rows = listed(plan), total = sumBytes(rows);
  if (rows.some(outsideDefault)) return "outside";
  if (rows.some((i) => shareOf(i.bytes ?? 0, total) > DOMINANT_SHARE)) return "dominant";
  return "";
}

/**
 * The one decision of the agile flow. Automatic never shows a dialog (the server does it, cleanupAuto.ts); the tick at
 * merge time is the consent, so a plan that needs no look runs at once and only a toast says so; Ask and the PR's own
 * button keep the review dialog. Off offers nothing. A plan with nothing listed has nothing to run or review.
 */
export function cleanupStep(mode: CleanupMode, via: CleanupVia, plan: Plan): CleanupStep {
  if (mode === "off" || mode === "auto") return "never";
  if (via === "button" || via === "ask") return "dialog";
  if (!listed(plan).length && !plan.blocks.length) return "nothing";
  return needsLook(plan) ? "dialog" : "direct";
}

/** The toast that closes a run: one line, and the lines Details unfolds. */
export interface CleanupNote { key: string; text: string; tone: "ok" | "warn" | "run"; lines: string[] }
/** The quiet progress line of a run that has no dialog: the toast says it is working, and the result replaces it. */
export const runningNote = (plan: Pick<Plan, "slug" | "pr">): CleanupNote => ({ key: `${plan.pr}`, text: `Cleaning ${name(plan)}\u2026`, tone: "run", lines: [] });
export function noteOf(plan: Pick<Plan, "slug" | "pr">, r: Report): CleanupNote {
  const o = outcome(plan, r), left = leftAfter(r);
  const text = [o.failed ? `Cleaned ${name(plan)} with ${plural(o.failed, "problem")}` : `Cleaned ${name(plan)}`, `${o.freed} freed`, ...(left ? [`${left} left`] : [])].join(" \u00b7 ");
  const lines = r.items.filter((i) => groupOf(i.kind)).map((i) => `${kindWord(i.kind)} \u00b7 ${i.target} \u00b7 ${i.status === "done" ? "removed" : i.detail || i.status}${i.bytes ? ` \u00b7 ${sizeWord(i.bytes)}` : ""}`);
  return { key: `${plan.pr}`, text, tone: o.tone, lines };
}

/** The shared Docker build cache: its own action, never in a plan. */
export const BUILD_CACHE_WARNING = "The build cache is shared by every project on this computer. Pruning it frees disk now, and the next build of any project is slower.";
export const buildCacheLabel = (reclaimable: number): string => `Prune build cache (${sizeWord(reclaimable)} reclaimable)`;

/* ---- running, done, failed ---- */

export type RowState = "waiting" | "running" | "done" | "failed" | "warn" | "skipped";

export function rowState(r: ItemResult | undefined, phase: "running" | "finished"): RowState {
  if (!r) return phase === "running" ? "running" : "waiting";
  return r.status;
}

export interface Outcome { title: string; sub: string; tone: "ok" | "warn"; freed: string; failed: number; retry: boolean; patches: number }
/** The header of the finished dialog: a clean finish, or the problems named. */
export function outcome(plan: Pick<Plan, "slug" | "pr">, r: Report): Outcome {
  /* The app's own bookkeeping rows (own-state, worklog) ride in the report but are not leftovers: not counted, not listed. */
  const rows = r.items.filter((i) => groupOf(i.kind));
  const done = rows.filter((i) => i.status === "done").length;
  const warned = rows.filter((i) => i.status === "warn").length;
  const skipped = rows.filter((i) => i.status === "skipped").length;
  const failed = rows.filter((i) => i.status === "failed").length;
  const parts = [`${plural(done, "item")} removed`, ...(warned ? [`${plural(warned, "note")}`] : []), ...(skipped ? [`${skipped} left as is`] : []), ...(failed ? [`${failed} failed`] : [])];
  return {
    title: failed ? `${name(plan)} cleaned with ${plural(failed, "problem")}` : `${name(plan)} cleaned`,
    sub: parts.join(" · "),
    tone: failed ? "warn" : "ok",
    freed: sizeWord(r.freedBytes),
    failed,
    retry: failed > 0,
    patches: r.items.filter((i) => i.kind === "stash" && i.status === "done").length,
  };
}


/* ---- the wide dialog: finding, reading and ordering a long list ---- */

/** Rows drawn per group before "Show next": 400 items never mean 400 nodes. Ceiling: pages, not a scroll window; rows differ in height (a name wraps), so a window by arithmetic is not possible. */
export const PAGE = 50;
/** Characters kept at the end of a name that is shortened in the middle: the part that tells two names apart. */
export const TAIL = 26;
/** A name this long gets the middle-ellipsis, Copy and Show all. */
export const LONG_NAME = 56;
/** A size is flagged from this many bytes, or from half of the total. */
export const BIG_BYTES = 10_000_000_000;
const BIG_SHARE_FLOOR = 1_000_000_000;

export const splitTail = (s: string, tail = TAIL): [string, string] => (s.length > tail * 2 ? [s.slice(0, -tail), s.slice(-tail)] : [s, ""]);
export const isLong = (s: string): boolean => s.length > LONG_NAME;

/** Whole percent of the ticked total, 0 when there is no total. */
export const shareOf = (bytes: number, total: number): number => (total > 0 ? Math.round((100 * bytes) / total) : 0);
/** Red size: above 10 GB, or half of everything that will go (and at least 1 GB, so a lone 4 KB note is not an alarm). */
export const isBig = (bytes: number, total: number): boolean => bytes >= BIG_BYTES || (bytes >= BIG_SHARE_FLOOR && total > 0 && bytes * 2 >= total);

export const largestFirst = <T extends { bytes?: number }>(items: readonly T[]): T[] => [...items].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));

/** The word before the detail: what kind of thing a row is. */
const KIND_WORD: Record<string, string> = {
  "docker-container": "container", "docker-volume": "volume", "docker-image": "image", "test-db": "test database",
  worktree: "worktree", branch: "branch", "fetch-prune": "fetch", stash: "stash", evidence: "evidence", note: "note", brief: "brief", tab: "tab",
  "agent-scratch": "agent scratch", "agent-history": "session history", "other-folder": "other folder",
};
export const kindWord = (kind: string): string => KIND_WORD[kind] ?? kind;
export const subOf = (i: Pick<PlanItem, "kind" | "detail">): string => [kindWord(i.kind), i.detail].filter(Boolean).join(" \u00b7 ");

/** The filter box: every word must appear in the name, the kind or the reason. */
export function matches(i: Pick<PlanItem, "target" | "kind" | "detail">, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${i.target} ${kindWord(i.kind)} ${i.detail}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Ticks for a set of ids at once (All / None on the rows a filter leaves): everything else keeps its tick. */
export const setTicks = (off: readonly string[], ids: readonly string[], on: boolean): string[] =>
  on ? off.filter((x) => !ids.includes(x)) : [...off, ...ids.filter((id) => !off.includes(id))];

/** A PR that was never merged opens with branches and stashes unticked: they may hold the only copy of the work. */
export const defaultOff = (plan: Plan): string[] => (plan.notMerged ? listed(plan).filter((i) => ["branch", "stashes"].includes(groupOf(i.kind) ?? "")).map((i) => i.id) : []);

export type RowFilter = "all" | "ticked" | "attention";
/** The "Needs attention" chip: a flagged size, or a worktree, branch or stash of a PR that was not merged (it may be the only copy), or a result that is not clean. */
export const needsAttention = (plan: Pick<Plan, "notMerged">, i: PlanItem, total: number, r?: Pick<ItemResult, "status">): boolean =>
  r ? r.status === "failed" || r.status === "warn" : isBig(i.bytes ?? 0, total) || (plan.notMerged && ["worktree", "branch", "stashes"].includes(groupOf(i.kind) ?? ""));

/** A retry's report laid over the first one: retried rows take their new result, done rows are never touched twice. A retried row the fresh plan no longer lists is gone already. */
export function mergeReports(prev: Report, next: Report, retried: readonly string[]): Report {
  const nextById = new Map(next.items.map((i) => [i.id, i]));
  const items = prev.items.map((i) => (retried.includes(i.id) ? nextById.get(i.id) ?? { ...i, status: "skipped" as const, detail: "already gone", bytes: 0 } : i));
  const failed = items.filter((i) => i.status === "failed" && groupOf(i.kind)).length;
  return { ...next, items, freedBytes: prev.freedBytes + next.freedBytes, failed, ok: failed === 0 };
}

/** Failed rows first, then the rest in the order they came. */
export const failedFirst = <T extends { id: string }>(items: readonly T[], byId: ReadonlyMap<string, Pick<ItemResult, "status">>): T[] =>
  [...items].sort((a, b) => Number(byId.get(b.id)?.status === "failed") - Number(byId.get(a.id)?.status === "failed"));

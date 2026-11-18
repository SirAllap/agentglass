/*
 * "Does this finished PR have anything on this computer?": the one answer every
 * surface (the card's footer, the Closed list's rows, the PR panel's chip, a
 * lane footer) reads before it shows a chip or a Clean up button. The rule is
 * one sentence: a button exists only when the inventory was read and has at
 * least one real item. Computing, unknown and nothing all draw no button; an
 * unknown one is at most a muted "Leftovers ?" on the PR panel, with the reason
 * in its tooltip. The rows are the server's local inventory (GET
 * /cleanup/inventory: no gh, one answer per row), cached by PR and state.
 */
import { humanSize } from "../../../shared/dockerSize.ts";
import { CLEANUP_KIND_ROWS, type CleanupKind, type CleanupMode } from "./cleanupSettings.ts";
import { groupOf, listed, plural, type Plan } from "./cleanupPr.ts";
import { type AutoEntry } from "./housekeeping.ts";

export interface LeftoverGroup { group: string; items: number; bytes: number }
export type LeftoverState =
  | { kind: "computing" }
  | { kind: "unknown"; why: string }
  | { kind: "none" }
  /** `blocked` is why a cleanup would be refused, in a few words (the server's local inventory): the items are there, none of them can go yet. */
  | { kind: "some"; items: number; bytes: number; groups: LeftoverGroup[]; blocked?: string };

export type Surface = "card" | "closedRow" | "panel" | "lane";

export interface Offer {
  /** The Clean up control exists. Never true unless the inventory has an item. */
  button: boolean;
  /** The tinted size (or item count) chip; the muted "Leftovers ?" on the panel for an unknown one. */
  chip: string | null;
  muted: boolean;
  tooltip: string;
  /** Still reading: a quiet placeholder, never a control. */
  skeleton: boolean;
}

const NOTHING: Offer = { button: false, chip: null, muted: false, tooltip: "", skeleton: false };

const sizeText = (bytes: number): string => (bytes > 0 ? humanSize(bytes) : "");
const nameOf = (g: string): string => CLEANUP_KIND_ROWS.find((k) => k.id === (g as CleanupKind))?.name ?? g;

/** "Docker 6.1 GB · Worktree 222 MB": the groups that have a size, largest first; the count for a group with none. */
export const tooltipOf = (groups: readonly LeftoverGroup[]): string =>
  [...groups].sort((a, b) => b.bytes - a.bytes).map((g) => `${nameOf(g.group)} ${sizeText(g.bytes) || (g.items === 1 ? "1 item" : `${g.items} items`)}`).join(" · ");

export function offerFor(s: LeftoverState | undefined, surface: Surface): Offer {
  if (!s || s.kind === "computing") return { ...NOTHING, skeleton: true };
  if (s.kind === "none") return NOTHING;
  if (s.kind === "unknown") return surface === "panel" ? { ...NOTHING, chip: "Leftovers ?", muted: true, tooltip: s.why } : NOTHING;
  if (s.items < 1) return NOTHING;
  return { button: true, chip: sizeText(s.bytes) || (s.items === 1 ? "1 item" : `${s.items} items`), muted: false, tooltip: tooltipOf(s.groups), skeleton: false };
}

/* ---- the automatic cleanup's own state of one PR: the top bar's answers, read by the PR's bar and its card ---- */

/** A running or finished automatic cleanup, or one waiting for its tab to close, narrowed to what the PR's own surfaces say. */
export interface AutoRun {
  state: "waiting" | "cleaning" | "cleaned" | "failed"; done: number; total: number; freed: number; failed: number;
  /** The first failed item's own sentence, so the tooltip says why instead of only how many. */
  why?: string;
  /** The project's teardown script was the item that failed: the checkout and what lives on it were kept on purpose. */
  teardown?: boolean;
  /** The kind of the first failed item, so the line can name it. */
  what?: string;
  /** The run failed, but a later read of the disk found nothing of this pull request left (cleaned another way). */
  settled?: boolean;
}

/**
 * A failed item in plain words: what it is and that it is still there.
 *
 * The card said "Cleaning failed · 1 item" and nothing else: which item, and why, were one hover and one dialog
 * away, and six cards in a row read the same whatever had gone wrong. A kind this build does not know gets no
 * words, and the line falls back to the count.
 */
const FAILED_WORDS: Record<string, string> = {
  "teardown-script": "the teardown script stopped", worktree: "the worktree is still there", branch: "the branch was kept",
  "docker-container": "a container was not removed", "docker-volume": "a volume was not removed", "docker-image": "an image was not removed",
  "test-db": "the test database was not dropped", stash: "a stash was kept", tab: "its tab is still open",
  evidence: "an evidence folder is still there", note: "a note is still there", brief: "a brief was not archived",
  "agent-scratch": "an agent folder is still there", "agent-history": "the session history is still there", "other-folder": "a folder is still there",
  "card-move": "the card was not moved", worklog: "the worklog line was not written",
};
export const failedWords = (kind: string | undefined): string => (kind ? FAILED_WORDS[kind] ?? "" : "");

/** The reason line of a failed item without terminal colours, cut to what a tip can hold. */
export const reasonOf = (detail: string | undefined): string => (detail ?? "").replace(/\u001b\[[0-9;]*m/g, "").trim().slice(0, 300);

/** "the teardown script stopped: <the script's last line>": what failed and why, for a summary or a tip. */
export function failureLine(items: readonly { kind: string; status: string; detail?: string }[]): { short: string; why: string } | null {
  const bad = items.filter((i) => i.status === "failed");
  if (!bad.length) return null;
  const first = bad[0]!, words = failedWords(first.kind) || `${plural(bad.length, "item")} failed`;
  const more = bad.length > 1 && failedWords(first.kind) ? ` (+${bad.length - 1} more)` : "";
  const reason = reasonOf(first.detail);
  return { short: `${words}${more}`, why: `${words}${more}${reason ? `: ${reason}` : ""}` };
}

/**
 * The run's word, checked against the disk. A failed run is history: when the inventory read after it finds nothing
 * left (somebody removed the checkout by hand, or a second run did), "Cleaning failed" over an empty disk is a lie
 * that asks for a retry with nothing to retry. Only a definite "none" settles it; unknown and still-reading keep the
 * run's own word.
 */
export function onDisk(run: AutoRun | null, left: LeftoverState | undefined): AutoRun | null {
  if (run?.state !== "failed" || left?.kind !== "none") return run;
  return { ...run, state: "cleaned", failed: 0, settled: true };
}

/** The one block that clears by itself: the line the PR view and its card say instead of a bare button. */
export const WAITING_LINE = "Waiting for its tab to close, then it cleans up on its own.";
export const WAITING_TITLE = "A tab or a program is still in this pull request's checkout. That is the only thing holding the automatic cleanup: once it is gone, the next read of the pull request list cleans up on its own.";

/** The Housekeeping entry of this PR (`autoEntryFor`), or null when the automatic cleanup has nothing to say about it. */
export function autoRunOf(e: AutoEntry | undefined): AutoRun | null {
  if (!e) return null;
  const bad = e.items.filter((i) => i.status === "failed");
  const base = {
    done: Math.max(0, e.done), total: Math.max(0, e.total), freed: Math.max(0, e.freed), failed: bad.length,
    ...(bad[0]?.detail ? { why: bad[0].detail.replace(/\u001b\[[0-9;]*m/g, "") } : {}),
    ...(bad.some((i) => i.kind === "teardown-script") ? { teardown: true } : {}),
    ...(bad[0] && failedWords(bad[0].kind) ? { what: bad[0].kind } : {}),
  };
  if (e.state === "blocked" && e.waiting) return { state: "waiting", ...base };
  if (e.state !== "cleaning" && e.state !== "cleaned" && e.state !== "failed") return null;
  return { state: e.state, ...base };
}

/** The words of one automatic run: the PR's bar carries the bytes, its card only the count. */
export function autoWords(run: AutoRun, surface: "panel" | "card"): { text: string; title: string } {
  if (run.state === "waiting") return { text: WAITING_LINE, title: WAITING_TITLE };
  const freed = run.freed > 0 ? humanSize(run.freed) : "";
  const of = `${run.done} of ${run.total}`;
  if (run.state === "cleaning") {
    return {
      text: surface === "panel" ? `Cleaning \u00b7 ${of}${freed ? ` \u00b7 ${freed} freed` : ""}` : `Cleaning \u00b7 ${of}`,
      title: `Cleaning this pull request: ${of} items removed${freed ? `, ${freed} freed so far` : ""}.`,
    };
  }
  if (run.state === "failed") {
    const n = run.failed || Math.max(0, run.total - run.done);
    // A teardown refusal fails the same way on every retry: say so, and name the one way past it.
    const next = run.teardown
      ? "The project's teardown script stopped, so the checkout and what lives on it were kept; the rest was cleaned. Retry opens the cleanup: untick the teardown to remove them anyway."
      : "Retry to run it again.";
    // Named when the first failed item is one this build has words for; the count otherwise.
    const words = failedWords(run.what);
    return {
      text: words ? `Cleaning failed \u00b7 ${words}${n > 1 ? ` (+${n - 1} more)` : ""}` : `Cleaning failed \u00b7 ${plural(n, "item")}`,
      title: `${plural(n, "item")} could not be removed${freed ? `; ${freed} freed` : ""}${run.why ? `: ${run.why}` : ""}. ${next}`,
    };
  }
  if (run.settled) return { text: "Cleaned \u00b7 nothing left", title: "The automatic cleanup stopped on an item, but nothing of this pull request is left on this machine now." };
  const n = run.done || run.total;
  return {
    text: surface === "panel" ? `Cleaned \u00b7 ${plural(n, "item")}${freed ? ` \u00b7 ${freed}` : ""}` : `Cleaned \u00b7 ${plural(n, "item")}`,
    title: `Cleaned automatically: ${plural(n, "item")} removed${freed ? `, ${freed} freed` : ""}.`,
  };
}

/** Where a finished PR's bottom bar stands: the manual button, or the automatic run's own state in its place. */
export interface BarView {
  button: boolean; retry: boolean; text: string | null; title: string; tone: "run" | "ok" | "warn" | null;
  /** The bar is holding its breath for a tab or session to close: the sentence is a line of its own, never a chip. */
  wait?: boolean;
}

/**
 * One rule for both surfaces: with Automatic on and a run of this PR in the Housekeeping entries, the run speaks and the
 * manual button stays away (a retry takes its place when items failed). Anywhere else the button is the leftovers' offer.
 */
export function barFor(o: { mode: CleanupMode; run: AutoRun | null; leftovers: boolean }, surface: "panel" | "card" = "panel"): BarView {
  if (o.mode === "auto" && o.run) {
    const w = autoWords(o.run, surface);
    if (o.run.state === "waiting") return { button: o.leftovers, retry: false, text: w.text, title: w.title, tone: "run", wait: true };
    if (o.run.state === "cleaning") return { button: false, retry: false, text: w.text, title: w.title, tone: "run" };
    if (o.run.state === "failed") return { button: false, retry: true, text: w.text, title: w.title, tone: "warn" };
    return { button: o.leftovers, retry: false, text: w.text, title: w.title, tone: "ok" };
  }
  return { button: o.leftovers, retry: false, text: null, title: "", tone: null };
}

/** The server's row, or "unknown" when it said so or sent nothing for this PR. */
export function stateOfRow(row: unknown): LeftoverState {
  const r = row as { unknown?: boolean; items?: unknown; bytes?: unknown; groups?: unknown; blocked?: unknown } | null | undefined;
  if (!r || r.unknown || typeof r.items !== "number") return { kind: "unknown", why: "The local inventory could not be read for this pull request." };
  if (r.items < 1) return { kind: "none" };
  const parts = Array.isArray(r.groups) ? (r.groups as LeftoverGroup[]) : [];
  const blocked = typeof r.blocked === "string" && r.blocked ? { blocked: r.blocked } : {};
  return { kind: "some", items: r.items, bytes: typeof r.bytes === "number" ? r.bytes : 0, groups: parts, ...blocked };
}

/**
 * The same answer from a full plan: bookkeeping rows (own-state, worklog) are not leftovers, the filter the server's
 * automatic cleanup uses. A plan that blocks still lists what is there; the block is shown, the chip stays.
 */
export function stateOfPlan(plan: Plan | null, failed: boolean, why = "The plan could not be read."): LeftoverState {
  if (!plan) return failed ? { kind: "unknown", why } : { kind: "computing" };
  const rows = listed(plan);
  if (!rows.length) return { kind: "none" };
  const by = new Map<string, LeftoverGroup>();
  for (const i of rows) {
    const g = groupOf(i.kind)!, cur = by.get(g) ?? { group: g, items: 0, bytes: 0 };
    by.set(g, { group: g, items: cur.items + 1, bytes: cur.bytes + Math.max(0, i.bytes ?? 0) });
  }
  const groups = [...by.values()];
  return { kind: "some", items: rows.length, bytes: groups.reduce((n, g) => n + g.bytes, 0), groups };
}

/**
 * What a run left behind, from the report's own re-read: the same answer `stateOfPlan` gives for a plan.
 *
 * A run that ends with items left used to drop the card's row and ask the inventory again. Until that read came
 * back the card had no inventory, and a card with none offers "Open" where its neighbour in the same failed state
 * offered "Clean up local leftovers"; one whose re-read failed stayed on "Open". The report already holds what is
 * left, so the row is set from it.
 */
export function stateOfRemaining(items: readonly { kind: string; bytes?: number }[]): LeftoverState {
  const rows = items.filter((i) => groupOf(i.kind));
  if (!rows.length) return { kind: "none" };
  const by = new Map<string, LeftoverGroup>();
  for (const i of rows) {
    const g = groupOf(i.kind)!, cur = by.get(g) ?? { group: g, items: 0, bytes: 0 };
    by.set(g, { group: g, items: cur.items + 1, bytes: cur.bytes + Math.max(0, i.bytes ?? 0) });
  }
  const groups = [...by.values()];
  return { kind: "some", items: rows.length, bytes: groups.reduce((n, g) => n + g.bytes, 0), groups };
}

/**
 * Whether a finished card offers Clean up: the inventory found something, or the last automatic run failed and
 * nothing has said the computer is clean since. One rule, so two cards in the same failed state show the same
 * button whether or not their inventory has been read back yet.
 */
export function cleanOffered(s: LeftoverState | undefined, run: AutoRun | null | undefined): boolean {
  if (offerFor(s, "card").button) return true;
  return run?.state === "failed" && s?.kind !== "none";
}

export interface LeftoverLine { tone: "none" | "some" | "run" | "blocked"; text: string; title: string }

/**
 * The finished card's quiet line about this computer. Nothing while the inventory is read or when it failed: the card
 * does not claim "No leftovers" over a silence. The Clean up button is the card's own primary action (offerFor). When the
 * server says a cleanup would be refused, the line wears the reason: the words on it say blocked, and the tip says why.
 * A run that is happening says so instead of "No leftovers", and a finished one says what it removed.
 */
export function leftoverLine(s: LeftoverState | undefined, cleaning: boolean, run: AutoRun | null = null): LeftoverLine | null {
  const has = !!s && s.kind === "some" && s.items > 0;
  /* Waiting for a tab is neither a warning nor a run: one plain line, and the Clean up button stays beside it as the manual way. */
  if (run?.state === "waiting") return { tone: "none", text: WAITING_LINE, title: WAITING_TITLE };
  /* A failed run speaks only while its items are still listed; once the inventory
     is empty it is history, and "No leftovers" is the answer. */
  if (run && (run.state === "failed" ? has : run.state === "cleaning" || !has)) {
    const w = autoWords(run, "card");
    return { tone: run.state === "cleaning" ? "run" : run.state === "failed" ? "blocked" : "none", text: w.text, title: w.title };
  }
  if (cleaning) return { tone: "run", text: "Cleaning up\u2026", title: "Removing this pull request's local leftovers" };
  if (!s || s.kind === "computing" || s.kind === "unknown") return null;
  if (s.kind === "none") return { tone: "none", text: "No leftovers", title: "Nothing of this pull request is left on this computer" };
  if (s.items < 1) return { tone: "none", text: "No leftovers", title: "Nothing of this pull request is left on this computer" };
  const size = sizeText(s.bytes);
  const count = s.items === 1 ? "1 item" : `${s.items} items`;
  if (s.blocked) {
    return {
      tone: "blocked",
      text: `Leftovers: ${count}${size ? ` \u00b7 ${size}` : ""} \u00b7 blocked`,
      title: [`${s.blocked}. Clean up would refuse until that is gone.`, tooltipOf(s.groups)].filter(Boolean).join(" "),
    };
  }
  return { tone: "some", text: `Leftovers: ${count}${size ? ` \u00b7 ${size}` : ""}`, title: tooltipOf(s.groups) };
}

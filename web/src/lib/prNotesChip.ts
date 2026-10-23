// What a plugin's review notes say about a pull request, in the words a card,
// the header and the board's lanes use. Pure: the summary comes from
// `GET /plugins/pr-notes/summary` (see summaryFor in server/src/plugin-ui.ts)
// and nothing here fetches.
//
// Three readings of one summary, kept apart on purpose:
//   chipFor      what a card says. Always honest about a stale review.
//   notReadyOpen the "Not ready: n open" chip. Only a review that covered the
//                CURRENT head can say a pull request is not ready.
//   gateFacts    what the opt-in lane gate files on. The same rule as
//                notReadyOpen, so the chip and the lane can never disagree.
//
// The ceiling, said once: `stale` is only known when the plugin wrote the sha
// of the head it reviewed AND the list knows the current head. A review whose
// head is unknown is never called stale and never gates — a gate that fires on
// a guess would hold back pull requests nobody reviewed.

import type { PrNotesSummary } from "../../../shared/pluginUi.ts";

export type ChipTone = "error" | "warning" | "ok" | "dim";

export interface NotesChip {
  text: string;
  tone: ChipTone;
  title: string;
}

const ORDER = ["critical", "high", "medium", "low", "info"] as const;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

const totalOpen = (s: PrNotesSummary) => ORDER.reduce((n, k) => n + s.open[k], 0);

/** Counts for the tooltip: "2 critical, 1 medium open · 3 resolved". */
export function countsLine(s: PrNotesSummary): string {
  const open = ORDER.filter((k) => s.open[k] > 0).map((k) => `${s.open[k]} ${k}`).join(", ");
  const done = [s.resolved ? `${s.resolved} resolved` : "", s.dismissed ? `${s.dismissed} dismissed` : ""].filter(Boolean).join(", ");
  return [open ? `${open} open` : "nothing open", done].filter(Boolean).join(" · ");
}

function whenLine(s: PrNotesSummary, now: number): string {
  if (s.lastReviewAt === null) return "";
  const mins = Math.max(0, Math.round((now - s.lastReviewAt) / 60_000));
  const ago = mins < 1 ? "just now" : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
  return `reviewed ${ago}`;
}

/** Whether this pull request has anything from a plugin's review to say. */
export function hasNotes(s: PrNotesSummary | undefined): s is PrNotesSummary {
  return !!s && (totalOpen(s) + s.resolved + s.dismissed > 0 || s.lastReviewAt !== null);
}

export function chipFor(s: PrNotesSummary | undefined, now = Date.now()): NotesChip | null {
  if (!hasNotes(s)) return null;
  const by = s.plugins.length ? ` · ${s.plugins.join(", ")}` : "";
  const detail = [countsLine(s), whenLine(s, now)].filter(Boolean).join(" · ") + by;
  if (s.stale === true) {
    return { text: "stale review", tone: "dim", title: `The head moved after this review (${detail}). Review again to cover the new commits.` };
  }
  const worst = ORDER.find((k) => s.open[k] > 0);
  if (worst) {
    const tone: ChipTone = worst === "critical" || worst === "high" ? "error" : worst === "medium" || worst === "low" ? "warning" : "dim";
    return { text: `${s.open[worst]} ${worst} open`, tone, title: detail };
  }
  return { text: "reviewed · clean", tone: "ok", title: detail };
}

/** Open critical and high findings of a review that covered the current head;
 *  zero when the review is stale or its head is unknown. */
export function blockingOpen(s: PrNotesSummary | undefined): { critical: number; high: number; n: number } {
  if (!s || s.stale !== false) return { critical: 0, high: 0, n: 0 };
  return { critical: s.open.critical, high: s.open.high, n: s.open.critical + s.open.high };
}

/** The "Not ready: n open" chip, or null. Never moves a lane. */
export function notReadyChip(s: PrNotesSummary | undefined): { text: string; title: string } | null {
  const b = blockingOpen(s);
  if (b.n === 0) return null;
  return { text: `Not ready: ${b.n} open`, title: `${plural(b.critical, "critical finding")} and ${plural(b.high, "high finding")} open from the local review of the current head.` };
}

/** What the lane filing needs, or undefined when this pull request is not held. */
export type GateFacts = { n: number; critical: number; high: number };
export function gateFacts(s: PrNotesSummary | undefined): GateFacts | undefined {
  const b = blockingOpen(s);
  return b.n > 0 ? b : undefined;
}

/** The reason line on the card in the Blocked lane. */
export function gateReason(g: GateFacts): string {
  return g.high === 0
    ? `${plural(g.n, "open critical finding")} from local-review`
    : `${g.n} open critical or high ${g.n === 1 ? "finding" : "findings"} from local-review`;
}

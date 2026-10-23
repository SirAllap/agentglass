import { DEFAULT_PUBLISH_OPTIONS, PUBLISH_MAX_CHARS, type PublishOptions } from "../../../shared/reviewPublish.ts";
import { reviewStale, type HeadRead } from "../../../shared/headCompare.ts";
import type { PrNote, PrRun } from "./pluginTypes.ts";

/**
 * The decisions behind "Publish review…", out of the screen so they can be
 * asserted without a renderer: which of its four states the button is in,
 * what the dialog starts with, what "Publish all" ticks, when Post is allowed,
 * and which finding cards say "local only" afterwards.
 */

export { DEFAULT_PUBLISH_OPTIONS, PUBLISH_MAX_CHARS };

export const NO_REVIEW_TIP = "Run a local review first";
export const NOTHING_OPEN_WARNING = "no open findings; header and verdict only";
/** The sentence the dialog opens with, and the reason it exists. */
export const NOTHING_LEAVES_WARNING =
  "Nothing from your local review is on GitHub until you press Post comment. This posts ONE plain comment as you (no approval, no change request); if a published review already exists on this pull request, it is edited instead. Replies stay local unless ticked.";

export type PublishButtonKind = "none" | "ready" | "nothing-open" | "stale" | "published";

export interface PublishButtonState {
  kind: PublishButtonKind;
  label: string;
  disabled: boolean;
  tooltip: string;
  /** The amber chip when the head moved since the review. */
  staleChip: boolean;
  /** The neutral chip on a run a newer finished review of the same plugin replaced. */
  supersededChip: boolean;
  /** The "published to GitHub" chip, with where it points. */
  published: { at: number; url: string } | null;
}

const isInfo = (n: Pick<PrNote, "severity">) => n.severity === "idea" || n.severity === "info";

/** The run a plugin's review stands on: its latest FINISHED run, by when it
 *  finished. A run still going shows instead, so the button says so. */
export function latestRun<R extends Pick<PrRun, "state" | "startedAt" | "finishedAt"> & { plugin: string }>(runs: readonly R[], plugin: string): R | undefined {
  const mine = runs.filter((r) => r.plugin === plugin);
  const going = mine.filter((r) => r.state === "running" || r.state === "queued" || r.state === "needs-ok").sort((x, y) => y.startedAt - x.startedAt)[0];
  if (going) return going;
  const done = mine.filter((r) => r.state === "done").sort((x, y) => (x.finishedAt ?? x.startedAt) - (y.finishedAt ?? y.startedAt));
  return done[done.length - 1] ?? mine.sort((x, y) => x.startedAt - y.startedAt).pop();
}

/** How many findings the verdict counts: open, and not info-level. */
export function openCount(notes: readonly Pick<PrNote, "status" | "severity">[]): number {
  return notes.filter((n) => n.status === "open" && !isInfo(n)).length;
}

/**
 * One state for one plugin's latest run on this pull request. Stale and
 * published are not exclusive: a review published for an older commit is both,
 * and the button then reads "Update published review…".
 */
export function publishButtonState(
  run: Pick<PrRun, "state" | "sha" | "published" | "startedAt" | "finishedAt"> | undefined,
  notes: readonly Pick<PrNote, "status" | "severity">[],
  head: HeadRead | string | undefined,
  superseded = false,
): PublishButtonState {
  if (!run) return { kind: "none", label: "Publish review…", disabled: true, tooltip: NO_REVIEW_TIP, staleChip: false, supersededChip: false, published: null };
  if (run.state !== "done") {
    return { kind: "none", label: "Publish review…", disabled: true, tooltip: run.state === "failed" || run.state === "cancelled" ? NO_REVIEW_TIP : "The review is still running", staleChip: false, supersededChip: false, published: null };
  }
  // Stale is one thing: the LATEST finished review's commit differs from a head read after it ended
  // (reviewStale). An older run is "superseded", never stale: a newer review covers the head.
  const stale = !superseded && reviewStale(run.sha, run.finishedAt ?? run.startedAt, head) === true;
  const published = run.published ? { at: run.published.at, url: run.published.url } : null;
  const open = openCount(notes);
  const kind: PublishButtonKind = published ? "published" : stale ? "stale" : open === 0 ? "nothing-open" : "ready";
  return {
    kind,
    label: published ? "Update published review…" : "Publish review…",
    disabled: false,
    tooltip: published ? "Edit the comment this review already has on the pull request"
      : stale ? "The pull request has new commits since this review"
        : open === 0 ? `Publish: ${NOTHING_OPEN_WARNING}` : "Post this review as one comment on the pull request",
    staleChip: stale,
    supersededChip: superseded,
    published,
  };
}

export interface OptionRow { key: keyof PublishOptions; label: string; count: number | null; checked: boolean; locked: boolean }

/** The checkbox list, with counts. Open findings and the header are what goes out
 *  anyway; they are shown ticked and can still be taken off. */
export function optionRows(notes: readonly Pick<PrNote, "status" | "severity" | "replies">[], o: PublishOptions): OptionRow[] {
  const n = (st: string, info = false) => notes.filter((x) => x.status === st && (info || !isInfo(x))).length;
  return [
    { key: "includeHeader", label: "Header and verdict", count: null, checked: o.includeHeader, locked: false },
    { key: "includeOpen", label: "Open findings", count: n("open"), checked: o.includeOpen, locked: false },
    { key: "includeResolved", label: "Resolved findings", count: n("resolved"), checked: o.includeResolved, locked: false },
    { key: "includeDismissed", label: "Dismissed findings", count: n("dismissed"), checked: o.includeDismissed, locked: false },
    { key: "includeReplies", label: "My replies and conversation with the plugin", count: notes.reduce((a, x) => a + (x.replies?.length ?? 0), 0), checked: o.includeReplies, locked: false },
    { key: "includeInfo", label: "Info-level findings", count: notes.filter(isInfo).length, checked: o.includeInfo, locked: false },
  ];
}

/** "Publish all for context": every box ticked. */
export const publishAllOptions = (): PublishOptions => ({
  includeHeader: true, includeOpen: true, includeResolved: true, includeDismissed: true, includeReplies: true, includeInfo: true,
});

/** What the dialog opens with: the minimum, never the last choice. */
export const freshOptions = (): PublishOptions => ({ ...DEFAULT_PUBLISH_OPTIONS });

export function allTicked(o: PublishOptions): boolean {
  return (Object.keys(o) as (keyof PublishOptions)[]).every((k) => o[k]);
}

export function charCounter(chars: number): { text: string; over: boolean } {
  return { text: `${chars.toLocaleString("en-US")} / ${PUBLISH_MAX_CHARS.toLocaleString("en-US")}`, over: chars > PUBLISH_MAX_CHARS };
}

/** Post is the dialog's own confirmation, so it asks nothing more; it is simply
 *  not available while there is nothing to send, too much, or a post in flight. */
export function canPost(markdown: string, busy: boolean): boolean {
  return !busy && markdown.trim().length > 0 && markdown.length <= PUBLISH_MAX_CHARS;
}

export const postLabel = (existing: boolean) => (existing ? "Update comment" : "Post comment");

/**
 * After a publish: a closed finding the comment did not include is "local
 * only". Open findings are always in the comment unless the person took them
 * off, so only the closed ones are marked.
 */
export function localOnly(n: Pick<PrNote, "status">, run: Pick<PrRun, "published"> | undefined): boolean {
  const o = run?.published?.options;
  if (!run?.published || !o) return false;
  if (n.status === "resolved") return !o.includeResolved;
  if (n.status === "dismissed") return !o.includeDismissed;
  return false;
}

/** The dialog's two views of the comment text. Preview is what GitHub will draw; Markdown is the editable source and the only thing posted. */
export type PreviewTab = "preview" | "markdown";
export const DEFAULT_PREVIEW_TAB: PreviewTab = "preview";
export const PREVIEW_TABS: readonly { id: PreviewTab; label: string; title: string }[] = [
  { id: "preview", label: "Preview", title: "How GitHub will draw the comment" },
  { id: "markdown", label: "Markdown", title: "The text that is posted; edit it here" },
];
/** Who the card's header line speaks for. */
export const PREVIEW_CARD_LINE = "you will comment";

const TAB_KEY = "agx.publishReview.tab";

/** The tab chosen earlier in this window's session, or Preview. Storage can be blocked; the default then stands. */
export function readPreviewTab(): PreviewTab {
  try {
    const v = sessionStorage.getItem(TAB_KEY);
    return v === "markdown" || v === "preview" ? v : DEFAULT_PREVIEW_TAB;
  } catch { return DEFAULT_PREVIEW_TAB; }
}
export function rememberPreviewTab(t: PreviewTab): void {
  try { sessionStorage.setItem(TAB_KEY, t); } catch { /* blocked storage: the choice just is not remembered */ }
}

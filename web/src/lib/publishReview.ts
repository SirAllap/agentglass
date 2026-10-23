import { DEFAULT_PUBLISH_OPTIONS, PUBLISH_MAX_CHARS, type PublishOptions } from "../../../shared/reviewPublish.ts";
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
  /** The "published to GitHub" chip, with where it points. */
  published: { at: number; url: string } | null;
}

const isInfo = (n: Pick<PrNote, "severity">) => n.severity === "idea" || n.severity === "info";
const sameCommit = (a?: string, b?: string) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

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
  run: Pick<PrRun, "state" | "sha" | "published"> | undefined,
  notes: readonly Pick<PrNote, "status" | "severity">[],
  headSha: string | undefined,
): PublishButtonState {
  if (!run) return { kind: "none", label: "Publish review…", disabled: true, tooltip: NO_REVIEW_TIP, staleChip: false, published: null };
  if (run.state !== "done") {
    return { kind: "none", label: "Publish review…", disabled: true, tooltip: run.state === "failed" || run.state === "cancelled" ? NO_REVIEW_TIP : "The review is still running", staleChip: false, published: null };
  }
  const stale = !!headSha && !!run.sha && !sameCommit(headSha, run.sha);
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

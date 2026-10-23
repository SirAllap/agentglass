/**
 * What the person may tick when they publish a local review as one pull
 * request comment. Shared so the dialog and the builder (server/src/review-
 * publish.ts) read the same defaults: the minimum goes out unless more is
 * asked for.
 */

/** GitHub refuses a comment over 65,536 characters; this leaves room for an edit. */
export const PUBLISH_MAX_CHARS = 60_000;

/** What goes out. The header with its verdict, and the open findings, are the
 *  minimum; everything else is something the person ticked. */
export interface PublishOptions {
  includeHeader: boolean;
  includeOpen: boolean;
  includeResolved: boolean;
  includeDismissed: boolean;
  /** The whole thread under each included finding, not only the closing answer. */
  includeReplies: boolean;
  /** Findings of severity `idea` and `info`. */
  includeInfo: boolean;
}

export const DEFAULT_PUBLISH_OPTIONS: Readonly<PublishOptions> = {
  includeHeader: true, includeOpen: true,
  includeResolved: false, includeDismissed: false, includeReplies: false, includeInfo: false,
};

/** Anything not a boolean, and anything missing, is the default. */
export function cleanPublishOptions(raw: unknown): PublishOptions {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const out = { ...DEFAULT_PUBLISH_OPTIONS };
  for (const k of Object.keys(out) as (keyof PublishOptions)[]) if (typeof o[k] === "boolean") out[k] = o[k] as boolean;
  return out;
}


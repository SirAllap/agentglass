/*
 * One event of a pull request's conversation, written the way GitHub words it.
 *
 * The desk and the phone both draw "ada requested a review from bob", and the
 * sentence was a switch inside the desk's panel: the phone could only copy it,
 * and a copy is the one that drifts. The wording lives here as parts, and each
 * screen decides how a part looks — bold, monospace, a coloured chip — because
 * that is the only thing the two do differently.
 */
import type { PrEvent } from "./types.ts";

export interface EventPart {
  text: string;
  /** who: the actor. strong: somebody named. code: a ref or a sha pair.
   *  label: a label name, carrying the colour GitHub gave it. */
  as?: "who" | "strong" | "code" | "label";
  /** For `label`: GitHub's hex (no #) on a label that was added, null on one removed. */
  tint?: string | null;
}

export function eventParts(e: PrEvent): EventPart[] {
  const who: EventPart = { text: e.actor || "somebody", as: "who" };
  const d = e.detail || "";
  const t = (text: string): EventPart => ({ text });
  const strong = (text: string): EventPart => ({ text, as: "strong" });
  const code = (text: string): EventPart => ({ text, as: "code" });
  switch (e.kind) {
    case "force-push": return d ? [who, t(" force-pushed "), code(d)] : [who, t(" force-pushed")];
    case "renamed": return [who, t(` changed the title to “${d}”`)];
    case "labeled": return [who, t(" added the "), { text: d, as: "label", tint: e.tint ?? null }, t(" label")];
    case "unlabeled": return [who, t(" removed the "), { text: d, as: "label", tint: null }, t(" label")];
    case "assigned": return [who, t(" assigned "), strong(d)];
    case "unassigned": return [who, t(" unassigned "), strong(d)];
    case "review-requested": return [who, t(" requested a review from "), strong(d)];
    case "review-request-removed": return [who, t(` withdrew the review request for ${d}`)];
    case "ready-for-review": return [who, t(" marked this ready for review")];
    case "convert-to-draft": return [who, t(" converted this to a draft")];
    case "merged": return [who, t(" merged this into "), code(d)];
    case "closed": return [who, t(" closed this")];
    case "reopened": return [who, t(" reopened this")];
    case "cross-referenced": return [who, t(` mentioned this in ${d}`)];
    case "milestoned": return [who, t(` added this to the ${d} milestone`)];
    case "demilestoned": return [who, t(` removed this from the ${d} milestone`)];
    case "head-ref-deleted": return [who, t(" deleted the "), code(d), t(" branch")];
    case "auto-merge-enabled": return [who, t(" armed auto-merge")];
    case "auto-merge-disabled": return [who, t(d ? ` cancelled auto-merge (${d})` : " cancelled auto-merge")];
    default: return [who, t(" did something")];
  }
}

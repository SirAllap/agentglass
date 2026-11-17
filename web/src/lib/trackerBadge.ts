/*
 * WHICH TRACKER A BLOCK IS ABOUT TO WRITE TO, as one word.
 *
 * Every block that changes a card — the status picker at merge, the review
 * popover's "On the card", the sidebar sections — names the card and then asks
 * for a status or a person. The id alone does not say which system will be
 * written: `ORBIT-1042` is a Jira key on a machine with both connected, and the
 * same string is a ClickUp custom id on a machine with only ClickUp.
 *
 * So the badge reads the value the write reads, never a second guess about the
 * id's shape. The callers own that value (`side.kind`, `ref.tracker`,
 * `TRACKERS.x.id`); this only turns it into what is drawn.
 */

export type BadgeTracker = "jira" | "clickup";

export interface BadgeLook {
  label: "Jira" | "ClickUp";
  /** The glyph: Jira's flag and ClickUp's checkbox, the two this app already
   *  draws for them (PrAskPicker's card row, PrCard's ticket row). */
  icon: "flag" | "checkbox";
}

export function trackerBadge(tracker: BadgeTracker | null | undefined): BadgeLook | null {
  if (tracker === "jira") return { label: "Jira", icon: "flag" };
  if (tracker === "clickup") return { label: "ClickUp", icon: "checkbox" };
  return null;
}

/**
 * Which tracker the merge dialog's "Tracker card" block writes to.
 *
 * The two halves of that block are exclusive: a Jira card is looked up and moved
 * by `MergeJiraCard`, and a ClickUp card by the dialog's own read. Neither
 * present means the block is not drawn at all.
 */
export function mergeTracker(hasJiraCard: boolean, hasClickupCard: boolean): BadgeTracker | null {
  if (hasJiraCard) return "jira";
  if (hasClickupCard) return "clickup";
  return null;
}

/**
 * Which tracker a card section in the pull request panel writes to.
 *
 * `ref.tracker === "jira"` is what picks `JiraCardFacts` over `CardFacts`; with
 * no name the section is ClickUp's, the same fallback the writes make.
 */
export function sectionTracker(ref: { tracker?: string | null } | null): BadgeTracker {
  return ref?.tracker === "jira" ? "jira" : "clickup";
}

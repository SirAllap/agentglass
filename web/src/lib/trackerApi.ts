/*
 * Which tracker a card belongs to, decided once.
 *
 * The seam between the card screens and the trackers behind them. This slice
 * holds the question every later one starts from: given an id read out of a
 * branch or a body, WHOSE is it? Moving a card and putting someone on it are
 * methods on what `trackerFor` returns; commenting comes after.
 *
 * Why the question needs an owner at all. `ORBIT-1042` is the same string in
 * both trackers, and with one connected nothing was ever ambiguous: the id was
 * that tracker's or it was nobody's. With two connected, a lookup sent to the
 * wrong one either finds nothing (and says "no such card") or, worse, finds a
 * different card with the same number.
 *
 * The rule, in order, first answer wins:
 *
 *   1. The id names its tracker (an address, ClickUp's own `CU-` ids): that
 *      one, if it is connected here, otherwise nobody's.
 *   2. The repository's own choice, when it is not "auto" and that tracker is
 *      connected: that one. This is the only way to settle an id both claim.
 *   3. The id's prefix against each connected tracker's: Jira's are the
 *      project keys its site reported, ClickUp's is the prefix read from its
 *      cards. One claim wins; none or two is nobody's.
 *
 * "Nobody's" is `null`, and `null` means say nothing and offer no write: a
 * chip that opens the wrong tracker is believed, which is worse than no chip.
 *
 * A machine with only ClickUp (or only nothing) never reaches rule 3 in a way
 * that differs from before: `looksLikeOurs` is asked with the same arguments
 * it was asked with, and the answer is its answer. Only when Jira is connected
 * too does "no prefix known" stop meaning yes, because then yes would also be
 * said for Jira's ids.
 *
 * Ceiling, what this does not cover: boards, saved views, folders, the Tasks
 * tab, the bell, search, checklists, field edits, priority writes and comment
 * edits. Those stay ClickUp's until a slice gives Jira its own. This is for
 * one card, its status, its person and a comment.
 */
import type { TrackerChoice } from "../../../shared/providers.ts";
import { looksLikeCardId } from "../../../shared/cardRef.ts";
import { looksLikeOurs, type CardRef } from "./cardRef.ts";
import type { TrackerSetup } from "./trackerSetup.ts";
import type { ProviderTask } from "../../../shared/providers.ts";
import {
  clickupSetStatus, clickupStatusOptions, jiraSetStatus, jiraStatusOptions,
  type StatusOption, type StatusOptionsResult, type StatusWriteResult,
} from "./trackerStatus.ts";

import { jiraHandOff, jiraPeople, jiraSetPeople, type CardWriteResult, type PeopleResult } from "./trackerPeople.ts";
import { clickupComment, jiraComment, type CommentMention, type CommentResult } from "./trackerComment.ts";

export type { StatusOption } from "./trackerStatus.ts";

export type TrackerId = "clickup" | "jira";

export interface TrackerCaps {
  /** ClickUp puts several people on a card; Jira has one assignee. */
  multiAssignee: boolean;
  /** Jira moves a card by a transition from where it is; ClickUp sets a status by name. */
  statusByTransition: boolean;
  checklists: boolean;
  boards: boolean;
  /** The fewest digits a typed id may have before it is taken for a card. ClickUp
   *  keeps three so a page or sprint number is not mistaken for one; a new Jira
   *  project's first cards are `ORBIT-7`. */
  idMinDigits: number;
}

/** What `trackerFor` hands back. Operations are added to this in the slices that need them. */
export interface Tracker {
  id: TrackerId;
  caps: TrackerCaps;
  /** Where the card can go from here: ClickUp's list statuses, Jira's moves. An error is a sentence for the person. */
  statusOptions(task: ProviderTask): Promise<StatusOptionsResult>;
  /** One move, with the stamp the person saw (`task.updated`). The answer carries the card as it is afterwards. */
  setStatus(task: ProviderTask, opt: StatusOption, fields?: Record<string, string | string[]>): Promise<StatusWriteResult>;
  /*
   * People and the hand-off, for a tracker with one assignee. ClickUp has
   * neither here: its multi-person picker and its hand-off button keep the
   * bodies they always sent, in the pull request panel. Ceiling: one seam for
   * one shape, not one for both.
   */
  /** Who the card can be given to, by what was typed; `transition` asks for during that move. */
  people?(task: ProviderTask, query: string, transition?: string): Promise<PeopleResult>;
  /** One person on (`set: key`) or nobody (`set: null`), with the stamp the person saw. */
  setPeople?(task: ProviderTask, change: { set: string | null }): Promise<CardWriteResult>;
  /** The hand-off, as one request; a choice left out is the project's setting. */
  handOff?(task: ProviderTask, choice?: { to?: string; clear?: boolean }): Promise<CardWriteResult>;
  /** One comment, Markdown. `mentions` are the people named in it by the id the
   *  tracker's people search gave; ClickUp finds them itself and ignores it. */
  comment(task: ProviderTask, markdown: string, mentions?: CommentMention[], replyTo?: string): Promise<CommentResult>;
}

const CLICKUP: Tracker = {
  id: "clickup",
  caps: { multiAssignee: true, statusByTransition: false, checklists: true, boards: true, idMinDigits: 3 },
  statusOptions: clickupStatusOptions,
  setStatus: clickupSetStatus,
  comment: (task, markdown) => clickupComment(task, markdown),
};
const JIRA: Tracker = {
  id: "jira",
  caps: { multiAssignee: false, statusByTransition: true, checklists: false, boards: false, idMinDigits: 1 },
  statusOptions: jiraStatusOptions,
  setStatus: jiraSetStatus,
  people: jiraPeople,
  setPeople: jiraSetPeople,
  handOff: jiraHandOff,
  comment: jiraComment,
};

/** The two descriptors by id: for a screen that already knows its tracker (the Jira tab), and for a test that compares by identity. */
export const TRACKERS = { clickup: CLICKUP, jira: JIRA } as const;

export interface OwnerOptions {
  /** The answer for a prefix nobody has read yet. The chip says yes (it only
   *  picks where a tap goes), the merge form says no (it would spin on a lookup
   *  that may find nothing) — the same argument `looksLikeOurs` takes. */
  whenUnknown?: boolean;
  /** Cards were read and none carries a custom id (ClickUp's `noCustomIds`). */
  noCustomIds?: boolean;
}

/** The part of `ORBIT-1042` before its last hyphen, upper-cased; "" when there is none. */
function prefixOf(label: string): string {
  const i = label.lastIndexOf("-");
  return i > 0 ? label.slice(0, i).toUpperCase() : "";
}

const digitsOf = (label: string): number => /(\d+)$/.exec(label)?.[1]?.length ?? 0;

export function trackerFor(
  ref: CardRef, setup: TrackerSetup, choice: TrackerChoice = "auto", opts: OwnerOptions = {},
): Tracker | null {
  const cu = setup.clickup;
  const jira = setup.jira;
  if (!cu && !jira) return null;
  const whenUnknown = opts.whenUnknown ?? true;

  // 1. The id says whose it is.
  if (ref.tracker) {
    if (ref.tracker === "clickup") return cu ? CLICKUP : null;
    if (ref.tracker === "jira") return jira ? JIRA : null;
    return null;
  }

  // An address that named no tracker is the one case the old rule answered
  // for ClickUp alone (`from === "url"` is true on its own there).
  if (ref.from === "url") return cu && !jira ? CLICKUP : null;

  // 2. The repository's choice, when the tracker it names is here.
  if (choice === "clickup" && cu) return CLICKUP;
  if (choice === "jira" && jira) return JIRA;

  // 3. The prefix. ClickUp alone is exactly what it always was.
  if (cu && !jira) {
    return looksLikeOurs(ref, cu.prefix, whenUnknown, opts.noCustomIds) ? CLICKUP : null;
  }

  const pre = prefixOf(ref.label);
  // With both connected, "no prefix known" is no longer yes, and a typed id
  // under ClickUp's digit floor is not a ClickUp id.
  const claimsClickup = !!cu
    && digitsOf(ref.label) >= CLICKUP.caps.idMinDigits
    && looksLikeOurs(ref, cu.prefix, false, opts.noCustomIds);
  const keys = jira?.prefixes ?? [];
  // A Jira site that reported no projects is unknown, not empty; on its own that follows `whenUnknown`.
  const claimsJira = !!jira && !!pre && (keys.length
    ? keys.some((k) => k.toUpperCase() === pre)
    : whenUnknown && !cu);

  if (claimsClickup === claimsJira) return null;
  return claimsClickup ? CLICKUP : JIRA;
}

/** Is `q` a card id as THIS tracker spells them? `ORBIT-7` is one for Jira and not for ClickUp. */
export function looksLikeIdFor(tracker: Tracker, q: string): boolean {
  return looksLikeCardId(q, { minDigits: tracker.caps.idMinDigits });
}

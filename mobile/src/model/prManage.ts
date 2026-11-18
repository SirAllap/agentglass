/*
 * The PR writes, as decisions rather than presses.
 *
 * Labels and reviewers are two lists that look alike and are not: one adds a
 * tag GitHub keeps for the whole repository, the other asks a person for a
 * review. Both are edited here as "what the pull request holds now" against
 * "what the sheet has ticked", so the request is always a diff — a save that
 * re-sent every ticked name would be a write per row on somebody's repository.
 *
 * Close, draft and edit are here for the same reason: the sentence a control
 * owes the person (a close keeps the branch; a draft asks nobody) is a fact
 * about the write, not about the drawing, and it is testable without a screen.
 *
 * No renderer here. The sheets read these and paint; every guard below is a
 * value, so breaking one is a red test rather than a screen to go and look at.
 */
import type { DeviceScope, PrDetail } from "../../../shared/types.ts";

/** A label as both the repository and the pull request describe it. */
export interface LabelLike {
  name: string;
  color?: string;
}

/** One row of the label picker. */
export interface LabelChoice extends LabelLike {
  on: boolean;
}

/** One row of the reviewer picker. */
export interface ReviewerChoice {
  login: string;
  on: boolean;
}

/**
 * Add and remove, from what the pull request holds and what was ticked.
 *
 * Order follows the input on both sides: the repository's order for labels is
 * the order somebody arranged, and a picker that re-alphabetised it would be a
 * second opinion. A name in neither list contributes nothing.
 */
export function membershipDiff(
  before: readonly string[],
  picked: readonly string[],
): { add: string[]; remove: string[] } {
  const was = new Set(before);
  const now = new Set(picked);
  return {
    add: picked.filter((name) => !was.has(name)),
    remove: before.filter((name) => !now.has(name)),
  };
}

/** The label request: the two lists GitHub's own `pr edit` takes. */
export function labelDiff(before: readonly string[], picked: readonly string[]): { add: string[]; remove: string[] } {
  return membershipDiff(before, picked);
}

/** The reviewer request. Separate function, same rule: two lists, add and remove. */
export function reviewerDiff(before: readonly string[], picked: readonly string[]): { add: string[]; remove: string[] } {
  return membershipDiff(before, picked);
}

/**
 * What the label picker draws.
 *
 * The repository's labels come from `/prs/facets`; the pull request's own are
 * taken as given, because a repo read can fail or be a page behind and a label
 * already on the pull request must still be removable. Any name only the pull
 * request knows is appended rather than dropped.
 */
export function labelChoices(repo: readonly LabelLike[], current: readonly string[]): LabelChoice[] {
  const on = new Set(current);
  const seen = new Set<string>();
  const out: LabelChoice[] = [];
  for (const l of repo) {
    if (!l.name || seen.has(l.name)) continue;
    seen.add(l.name);
    out.push({ name: l.name, color: l.color, on: on.has(l.name) });
  }
  for (const name of current) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, on: true });
  }
  return out;
}

/** The labels on the pull request, in the order the detail carries them. */
export function labelsOf(detail: Pick<PrDetail, "labels">): string[] {
  return (detail.labels ?? []).map((l) => l.name).filter(Boolean);
}

/** The reviewers already asked, as GitHub has them. Teams included: that is
 *  what `/prs/reviewers` takes and what a `pr edit` accepts. */
export function reviewersOf(detail: Pick<PrDetail, "reviewers">): string[] {
  return (detail.reviewers ?? []).map((r) => r.login).filter(Boolean);
}

/**
 * The reviewer picker: people who could be asked, then anyone already asked
 * that the repository's people list did not include (a team, or somebody who
 * left) so Remove is still reachable.
 */
export function reviewerChoices(people: readonly string[], current: readonly string[]): ReviewerChoice[] {
  const on = new Set(current);
  const seen = new Set<string>();
  const out: ReviewerChoice[] = [];
  for (const login of people) {
    if (!login || seen.has(login)) continue;
    seen.add(login);
    out.push({ login, on: on.has(login) });
  }
  for (const login of current) {
    if (!login || seen.has(login)) continue;
    seen.add(login);
    out.push({ login, on: true });
  }
  return out;
}

/** Case-insensitive substring, the way every picker on this phone searches. */
export function matchesQuery(text: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || text.toLowerCase().includes(q);
}

export function findLabels(choices: readonly LabelChoice[], query: string): LabelChoice[] {
  return choices.filter((c) => matchesQuery(c.name, query));
}

export function findReviewers(choices: readonly ReviewerChoice[], query: string): ReviewerChoice[] {
  return choices.filter((c) => matchesQuery(c.login, query));
}

/** What the close row is, on the pull request in front of you. */
export interface StateAction {
  verb: "close" | "reopen";
  label: string;
  line: string;
}

/**
 * Close or reopen — never merge, which has its own sheet and its own hold.
 *
 * Closing is the write people expect to delete something and does not: the
 * branch stays, nothing merges, and reopening is one press by any maintainer.
 * That sentence belongs next to the button rather than to a help page.
 */
export function stateAction(state: PrDetail["state"]): StateAction | null {
  if (state === "OPEN") {
    return {
      verb: "close",
      label: "Close it",
      line: "Nothing merges. The checks stop running, the review requests go away, and the branch stays on the computer.",
    };
  }
  if (state === "CLOSED") {
    return {
      verb: "reopen",
      label: "Reopen it",
      line: "It goes back into the review queue with the same branch and the same conversation.",
    };
  }
  return null;
}

/** What the draft row does, and what the state means for the next person. */
export interface DraftAction {
  draft: boolean;
  label: string;
  line: string;
}

export function draftAction(isDraft: boolean): DraftAction {
  return isDraft
    ? {
        draft: false,
        label: "Mark it ready for review",
        line: "It goes back in the same queue. Nobody new is asked until it is ready.",
      }
    : {
        draft: true,
        label: "Mark it as a draft",
        line: "Drafts do not ask for review and cannot merge by accident. The checks keep running.",
      };
}

/** The title and body edit, reduced to the fields that really moved. */
export interface EditPatch {
  changed: boolean;
  title?: string;
  body?: string;
  /** Why nothing can be saved, when that is the case. */
  problem?: string;
}

/**
 * Only the fields that changed go over the wire.
 *
 * `gh pr edit` takes a title and a body; sending both on every save would
 * rewrite the description's own `updatedAt` and notify everybody watching it
 * for a typo in the title. An empty body is a real edit — it clears the
 * description — while an empty title is refused here rather than by GitHub.
 */
export function editPatch(detail: Pick<PrDetail, "title" | "body">, title: string, body: string): EditPatch {
  const nextTitle = title.trim();
  if (!nextTitle) return { changed: false, problem: "A pull request needs a title." };
  const patch: EditPatch = { changed: false };
  if (nextTitle !== detail.title) { patch.title = nextTitle; patch.changed = true; }
  if (body !== detail.body) { patch.body = body; patch.changed = true; }
  return patch;
}

/**
 * Why a control on this phone cannot write, or null when it can.
 *
 * The server needs `full` for every POST that is not a gate answer, so a
 * `read` or `answer` pairing gets one sentence here instead of a 403 after a
 * gesture. The row stays drawn: the app says what the phone is for, and a
 * control that vanishes teaches nobody that pairing differently would help.
 */
export function writeBlocked(scope: DeviceScope | null | undefined): string | null {
  if (scope === "full") return null;
  return "This phone is paired for reading. Pair with Everything to change a pull request.";
}

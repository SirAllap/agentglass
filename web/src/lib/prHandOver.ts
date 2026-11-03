// The paired apply: one Done, up to four calls, each to the system that owns it.
//
// "Request a review" and "Assign" act on GitHub. The "On the card" block beside
// them acts on the tracker card the pull request is linked to: who it is
// assigned to and which status it sits in. The person presses one button, so
// what that button will do is a plan, built here, shown as one sentence before
// it runs, and handed to prApplyResult.ts to report afterwards. Each step is a
// separate request to a separate service and one can fail while the other
// passes, which is why they are separate steps and not one call.
//
// A pull request with no tracker, an unlinked card, or a read-only token gets
// the GitHub steps only, and the plan says which of the three it was.
//
// The ceiling: steps are independent. A status move does not wait for the
// assignment before it, and nothing is rolled back when the other system
// fails; the result says what is done and what is not.
import { withoutAuthor } from "./reviewerPick.ts";
import type { AskMode } from "./prAskWho.ts";

export type TrackerKind = "clickup" | "jira";
const SYSTEM_NAME: Record<TrackerKind, string> = { clickup: "ClickUp", jira: "Jira" };

export type StepId = "gh-reviewers" | "gh-assignees" | "card-assign" | "card-status" | "card-extras";
export type System = "github" | TrackerKind;

export interface Step {
  id: StepId;
  system: System;
  /** `GitHub`, `ClickUp`, `Jira`: the row it reports under. */
  label: string;
  /** What it sends. */
  add?: string[];
  /** The card's people who come off it (a hand-over replaces whoever held the card). */
  drop?: string[];
  teams?: string[];
  status?: string;
  /** Past the verb, for the plan sentence: `Request mara-k on GitHub`. */
  text: string;
}

/** Why the card half is not part of the plan. */
export type CardSkip = "no-tracker" | "unlinked" | "read-only";

export interface HandOverInput {
  mode: AskMode;
  /** The hand-over entry point: asks for a review, so the mode toggle is hidden. */
  handOver?: boolean;
  author: string;
  /** Logins and `@org/team` slugs picked in the picker. */
  picked: string[];
  /** Already on the pull request in this role; sending them again is a no-op and a re-request is a different action. */
  already?: string[];
  tracker: {
    kind: TrackerKind | null;
    /** The card id, e.g. `ORBIT-1042`; absent when no card is linked. */
    card?: string;
    readOnly?: boolean;
    /** Where the card is now. */
    status?: string;
  };
  card: {
    /** "Same people as reviewers|assignees" is on: the card follows the picker. */
    mirror: boolean;
    /** The card's own list, used once mirroring is off. */
    people: string[];
    /** The chosen next status; null is "Leave it". */
    status: string | null;
    /** Who comes off the card, named as the card names them. A hand-over fills it; a plain request leaves it empty. */
    drop?: string[];
    /** What the team's own review step also writes on the card (a comment, a field), as the sentence says it. */
    extras?: string[];
  };
}

export interface Plan {
  steps: Step[];
  /** `Request mara-k on GitHub · assign mara-k on ClickUp · move to in review` */
  summary: string;
  empty: boolean;
  cardSkip: CardSkip | null;
  /** The people the card gets after this: the picker's, or its own list. */
  cardPeople: string[];
  done: { label: string; disabled: boolean };
}

const isTeam = (id: string) => id.startsWith("@");
const lc = (s: string) => s.trim().toLowerCase();

/** The card's people for a given picker: mirrored, or its own list. Teams cannot be assigned a card. */
export function cardPeopleOf(card: HandOverInput["card"], picked: string[]): string[] {
  return (card.mirror ? picked : card.people).filter((x) => !isTeam(x));
}

/** Editing the card's own list turns mirroring off; "Mirror again" turns it on and forgets the list. */
export function editCardPeople(people: string[]): { mirror: false; people: string[] } {
  return { mirror: false, people };
}

const join = (xs: string[]) => xs.join(", ");

export function cardSkipOf(t: HandOverInput["tracker"]): CardSkip | null {
  if (!t.kind) return "no-tracker";
  if (!t.card) return "unlinked";
  if (t.readOnly) return "read-only";
  return null;
}

/**
 * The plan for one press of Done.
 *
 * Order is GitHub first, then the card's people, then its status: the order the
 * sentence reads in and the order the result rows list. A step with nothing to
 * send is not in the plan, so "Nothing to apply yet" is simply an empty list.
 */
export function handOverPlan(i: HandOverInput): Plan {
  const steps: Step[] = [];
  const already = new Set((i.already ?? []).map(lc));
  const reviewing = i.mode === "reviewers" || !!i.handOver;
  const askable = withoutAuthor(i.picked.map((value) => ({ value })), reviewing ? i.author : undefined).map((o) => o.value);
  const fresh = askable.filter((x) => !already.has(lc(x)));
  const people = fresh.filter((x) => !isTeam(x));
  const teams = fresh.filter(isTeam);

  if (people.length || teams.length) {
    const names = join([...people, ...teams]);
    steps.push(reviewing
      ? { id: "gh-reviewers", system: "github", label: "GitHub", add: people, teams, text: `Request ${names} on GitHub` }
      : { id: "gh-assignees", system: "github", label: "GitHub", add: people, text: `Assign ${names} on GitHub` });
  }

  const skip = cardSkipOf(i.tracker);
  const cardPeople = cardPeopleOf(i.card, askable);
  if (!skip && i.tracker.kind) {
    const system = i.tracker.kind;
    const label = SYSTEM_NAME[system];
    const drop = (i.card.drop ?? []).filter((x) => !cardPeople.some((p) => lc(p) === lc(x)));
    if (cardPeople.length || drop.length) {
      const said = [cardPeople.length && `assign ${join(cardPeople)}`, drop.length && `take ${join(drop)} off`].filter(Boolean).join(" and ");
      steps.push({ id: "card-assign", system, label, add: cardPeople, ...(drop.length ? { drop } : null), text: `${said} on ${label}` });
    }
    const next = i.card.status;
    if (next && lc(next) !== lc(i.tracker.status ?? "")) {
      steps.push({ id: "card-status", system, label, status: next, text: `move to ${next}` });
    }
    if (i.card.extras?.length) steps.push({ id: "card-extras", system, label, text: i.card.extras.join(" and ") });
  }

  const summary = steps.length ? steps.map((s) => s.text).join(" · ") : "Nothing to apply yet";
  return {
    steps, summary, empty: steps.length === 0, cardSkip: skip, cardPeople,
    done: { label: i.handOver ? "Hand over" : "Done", disabled: steps.length === 0 },
  };
}

/** Where the card is in its chain, in the order a card normally moves. */
export const CHAIN: Record<TrackerKind, string[]> = {
  clickup: ["to do", "in progress", "in review", "in qa", "done"],
  jira: ["To Do", "In progress", "In review", "Ready for QA", "Done"],
};

/**
 * The statuses offered after "Leave it": up to three that come after where the
 * card is now, review first because that is what a hand-over is for. A status
 * the chain does not know starts from the top. `chain` lets a caller pass the
 * tracker's real ordered statuses instead of the common ones.
 */
export function nextStatuses(kind: TrackerKind, now: string | undefined, chain: readonly string[] = CHAIN[kind]): string[] {
  const at = chain.findIndex((s) => lc(s) === lc(now ?? ""));
  const after = chain.slice(at + 1);
  const review = after.find((s) => /review/i.test(s));
  return (review ? [review, ...after.filter((s) => s !== review)] : after).slice(0, 3);
}

export type StatusTone = "done" | "review" | "progress" | "plain";

/** The colour a status pill takes: done and QA green, review blue, in progress amber, the rest grey. */
export function statusTone(status: string): StatusTone {
  const s = lc(status);
  if (/\b(done|qa|complete|closed|released)\b/.test(s)) return "done";
  if (/review/.test(s)) return "review";
  if (/progress|doing|started/.test(s)) return "progress";
  return "plain";
}

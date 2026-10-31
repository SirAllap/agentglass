// What a board card shows for each state, decided apart from the screen.
//
// The card (direction "Facet") has fixed slots: a verdict strip with one
// sentence, a ring that is the checks, a ticket row, three cells (Review,
// Branch, Changes), an event line and a footer with one primary action. Which
// words fill them, which colour speaks, which action is offered and why another
// one is greyed all follow from a handful of facts about the pull request, so
// the decision is here and the card only draws it. There is no renderer in this
// project, and a rule that lives only inside JSX is a rule nothing checks.
//
// What is reused rather than restated: the lane and its sentence (prLanes), the
// suggested press (suggestedAction), the tracker block rule (prCardBlock), the
// reviewers (cardReviewers) and the finished test (shared/prClosed).
//
// Ceilings, named so a gap is not mistaken for a choice: the list does not say
// whether auto-merge is on, whether the token can write, or how much a merged
// branch left on disk, so the card draws none of those states and the callers
// pass `readOnly` / `leftovers` only when they know them.
import { leftoverLine, offerFor, type LeftoverLine, type LeftoverState } from "./leftovers.ts";
import type { PrCheckRollup, PrSummary } from "../../../shared/types.ts";
import { finishedKind } from "../../../shared/prClosed.ts";
import { staleApproval } from "../../../shared/mergeBlockers.ts";
import { suggestedAction, type Filed } from "./prLanes.ts";
import type { TrackerBlock } from "./prCardBlock.ts";
import type { CardFace, CardReviewers } from "./cardReviewers.ts";
import { stalledDays } from "./prCardZones.ts";

/** What a card is, before anything about it is decided. */
export type CardKind = "finished" | "draft" | "open";

/** The card's own colour (`--st`): ring, strip wash, hover and selected outline. */
export type Tone = "ok" | "bad" | "run" | "info" | "merged" | "mute";

export type StripIcon = "merge" | "eye" | "ok" | "alert" | "clock" | "edit" | "x";

/** Whole days without a push or a comment after which the strip says so instead of "Waiting on". */
export const STALE_DAYS = 30;

/** Commits behind the base from which the Branch cell turns red: a few is routine, this many is a rebase. */
export const FAR_BEHIND = 20;

/** Faces the strip draws before the rest read as "+N": it shares its row with the sentence, the threads and the stack chip. */
export const STRIP_FACES = 2;

/** A count over this prints `99+`: a chip is two digits wide and never grows. */
export const COUNT_MAX = 99;
export const cap99 = (n: number): string => (n > COUNT_MAX ? `${COUNT_MAX}+` : String(n));

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export type PrimaryId = "review" | "merge" | "rerun" | "resolve" | "open" | "clean";
export interface Primary {
  id: PrimaryId;
  label: string;
  title: string;
  /** Busy turns the label into "Working…" and the button off. */
  disabled: boolean;
  tone: "prime" | "ok" | "warn" | "plain";
  /** Merge without write access: the button carries a lock and says why. */
  lock: boolean;
}

export interface Secondary {
  /** What pressing it asks the panel for; null is the quiet "Up to date" text or nothing. */
  id: "update" | "draft" | "open" | null;
  label: string;
  title: string;
  /** "Up to date" is drawn as text (not for a draft, a conflict or a finished one). */
  upToDate: boolean;
}

/** The ticket slot's shape, on top of the repository rule in prCardBlock. */
export type TrackerSlot = "card" | "loading" | "id" | "no-card" | "none" | "no-tracker";

export interface Ring {
  /** One segment per check. */
  green: number;
  red: number;
  running: number;
  /** `2 failing` | `9/12` | `no checks` | `closed`. */
  caption: string;
  /** `3 running` under the caption while a suite is out and nothing has failed. */
  sub: string | null;
  kind: "checks" | "none" | "reading";
  aria: string;
}

export interface Cell {
  label: "Review" | "Branch" | "Changes" | "Merged" | "Leftovers";
  tone: Tone;
  word: string;
  title: string;
}

export interface CardView {
  kind: CardKind;
  /** `#42 Title. Verdict.` */
  aria: string;
  tone: Tone;
  strip: { text: string; icon: StripIcon; threads: { text: string; title: string } | null };
  ring: Ring;
  /** The people drawn in the strip: two at most, then "+N". */
  stripFaces: { faces: CardFace[]; more: number };
  review: Cell & { faces: CardFace[]; more: number };
  branch: Cell;
  /** The third cell: Changes, or Leftovers for a merged one. */
  third: Cell & { add: number; del: number; addShare: number | null };
  /** A finished card's line about what is left on this computer; null when nobody asked or the answer is not in. */
  leftover: LeftoverLine | null;
  /** The merged card's second cell. */
  mergedInto: Cell | null;
  event: { text: string; empty: boolean };
  tracker: TrackerSlot;
  primary: Primary;
  secondary: Secondary;
  /** GitHub has not answered yet, or the app is asking git: shown as "checking", not as a conflict. */
  checking: boolean;
  behind: number | null;
  conflict: boolean;
  /** What ends the event line, in this order: your unpublished notes, the lock, the GitHub labels. */
  tail: {
    /** `3`, `99+`, `0`; open cards only: a finished one has nothing left to review. */
    notes: { text: string; n: number } | null;
    readOnly: boolean;
    labels: { first: string; more: number; all: string[] } | null;
  };
  /** Why an action the menu offers is off; null means it is on. */
  reasons: { merge: string | null; update: string | null; resolve: string | null; rerun: string | null };
}

/** `4210` -> `4.2k`: three digits are the most a cell holds. */
export const kFormat = (n: number): string => (n > 999 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** The tracker block with the "no tracker connected at all" case the mockup draws. */
export function trackerSlot(block: TrackerBlock, hasTaskProvider: boolean): TrackerSlot {
  if (block === "hint") return "no-card";
  if (block === "none") return hasTaskProvider ? "none" : "no-tracker";
  return block;
}

type Facts = Pick<PrSummary, "number" | "title" | "author" | "state" | "isDraft" | "headRefName" | "baseRefName" | "mergeable" | "reviewDecision" | "checks" | "humanReview">
  & Partial<Pick<PrSummary, "additions" | "deletions" | "changedFiles" | "openThreads" | "updatedAt" | "closed">>;

/**
 * The reason Merge is off, or null when it is on. The order is the order of
 * what would stop you: the pull request's own state, then the conflict that
 * nothing gets past, then the checks, then the missing approval.
 */
export function mergeReason(p: Pick<Facts, "state" | "isDraft" | "mergeable" | "reviewDecision" | "checks" | "baseRefName">): string | null {
  if (p.state === "MERGED") return "Already merged";
  if (p.state === "CLOSED") return "Closed";
  if (p.isDraft) return "Draft pull requests cannot merge";
  if (p.mergeable === "CONFLICTING") return `There is a conflict with ${p.baseRefName}`;
  if (p.checks.failure > 0) return "Checks are failing";
  if (p.checks.pending > 0) return "Checks are still running";
  if (p.reviewDecision !== "APPROVED") return "Not approved yet";
  return null;
}

/** The checks as the ring and its caption say them. */
function ringFor(c: Pick<PrCheckRollup, "total" | "success" | "failure" | "pending" | "skipped">, kind: CardKind, reading: boolean): Ring {
  if (reading) return { green: 0, red: 0, running: 0, caption: "", sub: null, kind: "reading", aria: "Reading the checks" };
  /* A skipped check is neither a pass nor a failure to act on: it fills its segment green. */
  const green = c.success + (c.skipped ?? 0), red = c.failure, running = c.pending;
  const n = green + red + running;
  if (n === 0) {
    const caption = kind === "finished" ? "closed" : "no checks";
    return { green, red, running, caption: kind === "finished" ? caption : "no checks", sub: null, kind: "none", aria: kind === "finished" ? "No checks ran" : "No checks yet" };
  }
  const caption = red ? `${red} failing` : running ? `${green}/${n}` : `${green}/${n}`;
  return {
    green, red, running, caption, sub: running && !red ? `${running} running` : null, kind: "checks",
    aria: `${green} passed, ${red} failed, ${running} running`,
  };
}

interface Verdict { text: string; tone: Tone; icon: StripIcon; reviewWord?: [string, Tone] }

/**
 * The sentence in the strip, and the colour that goes with it. `waiting` are
 * the people a review is still asked of; `mineAgain` is a review of yours that
 * a push has sent back.
 */
function verdictFor(p: Facts, filed: Filed, waiting: string[], o: { stale: boolean; approved: boolean; staleCounts: boolean; again: boolean; askedAgain: boolean; changes: string[]; quiet: number | null }): Verdict {
  if (p.state === "MERGED") return { text: "Merged", tone: "merged", icon: "merge" };
  if (p.state === "CLOSED") return { text: "Closed · not merged", tone: "mute", icon: "x" };
  if (p.isDraft) return { text: "Draft · not asked yet", tone: "mute", icon: "edit" };
  const conflict = p.mergeable === "CONFLICTING";
  if (conflict) {
    const f = p.checks.failure;
    return { text: f > 0 ? `Conflicts with ${p.baseRefName} · ${plural(f, "check")} failing` : `Conflicts with ${p.baseRefName}`, tone: "bad", icon: "alert" };
  }
  if (p.checks.failure > 0 && filed.lane !== "review") {
    const name = p.checks.failing?.[0]?.name;
    return { text: `${plural(p.checks.failure, "check")} failing${name ? ` · ${name}` : ""}`, tone: "bad", icon: "alert" };
  }
  /* AMBER IS FOR THE RE-REQUEST, NOT FOR TIME PASSING: while GitHub still counts the approval and nobody has been asked to look again, the merge box
     reads this green ("still counts"), and a card that read amber for commits alone said the opposite of it on the same pull request. */
  if (o.stale) {
    return o.staleCounts && !o.askedAgain
      ? { text: "Approved · new commits since", tone: "ok", icon: "ok", reviewWord: ["approved", "ok"] }
      : { text: "Approved · new commits since", tone: "run", icon: "alert", reviewWord: ["stale", "run"] };
  }
  if (filed.lane === "land") return { text: "Approved · ready to land", tone: "ok", icon: "ok" };
  if (filed.lane === "review") {
    if (o.again) return { text: `${p.author} pushed since your review`, tone: "info", icon: "eye", reviewWord: ["asked again", "info"] };
    return { text: `${p.author} wants your review`, tone: "info", icon: "eye" };
  }
  /* Changes asked for and not yet answered: the one state where the ball is with the author, and a quiet "nobody asked yet" over it would be false. */
  if (o.changes.length) {
    return { text: o.changes.length > 1 ? `${o.changes.length} reviewers asked for changes` : `${o.changes[0]} asked for changes`, tone: "bad", icon: "alert" };
  }
  /* Approved and nothing left but the checks: the card says so instead of "nobody asked", which the Review cell beside it would contradict. */
  if (o.approved && p.checks.pending > 0) return { text: "Approved · waiting for checks", tone: "run", icon: "clock" };
  if (o.quiet !== null && o.quiet >= STALE_DAYS) return { text: `No activity for ${o.quiet} days`, tone: "run", icon: "clock" };
  if (waiting.length === 1) return { text: `Waiting on ${waiting[0]}`, tone: "run", icon: "clock" };
  if (waiting.length > 1) return { text: `Waiting on ${waiting.length} reviewers`, tone: "run", icon: "clock" };
  /* A blocked card that is neither red nor conflicting (changes asked, say)
     keeps the sentence that filed it; with nothing else known, the plain fact. */
  return filed.lane === "blocked" ? { text: filed.reason, tone: "bad", icon: "alert" } : { text: "Open · nobody asked yet", tone: "mute", icon: "clock" };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The last-event line. The sentence that filed the card (`filed.reason`) is a
 * paragraph and lives in the tooltip; the line keeps what the mockup's keeps:
 * the failing test when one is known, the day it went quiet once it has, and
 * otherwise the strip's own words (the age follows in the card).
 */
function eventText(p: Facts, filed: Filed, strip: string, quiet: number | null): string {
  if (filed.test?.title) return filed.test.title;
  if (quiet !== null && quiet >= STALE_DAYS && p.updatedAt) {
    const d = new Date(p.updatedAt);
    return `nothing pushed or commented since ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  }
  return strip;
}

function reviewCell(p: Facts, r: CardReviewers, kind: CardKind, v: Verdict): Cell & { faces: CardFace[]; more: number } {
  const people = [...r.faces, ...r.more];
  const [word, tone] = v.reviewWord ?? reviewWord(people);
  /* Two faces fit beside the word; a third turns the row into one face and "+N". */
  const fit = people.length > 2 ? 1 : 2;
  return {
    label: "Review", tone, word,
    title: people.length ? people.map((f) => f.title).join("\n") : "Nobody has been asked to review",
    faces: people.slice(0, fit), more: Math.max(0, people.length - fit),
  };
}

function reviewWord(people: CardFace[]): [string, Tone] {
  if (!people.length) return ["nobody asked", "mute"];
  if (people.some((f) => f.state === "changes")) return ["changes", "bad"];
  const waiting = people.filter((f) => f.state === "await" || f.state === "again").length;
  if (waiting) return [`${waiting} waiting`, "run"];
  return people.some((f) => f.state === "approved") ? ["approved", "ok"] : ["commented", "mute"];
}

const PRIMARY: Record<PrimaryId, Omit<Primary, "disabled" | "lock">> = {
  review: { id: "review", label: "Review", title: "Open the review tab", tone: "prime" },
  merge: { id: "merge", label: "Merge", title: "Merge when ready", tone: "ok" },
  rerun: { id: "rerun", label: "Rerun failed", title: "Rerun only the failed checks", tone: "warn" },
  resolve: { id: "resolve", label: "Resolve conflicts", title: "Resolve the conflicts", tone: "warn" },
  open: { id: "open", label: "Open", title: "Open beside the board", tone: "plain" },
  clean: { id: "clean", label: "Clean up local leftovers", title: "Remove the worktree, branch and containers left on this computer", tone: "prime" },
};

/**
 * The one press the footer offers. Merged: clean up. Review lane: Review (or
 * Merge when `suggestedAction` knows the only step left is the button). Ready:
 * Merge. A conflict: Resolve. Red and not a draft: Rerun. Everything else: Open.
 */
function primaryFor(p: Facts, filed: Filed, kind: CardKind, busy: boolean, readOnly: boolean, clean: boolean): Primary {
  let id: PrimaryId;
  if (kind === "finished" && clean) id = "clean";
  else if (kind === "finished") id = "open";
  else if (suggestedAction(p, filed) === "merge") id = "merge";
  else if (filed.lane === "review") id = "review";
  else if (p.mergeable === "CONFLICTING") id = "resolve";
  else if (p.checks.failure > 0 && !p.isDraft) id = "rerun";
  else id = "open";
  const lock = id === "merge" && readOnly;
  return { ...PRIMARY[id], title: lock ? "Read-only: the token has no write access" : PRIMARY[id].title, disabled: busy || lock, lock };
}

/** The slot beside it: Mark ready on a draft, Open where nothing else moves, Update when behind, else the quiet "Up to date". */
function secondaryFor(p: Facts, kind: CardKind, behind: number | null, readOnly: boolean, primary: PrimaryId): Secondary {
  if (kind === "finished") return { id: null, label: "", title: "", upToDate: false };
  if (p.isDraft) return { id: "draft", label: "Mark ready", title: "Mark this draft ready for review", upToDate: false };
  if (readOnly || p.mergeable === "CONFLICTING") {
    return primary === "open" ? { id: null, label: "", title: "", upToDate: false }
      : { id: "open", label: "Open", title: "Open beside the board", upToDate: false };
  }
  if (behind && behind > 0) return { id: "update", label: `Update · ${behind}`, title: `Merge ${p.baseRefName} into ${p.headRefName}`, upToDate: false };
  return { id: null, label: "Up to date", title: "Nothing to update", upToDate: true };
}

function branchCell(p: Facts, kind: CardKind, behind: number | null, checking: boolean, behindAsked: boolean): Cell {
  const base = p.baseRefName;
  if (kind === "finished") return { label: "Branch", tone: "mute", word: "not merged", title: `Closed without merging into ${base}` };
  if (p.mergeable === "CONFLICTING") return { label: "Branch", tone: "bad", word: "conflict", title: `Conflicts with ${base}: nothing else can move until they are resolved` };
  if (checking) return { label: "Branch", tone: "mute", word: "checking", title: `GitHub has not worked out whether this conflicts with ${base} yet` };
  if (behind && behind > 0) {
    return {
      label: "Branch", tone: behind >= FAR_BEHIND ? "bad" : "run", word: `${behind} behind`,
      title: `${plural(behind, "commit")} on ${base} that this branch does not have: its checks ran against an older base`,
    };
  }
  if (behindAsked) return { label: "Branch", tone: "mute", word: "checking", title: "Working out how far behind its base this branch is" };
  return { label: "Branch", tone: "ok", word: "up to date", title: `Nothing on ${base} that this branch lacks` };
}

export function cardView(o: {
  p: Facts;
  filed: Filed;
  /** The people drawn on the card, from `cardReviewers(...)`. */
  reviewers: CardReviewers;
  /** Commits the base has that this branch lacks; null while unknown. */
  behind?: number | null;
  /** The app is asking git how far behind: the cell says "checking" rather than "up to date". */
  asking?: boolean;
  /** GitHub said UNKNOWN and the app is asking git. */
  checking?: boolean;
  /** The second pass (review, checks, tracker) has not landed: the card holds its shape and claims nothing. */
  reading?: boolean;
  busy?: boolean;
  tracker: TrackerBlock;
  hasTaskProvider: boolean;
  /** How many findings a local review left open on it; absent is no review, 0 a review with nothing open. */
  notes?: number;
  /** The pull request's GitHub labels, by name. */
  labels?: readonly string[];
  /** The token cannot write here; the list does not carry it, so a caller that does not know leaves it out. */
  readOnly?: boolean;
  /** What a merged pull request left on this computer, when somebody measured it. */
  leftovers?: string;
  /** The local inventory's answer for a merged one; absent (not asked) offers no cleanup. */
  leftoverState?: LeftoverState;
  /** A Clean up of it is running now. */
  cleaning?: boolean;
  now?: number;
}): CardView {
  const { p, filed } = o;
  const kind: CardKind = finishedKind(p) ? "finished" : p.isDraft ? "draft" : "open";
  const live = kind !== "finished";
  const behind = live ? o.behind ?? null : null;
  const conflict = live && p.mergeable === "CONFLICTING";
  const checking = live && !!o.checking && !conflict;
  const readOnly = !!o.readOnly;
  const waiting = o.reviewers.waiting.map((f) => f.login);
  const people = [...o.reviewers.faces, ...o.reviewers.more];
  const hr = p.humanReview;
  const quiet = live && p.updatedAt ? stalledDays(p.updatedAt, o.now) : null;
  const v = o.reading
    ? { text: "Reading the review", tone: "mute", icon: "clock" } satisfies Verdict
    : verdictFor(p, filed, waiting, {
      stale: live && !p.isDraft && hr?.kind === "approved" && hr.stale === true,
      approved: hr?.kind === "approved",
      staleCounts: !!staleApproval(p.reviewDecision).counts,
      again: !!hr?.mine && people.some((f) => f.state === "again"),
      askedAgain: people.some((f) => f.state === "again"),
      changes: people.filter((f) => f.state === "changes").map((f) => (hr?.mine ? "You" : f.login)),
      quiet,
    });
  /* Clean up is offered only once the local inventory found something (lib/leftovers.ts): not while it is read, not when it failed, not when there is nothing. */
  const offer = offerFor(o.leftoverState, "card");
  const clean = o.leftovers !== undefined || offer.button;
  const primary = primaryFor(p, filed, kind, !!o.busy || !!o.cleaning, readOnly, clean);
  const add = p.additions ?? 0, del = p.deletions ?? 0;
  const merged = p.state === "MERGED";
  const review = reviewCell(p, o.reviewers, kind, v);
  const changes: CardView["third"] = {
    label: "Changes", tone: "mute", word: `+${kFormat(add)} −${kFormat(del)}`,
    title: `${plural(p.changedFiles ?? 0, "file")} changed: +${add} −${del}`,
    add, del, addShare: add + del > 0 ? Math.round((add / (add + del)) * 100) : null,
  };
  const b = branchCell(p, kind, behind, checking, !!o.asking && behind === null);
  return {
    kind,
    aria: `#${p.number} ${p.title}. ${v.text}`,
    tone: v.tone,
    strip: {
      text: v.text, icon: v.icon,
      threads: live && (p.openThreads?.open ?? 0) > 0
        ? { text: cap99(p.openThreads!.open), title: `${p.openThreads!.open}${p.openThreads!.more ? "+" : ""} review ${p.openThreads!.open === 1 ? "thread" : "threads"} still unresolved` }
        : null,
    },
    ring: ringFor(p.checks, kind, !!o.reading),
    stripFaces: { faces: people.slice(0, STRIP_FACES), more: Math.max(0, people.length - STRIP_FACES) },
    review,
    branch: merged ? { label: "Merged", tone: "merged", word: `into ${p.baseRefName}`, title: `Merged into ${p.baseRefName}` } : b,
    third: changes,
    leftover: kind === "finished" ? leftoverLine(o.leftoverState, !!o.cleaning) : null,
    mergedInto: null,
    event: { text: eventText(p, filed, v.text, quiet), empty: false },
    tracker: trackerSlot(o.tracker, o.hasTaskProvider),
    primary,
    secondary: secondaryFor(p, kind, behind, readOnly, primary.id),
    checking,
    behind,
    conflict,
    tail: {
      notes: live && o.notes !== undefined ? { text: cap99(o.notes), n: o.notes } : null,
      readOnly,
      labels: o.labels?.length ? { first: o.labels[0]!, more: o.labels.length - 1, all: [...o.labels] } : null,
    },
    reasons: {
      merge: readOnly && !merged && kind !== "finished" ? "Read-only: no write access" : mergeReason(p),
      update: !live ? "This pull request is finished" : conflict ? "Resolve the conflict first"
        : behind && behind > 0 ? null : `Already up to date with ${p.baseRefName}`,
      resolve: conflict ? null : `No conflict with ${p.baseRefName}`,
      rerun: live && p.checks.failure > 0 ? null : "No failed checks",
    },
  };
}

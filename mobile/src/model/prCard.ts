/*
 * What a pull request's CARD says, decided apart from the screen.
 *
 * A row used to be a mark, two chips and a line. It is a card now, and the card
 * answers four questions in the order they decide whether it is opened: whose
 * move is it (the banner), is CI happy (the bar), what is it (title, author,
 * size), and what work is it for (the linked card). The words and the choices
 * are here so a test can hold them; the screen only paints.
 */
import type { PrMergeGate, PrSummary } from "../../../shared/types.ts";
import type { ProviderTask } from "../../../shared/providers.ts";
import { mergeBlockers, staleApproval } from "../../../shared/mergeBlockers.ts";
import { since } from "../lib/dates.ts";
import type { Tone } from "./prLook.ts";

/** Past this many commits behind, the branch word is red on the desktop too. */
export const FAR_BEHIND = 20;

/** How old a row's copy of its tracker card may be before it is re-read. The
 *  server fills it from a board cached on disk and accepts a day-old one. */
export const CARD_FRESH_MS = 5 * 60_000;

/** Is the row's tracker card a reading recent enough to draw as it stands? */
export function cardFresh(card: PrSummary["card"], now: number): boolean {
  // No reading time is no promise: it is re-read rather than presented as current.
  return typeof card?.at === "number" && now - card.at < CARD_FRESH_MS;
}

/**
 * The tracker a stale row is re-asked of, or null when it is not re-asked.
 *
 * A Jira card comes from the server's own Jira views, and asking for a key the
 * row already names can only come back empty: the desktop refuses it too
 * (`web/src/lib/prCardStore.ts`: `if (jira || …) return p`). Without that, a
 * board of twenty stale Jira cards spent twenty `/jira/find` requests on open
 * and twenty more on every pull, where the desktop made none.
 */
export function reaskDoor(card: PrSummary["card"], now: number = Date.now()): { tracker: "clickup"; id: string } | null {
  if (!card || cardFresh(card, now) || card.tracker === "jira") return null;
  const id = card.customId ?? card.id;
  return id ? { tracker: "clickup", id } : null;
}

export interface Banner {
  label: string;
  tone: Tone;
  /** The small text at the right edge, or null. */
  right: string | null;
}

/** "1 open thread", "3 open threads", "100+ open threads"; null when none. */
export function threadsLabel(pr: PrSummary): string | null {
  const t = pr.openThreads;
  if (!t || t.open <= 0) return null;
  return `${t.open}${t.more ? "+" : ""} open thread${t.open === 1 && !t.more ? "" : "s"}`;
}

/** "ada", "ada and bob", "ada, bob and 2 more". */
function names(who: readonly string[]): string {
  if (who.length <= 2) return who.join(" and ");
  return `${who[0]}, ${who[1]} and ${who.length - 2} more`;
}

/**
 * The strip across the top of the card: where the ball is.
 *
 * The verdict is the HUMANS' (`humanReview`), never `reviewDecision`, which
 * counts a bot's approval: a pull request one assistant had waved through
 * painted green beside a person's "changes requested". A bot approval reaches
 * this function only as `reviewDecision === "APPROVED"` with no human verdict,
 * and that is "waiting", never green.
 *
 * Order is what the reader needs first. A draft is nobody's problem, so it
 * outranks everything; then a person's block; then red CI (a red approved
 * pull request is not ready to land whatever was said); then the approval.
 */
export function bannerLook(pr: PrSummary, o: { forMe: boolean; unread?: number }): Banner {
  const newer = o.unread ? `${o.unread} new` : null;
  if (pr.isDraft) return { label: "Draft", tone: "neutral", right: newer };
  const human = pr.humanReview && typeof pr.humanReview === "object" && pr.humanReview.kind ? pr.humanReview : null;
  const threads = threadsLabel(pr);
  if (human?.kind === "changes") {
    return {
      label: `Changes requested by ${names(human.who) || "a reviewer"}`,
      tone: human.cleared ? "warn" : "bad",
      right: newer ?? threads,
    };
  }
  const { total, failure, pending } = pr.checks ?? { total: 0, failure: 0, pending: 0 };
  if (pr.checksLoaded !== false && failure > 0 && redBlocks(pr)) {
    return { label: "Checks failing", tone: "bad", right: newer ?? `${failure} of ${total}` };
  }
  if (human?.kind === "approved") {
    // GitHub's own word on whether the approval still counts, the same call the
    // desktop's strip makes (web/src/lib/prCardView.ts): a repository that keeps
    // approvals across pushes is green here and amber only where it drops them.
    // The sentence is the desktop's for both ("Approved · new commits since").
    if (human.stale && !staleApproval(pr.reviewDecision).counts) return { label: "Approved · new commits since", tone: "warn", right: newer };
    const ready = pr.checksLoaded !== false && pending === 0 && pr.mergeable !== "CONFLICTING";
    return { label: `Approved by ${names(human.who) || "a reviewer"}`, tone: "good", right: newer ?? (ready ? "ready to land" : null) };
  }
  if (human?.askedAgain) return { label: "Asked to look again", tone: "warn", right: newer };
  if (human?.kind === "commented") return { label: "Commented", tone: "neutral", right: newer };
  if (human?.kind === "awaiting") {
    if (o.forMe || human.mine) return { label: "Waiting on you", tone: "warn", right: newer };
    return { label: human.who.length ? `Waiting on ${names(human.who)}` : "Needs review", tone: "neutral", right: newer };
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { label: "Changes requested", tone: "bad", right: newer ?? threads };
  // Nothing from a person. Still being read is silence; read and empty means
  // nobody has looked, whatever a bot said.
  if (pr.checksLoaded === false) return { label: "Reading review…", tone: "neutral", right: newer };
  return { label: o.forMe ? "Waiting on you" : "Needs review", tone: o.forMe ? "warn" : "neutral", right: newer };
}

export type Seg = "ok" | "fail" | "run";

/** The widest bar that still has segments you can tell apart on a phone. */
export const MAX_SEGMENTS = 24;

/**
 * One segment per check, passed first, then failed, then running.
 *
 * The list row carries counts and not the checks themselves, so the ORDER of
 * the real checks is not known here and the bar sorts by state: how many of
 * each is the claim, and it is true. Above `MAX_SEGMENTS` the bar is scaled
 * down and every state that exists keeps at least one segment, so a single
 * failure among sixty never disappears. Null while the rollup has not landed
 * (the screen draws an empty track, which says nothing) and for no checks.
 */
export function ciSegments(pr: PrSummary): Seg[] | null {
  if (pr.checksLoaded === false || !pr.checks?.total) return null;
  const { total, failure, pending } = pr.checks;
  const fail = Math.min(failure, total);
  const run = Math.min(pending, total - fail);
  const ok = total - fail - run; // success and skipped: nothing is wrong there
  if (total <= MAX_SEGMENTS) return [...fill("ok", ok), ...fill("fail", fail), ...fill("run", run)];
  const scaled = (n: number): number => (n ? Math.max(1, Math.round((n * MAX_SEGMENTS) / total)) : 0);
  const f = scaled(fail);
  const r = scaled(run);
  return [...fill("ok", Math.max(0, MAX_SEGMENTS - f - r)), ...fill("fail", f), ...fill("run", r)];
}

const fill = (seg: Seg, n: number): Seg[] => Array.from({ length: n }, () => seg);

/**
 * What the board card's three cells say, decided here so the screen only paints.
 *
 * The mock draws the run as a ring with a fraction under it, the review as the
 * faces plus one word, and the branch as the one fact you act on. Each answer
 * is short because the tile is 111 wide.
 */
export interface Cell {
  word: string;
  tone: Tone;
}

/** The ring's fraction, and how far round it goes. */
/**
 * Does a red check stand in the way of the merge? The verdict is the shared
 * module's (`mergeBlockers`): a red check GitHub does not require is amber, as
 * on the desktop. What is unknown (a row naming fewer red checks than it
 * counts, or checks the server did not say were required) stays blocking.
 */
export function redBlocks(pr: PrSummary): boolean {
  const failure = pr.checks?.failure ?? 0;
  if (failure <= 0) return false;
  const named = pr.checks.failing ?? [];
  if (named.length !== failure || !named.every((c) => typeof c.required === "boolean")) return true;
  return mergeBlockers({
    state: "OPEN", mergeState: "", baseRefName: pr.baseRefName, checks: pr.checks, checksAll: named,
    gate: {} as PrMergeGate,
  }).some((b) => b.kind === "required-failing");
}

export function ciCount(pr: PrSummary): Cell & { pct: number } {
  if (pr.checksLoaded === false) return { word: "…", tone: "neutral", pct: 0 };
  const { total, success, skipped, failure, pending } = pr.checks;
  if (!total) return { word: "—", tone: "neutral", pct: 0 };
  const passed = success + skipped;
  const pct = Math.round(((total - failure - pending) / total) * 100);
  if (failure > 0) {
    const hard = redBlocks(pr);
    return hard ? { word: `${failure} failing`, tone: "bad", pct } : { word: `${failure} red · optional`, tone: "warn", pct };
  }
  if (pending > 0) return { word: `${passed}/${total}`, tone: "warn", pct };
  return { word: `${total}/${total}`, tone: "good", pct: 100 };
}

export function reviewCell(pr: PrSummary, forMe: boolean): Cell {
  if (pr.isDraft) return { word: "draft", tone: "neutral" };
  const human = pr.humanReview && typeof pr.humanReview === "object" && pr.humanReview.kind ? pr.humanReview : null;
  if (!human) {
    // Absent while the second pass is still out; null is a real "nobody".
    if (pr.humanReview === undefined && pr.checksLoaded === false) return { word: "reading…", tone: "neutral" };
    return { word: "nobody asked", tone: "neutral" };
  }
  if (human.kind === "changes") return { word: "changes", tone: human.cleared ? "warn" : "bad" };
  if (human.kind === "approved") {
    /* A stale approval GitHub still counts is approved: the merge box says
       "still counts" on the same pull request, and "out of date" beside it said
       the opposite of the thing that decides the merge. Amber is for the
       repository that drops approvals on a push, and its word is the desktop's
       ("stale", web/src/lib/prCardView.ts:207). */
    const counts = !human.stale || staleApproval(pr.reviewDecision).counts === true;
    return { word: counts ? "approved" : "stale", tone: counts ? "good" : "warn" };
  }
  if (human.kind === "commented") return { word: "commented", tone: "neutral" };
  const waiting = human.who.length || 1;
  return { word: `${waiting} waiting`, tone: forMe || human.mine ? "warn" : "neutral" };
}

/**
 * The branch cell: the one thing that stops a merge locally.
 *
 * The count comes from the compare the card asks for (`/prs/behind`, three at a
 * time, five minutes of memory — see state/pr-behind.ts), because "no conflict"
 * is not "0 behind": a branch 194 commits behind its base reported CLEAN where
 * the repository does not require it up to date. `asking` is the first look
 * still out and `failed` a compare that came back with nothing; neither is a
 * count, and neither is drawn as "up to date". A conflict outranks the count:
 * nothing else can move until it is resolved.
 *
 * `mergeable: "UNKNOWN"` is not a word of its own here: the desktop answers it
 * through its conflict store and says "up to date" once that has settled
 * (web/src/lib/prCardView.ts:342,349), and the same row has to read the same
 * word on both screens.
 *
 * The desktop's own compare store has the hole `failed` closes (it holds a
 * failure as `behind: null` and draws that as current); a card claiming a branch
 * 194 commits behind is not where to copy it.
 */
export function branchCell(pr: PrSummary, behind: number | null = null, asking = false, failed = false): Cell {
  if (pr.mergeable === "CONFLICTING") return { word: "conflict", tone: "bad" };
  if (behind === null) {
    return asking || failed
      ? { word: "checking", tone: "neutral" }
      : { word: "up to date", tone: "good" };
  }
  if (behind > 0) return { word: `${behind} behind`, tone: behind >= FAR_BEHIND ? "bad" : "warn" };
  return { word: "up to date", tone: "good" };
}

/** The faces on the review tile, and in the banner: people first, then whoever
 *  was asked. Teams have no face. */
export function facesOf(pr: PrSummary, most = 2): string[] {
  const people = pr.humanReview?.people?.filter((p) => !p.team).map((p) => p.login) ?? [];
  if (people.length) return people.slice(0, most);
  return (pr.reviewers ?? []).filter((r) => !r.isTeam).map((r) => r.login).slice(0, most);
}

/** The line under the tiles: what last happened, and how long ago. */
export function eventLine(pr: PrSummary, now: number): { what: string; when: string } {
  const human = pr.humanReview && typeof pr.humanReview === "object" && pr.humanReview.kind ? pr.humanReview : null;
  const at = human?.at ?? pr.updatedAt;
  const when = since(at, now);
  if (pr.isDraft) return { what: "Draft saved", when };
  if (human?.kind === "changes") return { what: human.mine ? "You asked for changes" : "Changes requested", when };
  if (human?.kind === "approved") return { what: human.stale ? "Approved · new commits" : `Approved by ${human.who[0] ?? "a reviewer"}`, when };
  if (human?.kind === "commented") return { what: "Commented", when };
  if (human?.kind === "awaiting") return { what: "Asked for a review", when };
  return { what: "Pushed", when };
}

/** The share of the change bar that is green: additions over the whole diff. */
export function changesShare(pr: PrSummary): number {
  const all = pr.additions + pr.deletions;
  return all > 0 ? pr.additions / all : 0;
}

/** The card as a row draws it: what `PrSummary.card` carries, and nothing more. */
export type CardLine = NonNullable<PrSummary["card"]>;

/** How many faces the card line draws. */
export const CARD_FACES = 3;

export function cardLineOf(
  t: Pick<ProviderTask, "id" | "customId" | "title" | "url" | "status" | "statusColor" | "statusKind" | "priority" | "people">,
  tracker: "clickup" | "jira" = "clickup",
): CardLine {
  return {
    id: t.id, customId: t.customId, title: t.title, url: t.url,
    status: t.status, statusColor: t.statusColor, statusKind: t.statusKind,
    priority: t.priority, people: t.people?.slice(0, CARD_FACES),
    // Absent for ClickUp, so every row that had a card reads as it did.
    ...(tracker === "jira" ? { tracker: "jira" as const } : null),
  };
}

/** What a row says about its card. `asking`: the free lookup is out, draw a
 *  skeleton. `look`: the id is known and nothing cached has it, so one request
 *  is offered on demand. `none`: there is no card to find. */
export type CardState =
  | { kind: "card"; card: CardLine }
  | { kind: "asking" }
  | { kind: "look"; query: string }
  | { kind: "finding"; query: string }
  | { kind: "missed"; query: string }
  | { kind: "none" };

/** What the lookups hold for one id, see cardLookup.ts. */
export type Looked =
  | { phase: "where" }
  | { phase: "missed" }
  | { phase: "finding" }
  | { phase: "card"; card: CardLine }
  | { phase: "failed" };

/**
 * The card line's state, as one decision.
 *
 * The row's own `card` comes free off the server's cached boards and wins —
 * unless it is older than five minutes, where the desktop re-asks the tracker
 * (`web/src/lib/prCardStore.ts`): the server's copy is accepted up to a day old,
 * and a card moved this morning drew its old status all day. What this session
 * read is then drawn instead, and the row's copy stays up while the re-ask is
 * out, because a stale status is worse than a fresh one and better than none.
 *
 * With no card at all, a branch or title naming an id is looked up in those same
 * boards (`/clickup/where`, no ClickUp request), and only when that misses is a
 * per-card request (`/clickup/find`) offered — never made on its own. `query` is
 * null when the row names no card, or no tracker is connected.
 */
export function cardState(
  pr: Pick<PrSummary, "card">,
  query: string | null,
  looked: Looked | null,
  now: number = Date.now(),
): CardState {
  const stale = !!pr.card && !cardFresh(pr.card, now);
  if (looked?.phase === "card" && (stale || !pr.card)) return { kind: "card", card: looked.card };
  if (pr.card) return { kind: "card", card: pr.card };
  if (!query) return { kind: "none" };
  if (!looked || looked.phase === "where") return { kind: "asking" };
  if (looked.phase === "card") return { kind: "card", card: looked.card };
  if (looked.phase === "finding") return { kind: "finding", query };
  return looked.phase === "failed" ? { kind: "missed", query } : { kind: "look", query };
}

/**
 * The tab's "All" count, which the server does not send (`/prs/counts` answers
 * Review and Mine only). It is what the list itself says: the sum of the
 * repositories' own `total` when every one gave it, else the rows loaded — and
 * only when nothing is left to load, because "9" over a list with a next page
 * would be a wrong number said with confidence. Null draws no number.
 */
export function allCount(groups: readonly { items: readonly unknown[]; total?: number; hasNext?: boolean }[]): number | null {
  if (!groups.length) return null;
  if (groups.every((g) => typeof g.total === "number")) return groups.reduce((n, g) => n + (g.total ?? 0), 0);
  if (groups.some((g) => g.hasNext)) return null;
  return groups.reduce((n, g) => n + g.items.length, 0);
}

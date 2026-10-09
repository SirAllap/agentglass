/*
 * What a pull request's CARD says, decided apart from the screen.
 *
 * A row used to be a mark, two chips and a line. It is a card now, and the card
 * answers four questions in the order they decide whether it is opened: whose
 * move is it (the banner), is CI happy (the bar), what is it (title, author,
 * size), and what work is it for (the linked card). The words and the choices
 * are here so a test can hold them; the screen only paints.
 */
import type { PrSummary } from "../../../shared/types.ts";
import type { ProviderTask } from "../../../shared/providers.ts";
import type { Tone } from "./prLook.ts";

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
  if (pr.checksLoaded !== false && failure > 0) {
    return { label: "Checks failing", tone: "bad", right: newer ?? `${failure} of ${total}` };
  }
  if (human?.kind === "approved") {
    if (human.stale && pr.reviewDecision !== "APPROVED") return { label: "Approval out of date", tone: "warn", right: newer };
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

/** The card as a row draws it: what `PrSummary.card` carries, and nothing more. */
export type CardLine = NonNullable<PrSummary["card"]>;

/** How many faces the card line draws. */
export const CARD_FACES = 3;

export function cardLineOf(t: Pick<ProviderTask, "id" | "customId" | "title" | "url" | "status" | "statusColor" | "statusKind" | "priority" | "people">): CardLine {
  return {
    id: t.id, customId: t.customId, title: t.title, url: t.url,
    status: t.status, statusColor: t.statusColor, statusKind: t.statusKind,
    priority: t.priority, people: t.people?.slice(0, CARD_FACES),
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
 * The row's own `card` comes free off the server's cached boards and wins. With
 * none, a branch or title naming an id is looked up in those same boards
 * (`/clickup/where`, no ClickUp request), and only when that misses is a
 * per-card request (`/clickup/find`) offered — never made on its own, because
 * twenty rows of misses would be twenty requests on a token shared with real
 * work. `query` is null when the row names no card, or no tracker is connected.
 */
export function cardState(pr: Pick<PrSummary, "card">, query: string | null, looked: Looked | null): CardState {
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

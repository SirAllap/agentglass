/*
 * The conversation of a pull request as the rail draws it, decided apart from
 * the screen.
 *
 * Order and grouping are the desk's (shared/prTimeline.ts): a review carries
 * the line threads it was submitted with, commits that land back to back are
 * one entry, events sit between remarks by time. The words of an event are the
 * desk's too (shared/prEventLine.ts). What is decided here is what only a phone
 * decides: a review is a one-line verdict and, when it has words, a bubble; an
 * event is a quiet line with a glyph; and which rows the Humans / Bots split
 * keeps. The counts above that split are NOT these rows — they stay
 * `countLanes`, the number the desk shows, because events are not remarks and
 * Humans plus Bots must add up to All.
 */
import type {
  PrAuthorAssociation, PrComment, PrCommit, PrDetail, PrEvent, PrReaction, PrReview, PrThread,
} from "../../../shared/types.ts";
import { eventParts, type EventPart } from "../../../shared/prEventLine.ts";
import { at } from "../../../shared/prUnread.ts";
import { prTimeline, type TimelineItem } from "../../../shared/prTimeline.ts";
import type { Lane } from "../../../shared/prConversation.ts";

export type Tone = "neutral" | "good" | "bad" | "warn" | "accent";

/** Names of marks in nav/glyphs.tsx. Spelled here, not imported, so a model
 *  stays something a test can load without a renderer; a name that is not a
 *  glyph is a type error where a screen hands it to `Glyph`. */
export type Mark =
  | "refresh" | "commit" | "type" | "tag" | "people" | "eye" | "ok_circle" | "draft_circle" | "merge"
  | "x_circle" | "link" | "branch" | "clock" | "plus" | "alert" | "comment" | "circle";

export interface Bubble {
  author: string;
  isBot: boolean;
  /** Milliseconds; 0 when GitHub gave none. */
  at: number;
  body: string;
  /** What GitHub calls their standing (OWNER, MEMBER…), or "YOU"; null draws no badge. */
  badge: string | null;
  edited: boolean;
  reactions: { emoji: string; count: number; mine: boolean }[];
  /** A bot's comment boiled down to its point. */
  digest?: string | null;
  url?: string;
}

export type TalkRow =
  | { kind: "event"; key: string; convKeys: string[]; lane: Lane | "event"; at: number; glyph: Mark; tone: Tone; actor: string; parts: EventPart[]; url?: string }
  | { kind: "commits"; key: string; convKeys: string[]; lane: "event"; at: number; actor: string; commits: { short: string; message: string }[] }
  | { kind: "bubble"; key: string; convKeys: string[]; lane: Lane | "event"; bubble: Bubble; verdict: "approved" | "changes" | null }
  | { kind: "thread"; key: string; convKeys: string[]; lane: Lane | "event"; thread: PrThread };

const EMOJI: Record<string, string> = {
  THUMBS_UP: "👍", THUMBS_DOWN: "👎", LAUGH: "😄", HOORAY: "🎉", CONFUSED: "😕", HEART: "❤️", ROCKET: "🚀", EYES: "👀",
};

export function reactionsOf(rs: readonly PrReaction[] | undefined): Bubble["reactions"] {
  return (rs ?? []).filter((r) => r.count > 0).map((r) => ({ emoji: EMOJI[r.content] ?? "•", count: r.count, mine: r.viewerHasReacted }));
}

/** The little badge beside a name. "You" wins over what GitHub says of the
 *  account, because your own remark is how you find your place. A plain
 *  account with no standing draws none. */
export function badgeOf(assoc: PrAuthorAssociation | undefined, you: boolean | undefined): string | null {
  if (you) return "YOU";
  switch (assoc) {
    case "OWNER": case "MEMBER": case "COLLABORATOR": case "CONTRIBUTOR": return assoc;
    case "FIRST_TIME_CONTRIBUTOR": case "FIRST_TIMER": return "FIRST TIME";
    default: return null;
  }
}

/** Every kind of event, its mark and its tone. Only the mark and the tone: the
 *  sentence is shared. */
const EVENT_LOOK: Record<PrEvent["kind"], { glyph: Mark; tone: Tone }> = {
  "force-push": { glyph: "refresh", tone: "warn" },
  commit: { glyph: "commit", tone: "neutral" },
  renamed: { glyph: "type", tone: "neutral" },
  labeled: { glyph: "tag", tone: "neutral" },
  unlabeled: { glyph: "tag", tone: "neutral" },
  assigned: { glyph: "people", tone: "neutral" },
  unassigned: { glyph: "people", tone: "neutral" },
  "review-requested": { glyph: "eye", tone: "neutral" },
  "review-request-removed": { glyph: "eye", tone: "neutral" },
  "ready-for-review": { glyph: "ok_circle", tone: "good" },
  "convert-to-draft": { glyph: "draft_circle", tone: "neutral" },
  merged: { glyph: "merge", tone: "accent" },
  closed: { glyph: "x_circle", tone: "bad" },
  reopened: { glyph: "ok_circle", tone: "good" },
  "cross-referenced": { glyph: "link", tone: "neutral" },
  milestoned: { glyph: "tag", tone: "neutral" },
  demilestoned: { glyph: "tag", tone: "neutral" },
  "head-ref-deleted": { glyph: "branch", tone: "neutral" },
  "auto-merge-enabled": { glyph: "clock", tone: "neutral" },
  "auto-merge-disabled": { glyph: "clock", tone: "neutral" },
};

const REVIEW_VERB: Partial<Record<PrReview["state"], { words: string; glyph: Mark; tone: Tone }>> = {
  APPROVED: { words: " approved these changes", glyph: "ok_circle", tone: "good" },
  CHANGES_REQUESTED: { words: " requested changes", glyph: "x_circle", tone: "bad" },
  COMMENTED: { words: " reviewed", glyph: "eye", tone: "neutral" },
  DISMISSED: { words: "'s review was dismissed", glyph: "eye", tone: "neutral" },
};

const laneOf = (isBot: boolean): Lane => (isBot ? "bots" : "humans");

function commentBubble(c: PrComment): Bubble {
  return {
    author: c.author, isBot: c.isBot, at: at(c.createdAt), body: c.body,
    badge: badgeOf(c.association, c.viewerDidAuthor), edited: !!c.editedAt,
    reactions: reactionsOf(c.reactions), digest: c.digest, url: c.url,
  };
}

function reviewBubble(r: PrReview): Bubble {
  return {
    author: r.author, isBot: r.isBot, at: at(r.submittedAt), body: r.body,
    badge: badgeOf(r.association, r.viewerDidAuthor), edited: !!r.editedAt,
    reactions: reactionsOf(r.reactions), url: r.url,
  };
}

type Source = Pick<PrDetail, "reviews" | "comments" | "threads" | "timeline" | "commits" | "author" | "headRefName" | "baseRefName" | "createdAt">;

/**
 * Every row of the rail, oldest first, opened line first.
 *
 * `convKeys` are the keys `conversation()` gives the same things, so the
 * "new since you last looked" marks (which are computed over that list) land on
 * the row that holds them.
 */
export function talkRows(d: Source): TalkRow[] {
  const out: TalkRow[] = [];
  if (d.author) {
    out.push({
      kind: "event", key: "opened", convKeys: [], lane: "event", at: at(d.createdAt), glyph: "plus", tone: "neutral", actor: d.author,
      parts: [
        { text: d.author, as: "who" }, { text: " opened this from " },
        { text: d.headRefName, as: "code" }, { text: " into " }, { text: d.baseRefName, as: "code" },
      ],
    });
  }
  for (const item of prTimeline(d)) out.push(...rowsOf(item, d));
  return out;
}

function rowsOf(item: TimelineItem, d: Source): TalkRow[] {
  switch (item.kind) {
    case "event": {
      const look = EVENT_LOOK[item.event.kind] ?? { glyph: "commit" as Mark, tone: "neutral" as Tone };
      return [{
        kind: "event", key: item.key, convKeys: [], lane: "event", at: item.ms, glyph: look.glyph, tone: look.tone,
        actor: item.event.actor, parts: eventParts(item.event), url: item.event.url,
      }];
    }
    case "commits": {
      const first: PrCommit | undefined = item.commits[0];
      return [{
        kind: "commits", key: item.key, convKeys: [], lane: "event", at: item.ms, actor: first?.author ?? "",
        commits: item.commits.map((c) => ({ short: c.short, message: c.message })),
      }];
    }
    case "comment":
      return [{
        kind: "bubble", key: item.key, convKeys: [`comment-${item.comment.id}`], lane: laneOf(item.comment.isBot),
        bubble: commentBubble(item.comment), verdict: null,
      }];
    case "thread":
      return [{ kind: "thread", key: item.key, convKeys: [`thread-${item.thread.id}`], lane: laneOf(!!item.thread.comments[0]?.isBot), thread: item.thread }];
    case "review": {
      const r = item.review;
      const own = `review-${d.reviews.indexOf(r) + 1}`;
      const threadKeys = item.threads.map((t) => `thread-${t.id}`);
      const lane = laneOf(r.isBot);
      const verb = REVIEW_VERB[r.state] ?? REVIEW_VERB.COMMENTED!;
      const rows: TalkRow[] = [{
        kind: "event", key: `${item.key}-line`, convKeys: [own, ...threadKeys], lane, at: item.ms, glyph: verb.glyph, tone: verb.tone,
        actor: r.author, parts: [{ text: r.author, as: "who" }, { text: verb.words }], url: r.url,
      }];
      if (r.body.trim()) {
        rows.push({
          kind: "bubble", key: item.key, convKeys: [own], lane, bubble: reviewBubble(r),
          verdict: r.state === "APPROVED" ? "approved" : r.state === "CHANGES_REQUESTED" ? "changes" : null,
        });
      }
      for (const t of item.threads) {
        rows.push({ kind: "thread", key: `t${t.id}`, convKeys: [`thread-${t.id}`], lane, thread: t });
      }
      return rows;
    }
  }
}

/** The rows a lane keeps. Events belong to no voice, so only All shows them;
 *  a review's verdict line has a voice (whose review it is) and stays with it. */
export function rowsIn(rows: readonly TalkRow[], lane: Lane): TalkRow[] {
  if (lane === "all") return [...rows];
  return rows.filter((r) => r.lane === lane);
}

/** Where the "N new" line goes: above the first row that holds the first new
 *  remark, or -1. */
export function dividerAt(rows: readonly { convKeys: readonly string[] }[], dividerBefore: string | null): number {
  if (!dividerBefore) return -1;
  return rows.findIndex((r) => r.convKeys.includes(dividerBefore));
}

/** Whether a row holds something new. */
export function isFresh(row: { convKeys: readonly string[] }, keys: ReadonlySet<string> | undefined): boolean {
  return !!keys && row.convKeys.some((k) => keys.has(k));
}

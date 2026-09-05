// One timeline for a card: what people said, and what happened to it.
//
// The tab used to be Comments and hold only the conversation, which left the other
// half of a card's story — who opened it, when, and how it moved through the board
// — available only by opening the website. Asked for as: "I would like to see all
// those details that show up in activity… they should not count as comments, but
// they are there as a history of what happened".
//
// Two rules come straight from ClickUp's own Activity pane, and both matter more
// than they look:
//
//   the count stays comments. A card with four comments and thirty status changes
//   is a card with four comments. The number on the tab is what somebody scans a
//   board with, and inflating it with automation would make it useless.
//
//   a RUN of events folds. ClickUp collapses consecutive history rows behind "Show
//   more" and it is not decoration: a bug card opens with fifteen "set field X"
//   rows before the first sentence a person wrote, and unfolded they push the
//   conversation off the screen. "That way the scroll does not get huge and you go
//   straight to what matters, which is the comments."
//
// Everything here is pure: it takes the detail the panel already fetched and
// returns what to draw, so what folds and what does not is testable without a DOM.

import type { CardEvent } from "../../../shared/providers.ts";

/** A comment, as the card detail carries it. Structural only — this file never
 *  looks inside the text. */
export interface ActivityComment {
  id: string;
  at: number;
}

export type ActivityRow<C extends ActivityComment> =
  /** Somebody speaking. Always drawn, never folded. */
  | { kind: "comment"; at: number; comment: C }
  /**
   * A run of consecutive events with nothing said between them.
   *
   * One row rather than N, so the fold is a property of the timeline rather than
   * something the rendering has to work out as it goes. A run of ONE is still a
   * run — see `foldFrom`, which decides whether it is worth hiding.
   */
  | { kind: "events"; at: number; events: CardEvent[]; id: string };

/**
 * How many consecutive events it takes before they are worth hiding.
 *
 * Two, which is ClickUp's own rule and his call: it folds a run of two the same as
 * a run of fifteen. I had put it at three on the theory that two lines are not a
 * wall — but the thing being protected is not the pixels, it is the SHAPE of the
 * column: comment, comment, comment, with the machinery behind one consistent
 * toggle. A rule that only sometimes applies makes the reader work out which case
 * they are looking at.
 */
export const FOLD_FROM = 2;

/**
 * Merge comments and events into one timeline, oldest first, with runs of events
 * grouped.
 *
 * Ties go to the EVENT: a comment that lands in the same second as a status change
 * is almost always the reason for it ("Triaged — P2 Normal" and the move to Ready
 * for engineering), and reading the move first is how that sentence makes sense.
 */
export function activityRows<C extends ActivityComment>(
  comments: readonly C[],
  events: readonly CardEvent[],
): ActivityRow<C>[] {
  const out: ActivityRow<C>[] = [];
  const cs = [...comments].sort((a, b) => a.at - b.at);
  const es = [...events].sort((a, b) => a.at - b.at);
  let i = 0, j = 0;
  while (i < cs.length || j < es.length) {
    const c = cs[i], e = es[j];
    const takeEvent = e !== undefined && (c === undefined || e.at <= c.at);
    if (takeEvent) {
      const last = out[out.length - 1];
      if (last?.kind === "events") last.events.push(e!);
      // The id is the run's first event, which is stable across a re-fetch — an
      // index would move the moment anything new arrived and take an open fold
      // with it.
      else out.push({ kind: "events", at: e!.at, events: [e!], id: `e${e!.at}-${e!.kind}` });
      j++;
    } else {
      out.push({ kind: "comment", at: c!.at, comment: c! });
      i++;
    }
  }
  return out;
}

/** Whether this run is drawn folded until somebody asks for it. */
export function folds<C extends ActivityComment>(row: ActivityRow<C>): boolean {
  return row.kind === "events" && row.events.length >= FOLD_FROM;
}

/** What the tab says. Comments only — see the note at the top of this file. */
export function activityCount<C extends ActivityComment>(comments: readonly C[]): number {
  return comments.length;
}

/** The sentence for one event. Never names who moved a card: the API does not say,
 *  and inventing a person there is an accusation. */
export function eventLine(e: CardEvent): string {
  /* What a ClickUp notification said about this card on this machine. The API
     reports no assignment and no follower — the notification does, by name —
     so this is the only place those ever appear, and it says where it came
     from rather than passing itself off as history the API gave us. */
  if (e.kind === "seen") return (e.text ?? "").trim() || "Something happened to this card";
  if (e.kind === "created") {
    const who = e.who || "Somebody";
    return e.status ? `${who} created this card in ${e.status}` : `${who} created this card`;
  }
  return e.from ? `Moved from ${e.from} to ${e.status}` : `Moved to ${e.status}`;
}

/** "3 changes" / "1 change" — what the fold offers to open. */
export function foldLabel(n: number): string {
  return `${n} ${n === 1 ? "change" : "changes"}`;
}

/**
 * How long the card sat somewhere, in the shortest true form.
 *
 * ClickUp counts minutes; a card that spent four days in QA reads as `5760`,
 * which is a number nobody converts in their head. Days lose the minutes on
 * purpose — at that scale nobody is asking about them, and "4d 3h" beside a
 * status pill is longer than the pill.
 */
export function spanLabel(mins: number): string {
  const m = Math.max(0, Math.round(mins));
  if (!m) return "";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/**
 * WHY A STATUS ROW HAS NO NAME ON IT, said once instead of guessed at.
 *
 * Measured against the real API on 2026-09-01 with a personal token:
 * `/task/{id}/history` and `/task/{id}/activity` are 404 on v1 and v2, and the
 * v1 route ClickUp's own web client uses answers `JWT_008 — Auth header
 * missing`: it wants a browser session, not an API key. So the people the API
 * will name are the card's creator and whoever wrote each comment, and nobody
 * else. Saying that where the rows are is the difference between a gap and a
 * bug in the reader's mind.
 */
export const NO_AUTHOR_NOTE =
  "ClickUp's API does not say who moved a card — only its creation and its comments carry a name.";


/**
 * WHO A "SEEN HERE" LINE IS ABOUT.
 *
 * ClickUp writes its notifications as a sentence that starts with the person:
 * "Irra assigned this task to: javi", "javi set the status to: READY FOR QA".
 * The API never says who did anything, so this sentence is the only place a
 * name appears — and a name deserves the same face the creation row gets.
 *
 * Split on the verb rather than on the first word: names have two and three
 * parts ("Alejandro Garcia assigned this task to you"), and a first-word rule
 * would put "Alejandro" beside a face belonging to somebody else.
 */
const SEEN_VERBS = [
  "assigned", "unassigned", "set", "moved", "commented", "mentioned", "added",
  "removed", "changed", "completed", "reopened", "attached", "shared", "created",
];

export function seenActor(text: string): { who: string; rest: string } {
  const line = (text || "").trim();
  if (!line) return { who: "", rest: "" };
  const words = line.split(/\s+/);
  /* A name is at most three words here; beyond that this is a sentence that
     does not start with one, and guessing would put a face on the wrong row. */
  for (let n = 1; n <= Math.min(3, words.length - 1); n++) {
    const verb = words[n]?.toLowerCase().replace(/[^a-z]/g, "");
    if (verb && SEEN_VERBS.includes(verb)) {
      return { who: words.slice(0, n).join(" "), rest: words.slice(n).join(" ") };
    }
  }
  return { who: "", rest: line };
}

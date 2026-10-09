// Who the board card's header band shows a face for, as decisions rather than
// as markup: which people, in which order, how many are drawn, what the
// tooltip says and how the sentence reads for one, two or five of them.
//
// The server's `humanReview.people` is the source (see `humanVerdict`): every
// person asked or heard from, one entry each. A server older than that field
// sends only `who` and `kind`, so the faces are derived from those instead of
// vanishing: the same people the band named before, with the state its kind
// implies.
//
// What this does not know, because the list does not carry it: when somebody
// was asked ("asked 23h ago") and how many threads each person has open. Those
// stay in the pull request's own page.
import type { PrSummary, ReviewPerson } from "../../../shared/types.ts";

type State = ReviewPerson["state"];

/** Faces drawn before the rest collapse into a "+N" pill. */
export const CARD_FACES_MAX = 3;

/** Blocking first, then the ball back with someone, then not answered, then done. */
const RANK: Record<State, number> = { changes: 0, again: 1, await: 2, approved: 3, comment: 4 };

const SAID: Record<State, string> = {
  again: "re-review requested",
  await: "review requested, not answered yet",
  changes: "changes requested",
  approved: "approved",
  comment: "commented",
};

export interface CardFace {
  login: string;
  state: State;
  team: boolean;
  /** "<login> — <state>": the native tooltip. */
  title: string;
}

export interface CardReviewers {
  /** At most `CARD_FACES_MAX`, in reading order. */
  faces: CardFace[];
  /** The rest, behind the "+N" pill. */
  more: CardFace[];
  /** Asked and not answered (a re-request counts): the people a sentence is about. */
  waiting: CardFace[];
}

const isState = (s: unknown): s is State => typeof s === "string" && s in RANK;

const face = (login: string, state: State, team: boolean): CardFace =>
  ({ login, state, team, title: `${login}${team ? " (team)" : ""} — ${SAID[state]}` });

/** The wire shape is checked, not trusted: a row from an older server, a cached
 *  list or a half-built fixture must not turn a version skew into a blank view. */
export function cardReviewers(raw: unknown): CardReviewers {
  const hr = raw && typeof raw === "object" ? raw as Partial<NonNullable<PrSummary["humanReview"]>> : null;
  const list: CardFace[] = [];
  const seen = new Set<string>();
  const add = (login: unknown, state: State, team = false) => {
    if (typeof login !== "string" || !login || seen.has(login.toLowerCase())) return;
    seen.add(login.toLowerCase());
    list.push(face(login, state, team));
  };
  if (hr && Array.isArray(hr.people)) {
    for (const p of hr.people as Partial<ReviewPerson>[]) if (p && isState(p.state)) add(p.login, p.state, p.team === true);
  } else if (hr && Array.isArray(hr.who)) {
    const state: State | null = hr.kind === "awaiting" ? "await" : hr.kind === "approved" ? "approved"
      : hr.kind === "commented" ? "comment" : hr.kind === "changes" ? (hr.cleared ? "again" : "changes") : null;
    if (state) for (const l of hr.who) add(l, state);
  }
  // Array.prototype.sort is stable: inside one state the server's order stands.
  list.sort((a, b) => RANK[a.state] - RANK[b.state]);
  return {
    faces: list.slice(0, CARD_FACES_MAX),
    more: list.slice(CARD_FACES_MAX),
    waiting: list.filter((f) => f.state === "again" || f.state === "await"),
  };
}

/** "Waiting on 3 reviewers" once two or more owe an answer. One person keeps the
 *  band's own wording, which already names them; null means nothing to add. */
export function waitingLine(r: CardReviewers): string | null {
  return r.waiting.length >= 2 ? `Waiting on ${r.waiting.length} reviewers` : null;
}

/** The "+N" pill's tooltip: one person a line. */
export const moreTitle = (r: CardReviewers) => r.more.map((f) => f.title).join("\n");

/** For the band's accessible name: the faces are decoration, the words are not. */
export const facesAria = (r: CardReviewers) =>
  [...r.faces, ...r.more].map((f) => `${f.login} (${SAID[f.state]})`).join(", ");

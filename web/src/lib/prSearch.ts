import type { PrSummary } from "../../../shared/types.ts";
import { refKey, refToken } from "./prRefs.ts";

/**
 * The one heading over a search: how many cards are on screen, in the words a
 * person would use. The count is the length of the list that is drawn, never a
 * second number from somewhere else — a search once read "1 of 200" and "408
 * matches" over a single card, three counts for one list.
 */
export function resultsHeading(shown: number): string {
  return `${shown} ${shown === 1 ? "result" : "results"}`;
}

/**
 * Which rows a search is made of.
 *
 * Once GitHub has been asked (`answered`), the rows ARE its answer, whatever their
 * state, and the box's words are not applied to them a second time: GitHub
 * matches the body and the comments too, and a local title filter would drop
 * the hits it was asked to find. Before the answer, the open rows in hand are
 * narrowed live, which is free and replaced as soon as the answer lands.
 *
 * The swept rows are not an option for a search any more. The sweep walks a
 * scope page by page and keeps whatever the first pass of each page said, which
 * is a row with no checks and "+0 −0 · 0f" — and kept it for good, because a
 * sweep that finished is never walked again.
 */
export function searchPool<T>(o: { answered: boolean; answer: T[]; inHand: T[] }): T[] {
  return o.answered ? o.answer : o.inHand;
}

/** A row the second pass has not reached: its checks and its size are not known yet. */
export const stillReading = (p: Pick<PrSummary, "checksLoaded">): boolean => p.checksLoaded === false;

/*
 * What the box understands, and said where somebody types into it.
 *
 *   #19811 · 19811 · PR 19811 · pr#19811   one pull request, by number
 *   a GitHub login that appears on a loaded card   everything that person is involved in
 *   author:name · assignee:name · reviewer:name    exactly that role
 *   ORBIT-1042 (any case)                            the title, the description and the branch
 *   any other words                                  the title and the description
 *
 * Ceiling: a bare login is recognised only when a card in hand carries it, so a
 * colleague nobody has loaded yet needs `author:name` once.
 */
export const SEARCH_HINT = "Filter these, or press ⏎ to search every pull request: a number (#123), a card key (ORBIT-1042), author:name, assignee:name, reviewer:name, or words from the title";

const NUMBER = /^#?(\d+)$/;
const PR_NUMBER = /^(?:pr|pull)#?(\d+)$/i;
const PR_WORD = /^(?:pr|pull|pull-request)$/i;

/** A key:value token is a qualifier, whatever the key — those are not words. */
const isQualifier = (t: string) => t.indexOf(":") > 0;

/**
 * The free words of a box with the number written the way GitHub indexes it:
 * `#19811`, `PR 19811` and `pr#19811` are all `19811`.
 */
export function normalizeFree(text: string): string {
  const toks = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const nextIsNumber = i + 1 < toks.length && NUMBER.test(toks[i + 1]);
    if (PR_WORD.test(t) && nextIsNumber) continue;
    const m = NUMBER.exec(t) ?? PR_NUMBER.exec(t);
    out.push(m ? m[1] : t);
  }
  return out.join(" ");
}

/** The logins on the cards in hand: author, assignees, reviewers asked. */
export function knownLogins(rows: { author?: string; assignees?: string[]; reviewers?: { login: string }[] }[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.author) out.add(r.author.toLowerCase());
    for (const a of r.assignees ?? []) out.add(a.toLowerCase());
    for (const v of r.reviewers ?? []) out.add(v.login.toLowerCase());
  }
  return out;
}

/**
 * What the box asks GitHub. Qualifiers pass through untouched; of the free
 * words, a number is normalised and a bare known login (`name` or `@name`)
 * becomes `involves:name` — author, assignee, mentioned or commenting, which is
 * what "searching for a person" means. Pure; the server turns it into GitHub's
 * grammar (`searchExpr`).
 */
export function toServerQuery(query: string, logins: ReadonlySet<string> = new Set()): string {
  const toks = query.trim().split(/\s+/).filter(Boolean);
  const free = toks.filter((t) => !isQualifier(t));
  const words = normalizeFree(free.join(" ")).split(/\s+/).filter(Boolean)
    .map((w) => {
      const bare = w.replace(/^@/, "");
      if (logins.has(bare.toLowerCase())) return `involves:${bare}`;
      const key = refKey(w);
      return key ? refToken(key) : w;
    });
  return [...toks.filter(isQualifier), ...words].join(" ");
}

/** The login a box is about: a person qualifier's value, or a bare word that is a known login. */
export function personIn(query: string, logins: ReadonlySet<string> = new Set()): string | null {
  for (const t of query.trim().split(/\s+/).filter(Boolean)) {
    const m = /^(?:author|assignee|reviewer|reviewed-by|involves):"?([^"\s]+)"?$/i.exec(t);
    if (m) return m[1];
    const bare = t.replace(/^@/, "");
    if (!isQualifier(t) && logins.has(bare.toLowerCase())) return bare;
  }
  return null;
}

/**
 * The login a box is about when it is about NOTHING else: one token, a person
 * qualifier or a known login (what the `@` menu writes). "author:ana fix" is a
 * search that happens to name somebody, not a request for her board.
 */
export function singleLogin(query: string, logins: ReadonlySet<string> = new Set()): string | null {
  const t = query.trim();
  if (!t || /\s/.test(t)) return null;
  const person = personIn(t, logins);
  return person && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/.test(person) ? person : null;
}

/**
 * Why a card is in a search for a person, in the words the card would use:
 * every way that login appears on it. Null when none shows on the row (GitHub
 * matched a mention in the description, which a row does not carry).
 */
export function matchedAs(
  p: { author?: string; assignees?: string[]; reviewers?: { login: string }[]; talk?: { who: string }[] },
  login: string | null,
): string | null {
  if (!login) return null;
  const l = login.toLowerCase();
  const why: string[] = [];
  if (p.author?.toLowerCase() === l) why.push("author");
  if ((p.assignees ?? []).some((a) => a.toLowerCase() === l)) why.push("assignee");
  if ((p.reviewers ?? []).some((r) => r.login.toLowerCase() === l)) why.push("reviewer");
  if ((p.talk ?? []).some((t) => t.who.toLowerCase() === l)) why.push("commented");
  return why.length ? `${login}: ${why.join(", ")}` : null;
}

/** What a lane needs before its card's title starts wrapping, and the gap between lanes. */
export const LANE_MIN_PX = 268;
/**
 * The width an open lane has on the board, fixed. Measured as the lane's card
 * at a 2576 px window with three lanes open beside the folded review strip (780 px: nothing inside it wraps or
 * moves). The board is that wide whatever the window is: when the lanes do not
 * fit, the lane strip scrolls sideways a whole lane at a time instead of
 * squeezing each one toward LANE_MIN_PX.
 */
export const LANE_WIDTH_PX = 780;
export const LANE_GAP_PX = 10;
/**
 * How many result columns a wide panel gets. Not the board's lane count: a
 * board of five lanes put results at a fifth of a 2576 px panel, about 475 px,
 * narrower than the same card reads on the board when it has three lanes in
 * view (~760 px). Three keeps the card at the width the board gives it.
 */
export const RESULT_COLUMNS = 3;
/**
 * A column of search results: exactly as wide as a lane is when the board shows
 * `lanes` of them side by side in this panel, and never narrower than a lane's
 * floor. The card is the board's card, so it gets the board's width — squeezed
 * to a sixth of the panel its badges wrapped and nothing sat where it sits on
 * the board. One result is one card at that width; a wide panel gets as many
 * columns as the board has lanes, a narrow one fewer.
 */
export const resultColumn = (lanes: number): string =>
  `minmax(max(${LANE_MIN_PX}px, calc((100% - ${Math.max(0, lanes - 1) * LANE_GAP_PX}px) / ${Math.max(1, lanes)})), 1fr)`;

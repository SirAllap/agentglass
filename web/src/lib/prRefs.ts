import type { PrSummary } from "../../../shared/types.ts";

/*
 * A tracker reference (`ORBIT-1042`) typed into the pull request search.
 *
 * Teams put the card's key in the branch name, the title or the description,
 * and "which pull request is for this card" is the question the box gets most.
 * This reads GitHub's pull request text and nothing else: no tracker is asked.
 *
 * What finds it:
 *   the title and the description   GitHub's search, `"KEY" in:title,body`
 *                                   (see `searchExpr` on the server)
 *   the branch name                 `git ls-remote --heads` in the local clone,
 *                                   read once per key (`refBranchRows` on the
 *                                   server); GitHub's search cannot match part
 *                                   of a branch name, and branches are where a
 *                                   card key most reliably is
 *
 * Ceiling: 20 branches per key, and a clone with no `origin` finds none by
 * branch. The cards already in hand are also checked by branch, for free.
 */

/** Letters, a dash, digits: `ORBIT-1042`, any case. A key is short; a long word-dash-number is a slug. */
const REF = /^[A-Za-z][A-Za-z0-9]{1,9}-\d{1,9}$/;

/** The reference a single search word is, upper-cased the way trackers print it; null when it is not one. */
export function refKey(word: string): string | null {
  const w = word.trim();
  return REF.test(w) ? w.toUpperCase() : null;
}

/** Every reference among the free words of a box, in order, once each. */
export function refsIn(query: string): string[] {
  const out: string[] = [];
  for (const t of query.trim().split(/\s+/)) {
    if (!t) continue;
    const k = t.indexOf(":") > 0 ? (/^ref:/i.test(t) ? refKey(t.slice(4)) : null) : refKey(t);
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

/** The server's token for a reference; `searchExpr` turns it into GitHub's grammar. */
export const refToken = (key: string): string => `ref:${key}`;

const has = (text: string | undefined, key: string): boolean => !!text && text.toUpperCase().includes(key);

/**
 * Where a key shows on a row. `body` is what is left: GitHub returned the row
 * for the reference and neither the title nor the branch carries it, so the
 * description does (a row does not carry its description to check).
 */
export function refPlaces(p: Pick<PrSummary, "title" | "headRefName">, key: string): ("branch" | "title" | "body")[] {
  const out: ("branch" | "title" | "body")[] = [];
  if (has(p.headRefName, key)) out.push("branch");
  if (has(p.title, key)) out.push("title");
  return out.length ? out : ["body"];
}

/** Why a card is in a reference search, in the card's words: `ORBIT-1042 in branch, title`. */
export function refWhy(p: Pick<PrSummary, "title" | "headRefName">, keys: readonly string[]): string | null {
  if (!keys.length) return null;
  const parts = keys.map((k) => `${k} in ${refPlaces(p, k).join(", ")}`);
  return parts.join(" · ");
}

/**
 * GitHub's answer plus the rows in hand whose branch carries a key. The answer
 * keeps its order; branch-only hits follow it. Rows are de-duplicated by number.
 */
export function withBranchHits<T extends Pick<PrSummary, "number" | "headRefName">>(answer: T[], inHand: T[], keys: readonly string[]): T[] {
  if (!keys.length) return answer;
  const seen = new Set(answer.map((p) => p.number));
  const extra: T[] = [];
  for (const p of inHand) {
    if (seen.has(p.number) || !keys.some((k) => has(p.headRefName, k))) continue;
    seen.add(p.number);
    extra.push(p);
  }
  return extra.length ? [...answer, ...extra] : answer;
}

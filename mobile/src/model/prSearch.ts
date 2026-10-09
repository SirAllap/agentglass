/*
 * What the search box asks, and what it makes of the answer.
 *
 * The box used to filter the rows already loaded, so a pull request on page two
 * or a merged one could not be found from the phone. Now the words go to the
 * server as `q=` and GitHub searches the whole repository — title and body. What
 * GitHub's free text does NOT cover is what this app has always matched locally
 * (number, author, branch, reviewers), so the loaded rows that match by those
 * are kept beside the server's: losing "ada" or "#101" to get the body search
 * would be a step back.
 *
 * Ceiling: the local half reads only the rows of the list the tabs show, so an
 * author or a branch is found on the rows loaded, a title or a body anywhere.
 */
import type { PrSummary } from "../../../shared/types.ts";
import { prTextMatch } from "../../../shared/prSearch.ts";
import { stateQuery, type StateView } from "./prState.ts";

/** The words as the server should get them: "#101" is the number's digits. */
export function searchText(text: string): string {
  return text.trim().split(/\s+/).map((w) => w.replace(/^#+/, "")).filter(Boolean).join(" ");
}

/**
 * One page of one repository's list.
 *
 * A search looks through the whole repository, so it drops the Review / Mine
 * tab (`filter=all`) and asks for `state` as chosen (Any unless the person
 * picked one; see effectiveState). Without words it is the tab's own list.
 */
export function listPath(o: { root: string; tab: "mine" | "review" | "all"; state: StateView; text: string; after?: string | null }): string {
  const q = searchText(o.text);
  const parts = [
    `root=${encodeURIComponent(o.root)}`,
    `filter=${q ? "all" : o.tab}`,
    `state=${stateQuery(o.state)}`,
  ];
  if (q) parts.push(`q=${encodeURIComponent(q)}`);
  if (o.after) parts.push(`after=${encodeURIComponent(o.after)}`);
  return `/prs/list?${parts.join("&")}`;
}

/** The server's rows, then the browsed ones it did not return that match by
 *  number, author, branch or reviewer. One row per pull request number. */
export function withLocalMatches<T extends Pick<PrSummary, "number" | "title" | "author" | "headRefName" | "assignees" | "reviewers">>(
  found: readonly T[], browsed: readonly T[], text: string,
): T[] {
  const have = new Set(found.map((p) => p.number));
  return [...found, ...browsed.filter((p) => !have.has(p.number) && prTextMatch(p, text))];
}

export interface Piece { text: string; hit: boolean }

/** `text` cut into runs, the ones containing a searched word marked. Case is
 *  ignored, overlapping words merge, and a blank query is one plain run. */
export function highlight(text: string, query: string): Piece[] {
  const words = searchText(query).toLowerCase().split(" ").filter(Boolean);
  const low = text.toLowerCase();
  const spans: [number, number][] = [];
  for (const w of words) {
    for (let at = low.indexOf(w); at >= 0; at = low.indexOf(w, at + w.length)) spans.push([at, at + w.length]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  const out: Piece[] = [];
  let at = 0;
  for (const [a, b] of merged) {
    if (a > at) out.push({ text: text.slice(at, a), hit: false });
    out.push({ text: text.slice(a, b), hit: true });
    at = b;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out.length ? out : [{ text, hit: false }];
}

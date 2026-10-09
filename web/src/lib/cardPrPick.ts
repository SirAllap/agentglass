/**
 * Which pull request a card's row chip names, when the card has more than
 * one.
 *
 * A card worked on for a while collects several: a draft opened first, closed
 * again, then the real one. The row has room for one chip, so it has to pick,
 * and "most recently opened" is not "most worth showing" — a merged pull
 * request from last week is not what the row should lead with over the open
 * one from this morning. Open work wins, then a draft in progress, then what
 * already landed, then what did not. Ties within a state are broken by pull
 * request number, which is the only ordering `clickup/prs` gives this card:
 * the endpoint that lists them does not carry `updatedAt`, and asking GitHub
 * for it would be the per-row round trip this chip exists to avoid — see
 * cardPrStore.ts.
 */

import { inkFor } from "./contrast.ts";

export interface CardPr {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  url: string;
  author?: string;
  mine?: boolean;
}

function rank(p: CardPr): number {
  if (p.state === "OPEN" && !p.draft) return 0;
  if (p.draft) return 1;
  if (p.state === "MERGED") return 2;
  return 3; // CLOSED, or anything the API ever adds
}

/** Every pull request the card has, in the order the chip and its popover
 *  read them: open first, then draft, then merged, then closed; within each,
 *  your own before anyone else's, then newest number first. */
export function sortedCardPrs(prs: readonly CardPr[]): CardPr[] {
  return [...prs].sort((a, b) => rank(a) - rank(b) || Number(!!b.mine) - Number(!!a.mine) || b.number - a.number);
}

export type CardPrPick =
  | { kind: "none" }
  | { kind: "one"; pr: CardPr }
  | { kind: "many"; primary: CardPr; rest: CardPr[] };

/** The one decision the row chip needs: what to show, and what a click on it
 *  alone (no popover) should open. */
export function pickCardPr(prs: readonly CardPr[] | null | undefined): CardPrPick {
  if (!prs || !prs.length) return { kind: "none" };
  const sorted = sortedCardPrs(prs);
  if (sorted.length === 1) return { kind: "one", pr: sorted[0]! };
  return { kind: "many", primary: sorted[0]!, rest: sorted.slice(1) };
}

/** The chip's colour, off the same state a pull request is drawn in
 *  everywhere else this app shows one (`Detail`'s pull-request list in
 *  TasksPanel.tsx): open green, merged purple, closed red, and a draft — open
 *  in GitHub's own state machine but not yet asking for anything — grey like
 *  `PrPanel.tsx`'s `rowState` already draws it. No new colour, just the two
 *  house mappings this app already has for a pull request's state. */
export function cardPrTint(p: CardPr): string {
  if (p.draft) return "var(--text3)";
  if (p.state === "MERGED") return "#a371f7";
  if (p.state === "CLOSED") return "var(--error)";
  return "var(--success)";
}

let mergedInkCache: { key: string; ink: string } | null = null;

/** `#a371f7` on a light theme's chip fill is 3.35:1 — GitHub's own "Merged"
 *  purple, chosen for a dark background and never checked against a light
 *  one. The green and red chips are theme tokens already lifted once per
 *  theme in contrast.ts's inkTints; this literal is not, so it is lifted
 *  here instead, cached per background/text pair rather than per read. */
/** Exported for the two spots that draw the merged badge directly rather
 *  than through `cardPrTint`/`cardPrInk` (TasksPanel's own issue-linked pull
 *  request list). */
export function mergedInk(): string {
  if (typeof document === "undefined") return "#a371f7";
  const cs = getComputedStyle(document.documentElement);
  const bg = cs.getPropertyValue("--bg").trim();
  const text = cs.getPropertyValue("--text").trim();
  const key = `${bg}|${text}`;
  if (mergedInkCache?.key === key) return mergedInkCache.ink;
  const ink = bg && text ? inkFor("#a371f7", text, bg, 4.5) : "#a371f7";
  mergedInkCache = { key, ink };
  return ink;
}

/** The chip's TEXT colour — `cardPrTint`, guaranteed to clear 4.5:1 against
 *  the page it sits on. Fills stay `cardPrTint` as they are; only text reads
 *  through this. */
export function cardPrInk(p: CardPr): string {
  if (p.draft) return "var(--text3)";
  if (p.state === "MERGED") return mergedInk();
  if (p.state === "CLOSED") return "var(--error-ink)";
  return "var(--success-ink)";
}

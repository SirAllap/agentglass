/*
 * The PR board's multi-select and its bulk "Tell me when…", as decisions with no React in them.
 *
 * "Picked" is its own word on purpose: `selected` on the board already means "docked beside it" (TriageBoard's
 * `selected` prop), and the two must never read the same. Everything here is pure so the rules the mockup states —
 * a shift-click range stays inside one lane, a card some have is "mixed", Apply writes exactly what is on — are
 * tested rather than eyeballed (web/test/pr-bulk-pick.test.ts).
 */
import type { PrWatch, PrWatchSetItem } from "../../../shared/types.ts";

/** The three cards of "Tell me when…", in the order they are drawn. */
export type CardRule = "ci-pass" | "ci-fail" | "comment";
export const CARD_RULES: readonly CardRule[] = ["ci-pass", "ci-fail", "comment"];
export const RULE_WORDS: Record<CardRule, string> = { "ci-pass": "Everything is green", "ci-fail": "Something fails", comment: "Someone comments" };
/** What the bell tag on a card says: short, because the strip is already full on most cards. */
export const RULE_SHORT: Record<CardRule, string> = { "ci-pass": "Green", "ci-fail": "If it fails", comment: "Comments" };

export interface Anchor { n: number; lane: string }

/**
 * A press on a card's box (or on the card while anything is picked). Shift with an anchor in the same lane picks the
 * whole run between them, in the lane's own order; anything else toggles the one card and makes it the anchor.
 */
export function pickClick(picked: ReadonlySet<number>, anchor: Anchor | null, n: number, lane: string, laneOrder: readonly number[], shift: boolean): { picked: Set<number>; anchor: Anchor } {
  const next = new Set(picked);
  if (shift && anchor && anchor.lane === lane) {
    const a = laneOrder.indexOf(anchor.n), b = laneOrder.indexOf(n);
    if (a >= 0 && b >= 0) {
      for (const x of laneOrder.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(x);
      return { picked: next, anchor };
    }
  }
  if (next.has(n)) next.delete(n); else next.add(n);
  return { picked: next, anchor: { n, lane } };
}

export const allPicked = (picked: ReadonlySet<number>, nums: readonly number[]): boolean => nums.length > 0 && nums.every((n) => picked.has(n));

/** The lane header's "Select all" / "Clear lane". */
export function laneToggle(picked: ReadonlySet<number>, nums: readonly number[]): Set<number> {
  const next = new Set(picked);
  if (allPicked(picked, nums)) for (const n of nums) next.delete(n);
  else for (const n of nums) next.add(n);
  return next;
}

/** A picked PR that is no longer on the board (merged, closed) drops out; `left` is what the bar says once. */
export function keepOnBoard(picked: ReadonlySet<number>, onBoard: ReadonlySet<number>): { picked: Set<number>; left: number[] } {
  const left = [...picked].filter((n) => !onBoard.has(n));
  if (!left.length) return { picked: picked as Set<number>, left };
  return { picked: new Set([...picked].filter((n) => onBoard.has(n))), left };
}

/** The bar's note for a PR that left while picked: "#1051 merged, left". */
export function leftNote(n: number, state: string | undefined): string {
  const word = state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : "left the board";
  return word === "left the board" ? `#${n} left the board` : `#${n} ${word}, left`;
}

/** The card rules a PR has on now, in card order. A per-check rule is not a card and is not counted. */
export function cardRulesOf(ws: readonly PrWatch[]): CardRule[] {
  const on = new Set(ws.filter((w) => w.active).map((w) => w.rule.type));
  return CARD_RULES.filter((r) => on.has(r));
}

/** What the popover opens with: the cards every picked PR already has. A card only some have starts off, drawn mixed. */
export function startChosen(have: readonly (readonly CardRule[])[]): Set<CardRule> {
  return new Set(have.length ? CARD_RULES.filter((r) => have.every((h) => h.includes(r))) : []);
}

/** How one card is drawn. "mixed" only until it is pressed: after that it is plainly on or off, for all of them. */
export function cardState(r: CardRule, chosen: ReadonlySet<CardRule>, touched: ReadonlySet<CardRule>, have: readonly (readonly CardRule[])[]): "true" | "false" | "mixed" {
  if (chosen.has(r)) return "true";
  return !touched.has(r) && have.some((h) => h.includes(r)) ? "mixed" : "false";
}

/** How many of the picked PRs have a card on, and how many have this one. */
export const watchedCount = (have: readonly (readonly CardRule[])[]): number => have.filter((h) => h.length > 0).length;
export const haveCount = (r: CardRule, have: readonly (readonly CardRule[])[]): number => have.filter((h) => h.includes(r)).length;

/** What Apply writes: every picked PR ends with exactly the chosen cards. Mixed and untouched means off: applying
 *  replaces their choice, as the popover says. */
export function applyItems(prs: readonly { number: number; title: string }[], chosen: ReadonlySet<CardRule>): PrWatchSetItem[] {
  const rules = CARD_RULES.filter((r) => chosen.has(r)).map((type) => ({ type }));
  return prs.map((p) => ({ number: p.number, title: p.title, rules: rules.map((r) => ({ ...r })) }));
}

/** What Undo sends: each PR's rules from before Apply, written only if it still has exactly what Apply set
 *  (`expect`). A card pressed on one of them since is theirs, and Undo leaves that PR alone. */
export function undoItems(prev: readonly PrWatchSetItem[], set: readonly PrWatchSetItem[]): PrWatchSetItem[] {
  return prev.map((p) => ({ ...p, expect: (set.find((s) => s.number === p.number)?.rules ?? []).map((r) => ({ ...r })) }));
}

/** The toast after an Undo the server partly skipped: "Undone, except #7 (changed since)". */
export function undoSkippedLine(skipped: readonly number[]): string {
  return `Undone, except ${skipped.map((n) => `#${n}`).join(", ")} (changed since)`;
}

/** Apply has something to do: a card on, or a watch to take off. */
export const canApply = (chosen: ReadonlySet<CardRule>, watched: number): boolean => chosen.size > 0 || watched > 0;

export function footLine(chosen: ReadonlySet<CardRule>, n: number, watched: number): string {
  if (chosen.size) return `${CARD_RULES.filter((r) => chosen.has(r)).map((r) => RULE_WORDS[r]).join(" + ")}, on ${n}`;
  return watched ? `Nothing on: removes the watch from ${watched}` : "Pick at least one";
}

const prs = (n: number) => `${n} pull request${n === 1 ? "" : "s"}`;
export function toastLine(n: number, chosen: ReadonlySet<CardRule>): string {
  const on = CARD_RULES.filter((r) => chosen.has(r));
  if (!on.length) return `Stopped watching ${prs(n)}`;
  return `Watching ${prs(n)}: tell me when ${on.map((r) => RULE_WORDS[r].toLowerCase()).join(" or ")}`;
}

/** The bell tag on a card: "Green", "Green +1". Null draws no tag. */
export function bellTag(rules: readonly CardRule[]): string | null {
  if (!rules.length) return null;
  return rules.length > 1 ? `${RULE_SHORT[rules[0]!]} +${rules.length - 1}` : RULE_SHORT[rules[0]!];
}

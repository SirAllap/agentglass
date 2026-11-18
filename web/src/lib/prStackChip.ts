// What the stack chip on a card, the chain it lights and the list it opens say.
//
// The chip reads `L3 · 10 PRs`: this pull request's level (two on one base
// share a level), bottom first, and how many pull requests the stack holds,
// merged ones included, because the list it opens counts them too ("2 merged,
// 8 open") and two totals for one stack would be two answers. The spine on the older cards counted open tiers only; the chip
// is the one place the whole chain is counted.
//
// Ceiling: a base that is gone is known only for the nearest hop on each edge
// (prStack keeps one), so a chain with two merged bases under it counts one.
import type { Box, Stack } from "./prStack.ts";
import type { Facts } from "./prStackWords.ts";

export interface StackRow {
  number: number;
  /** 1-based place in the chain, bottom first. */
  pos: number;
  kind: Box["kind"];
  me: boolean;
}

/** Every numbered member, bottom first; a fork lists its branches by number. */
export function stackRows(s: Stack, me: number): StackRow[] {
  const rows: StackRow[] = [];
  /* The place is the depth of the tier, not the count of rows before it: two on
     one base share a depth instead of standing one behind the other. */
  let depth = 0;
  for (const tier of s.tiers) {
    const numbered = tier.filter((b) => b.number !== undefined);
    if (!numbered.length) continue;
    depth++;
    for (const b of numbered) rows.push({ number: b.number!, pos: depth, kind: b.kind, me: b.number === me });
  }
  return rows;
}

/** `L2 · 3 PRs`: the level is the depth of this tier, the count is every pull request in the stack. Two numbers, two words, so `2/3` is never read as "second of three". */
export const chipText = (rows: readonly StackRow[]): string => `L${rows.find((r) => r.me)?.pos ?? 1} · ${rows.length} PR${rows.length === 1 ? "" : "s"}`;

/** The mark on the root of a fork: `2 children`. Nothing when it has one child or none. */
export const forkMark = (children: readonly number[]): string | null => (children.length > 1 ? `${children.length} children` : null);

/** What a card alone in its column says about where it hangs: `on #1042 · sibling #1044`. Null when it has no base pull request. */
export function loneNote(base: number | null, siblings: readonly number[]): string | null {
  if (base === null) return null;
  return siblings.length ? `on #${base} · sibling #${siblings[0]}` : `on #${base}`;
}

/** "2 merged, 8 open" counts for the popover. */
export function stackCounts(rows: readonly StackRow[]): { merged: number; open: number } {
  const merged = rows.filter((r) => r.kind === "merged").length;
  return { merged, open: rows.length - merged };
}

export const chipAria = (rows: readonly StackRow[]): string => {
  const me = rows.find((r) => r.me)?.pos ?? 1;
  return `Stack, level ${me}, ${rows.length} pull request${rows.length === 1 ? "" : "s"}. Show the chain`;
};

export type RowTone = "ok" | "info" | "run" | "bad" | "merged" | "mute";

/** The state word beside a row, and the colour that goes with it. */
export function rowWord(r: StackRow, f: Facts | undefined): { word: string; tone: RowTone } {
  if (r.kind === "merged") return { word: "merged", tone: "merged" };
  if (r.kind === "closed") return { word: "closed", tone: "mute" };
  if (f?.draft || f?.lane === "flight") return { word: "draft", tone: "mute" };
  switch (f?.lane) {
    case "land": return { word: "ready", tone: "ok" };
    case "review": return { word: "review", tone: "info" };
    case "blocked": return { word: "blocked", tone: "bad" };
    case "others": return { word: "waiting", tone: "run" };
    default: return { word: "open", tone: "run" };
  }
}

/**
 * Which cards of a lane hang on the gutter rail, and to whom. A card hangs on
 * its base when that base is in the lane and only cards that hang on the same
 * base stand between them, so each child of a fork draws its own connector to
 * the base, and two siblings are never joined to each other. A card with a card
 * of another stack between it and its base draws no line, because a line that
 * crosses a card says the wrong thing.
 *
 * `to` is the card this one hangs on (null for the one at the bottom of the
 * rail); `down` says the line goes on under this card, to the next one.
 */
export function railLinks(
  lane: readonly number[], nextOf: (n: number) => readonly number[], posOf: (n: number) => number | undefined,
): Map<number, { pos: number; down: boolean; to: number | null }> {
  const to = new Map<number, number>();
  const seg = new Set<number>();
  lane.forEach((a, i) => {
    const kids = nextOf(a);
    for (let j = i + 1; j < lane.length && kids.includes(lane[j]!); j++) { to.set(lane[j]!, a); seg.add(j - 1); }
    for (let j = i - 1; j >= 0 && kids.includes(lane[j]!); j--) { to.set(lane[j]!, a); seg.add(j); }
  });
  const out = new Map<number, { pos: number; down: boolean; to: number | null }>();
  lane.forEach((n, i) => {
    if (!seg.has(i) && !seg.has(i - 1)) return;
    const pos = posOf(n);
    if (pos !== undefined) out.set(n, { pos, down: seg.has(i), to: to.get(n) ?? null });
  });
  return out;
}

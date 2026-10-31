// What the stack chip on a card, the chain it lights and the list it opens say.
//
// The chip reads `3/10`: this pull request's place among every numbered member
// of its stack, bottom first, merged ones included, because the list it opens
// counts them too ("2 merged, 8 open") and two totals for one stack would be
// two answers. The spine on the older cards counted open tiers only; the chip
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
  for (const tier of s.tiers) {
    for (const b of tier) {
      if (b.number !== undefined) rows.push({ number: b.number, pos: rows.length + 1, kind: b.kind, me: b.number === me });
    }
  }
  return rows;
}

/** `3/10`. */
export const chipText = (rows: readonly StackRow[]): string => `${rows.find((r) => r.me)?.pos ?? 1}/${rows.length}`;

/** "2 merged, 8 open" counts for the popover. */
export function stackCounts(rows: readonly StackRow[]): { merged: number; open: number } {
  const merged = rows.filter((r) => r.kind === "merged").length;
  return { merged, open: rows.length - merged };
}

export const chipAria = (rows: readonly StackRow[]): string => {
  const me = rows.find((r) => r.me)?.pos ?? 1;
  return `Stack, ${me} of ${rows.length}. Show the chain`;
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
 * Which cards of a lane hang on the gutter rail: a card whose stack neighbour is
 * the very next card in the same lane, whichever of the two sits on top. Anything else (the neighbour is in
 * another column, or a card sits between them) draws no line, because a line
 * that crosses a card says the wrong thing.
 */
export function railLinks(
  lane: readonly number[], nextOf: (n: number) => readonly number[], posOf: (n: number) => number | undefined,
): Map<number, { pos: number; down: boolean }> {
  const out = new Map<number, { pos: number; down: boolean }>();
  for (let i = 0; i + 1 < lane.length; i++) {
    const a = lane[i]!, b = lane[i + 1]!;
    if (!nextOf(a).includes(b) && !nextOf(b).includes(a)) continue;
    const pa = posOf(a), pb = posOf(b);
    if (pa === undefined || pb === undefined) continue;
    out.set(a, { pos: pa, down: true });
    out.set(b, { pos: pb, down: out.get(b)?.down ?? false });
  }
  return out;
}

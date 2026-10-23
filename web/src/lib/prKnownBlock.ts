// What the detail learned about a pull request that the list cannot say.
//
// One datum, two views. Measured on a pull request the board filed under
// "Green, ready to land" while its own merge box said "Conflicts with the base"
// and "a required check never reported": GitHub answered `mergeable` UNKNOWN
// for the list, so the board had nothing to file it by, while the detail's own
// merge of the two trees named the conflicting files; and the list's rollup
// holds only the checks that exist, so a required job that never started was
// invisible to it. Both facts were drawn in the panel and thrown away.
//
// The panel writes what it concluded here, keyed by the head commit, and the
// board reads it back with no request of its own. A push changes the head and
// the note stops applying; nothing else expires it, because a conflict or a
// missing check does not go away by itself. Memory only: a restart asks again
// the first time the card is opened.
//
// Ceiling, named: a card nobody has opened since the app started still says
// only what the list says.

import type { PrSummary } from "../../../shared/types.ts";

export interface KnownBlock { conflicted: boolean; requiredMissing: boolean }

const seen = new Map<string, KnownBlock & { head: string }>();
const listeners = new Set<() => void>();
const keyOf = (root: string, number: number) => `${root}::${number}`;

/** The detail's conclusion for `number` at `head`. Rings the board only when it changed. */
export function noteKnownBlock(root: string, number: number, head: string, b: KnownBlock): void {
  if (!root || !head) return;
  const k = keyOf(root, number);
  const old = seen.get(k);
  if (!b.conflicted && !b.requiredMissing) {
    if (!old || old.head !== head) return;
    seen.delete(k);
  } else {
    if (old && old.head === head && old.conflicted === b.conflicted && old.requiredMissing === b.requiredMissing) return;
    seen.set(k, { head, ...b });
  }
  for (const l of listeners) l();
}

export function onKnownBlock(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** `p` with the detail's findings laid over it; `p` itself when there are none. */
export function withKnownBlock(root: string, p: PrSummary): PrSummary {
  const k = seen.get(keyOf(root, p.number));
  if (!k || !p.headSha || k.head !== p.headSha) return p;
  return {
    ...p,
    ...(k.conflicted ? { mergeable: "CONFLICTING" as const } : {}),
    ...(k.requiredMissing ? { requiredMissing: true } : {}),
  };
}

export function __resetKnownBlock(): void { seen.clear(); listeners.clear(); }

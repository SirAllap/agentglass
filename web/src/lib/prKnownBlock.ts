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

export interface KnownBlock { conflicted: boolean; requiredMissing: boolean; behindBlocks?: boolean;
  /** The detail has what a verdict needs (which checks are required, GitHub's merge state). Without it "nothing blocks" is not an answer, and is not stored. */
  settled?: boolean }

const seen = new Map<string, KnownBlock & { head: string }>();
const listeners = new Set<() => void>();
const keyOf = (root: string, number: number) => `${root}::${number}`;

/**
 * The detail's conclusion for `number` at `head`. Rings the board only when it changed.
 * Kept even when it finds nothing: the detail is the one that asked GitHub which checks
 * are required, so "nothing blocks" must be able to cancel a guess the list made.
 */
export function noteKnownBlock(root: string, number: number, head: string, b: KnownBlock): void {
  if (!root || !head) return;
  if (!b.conflicted && !b.requiredMissing && !b.behindBlocks && b.settled === false) return;
  const k = keyOf(root, number);
  const old = seen.get(k);
  const next = { conflicted: b.conflicted, requiredMissing: b.requiredMissing, behindBlocks: !!b.behindBlocks };
  if (old && old.head === head && old.conflicted === next.conflicted && old.requiredMissing === next.requiredMissing && old.behindBlocks === next.behindBlocks) return;
  seen.set(k, { head, ...next });
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
  const required = k.requiredMissing || undefined;
  const behind = k.behindBlocks || undefined;
  if (!k.conflicted && behind === p.behindBlocks && required === p.requiredMissing) return p;
  return {
    ...p,
    ...(k.conflicted ? { mergeable: "CONFLICTING" as const } : {}),
    requiredMissing: required,
    behindBlocks: behind,
  };
}

export function __resetKnownBlock(): void { seen.clear(); listeners.clear(); }

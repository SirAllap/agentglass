// The stack of any pull request in a list, with the lookups it needs asked for.
//
// Detection is a comparison over the list in hand (prStack.ts). What the list
// does not hold — a base that is somebody else's, merged or closed — is asked of
// the server one branch at a time through prBaseStore, which dedupes and
// remembers; this hook only says which branches are still unknown when the list
// changes. No timer: a refresh of the list is the only thing that asks again,
// and asking inside the cache window costs nothing.

import { useEffect, useMemo } from "react";
import { stackOf, needsLookup, type Stack, type StackPr } from "./prStack.ts";
import { askBases, foundBases, useBasesVersion } from "./prBaseStore.ts";

export interface Stacks {
  of: (n: number) => Stack | null;
  /** What the lookups found, by branch: for the facts of a base the list does not hold. */
  found: ReadonlyMap<string, StackPr | null>;
}

export function usePrStacks(root: string | undefined, pool: readonly StackPr[], shown: (n: number) => boolean): Stacks {
  const v = useBasesVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const found = useMemo(() => (root ? foundBases(root) : new Map<string, StackPr | null>()), [root, v]);
  useEffect(() => {
    if (!root) return;
    const want = needsLookup(pool, found);
    if (want.length) askBases(root, want);
  }, [root, pool, found]);
  return useMemo(() => {
    /* A board asks once per card, and each answer walks the whole list: kept for
       as long as the list, the lookups and the board stay as they are. */
    const memo = new Map<number, Stack | null>();
    return {
      of: (n: number) => { if (!memo.has(n)) memo.set(n, stackOf(n, pool, found, shown)); return memo.get(n)!; },
      found,
    };
  // `shown` is a closure over the board's own memoised set: it changes when the cards do.
  }, [pool, found, shown]);
}

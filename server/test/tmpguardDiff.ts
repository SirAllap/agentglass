/*
 * The rule behind tmpguard.ts, apart from its side effects so a test can import
 * it without registering a root hook.
 *
 * A name is a leak when it matches the house prefixes (`agx-*`, `agentglass-*`)
 * and was not in the listing taken before the run. Sorted so the failure message
 * is stable.
 */
export const HOUSE_NAME = /^(agx|agentglass)-/;

/**
 * Scoped to THIS run, so a parallel run in the same /tmp does not fail a clean
 * one. Two filters, both optional (omitted = the plain diff):
 *  - `startedAt` + `bornAt(name)`: an entry made before this run began is not ours;
 *  - `pid`: a name that carries a pid (`agx-tmux-12345`, `agentglass-9-x`) belongs
 *    to that process, so one carrying another pid is left to its owner.
 */
export interface RunScope { startedAt: number; pid: number; bornAt: (name: string) => number | null }

export function leakedEntries(before: Iterable<string>, after: Iterable<string>, match: RegExp = HOUSE_NAME, scope?: RunScope): string[] {
  const seen = new Set(before);
  return [...new Set(after)].filter((n) => {
    if (!match.test(n) || seen.has(n)) return false;
    if (!scope) return true;
    const born = scope.bornAt(n);
    if (born !== null && born < scope.startedAt) return false;
    const carried = /(?:^|-)(\d{2,8})(?:-|$)/.exec(n.replace(HOUSE_NAME, ""));
    return !carried || Number(carried[1]) === scope.pid;
  }).sort();
}

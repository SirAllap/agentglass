// Which pinned pull requests the Terminal toolbar lists, and in what order.
//
// The pins live with the PR panel; the shell needs the same list one click
// away. The repository the pane is working in comes first, so the pull request
// you are probably after is on top; the rest keep the order they were pinned in.
import type { Pin } from "./prPins.ts";

export function termPins(all: readonly Pin[], repo?: string | null): Pin[] {
  const seen = new Set<string>();
  const uniq = all.filter((p) => {
    const k = `${p.repo}#${p.number}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!repo) return uniq;
  const mine = uniq.filter((p) => p.repo === repo);
  return [...mine, ...uniq.filter((p) => p.repo !== repo)];
}

/** The list as one group per repository, in the order each first appears; the
 *  group of `repo` is marked `current`. `termPins` has already put it first. */
export function repoGroups(list: readonly Pin[], repo?: string | null): { repo: string; current: boolean; pins: Pin[] }[] {
  const by = new Map<string, Pin[]>();
  for (const p of list) by.set(p.repo, [...(by.get(p.repo) ?? []), p]);
  return [...by].map(([r, pins]) => ({ repo: r, current: r === repo, pins }));
}

/*
 * The chips under "A specific check" in the Notify menu.
 *
 * They come from THIS pull request's own checks and nothing else. The ones
 * worth watching are the ones that decide the merge or can still change, so
 * required goes first, then failing and running, then passed; a skipped check
 * will never report and comes last. Typing filters the whole list, not just the
 * eight that fit.
 */
import type { PrCheck } from "../../../shared/types.ts";

const weight = (c: PrCheck) =>
  (c.required ? 0 : 4) + (c.state === "skipped" || c.state === "neutral" ? 2 : 0) + (c.state === "success" ? 1 : 0);

export function suggestCheckNames(all: PrCheck[], typed: string, max = 8): string[] {
  const q = typed.trim().toLowerCase();
  const best = new Map<string, number>();
  for (const c of all) {
    if (q && !c.name.toLowerCase().includes(q)) continue;
    const w = weight(c);
    if (!best.has(c.name) || w < best.get(c.name)!) best.set(c.name, w);
  }
  return [...best.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).slice(0, max).map(([n]) => n);
}

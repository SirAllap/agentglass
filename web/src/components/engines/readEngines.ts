import type { EnginesReport } from "../../../../shared/types.ts";

/** How long the page waits before it asks once more about an engine that was slow to answer. */
export const SLOW_RETRY_MS = 4000;

/**
 * Ask the server about the engines; when one timed out (`slow`), ask again
 * once, fresh, a few seconds later. One retry and no more: an engine still
 * slow after that stays "Checking" with Recheck available, never a loop.
 */
export async function readEngines(
  ask: (fresh: boolean) => Promise<EnginesReport>,
  show: (r: EnginesReport) => void,
  o: { wait?: (ms: number) => Promise<void>; alive?: () => boolean } = {},
): Promise<void> {
  const alive = o.alive ?? (() => true);
  const first = await ask(false);
  if (!alive()) return;
  show(first);
  if (!first.engines.some((e) => e.slow)) return;
  await (o.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(SLOW_RETRY_MS);
  if (!alive()) return;
  show(await ask(true));
}

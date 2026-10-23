/*
 * "A usage reading just changed", for whoever acts on a reading and should not
 * poll for one. usage.ts and codexusage.ts say it; the orchestration policy
 * (orchpolicy.ts) listens. A module of its own so neither side imports the
 * other, and so the callers stay one line with no logic.
 */
const listeners = new Set<() => void>();

export function onUsageReading(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A reading was accepted or a poll came back. A listener that throws must not
 *  fail the statusline post or the poll that said so. */
export function usageRead(): void {
  for (const fn of listeners) {
    try { fn(); } catch (e) { console.error("[usage] a reading listener failed:", e instanceof Error ? e.message : e); }
  }
}

/*
 * The Housekeeping entries, re-read when the server says they changed (the
 * `cleanup-auto` frame) and once on start, never on a timer. The rows drawn
 * from them are housekeeping.ts.
 */
import { api } from "./api.ts";
import type { AutoEntry } from "./housekeeping.ts";

let items: readonly AutoEntry[] = [];
let queued = 0;
const subs = new Set<() => void>();
export const housekeeping = {
  list: (): readonly AutoEntry[] => items,
  /** Merged pull requests asked about and not started yet. */
  queued: (): number => queued,
  subscribe(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn); }; },
};

/** Fetch the list again; a failed read keeps what was shown. */
export async function housekeepingChanged(): Promise<void> {
  const r = await api.cleanupAuto().catch(() => null);
  if (!r?.ok || !Array.isArray(r.entries)) return;
  items = r.entries;
  queued = typeof r.queued === "number" ? r.queued : 0;
  for (const f of subs) f();
}

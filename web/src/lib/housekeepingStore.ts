/*
 * The Housekeeping entries, re-read when the server says they changed (the
 * `cleanup-auto` frame) and once on start, never on a timer. The rows drawn
 * from them are housekeeping.ts.
 */
import { api } from "./api.ts";
import { autoJustCleaned, autoNote, undoableRun, type AutoEntry } from "./housekeeping.ts";
import { showCleanupNote } from "./cleanupEvents.ts";

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
  const done = autoJustCleaned(items, r.entries);
  items = r.entries;
  queued = typeof r.queued === "number" ? r.queued : 0;
  for (const f of subs) f();
  /* One toast, so a burst of merges announces the newest run; the rows of the
     others stay in the Lantern. Nothing before the first read: that is history. */
  const e = done[0];
  if (!e) return;
  showCleanupNote({ ...autoNote(e), ...(undoableRun(e) ? { undo: { label: "Undo the moved briefs", run: () => { void undoBriefs(e); } } } : {}) });
}

/** Puts back the briefs that run moved to archive/; the next read of the entries says what is left. */
async function undoBriefs(e: AutoEntry): Promise<void> {
  await api.cleanupUndoBriefs(e.repo, e.pr).catch(() => null);
  await housekeepingChanged();
}

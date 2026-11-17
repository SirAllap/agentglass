/*
 * The person's merge locks as the board shows them: one read per repository
 * (`/prs/merge-locks`), kept here so the card, the drawer and the menu all read
 * the same row. The server decides; this only draws its answer.
 *
 * A lock with a date opens by itself. Nothing polls for that: one timer is set
 * for the earliest date ahead, and when it fires the repository is read again.
 */
import { useEffect, useSyncExternalStore } from "react";
import { api, type MergeLockRow } from "./api.ts";

type ByNumber = ReadonlyMap<number, MergeLockRow>;
const EMPTY: ByNumber = new Map();
const byRoot = new Map<string, ByNumber>();
const asked = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const subs = new Set<() => void>();
const changed = () => { for (const f of subs) f(); };

function store(root: string, rows: MergeLockRow[]): void {
  byRoot.set(root, new Map(rows.map((r) => [r.lock.number, r])));
  const t = timers.get(root);
  if (t) clearTimeout(t);
  const now = Date.now();
  const next = rows.filter((r) => r.state.waitingDate && r.lock.until != null && r.lock.until > now).map((r) => r.lock.until!);
  if (next.length) timers.set(root, setTimeout(() => { void refreshMergeLocks(root); }, Math.min(...next) - now + 500));
  else timers.delete(root);
  changed();
}

/** Reads the repository's locks again: after a write, a board refresh, or a date passing. */
export async function refreshMergeLocks(root: string): Promise<void> {
  if (!root) return;
  try {
    const r = await api.mergeLocks(root);
    if (r?.ok) store(root, r.locks ?? []);
  } catch { /* the next refresh asks again */ }
}

/** One pull request's row was written: put the server's answer in without a second read. */
export function noteMergeLock(root: string, number: number, row: MergeLockRow | null): void {
  const m = new Map(byRoot.get(root) ?? EMPTY);
  if (row) m.set(number, row); else m.delete(number);
  store(root, [...m.values()]);
}

/** The locks of one repository, by PR number. Read once per repository per page load, then on each write. */
export function useMergeLocks(root: string): ByNumber {
  useEffect(() => {
    if (!root || asked.has(root)) return;
    asked.add(root);
    void refreshMergeLocks(root);
  }, [root]);
  return useSyncExternalStore(
    (fn) => { subs.add(fn); return () => { subs.delete(fn); }; },
    () => byRoot.get(root) ?? EMPTY,
    () => byRoot.get(root) ?? EMPTY,
  );
}

/** The sentence a refused merge says, or null when this pull request is not held. */
export const lockReason = (locks: ByNumber, number: number): string | null => {
  const r = locks.get(number);
  return r?.state.locked ? r.state.reason : null;
};

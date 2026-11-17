/**
 * A merge lock: the person's own "not yet" on a pull request that GitHub would
 * merge today. Some PRs are approved and green and still must wait — step 2b of
 * a rollout may land only once step 2a is on production — and GitHub has no way
 * to know that. The lock holds it, locally, per repository and PR number.
 *
 * It unlocks when EVERY condition it carries holds: the date has passed, every
 * checklist item is ticked, and (when set) the other pull request is merged. The
 * state is computed on read from the clock; there is no timer to miss.
 *
 * Pure: the server and the web read the same answer from the same row.
 */

export interface MergeLockItem { id: string; text: string; done: boolean }

export interface MergeLock {
  /** `github.com/owner/name`, the key repoIdFor gives. */
  repo: string;
  number: number;
  /** Epoch ms, "not before"; null when the lock has no date. */
  until: number | null;
  items: MergeLockItem[];
  note: string;
  /** "After #n is merged", in the same repository; null when not set. */
  afterPr: number | null;
  setAt: number;
  updatedAt: number;
}

export interface MergeLockState {
  locked: boolean;
  /** The one sentence every refused merge says, or "" when unlocked. */
  reason: string;
  ticked: number;
  total: number;
  /** The date is still ahead. */
  waitingDate: boolean;
  /** The other pull request is set and not known to be merged. */
  waitingPr: boolean;
}

export const MERGE_LOCK_ITEMS_MAX = 20;
export const MERGE_LOCK_TEXT_MAX = 200;
export const MERGE_LOCK_NOTE_MAX = 1000;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number): string => String(n).padStart(2, "0");

/** "Wed 25 Nov 09:00", in the local time zone of whoever reads it. */
export function lockDateLabel(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * Locked or not, and the sentence that says why. `prMerged` answers the
 * "after #n" condition; unknown (undefined) counts as not merged, so a lock
 * never opens on a read that failed.
 */
export function mergeLockState(lock: MergeLock | null | undefined, now: number, prMerged?: boolean): MergeLockState {
  if (!lock) return { locked: false, reason: "", ticked: 0, total: 0, waitingDate: false, waitingPr: false };
  const total = lock.items.length;
  const ticked = lock.items.filter((i) => i.done).length;
  const waitingDate = lock.until != null && now < lock.until;
  const waitingItems = ticked < total;
  const waitingPr = lock.afterPr != null && prMerged !== true;
  const locked = waitingDate || waitingItems || waitingPr;
  if (!locked) return { locked, reason: "", ticked, total, waitingDate, waitingPr };
  const parts: string[] = [];
  if (total > 0) parts.push(`${ticked} of ${total} ${total === 1 ? "item" : "items"} ticked`);
  if (waitingPr) parts.push(`waiting for #${lock.afterPr} to merge`);
  const head = waitingDate ? `Locked until ${lockDateLabel(lock.until!)}` : "Locked";
  return { locked, reason: parts.length ? `${head} — ${parts.join(", ")}` : head, ticked, total, waitingDate, waitingPr };
}

export type LockInput = { until?: unknown; items?: unknown; note?: unknown; afterPr?: unknown };

/** A lock the person sent, checked: the clean fields, or the one sentence that refuses it. */
export function cleanLockInput(b: LockInput, number: number): { ok: true; until: number | null; items: MergeLockItem[]; note: string; afterPr: number | null } | { ok: false; error: string } {
  let until: number | null = null;
  if (b.until != null && b.until !== "") {
    const n = typeof b.until === "number" ? b.until : Date.parse(String(b.until));
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "the date is not a date" };
    until = Math.round(n);
  }
  const raw = b.items == null ? [] : b.items;
  if (!Array.isArray(raw)) return { ok: false, error: "items: a list of { text, done }" };
  if (raw.length > MERGE_LOCK_ITEMS_MAX) return { ok: false, error: `at most ${MERGE_LOCK_ITEMS_MAX} items` };
  const items: MergeLockItem[] = [];
  const seen = new Set<string>();
  for (const [i, it] of raw.entries()) {
    const text = String((it as { text?: unknown })?.text ?? "").trim();
    if (!text) continue;
    if (text.length > MERGE_LOCK_TEXT_MAX) return { ok: false, error: `an item is longer than ${MERGE_LOCK_TEXT_MAX} characters` };
    let id = String((it as { id?: unknown })?.id ?? "").trim();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || seen.has(id)) id = `i${i}-${Math.random().toString(36).slice(2, 8)}`;
    seen.add(id);
    items.push({ id, text, done: (it as { done?: unknown })?.done === true });
  }
  const note = String(b.note ?? "").trim();
  if (note.length > MERGE_LOCK_NOTE_MAX) return { ok: false, error: `the note is longer than ${MERGE_LOCK_NOTE_MAX} characters` };
  let afterPr: number | null = null;
  if (b.afterPr != null && b.afterPr !== "") {
    const n = Number(String(b.afterPr).replace(/^#/, ""));
    if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "after: a pull request number" };
    if (n === number) return { ok: false, error: "a pull request cannot wait for itself" };
    afterPr = n;
  }
  if (until == null && items.length === 0 && afterPr == null) return { ok: false, error: "a lock needs a date, an item or a pull request to wait for" };
  return { ok: true, until, items, note, afterPr };
}

/**
 * "Later", and what it means.
 *
 * The Settings row promised "hidden until they change". It was a lie twice
 * over: the list lived in component state, so the queue you emptied refilled on
 * every reload — and it was keyed on the item's id, which for a stalled agent
 * or a red pull request never changes, so a card really was hidden forever
 * rather than until anything about it moved.
 *
 * Both halves matter, and the second is the interesting one. A queue you can
 * empty is the whole idea of the Now tab; a queue that hides a pull request
 * whose checks have since gone from red to green is worse than one that never
 * hid anything, because you would never learn.
 *
 * So an item is snoozed by a mark: a string the queue builder writes to say
 * what state this card is reporting. Change the state and it comes back on its
 * own. What a mark must *not* contain is anything that moves while the item
 * sits still — a first attempt keyed this on the card's own copy, which reads
 * `idle 5m` on a stalled agent and `Exited (1) 3 hours ago` on a container, so
 * every snooze would have expired inside a minute. See nowQueue.ts, where each
 * kind decides for itself.
 *
 * Its own module, with no imports, so a test of it does not pull the whole
 * application graph in behind it.
 */

/** How long a snooze survives even if nothing about the item changes. */
const MAX_MS = 12 * 60 * 60_000;

export interface SnoozeItem {
  /** What this card is currently reporting — see nowQueue.ts. */
  mark: string;
}

export interface SnoozeStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = "mb.snoozed";

type Entry = { at: number };
type Saved = Record<string, Entry>;

function read(store: SnoozeStore, now: number): Saved {
  try {
    const raw = store.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Saved;
    if (!parsed || typeof parsed !== "object") return {};
    // Drop anything past the ceiling on the way in, so a device that has been
    // used for months does not accumulate a snooze list nobody remembers
    // making.
    const kept: Saved = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v && typeof v.at === "number" && now - v.at < MAX_MS) kept[k] = v;
    }
    return kept;
  } catch {
    // A corrupt or foreign value is not worth failing the tab over; the cost of
    // being wrong here is that a card you dismissed comes back once.
    return {};
  }
}

function write(store: SnoozeStore, saved: Saved): void {
  try { store.setItem(KEY, JSON.stringify(saved)); } catch { /* private mode, quota */ }
}

/** Hide this card until what it reports changes, or until the ceiling. */
export function snooze(store: SnoozeStore, it: SnoozeItem, now = Date.now()): void {
  const saved = read(store, now);
  saved[it.mark] = { at: now };
  write(store, saved);
}

export function restoreAll(store: SnoozeStore): void {
  write(store, {});
}

/** The items still worth showing. */
export function unsnoozed<T extends SnoozeItem>(
  store: SnoozeStore,
  items: readonly T[],
  now = Date.now(),
): T[] {
  const saved = read(store, now);
  if (!Object.keys(saved).length) return [...items];
  return items.filter((it) => !saved[it.mark]);
}

const memory = new Map<string, string>();

/**
 * Where a snooze lives on this device.
 *
 * Probed with a write rather than a read, because the mode that actually bites
 * is the one where reading works and `setItem` throws — Safari with site data
 * blocked, or a full quota. A read probe passes there, and then every "Later"
 * you tap is silently a no-op, which is the exact promise this module exists to
 * stop breaking. Falling back costs the snooze its durability and keeps it
 * working for as long as the tab lives, which is what everybody had before.
 */
export function deviceStore(): SnoozeStore {
  try {
    const probe = KEY + ".probe";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch { /* blocked by policy, or out of quota */ }
  return {
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => { memory.set(k, v); },
  };
}

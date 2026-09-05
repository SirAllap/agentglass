/*
 * Saved and Done, kept on this machine.
 *
 * GitHub's inbox has three shelves — Inbox, Saved, Done — and only one of them
 * is in the REST API. Reading, unreading, unsubscribing and marking a whole
 * repository read all have verbs; saving a thread and marking one done are the
 * new web inbox's own state, and nothing published reaches them. Measured
 * before this was written, not assumed.
 *
 * So they are ours: a thread you save is pinned HERE, a thread you finish is
 * hidden HERE (and marked read on GitHub, which is the part that does travel).
 * The alternative was to leave two of the three shelves out and send somebody
 * to the browser for them, which is the thing this panel exists to avoid.
 *
 * Both are just sets of thread ids in localStorage. Small on purpose: a thread
 * id is eleven digits and an inbox is a few dozen rows, so there is nothing
 * here worth a database and nothing worth syncing.
 */

const SAVED = "agx.inbox.saved";
const DONE = "agx.inbox.done";

/** How many finished threads to remember. The list only exists so a row does
 *  not come back the moment GitHub mentions it again; past a few hundred it is
 *  archaeology, and the oldest go first. */
const DONE_MAX = 400;

type Marks = { saved: Set<string>; done: Set<string> };

function read(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    // A corrupt entry is an empty shelf, never a crash: this is chrome around
    // somebody's inbox, not the inbox.
    return [];
  }
}

function write(key: string, ids: string[]): void {
  try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* full or blocked — the shelf is a nicety */ }
}

let marks: Marks | null = null;
const subs = new Set<() => void>();

function load(): Marks {
  if (!marks) marks = { saved: new Set(read(SAVED)), done: new Set(read(DONE)) };
  return marks;
}

/** Re-read from storage — for the test, and for a second window that changed
 *  them under this one. */
export function __resetMarks(): void { marks = null; }

export function subscribeMarks(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}
const changed = () => { for (const f of subs) f(); };

export const isSaved = (id: string): boolean => load().saved.has(id);
export const isDone = (id: string): boolean => load().done.has(id);
export const savedIds = (): string[] => [...load().saved];
export const doneIds = (): string[] => [...load().done];

export function setSaved(id: string, on: boolean): void {
  const m = load();
  if (on) m.saved.add(id); else m.saved.delete(id);
  write(SAVED, [...m.saved]);
  changed();
}

export function setDone(id: string, on: boolean): void {
  const m = load();
  if (on) {
    m.done.add(id);
    // Finishing a thread takes it off the saved shelf: it is done with, and a
    // row that is both is a row that shows up in two places saying different
    // things about itself.
    m.saved.delete(id);
    write(SAVED, [...m.saved]);
  } else m.done.delete(id);
  const kept = [...m.done].slice(-DONE_MAX);
  m.done = new Set(kept);
  write(DONE, kept);
  changed();
}

/** Which shelf a list is showing. */
export type Shelf = "inbox" | "saved" | "done";

/** The rows a shelf holds, out of everything GitHub answered with. */
export function onShelf<T extends { id: string }>(items: T[], shelf: Shelf): T[] {
  const m = load();
  if (shelf === "saved") return items.filter((n) => m.saved.has(n.id));
  if (shelf === "done") return items.filter((n) => m.done.has(n.id));
  // The inbox is everything that has not been finished — including what is
  // saved, exactly as GitHub's own does it.
  return items.filter((n) => !m.done.has(n.id));
}

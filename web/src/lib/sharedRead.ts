// One answer for every caller that asks in the same moment, and for a couple of
// seconds after it.
//
// `/git/repos` has 26 callers (every panel that shows a repo picker) and each
// one asked for itself on open and again when the doorbell rang. Measured: one
// git write was 4 reads of it, 100% identical, and two of them landed in the
// same second. The server holds the answer for 15 s; the cost was the requests.
//
// The ceiling: an answer here is up to `ttlMs` old. Anything that changes what
// it says (a git write from this window, the server's "git changed" frame)
// calls `forgetShared`, and a read that began before that is never handed to a
// caller that arrives after it.

type Entry = { at: number; gen: number; value: unknown; flight?: Promise<unknown> };
const store = new Map<string, Entry>();
let generation = 0;

export function sharedRead<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const held = store.get(key);
  if (held && held.gen === generation) {
    if (held.flight) return held.flight as Promise<T>;
    if (Date.now() - held.at < ttlMs) return Promise.resolve(held.value as T);
  }
  const gen = generation;
  const entry: Entry = { at: 0, gen, value: undefined };
  const flight = load().then(
    (v) => { if (store.get(key) === entry) { entry.at = Date.now(); entry.value = v; entry.flight = undefined; } return v; },
    (e) => { if (store.get(key) === entry) store.delete(key); throw e; },
  );
  entry.flight = flight;
  store.set(key, entry);
  return flight;
}

/** After a write, or the server's "git changed": everything held is suspect. */
export function forgetShared(): void {
  generation++;
  store.clear();
}

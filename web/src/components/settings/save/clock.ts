// A timer the tests can drive. Every decision in this folder is a duration
// (6 s undo, 2 s "Saved", 4 s disarm), so the durations are what the tests
// must see; real setTimeout is the default, a fake clock replaces it.
export type Clock = {
  set(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
};

export const realClock: Clock = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** Durations from pattern.md section 3. */
export const UNDO_MS = 6000;
export const SAVED_MS = 2000;
export const DISARM_MS = 4000;

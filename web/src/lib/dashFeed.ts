/*
 * WHAT THE STARBOARD IS DRAWN FROM, handed over without passing through the
 * workspace shell.
 *
 * The live socket's state lives at the root, so the root re-renders on every
 * flush of it: up to five times a second while agents work. The Starboard's
 * data used to travel down as a render prop of the workspace, and a fresh
 * closure on every one of those renders made the shell re-render too, and
 * with it every view under it: the terminal and its panes, the browser, the
 * boards. The views' own memo compares props by identity and one of them was
 * a fresh arrow each time, so even the hidden ones were rebuilt. With thirty
 * agents that is the whole window five times a second for a screen that is
 * usually not the one being looked at.
 *
 * So the data is left here and the Starboard, when it is on screen, picks it
 * up itself. The shell's props stay the same from one flush to the next and
 * it is skipped.
 *
 * `publish` compares field by field: the root publishes on every render, and
 * a render that changed none of these fields tells nobody.
 *
 * Ceiling: one value, kept whole. A reader is told when any field changed,
 * not which; a second reader that wanted one field would still wake for all
 * of them.
 */
export interface Feed<T extends object> {
  /** Leave the latest value; returns whether anybody was told. */
  publish(next: T): boolean;
  subscribe(fn: () => void): () => void;
  get(): T | null;
}

/** Same fields, each identical: the question `publish` asks. */
export function sameFields<T extends object>(a: T | null, b: T): boolean {
  if (!a) return false;
  const keys = Object.keys(b) as (keyof T)[];
  if (keys.length !== Object.keys(a).length) return false;
  return keys.every((k) => Object.is(a[k], b[k]));
}

export function feed<T extends object>(): Feed<T> {
  let cur: T | null = null;
  const subs = new Set<() => void>();
  return {
    publish(next) {
      if (sameFields(cur, next)) return false;
      cur = next;
      for (const fn of [...subs]) fn();
      return true;
    },
    subscribe(fn) {
      subs.add(fn);
      return () => { subs.delete(fn); };
    },
    get: () => cur,
  };
}

/** For a reader that is not on screen: told nothing, so it costs nothing. */
export const noFeed = (): (() => void) => () => {};

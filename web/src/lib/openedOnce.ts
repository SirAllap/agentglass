/*
 * "Has this ever been opened?", for a dialog whose code arrives on demand.
 *
 * A dialog that is mounted closed has to be in the first bundle. One that is
 * mounted the first time it is asked for can arrive in a chunk of its own,
 * and must then STAY mounted: closing it is `open={false}`, not an unmount,
 * so what it remembers (the page it was on, a half-typed search) and its
 * closing transition survive exactly as they did when it was always there.
 *
 * Returns a function to call on every render with the current `open`; it
 * answers true from the first time `open` was true, for good.
 */
export function openedOnce(): (open: boolean) => boolean {
  let seen = false;
  return (open) => {
    if (open) seen = true;
    return seen;
  };
}

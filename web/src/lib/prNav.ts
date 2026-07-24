// Pure keyboard-navigation helpers for the PR files tab. Kept out of PrPanel.tsx
// so the wrap-around can be unit-tested without dragging the whole component
// graph (and its browser-only imports) into a DOM-less test.

/** Next file index for j/k, wrapping. From no selection (cur < 0), j lands on
 *  the first file and k on the last. Returns -1 for an empty list. */
export function stepFileIndex(len: number, cur: number, dir: 1 | -1): number {
  if (len <= 0) return -1;
  if (cur < 0) return dir === 1 ? 0 : len - 1;
  return (cur + dir + len) % len;
}

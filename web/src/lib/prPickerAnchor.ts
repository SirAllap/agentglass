/*
 * Where the people picker hangs: from what was pressed; failing that (it was
 * opened from a card's menu, so nothing in the detail was pressed) under the
 * detail header's ⋯, where "Request a review…" lives; failing that, the middle.
 * A box with no area (a button that is gone, or hidden) is not an anchor.
 */
type Box = { width: number; height: number };

export function pickAnchor<T extends Box>(from: T | null | undefined, more: T | null | undefined, mid: T): T {
  const has = (b: T | null | undefined): b is T => !!b && b.width + b.height > 0;
  return has(from) ? from : has(more) ? more : mid;
}

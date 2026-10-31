// Where the drawn scrollbar's thumb sits, and what a press on the track means.
//
// The native bar is hidden so the menu can keep its rounded corners and follow
// the theme; the thumb is drawn by hand and has to agree with the scroller to
// the pixel, which is arithmetic and therefore tested.

/** The thumb never gets shorter than this: a long list must still leave something to grab. */
export const THUMB_MIN = 36;
/** The track stops this far short of the scroller's top and bottom edges. */
export const TRACK_INSET = 4;

export interface Thumb { over: boolean; track: number; height: number; top: number; more: { above: boolean; below: boolean } }

export function thumbFor(scrollTop: number, clientH: number, scrollH: number): Thumb {
  const over = scrollH > clientH + 1;
  const track = Math.max(0, clientH - TRACK_INSET * 2);
  const more = { above: scrollTop > 4, below: scrollTop + clientH < scrollH - 4 };
  if (!over) return { over, track, height: 0, top: 0, more };
  const height = Math.min(track, Math.max(THUMB_MIN, (track * clientH) / scrollH));
  const span = scrollH - clientH;
  return { over, track, height, top: ((track - height) * scrollTop) / span, more };
}

/** The scrollTop a press at `y` (from the track's top) asks for, with the thumb centred under the pointer. */
export function scrollForPress(y: number, thumbH: number, track: number, clientH: number, scrollH: number): number {
  const room = track - thumbH;
  if (room <= 0) return 0;
  return Math.min(scrollH - clientH, Math.max(0, ((y - thumbH / 2) / room) * (scrollH - clientH)));
}

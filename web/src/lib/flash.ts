/*
 * "It is this one."
 *
 * Scrolling somewhere is not the same as pointing at it: a smooth scroll ends
 * with the thing you wanted somewhere in the middle of a screen full of similar
 * things, and the eye has to find it again. A short pulse says which.
 *
 * Kept out of the component that asks for it because two things want it — a
 * mention from the inbox now, a search hit later — and both want the same rule:
 * one at a time, and it ends by itself.
 */

const CLASS = "agx-flash";
let last: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Pulse an element. Calling it again moves the pulse rather than stacking two,
 *  which is what a list of jumps in quick succession would otherwise leave. */
export function flashElement(el: HTMLElement, ms = 2400): void {
  if (last && last !== el) last.classList.remove(CLASS);
  if (timer) clearTimeout(timer);
  // Off and on again in the next frame, or re-flashing the SAME element does
  // nothing at all: the class is already there and the animation never restarts.
  el.classList.remove(CLASS);
  void el.offsetWidth;
  el.classList.add(CLASS);
  last = el;
  timer = setTimeout(() => {
    el.classList.remove(CLASS);
    if (last === el) last = null;
    timer = null;
  }, ms);
}

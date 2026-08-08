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

/** The bit of an element every jump here needs to know, so the rule below can
 *  be tested without a browser: how much it holds, how much it shows, whether
 *  it is allowed to scroll the difference, and what is above it. */
export type ScrollBox = {
  scrollHeight: number;
  clientHeight: number;
  parentElement: ScrollBox | null;
};

/**
 * The box that actually scrolls this element up and down.
 *
 * NOT `closest(".agx-scroll")`, which is what every jump in the PR panel used
 * to ask for, and the reason a search result never moved the page: `.agx-scroll`
 * is the app's scrollbar skin, worn by horizontal scrollers too, and in split
 * view each half of a diff is one of them. So the nearest one to a matched LINE
 * was a pane that scrolls sideways and not at all vertically — every `scrollTop`
 * written to it was a silent no-op, with no scroll event to notice it by. A file
 * card's nearest one is the page, which is why jumping to a FILE worked and
 * jumping to a line inside that same file did not.
 *
 * So this asks the question that was always meant: walking up from the element,
 * which ancestor has more content than height AND is allowed to scroll it. Only
 * `auto`/`scroll`/`overlay` count — `clip` and `hidden` overflow more than they
 * show (the file cards are `overflow: clip`) and would swallow the jump.
 */
export function verticalScrollerOf<T extends ScrollBox>(
  el: T,
  overflowY: (e: T) => string,
): T | null {
  /* Starting at the element itself, not at its parent.
   *
   * "Walking up from the element" used to mean "from its parent", which was
   * invisible while the scroller was always an ancestor. Then the Files tab
   * became its own scroll box, and the very element the jump was given WAS the
   * scroller — so this returned null and `frame.scrollTo` never ran. Measured:
   * with the real chain (a frame with overflow-y auto inside a tab body with
   * overflow hidden), it answered null, and pressing j in one-file mode landed
   * you halfway down a file you had never seen the top of.
   *
   * Including `el` cannot break the other callers: they hand it a matched line
   * or a file card, and neither has more content than height, so the first test
   * below skips it exactly as before. */
  for (let p: T | null = el; p; p = p.parentElement as T | null) {
    if (p.scrollHeight <= p.clientHeight + 1) continue;
    const oy = overflowY(p);
    if (oy === "auto" || oy === "scroll" || oy === "overlay") return p;
  }
  return null;
}

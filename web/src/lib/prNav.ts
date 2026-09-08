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

/** What marking a file viewed does to where you are: open another file, scroll
 *  to one, or leave the page alone. */
export type ViewedMove =
  | { kind: "open"; path: string }
  | { kind: "scroll"; path: string }
  | { kind: "stay" };

/**
 * Where you end up after ticking "Viewed".
 *
 * Two layouts, two meanings of "move on". In the stack every file is on the
 * page, so the one just marked collapses and the next is scrolled to. In one-
 * file mode the column holds a single file: collapsing it leaves an empty
 * screen and a scroll goes nowhere, so the only way on is to OPEN the next one
 * — which is what the tick already means when you take it literally.
 *
 * Un-marking never moves anything: that is you going back to look at something,
 * and moving the page out from under that takes the click away from you. Nor
 * does the last file, whose "next" would be a jump to the bottom of a list that
 * just got shorter.
 */
export function afterViewed(
  paths: string[],
  path: string,
  opts: { oneFile: boolean; wasViewed: boolean },
): ViewedMove {
  if (opts.wasViewed) return { kind: "stay" };
  const i = paths.indexOf(path);
  if (i < 0) return { kind: "stay" };
  const next = paths[i + 1];
  if (opts.oneFile) return next ? { kind: "open", path: next } : { kind: "stay" };
  // Nothing after it — hold the one just folded rather than throwing the page
  // to the bottom.
  return { kind: "scroll", path: next ?? path };
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

/**
 * Which file the reader is on, given where each file's card sits and where the
 * floor is — the line just under the pinned toolbar.
 *
 * THE LAST ONE THAT HAS CROSSED THE FLOOR, not the one covering the most of the
 * screen. Area is the tempting rule and it reads worse: half a page into a long
 * file the previous one still owns more pixels, so the mark lags by half a
 * screen. The floor is also exactly where `scrollToFileStable` parks a file, so
 * scrolling to a file by hand and jumping to it with `j` agree on what "here"
 * means instead of disagreeing by one.
 *
 * `tops` are viewport coordinates in the order the files are drawn. Returns the
 * index, or 0 when nothing has crossed yet — at the very top of the list the
 * honest answer is the first file, not "none", because that is the one on
 * screen. Returns -1 only for an empty list.
 *
 * `slack` absorbs the sub-pixel case: a card's top lands exactly on the floor
 * and an exact comparison flickers between two files on the frame where they
 * meet.
 */
export function fileAtFloor(tops: number[], floor: number, slack = 2): number {
  if (!tops.length) return -1;
  let hit = 0;
  for (const [i, top] of tops.entries()) {
    if (top - slack > floor) break;
    hit = i;
  }
  return hit;
}

/*
 * The find engine for the ordinary case: text that is in the DOM.
 *
 * All of the searching is `mdFind` — the walker, the ranges, the CSS Custom
 * Highlight API — which was written for the file viewer and needed nothing
 * added to serve a whole screen except the visibility filter it now has. What
 * is here is the part that a viewer of one static document did not need:
 *
 *   - a POSITION, kept across keystrokes, so Enter walks the matches;
 *   - re-running when the view renders more of itself, debounced, because a
 *     board that polls every thirty seconds would otherwise drop your matches
 *     on the floor mid-read;
 *   - and the honest answer that a range can go stale — React re-rendering the
 *     paragraph a highlight sits in leaves a Range pointing at a node that is no
 *     longer in the document, and painting it throws.
 */

import { findRanges, paint, clear as clearPaint, step, reveal } from "./mdFind.ts";
import type { FindEngine } from "./findScope.ts";

/** How long after the DOM settles before the search is re-run. Long enough that
 *  a burst of renders is one re-run, short enough that it feels like the same
 *  search rather than a new one. */
const SETTLE_MS = 180;

export function domFinder(root: HTMLElement | null): FindEngine {
  let ranges: Range[] = [];
  let i = 0;
  let query = "";
  let watcher: MutationObserver | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const repaint = () => {
    // A range whose nodes have been re-rendered away cannot be painted, and
    // throwing here would take the find bar down with it.
    try { paint(ranges, i); } catch { ranges = []; clearPaint(); }
  };

  const run = (q: string, keepPosition: boolean) => {
    query = q;
    const was = ranges[i];
    ranges = findRanges(root, q);
    if (!ranges.length) { i = 0; clearPaint(); return 0; }
    /* Land on the match nearest to where you were, not back at the top: the
       common re-run is the view repainting itself under you, and being sent to
       the first match every thirty seconds is what makes a find bar unusable on
       a live board. */
    if (keepPosition && was) {
      const y = rectTop(was);
      let best = 0, bestGap = Infinity;
      ranges.forEach((r, n) => {
        const gap = Math.abs(rectTop(r) - y);
        if (gap < bestGap) { bestGap = gap; best = n; }
      });
      i = best;
    } else {
      i = 0;
    }
    repaint();
    return ranges.length;
  };

  const watch = () => {
    if (watcher || !root || typeof MutationObserver !== "function") return;
    watcher = new MutationObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { if (query) run(query, true); }, SETTLE_MS);
    });
    watcher.observe(root, { childList: true, subtree: true, characterData: true });
  };

  return {
    search(q: string) {
      const n = run(q, false);
      if (n) { reveal(ranges[i]); watch(); }
      return n;
    },
    step(dir) {
      if (!ranges.length) return;
      i = step(i, ranges.length, dir);
      repaint();
      reveal(ranges[i]);
    },
    at: () => (ranges.length ? i + 1 : 0),
    clear() {
      if (timer) clearTimeout(timer);
      watcher?.disconnect();
      watcher = null;
      ranges = [];
      i = 0;
      query = "";
      clearPaint();
    },
  };
}

/** Where a match sits on the page, for matching one search's position to the
 *  next one's. Zero when the range has gone stale, which sorts it to the top —
 *  harmless, since the whole point of the comparison is "which is nearest". */
function rectTop(r: Range): number {
  try { return r.getBoundingClientRect().top; } catch { return 0; }
}

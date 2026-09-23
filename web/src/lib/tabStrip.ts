/*
 * The terminal's tab strip, as decisions rather than markup.
 *
 * The strip is one row that scrolls sideways with its scrollbar hidden. With a
 * dozen agents' windows in it that row is wider than the panel, and three
 * things went wrong at once:
 *
 *   - a plain mouse wheel sends vertical deltas, which a row that only scrolls
 *     horizontally ignores, so the tabs past the right edge were reachable only
 *     with a trackpad or Shift+wheel;
 *   - switching window with the tmux prefix moved the highlight to a tab that
 *     could be off screen, so the strip said nothing about where you were;
 *   - nothing said there WAS anything past the edge.
 *
 * Each of those is a function of a few numbers, and they live here so they can
 * be tested without a browser. The hook at the bottom is the only part that
 * touches the DOM.
 */
import { useCallback, useEffect, useLayoutEffect, useState } from "react";

/** Pixels per wheel "line" (deltaMode 1), the figure Firefox reports in. */
const LINE_PX = 16;

type WheelLike = { deltaX: number; deltaY: number; deltaMode: number; ctrlKey?: boolean; metaKey?: boolean };
type Box = { scrollWidth: number; clientWidth: number };

/**
 * How far a wheel event should move the strip sideways, or null to leave the
 * event to the browser.
 *
 * Null in three cases, each on purpose: nothing overflows (so the wheel keeps
 * doing whatever it did before, which is nothing); the gesture is already
 * horizontal (a trackpad, or Shift+wheel, which the browser scrolls natively
 * and better than we would); and Ctrl or Meta is held, which is the app's own
 * zoom and must reach its listener untouched.
 */
export function wheelToX(e: WheelLike, box: Box): number | null {
  if (e.ctrlKey || e.metaKey) return null;
  if (box.scrollWidth <= box.clientWidth + 1) return null;
  if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return null;
  const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? box.clientWidth : 1;
  return e.deltaY * unit;
}

/**
 * Where to scroll so an item is fully visible, or null if it already is.
 *
 * "Nearest", like `scrollIntoView({ inline: "nearest" })`: the strip moves the
 * least it can, so a tab already on screen never makes the row jump. Not
 * `scrollIntoView` itself, because that also scrolls every scrollable
 * ancestor — the panel and the page — to bring the row into view, and a tab
 * switch has no business moving the page.
 *
 * `pad` keeps a sliver of the neighbour showing, so a tab brought in from the
 * edge does not sit flush against the fade that says there is more.
 */
export function revealX(
  view: { scrollLeft: number; clientWidth: number; scrollWidth: number },
  item: { left: number; width: number },
  pad = 0,
): number | null {
  const start = item.left - pad;
  const end = item.left + item.width + pad;
  let to: number | null = null;
  if (start < view.scrollLeft) to = start;
  else if (end > view.scrollLeft + view.clientWidth) {
    // A tab wider than the strip shows its start, which is where its name is.
    to = item.width + 2 * pad > view.clientWidth ? start : end - view.clientWidth;
  }
  if (to === null) return null;
  const max = Math.max(0, view.scrollWidth - view.clientWidth);
  const clamped = Math.min(max, Math.max(0, to));
  return Math.abs(clamped - view.scrollLeft) < 1 ? null : clamped;
}

/** Which ends of the strip have tabs hidden past them. */
export function overflowEdges(scrollLeft: number, clientWidth: number, scrollWidth: number): { start: boolean; end: boolean } {
  // A pixel of slack either side: fractional widths leave scrollLeft at 0.5
  // short of the end on a zoomed display, and a fade over nothing is a lie.
  return { start: scrollLeft > 1, end: scrollLeft + clientWidth < scrollWidth - 1 };
}

/** Width of the fade that marks a hidden edge. */
export const EDGE_FADE_PX = 24;

/**
 * The fade as a CSS mask: the side with hidden tabs dissolves, the other stays
 * sharp. A mask rather than an overlay, so it fades whatever the strip's
 * background is — the panel's, a theme's, a translucent one — without having
 * to know it.
 */
export function edgeMask(edges: { start: boolean; end: boolean }): string | undefined {
  if (!edges.start && !edges.end) return undefined;
  const a = edges.start ? `transparent 0, #000 ${EDGE_FADE_PX}px` : "#000 0";
  const b = edges.end ? `#000 calc(100% - ${EDGE_FADE_PX}px), transparent 100%` : "#000 100%";
  return `linear-gradient(to right, ${a}, ${b})`;
}

/**
 * The strip's scroller: wheel to sideways, the active tab kept on screen, and
 * the edges it has hidden. Tabs mark themselves with `data-window="<id>"`.
 *
 * The wheel is a native listener because React binds `onWheel` passively and a
 * passive listener cannot `preventDefault` — without which the same notch
 * would also scroll whatever is behind the strip.
 */
export function useTabStripScroll(activeId: string | null, shapeKey: string) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  const ref = useCallback((node: HTMLDivElement | null) => setEl(node), []);

  useEffect(() => {
    if (!el) return;
    const measure = () => {
      const next = overflowEdges(el.scrollLeft, el.clientWidth, el.scrollWidth);
      setEdges((cur) => (cur.start === next.start && cur.end === next.end ? cur : next));
    };
    const onWheel = (e: WheelEvent) => {
      const dx = wheelToX(e, el);
      if (dx === null) return;
      e.preventDefault();
      el.scrollLeft += dx;
    };
    measure();
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [el]);

  // Layout effect, so the row is already where it belongs on the frame the
  // new highlight is painted — a tab lit off screen and then scrolled to is a
  // visible jump. Instant, never smooth: the switch is usually a keypress, and
  // a key pressed a hundred times a day should not animate.
  useLayoutEffect(() => {
    if (!el || !activeId) return;
    const tab = el.querySelector<HTMLElement>(`[data-window="${CSS.escape(activeId)}"]`);
    if (!tab) return;
    const box = el.getBoundingClientRect();
    const r = tab.getBoundingClientRect();
    const to = revealX(el, { left: r.left - box.left + el.scrollLeft, width: r.width }, EDGE_FADE_PX);
    if (to !== null) el.scrollLeft = to;
    const next = overflowEdges(el.scrollLeft, el.clientWidth, el.scrollWidth);
    setEdges((cur) => (cur.start === next.start && cur.end === next.end ? cur : next));
  }, [el, activeId, shapeKey]);

  return { ref, edges };
}

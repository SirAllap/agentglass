// Render a long list a screenful at a time.
//
// The panels here routinely hold lists nobody sized them for: 787 remote
// branches on a real repo, 500 commits of graph, a 200-entry reflog, 400 tool
// runs in one session. Mounting all of them builds thousands of DOM nodes for
// the dozen rows actually on screen, and it happens on *open* — which is
// precisely the moment the panel is supposed to feel instant.
//
// Deliberately not windowed virtualization. That needs a row height, and these
// rows don't have one: a branch row grows with its subject, a reflog row with
// its message, a tool row with its output. Guessing a height there produces
// jumping scrollbars and rows that overlap — worse than the problem. Growing
// the list instead keeps the browser's own layout in charge, costs one
// state value, and is indistinguishable from the full list once you've scrolled
// past the first chunk.
//
// The trade: memory still grows if you scroll to the end of 787 branches. That
// is fine — the complaint was that *opening* was slow, and nobody scrolls
// through 787 branches without filtering first.

import { useCallback, useEffect, useRef, useState } from "react";

/** Rows to show at first, and to add each time the bottom comes near. Sized to
 *  overfill a tall panel so the first paint never looks truncated. */
const CHUNK = 60;
/** How close to the bottom counts as "about to need more". Generous, so the
 *  next chunk is already mounted by the time it would have been visible. */
const NEAR_PX = 400;

export interface Incremental<T> {
  /** The slice to render. */
  rows: T[];
  /** True while more remain — drive a "showing N of M" footer off it. */
  more: boolean;
  /** Attach to the scroll container's `onScroll`, alongside any existing one. */
  onScroll: (e: { currentTarget: HTMLElement }) => void;
  /** Show everything now — for a "show all" affordance, or before printing. */
  showAll: () => void;
}

/**
 * `resetKey` is "which list is this". Change it — switching repo, switching
 * tab, applying a filter — and the window starts again from the top, because
 * carrying a 600-row window into a freshly filtered list would render the whole
 * thing at once and undo the point.
 */
export function useIncremental<T>(items: T[], resetKey?: unknown): Incremental<T> {
  const [limit, setLimit] = useState(CHUNK);
  // A ref as well as state: onScroll fires far faster than React re-renders, so
  // reading the state there would keep comparing against a stale limit and
  // request the same chunk several times.
  const limitRef = useRef(CHUNK);

  useEffect(() => { limitRef.current = CHUNK; setLimit(CHUNK); }, [resetKey, items.length === 0]);

  const onScroll = useCallback((e: { currentTarget: HTMLElement }) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight > NEAR_PX) return;
    if (limitRef.current >= items.length) return;
    limitRef.current += CHUNK;
    setLimit(limitRef.current);
  }, [items.length]);

  const showAll = useCallback(() => { limitRef.current = items.length; setLimit(items.length); }, [items.length]);

  return {
    rows: limit >= items.length ? items : items.slice(0, limit),
    more: items.length > limit,
    onScroll,
    showAll,
  };
}

export const INCREMENTAL_CHUNK = CHUNK;

// "Follow the newest, unless I've scrolled away."
//
// Every live view in the app wants the same three behaviours, and getting any
// one of them wrong is immediately annoying:
//
//   1. Opening it lands on the newest content. Never make someone scroll to
//      find the thing they opened the panel to read.
//   2. While it's at the bottom, new content keeps it at the bottom.
//   3. Scrolling up is an explicit "leave me here" and must be respected —
//      a live view that yanks you back down is unusable. Scrolling back to the
//      bottom re-arms following, because that gesture means "resume".
//
// The subtle one is (2). The obvious implementation re-pins from an effect
// keyed on whatever is believed to change the height — message count, the last
// message's length — and it is always wrong, because it is a *list* and the
// list is never complete. Chat height also grows from tool chips appended to an
// existing message, from markdown that finishes laying out a frame later, from
// syntax highlighting that arrives when the lazily-loaded highlighter resolves,
// and from images that finish decoding. None of those touch the dependencies,
// so the view silently falls behind the stream — which is exactly the bug this
// replaces.
//
// A ResizeObserver on the content asks the question directly: "did the content
// get taller?" That covers every cause, including ones added later, without
// anybody having to remember to extend a dependency array.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** How close to the bottom still counts as "at the bottom". Sub-pixel drift
 *  from fractional line heights and zoom means an exact comparison flickers
 *  off on renders where nothing actually moved. */
const SLACK = 40;

export interface StuckBottom {
  /**
   * The scrolling container.
   *
   * A *callback* ref, not an object one, and that distinction is the whole
   * reason this works. Both elements usually mount later than the hook runs —
   * a session modal renders "loading…" first and only mounts its conversation
   * once the fetch lands. An effect that read `contentRef.current` on mount
   * found null, returned early, and never ran again, so the observer was never
   * attached and the view sat at the top of a conversation forever. A callback
   * ref fires exactly when the node appears, whenever that is.
   */
  scrollRef: (el: HTMLDivElement | null) => void;
  /** The content *inside* the container — what's watched for height changes.
   *  It has to be the inner element: a ResizeObserver on the scroller itself
   *  only fires when the scroller's own box changes (a window resize), never
   *  when the content within it grows. */
  contentRef: (el: HTMLDivElement | null) => void;
  /** Whether the view is currently following. Drive a "jump to latest"
   *  affordance off this — silently stopping looks like the panel froze. */
  pinned: boolean;
  /** Jump to the newest content and resume following. */
  toBottom: () => void;
  /** Attach to the container's `onScroll`. */
  onScroll: () => void;
}

/**
 * Keep a scroll container pinned to its newest content.
 *
 * `resetKey` is "which conversation is this, and is it on screen" — change it
 * and the view re-arms and lands on the newest, whatever the user had done to
 * the previous one. Without it, scrolling up in one chat, switching to another
 * and coming back leaves the new view stuck mid-history with following off,
 * which reads as the panel opening in a random place.
 */
export function useStuckBottom(resetKey?: unknown): StuckBottom {
  const scrollEl = useRef<HTMLDivElement | null>(null);
  const contentEl = useRef<HTMLDivElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  // A ref, not state: the ResizeObserver and the scroll handler both read this
  // on paths where a stale closure would re-pin a view the user had scrolled
  // away from. `pinned` mirrors it for rendering only.
  const following = useRef(true);
  const [pinned, setPinned] = useState(true);
  /**
   * When the user last did something that means "I want to be here".
   *
   * Growing content fires `scroll` too, and it fires *before* the
   * ResizeObserver gets to re-pin — at which point scrollTop still points at
   * the old bottom and the container looks scrolled-up. Acting on that unpins a
   * view nobody touched, and since the observer only re-pins while following,
   * it stays unpinned: a session opens showing "↓ resume live" without anyone
   * having scrolled.
   *
   * So following is only ever given up in response to a wheel, a drag or a key
   * — the three things a person can do. Content moving underneath isn't one.
   */
  const lastIntent = useRef(0);
  const INTENT_MS = 400;
  const noteIntent = useCallback(() => { lastIntent.current = Date.now(); }, []);

  const jump = useCallback(() => {
    const el = scrollEl.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const toBottom = useCallback(() => {
    following.current = true;
    setPinned(true);
    jump();
  }, [jump]);

  const onScroll = useCallback(() => {
    const el = scrollEl.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < SLACK;
    // Returning to the bottom always re-arms, however it happened — that's
    // unambiguous. Leaving it only counts when the user did it.
    if (!atBottom && Date.now() - lastIntent.current > INTENT_MS) return;
    following.current = atBottom;
    // Only on a real transition: onScroll fires for every wheel notch, and a
    // setState per notch would re-render the whole conversation while scrolling.
    setPinned((was) => (was === atBottom ? was : atBottom));
  }, []);

  const INTENT_EVENTS = ["wheel", "touchstart", "touchmove", "keydown", "mousedown"] as const;

  /** The scroller. Wiring the intent listeners here, rather than in an effect,
   *  is what makes them survive a container that mounts after the hook. */
  const scrollRef = useCallback((el: HTMLDivElement | null) => {
    const prev = scrollEl.current;
    if (prev) for (const e of INTENT_EVENTS) prev.removeEventListener(e, noteIntent);
    scrollEl.current = el;
    if (el) for (const e of INTENT_EVENTS) el.addEventListener(e, noteIntent, { passive: true });
  }, [noteIntent]);

  /** The content. Observing here means the very first measurement — the one
   *  that happens when a conversation finally renders — already lands at the
   *  bottom, instead of being missed because the node didn't exist on mount. */
  const contentRef = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    contentEl.current = el;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { if (following.current) jump(); });
    ro.observe(el);
    observer.current = ro;
    // The observer fires on its own first measurement, but only once the
    // browser gets round to it; jumping now avoids a visible frame at the top.
    if (following.current) jump();
  }, [jump]);

  useEffect(() => () => observer.current?.disconnect(), []);

  // Landing on the newest when the view opens or switches. Layout-effect so it
  // happens before paint — a useEffect here shows one frame at the old offset,
  // which is visible as a flash of the wrong part of the conversation.
  useLayoutEffect(() => {
    following.current = true;
    setPinned(true);
    jump();
  }, [resetKey, jump]);

  return { scrollRef, contentRef, pinned, toBottom, onScroll };
}

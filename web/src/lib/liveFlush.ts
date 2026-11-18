/*
 * WHEN THE LIVE SOCKET BECOMES A RENDER, and what one render settles.
 *
 * Apart from useLive.ts so the two decisions can be tested without the hook
 * and everything it imports.
 */
import type { OpenToolCall, WatchEvent } from "../../../shared/types.ts";

const FLUSH_MS = 220; // coalesce bursts into ~5 renders/sec
/*
 * The flush while the Starboard is not the view on screen.
 *
 * Every flush re-renders the root of the app. Five a second is for the feed
 * and the charts, which only the Starboard draws; from any other view what
 * the root does with the events is a fleet count and a "something wants you"
 * chip in the top bar, and those do not need to be right to the fifth of a
 * second. One a second is five times fewer renders of the root in the views
 * people actually work in, with agents running.
 *
 * Ceiling: those two readings can be up to a second behind outside the
 * Starboard. Gates, alerts and notifications do not come through this buffer
 * and are not delayed by it.
 */
const SLOW_FLUSH_MS = 1000;
/** How long a burst is collected before it becomes one render. */
export function flushDelay(slow: boolean, focused = true): number {
  return slow || !focused ? SLOW_FLUSH_MS : FLUSH_MS;
}

/**
 * One timer per burst. A window that is visible but not focused (watched on a
 * second monitor) stays live, at the slow rate: 10 flushes in 10 s, not ~45.
 * `delay` is read when the timer is armed, so a focus or blur applies from the
 * next burst on, with no polling.
 */
export function createFlushGate(
  run: () => void,
  delay: () => number,
  setT: (fn: () => void, ms: number) => unknown = setTimeout,
) {
  let scheduled = false;
  return {
    schedule(): unknown {
      if (scheduled) return undefined;
      scheduled = true;
      return setT(() => { scheduled = false; run(); }, delay());
    },
    /** For a flush run by hand: the timer already armed is not needed twice. */
    get scheduled() { return scheduled; },
  };
}

/**
 * The open-tool list one flush applies: the server's latest whole list when a
 * frame arrived since the last flush (null = none), then the Posts of the batch
 * close what they close. Same array back when nothing changed.
 */
export function foldTools(cur: OpenToolCall[], frame: OpenToolCall[] | null, posts: readonly WatchEvent[]): OpenToolCall[] {
  return closeTools(frame ?? cur, posts);
}

/**
 * deriveAgents memoized on the identity of its inputs and nothing else. The
 * 10 s clock tick is not an input: the cards that render ages take `tick`
 * themselves, so a quiet buffer is not re-folded every 10 s.
 */
export function makeAgentsDeriver<A extends unknown[], R>(derive: (...a: A) => R): (...a: A) => R {
  let last: { a: A; r: R } | null = null;
  return (...a: A) => {
    if (last && last.a.length === a.length && last.a.every((x, i) => Object.is(x, a[i]))) return last.r;
    const r = derive(...a);
    last = { a, r };
    return r;
  };
}

export const isPost = (e: WatchEvent): boolean => e.hook_event_type === "PostToolUse" || e.hook_event_type === "PostToolUseFailure";

/**
 * The open tool calls with the ones these events closed taken out.
 *
 * A Post closes its tool: the matching seed is dropped so it cannot keep a
 * finished tool marked "running" after its Post later leaves the buffer.
 * Returns the SAME array when nothing closed, so setting it is not a render.
 *
 * This ran once per Post event, as a state update of its own outside the
 * flush: with many agents finishing tools the root re-rendered per tool call
 * and the 220 ms coalescing above it did nothing for them. It now runs once
 * per flush, over the Posts of that batch.
 */
export function closeTools(cur: OpenToolCall[], posts: readonly WatchEvent[]): OpenToolCall[] {
  if (!cur.length || !posts.length) return cur;
  const closed = (s: OpenToolCall) => posts.some((ev) =>
    s.session_id === ev.session_id && (!ev.tool_name || s.tool_name === ev.tool_name) && ev.timestamp >= s.since);
  return cur.some(closed) ? cur.filter((s) => !closed(s)) : cur;
}

/*
 * A tick per "somebody spoke on a pull request" — the live `talk` frame,
 * remembered as a count rather than as the note itself.
 *
 * A module-level store, in the shape of pr-detail.ts: a pane is also a route,
 * so the PR list and the pull request screen share no ancestor short of the
 * root, and a context there would re-render the whole app to bump one count.
 *
 * Only a tick, never the note's text: what a `talk` frame is FOR here is
 * "something changed, go re-read it" — the note itself already went to
 * `shouldNotifyTalk` (notifications/policy.ts) for the system notification,
 * and the list or the pane that refetches gets the real words from the server
 * the same way it always has.
 */
import { useEffect, useRef, useState } from "react";
import type { PrTalkNote } from "../../../shared/types.ts";
import { prMarkKey } from "../../../shared/prUnread.ts";

let globalTick = 0;
const globalListeners = new Set<() => void>();

const perPr = new Map<string, number>();
const perPrListeners = new Map<string, Set<() => void>>();


/** A `talk` frame arrived on the live socket. Bumps the global tick (for a
 *  list showing many pull requests) and this one's own tick (for a pane
 *  already open on it). */
export function noteTalk(n: PrTalkNote): void {
  globalTick++;
  for (const listen of globalListeners) listen();

  const key = prMarkKey(n);
  perPr.set(key, (perPr.get(key) ?? 0) + 1);
  for (const listen of perPrListeners.get(key) ?? []) listen();
}

/** Bumps on every `talk` frame, for anything showing more than one pull
 *  request at a time. */
export function useTalkTick(): number {
  const [tick, setTick] = useState(globalTick);
  useEffect(() => {
    const listen = (): void => setTick(globalTick);
    globalListeners.add(listen);
    return () => { globalListeners.delete(listen); };
  }, []);
  return tick;
}

/** Bumps only when the pull request with this mark key (prMarkKey) gets a
 *  fresh remark. An empty key (not resolved yet) subscribes to nothing. */
export function usePrTalkTick(key: string): number {
  const [tick, setTick] = useState(key ? (perPr.get(key) ?? 0) : 0);
  useEffect(() => {
    if (!key) return;
    setTick(perPr.get(key) ?? 0);
    const listen = (): void => setTick(perPr.get(key) ?? 0);
    const set = perPrListeners.get(key) ?? new Set();
    set.add(listen);
    perPrListeners.set(key, set);
    return () => {
      set.delete(listen);
      if (!set.size) perPrListeners.delete(key);
    };
  }, [key]);
  return tick;
}

/**
 * Run `reload` when `tick` moves, and only then.
 *
 * Keyed on the tick's value, not on the effect running: `reload` changes
 * identity with whatever it closes over (the filter, the detail), and a
 * mounted-once flag would reload a second time on each of those. `scope` is
 * what the tick counts for — when it changes (the pull request's key arriving
 * with its detail), the count it brings is adopted, not read as a new remark.
 */
export function useReloadOnTick(tick: number, reload: () => unknown, scope = ""): void {
  const seen = useRef({ scope, tick });
  useEffect(() => {
    const was = seen.current;
    seen.current = { scope, tick };
    if (was.scope !== scope || was.tick === tick) return;
    void reload();
  }, [scope, tick, reload]);
}

/** The counts, for a test that wants to look without rendering a hook — there
 *  is no renderer in this project, so `noteTalk`'s effect on the store is
 *  asserted here rather than through `useTalkTick`/`usePrTalkTick`. */
export function talkTickNow(): number { return globalTick; }
export function prTalkTickNow(key: string): number {
  return perPr.get(key) ?? 0;
}

/** Only for tests: the store is process-wide, and a suite that leaves ticks
 *  in it decides what the next one starts counting from. */
export function __resetTalkTicks(): void {
  globalTick = 0;
  perPr.clear();
}

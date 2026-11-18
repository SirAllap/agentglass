// An interval that costs nothing while nobody can see what it feeds.
//
// Measured: the renderer sits at ~2.6% CPU on a 20-core machine with the app
// idle, and the source holds 38 `setInterval` sites, several of them 1 s clocks
// and a 10 s tick at the App root, running whether or not the window or the view
// was on screen. `usePoll` already pauses on blur for fetches; a clock is
// different: a blurred window that is still visible must keep counting, so this
// gates on `document.hidden` and on the owning view being active, and nothing
// else. Coming back runs `fn` once at once, so the pause cannot be seen.
import { useEffect, useRef, useState } from "react";

/** Does the timer run? Pure, so the pause rule is tested without a clock or a DOM. */
export function shouldRun(active: boolean, hidden: boolean): boolean {
  return active && !hidden;
}

/** Does `fn` need an immediate extra call? Only on the edge from paused to running. */
export function shouldCatchUp(wasRunning: boolean, running: boolean): boolean {
  return running && !wasRunning;
}

/** For modules that are not components: `fn` every `ms` while the document is visible. Returns stop. */
export function intervalWhileVisible(fn: () => void, ms: number, active: () => boolean = () => true): () => void {
  let id: ReturnType<typeof setInterval> | null = null;
  // A module store can be loaded where there is no document (a test, a worker): it is then always visible.
  const doc = typeof document === "undefined" ? null : document;
  const on = () => shouldRun(active(), doc?.hidden ?? false);
  const sync = () => {
    const was = id !== null, now = on();
    if (now && !was) id = setInterval(fn, ms);
    else if (!now && was) { clearInterval(id!); id = null; }
    if (shouldCatchUp(was, now)) fn();
  };
  if (on()) id = setInterval(fn, ms);
  doc?.addEventListener("visibilitychange", sync);
  return () => {
    doc?.removeEventListener("visibilitychange", sync);
    if (id !== null) clearInterval(id);
    id = null;
  };
}

/** `fn` every `ms` while `active` and the document is visible; once more on return. */
export function useVisibleInterval(fn: () => void, ms: number, active = true): void {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (!active) return;
    return intervalWhileVisible(() => saved.current(), ms);
  }, [ms, active]);
}

/** `now` cut down to the unit a label shows: two reads in the same unit are equal, so the state write is skipped. */
export function quantize(now: number, unit: number): number {
  return unit > 1 ? Math.floor(now / unit) * unit : now;
}

/** Ms until the next wall-clock minute starts, so a "N min ago" or HH:MM label flips on the minute, not 30 s early. Never 0. */
export function nextMinuteDelay(now: number): number {
  return 60_000 - (now % 60_000);
}

/** `fn` on each wall-clock minute while the document is visible (the labels show whole minutes: a 30 s beat rendered every view twice a minute for one change). Once at once on return. */
export function minuteBoundaryTick(fn: () => void): () => void {
  let id: ReturnType<typeof setTimeout> | null = null;
  const doc = typeof document === "undefined" ? null : document;
  const arm = () => { id = setTimeout(() => { id = null; fn(); if (!doc?.hidden) arm(); }, nextMinuteDelay(Date.now())); };
  const sync = () => {
    if (doc?.hidden) { if (id !== null) { clearTimeout(id); id = null; } }
    else if (id === null) { fn(); arm(); }
  };
  if (!doc?.hidden) arm();
  doc?.addEventListener("visibilitychange", sync);
  return () => { doc?.removeEventListener("visibilitychange", sync); if (id !== null) clearTimeout(id); id = null; };
}

/** How long a relative label ("3m ago", "2h ago", "5d ago") for something `ageMs` old stays true: a minute under an hour, 10 min under a day, an hour after. */
export function nextTickDelay(ageMs: number): number {
  if (ageMs < 3_600_000) return 60_000;
  if (ageMs < 86_400_000) return 600_000;
  return 3_600_000;
}

/** `Date.now()`, refreshed every `ms` while `active` and visible. Pick `ms` at the finest unit the label shows.
 *  `unit` is that unit in ms (60_000 for minutes): a tick that lands in the same unit changes nothing and renders nothing. */
export function useNow(active = true, ms = 1000, unit = 1): number {
  const [now, setNow] = useState(() => quantize(Date.now(), unit));
  const put = () => setNow((prev) => { const n = quantize(Date.now(), unit); return n === prev ? prev : n; });
  useEffect(() => { if (active) put(); }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  useVisibleInterval(put, ms, active);
  return now;
}

/** `Date.now()` cut to the minute, refreshed on each wall-clock minute while `active` and visible: a "N min ago" label never lags a whole minute. */
export function useMinuteNow(active = true): number {
  const [now, setNow] = useState(() => quantize(Date.now(), 60_000));
  useEffect(() => {
    if (!active) return;
    setNow(quantize(Date.now(), 60_000));
    return minuteBoundaryTick(() => setNow((prev) => { const n = quantize(Date.now(), 60_000); return n === prev ? prev : n; }));
  }, [active]);
  return now;
}

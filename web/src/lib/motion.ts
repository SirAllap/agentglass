import { useEffect, useRef, useState } from "react";
import { usePoll } from "./usePoll.ts";

/** A clock that ticks every second — returns elapsed ms since `start`. */
export function useTicker(start: number): number {
  const [now, setNow] = useState(() => Date.now());
  usePoll(true, () => setNow(Date.now()), 1000, true);
  return Math.max(0, now - start);
}

export function fmtClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/** Smoothly tween a number toward its target using rAF (count-up effect). */
export function useTween(target: number, ms = 600): number {
  const [val, setVal] = useState(target);
  const from = useRef(target);
  const startAt = useRef(0);
  const raf = useRef(0);

  useEffect(() => {
    from.current = val;
    startAt.current = performance.now();
    cancelAnimationFrame(raf.current);
    const step = (t: number) => {
      const p = Math.min(1, (t - startAt.current) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(from.current + (target - from.current) * eased);
      if (p < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  return val;
}

/** Rolling per-second event counts over the last `buckets` seconds. */
export function rollingRate(timestamps: number[], buckets = 60, bucketMs = 1000): number[] {
  const now = Date.now();
  const out = new Array(buckets).fill(0);
  for (const ts of timestamps) {
    const idx = buckets - 1 - Math.floor((now - ts) / bucketMs);
    if (idx >= 0 && idx < buckets) out[idx]++;
  }
  return out;
}

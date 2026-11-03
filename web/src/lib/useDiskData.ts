/*
 * The disk figures, kept current by Docker's events instead of a timer.
 *
 * `docker system df -v` makes the daemon walk every layer, so it is asked for
 * when a view that needs it opens, when images or volumes change (Docker says
 * so), and when the person presses Measure again. Never on an interval. Events
 * come in bursts (removing 25 images is 25 of them), so a request in flight
 * absorbs the ones behind it into a single trailing one.
 *
 * The last good figures stay while a new measure runs: a view that went blank
 * on every event would flicker through a whole prune.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { DockerDisk } from "../../../shared/types.ts";
import { api } from "./api.ts";

export interface DiskState {
  d: DockerDisk | null;
  /** Why the last measure failed. Cleared by the next one that works. */
  error: string | null;
  measuring: boolean;
  /** Ask again; `force` skips the server's short cache. */
  measure: (force?: boolean) => Promise<void>;
}

/** `enabled`: a view that needs the figures is open. `tick`: the count of image and volume changes. */
export function useDiskData(enabled: boolean, tick: number): DiskState {
  const [d, setD] = useState<DockerDisk | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const inflight = useRef<Promise<void> | null>(null);
  const trailing = useRef<boolean | null>(null);

  const once = useCallback(async (force: boolean) => {
    try {
      const r = await api.dockerDisk(force);
      if (r.error) setError(r.error); else { setD(r); setError(null); }
    } catch (e) { setError(String(e)); }
  }, []);

  const measure = useCallback((force = false): Promise<void> => {
    if (inflight.current) { trailing.current = trailing.current || force; return inflight.current; }
    setMeasuring(true);
    const run = (async () => {
      let next: boolean | null = force;
      while (next !== null) {
        trailing.current = null;
        await once(next);
        next = trailing.current;
      }
    })().finally(() => { inflight.current = null; setMeasuring(false); });
    inflight.current = run;
    return run;
  }, [once]);

  // The tick of the last measure we started. Changes while no view needed the figures count too.
  const measuredAt = useRef<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const first = measuredAt.current === null;
    if (first || measuredAt.current !== tick) void measure(!first);
    measuredAt.current = tick;
  }, [enabled, tick, measure]);

  return { d, error, measuring, measure };
}

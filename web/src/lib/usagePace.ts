import { pace, PACE_MIN_MINUTES, type Pace, type PaceConfig } from "../../../shared/pace.ts";
import type { QuotaWindow } from "../../../shared/types.ts";
import { samplesFor } from "./paceSamples.ts";


/** Past this a reading is history, not a state: the budget line still holds, the
 *  verdict and the projection do not. */
export const OLD_READING_MS = 6 * 3_600_000;

export { PACE_MIN_MINUTES };

export type WindowPace = { pace: Extract<Pace, { state: "ok" }>; resetsAt: number };

export function windowPace(provider: string, w: QuotaWindow, now: number, cfg: PaceConfig): WindowPace | null {
  if (w.minutes < PACE_MIN_MINUTES || !w.resetsAt) return null;
  const resetsAt = new Date(w.resetsAt).getTime();
  if (!Number.isFinite(resetsAt)) return null;
  const start = resetsAt - w.minutes * 60_000;
  const p = pace({
    usedPercent: w.usedPercent, resetsAt, windowMinutes: w.minutes, now, cfg,
    samples: samplesFor(provider, w.label, start),
  });
  return p.state === "ok" ? { pace: p, resetsAt } : null;
}

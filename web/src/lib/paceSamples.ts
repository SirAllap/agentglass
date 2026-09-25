import { GAP_MS, type PaceSample } from "../../../shared/pace.ts";
import type { ProviderUsage } from "../../../shared/types.ts";

/**
 * A short memory of each window's used percent.
 *
 * The plan endpoint says how much is used, never how it got there. Two of the
 * pace numbers need the "how": what was spent today (the daily cap) and how
 * fast it is being spent now (the projection). So each reading is kept, in this
 * browser, and only when the number moved — a step function needs nothing more
 * and eight days of it is a few hundred bytes.
 *
 * WHAT IT CANNOT KNOW. While the app is closed nothing is read. The reading
 * that follows carries the whole jump, at the moment it was taken, so it is
 * marked `gap` and the burn rate refuses to reach back across it.
 */
const KEY = "agentglass.paceSamples";
const KEEP_MS = 8 * 24 * 3_600_000;

type WindowLog = { seen: number; samples: PaceSample[] };
type SampleLog = Record<string, WindowLog>;

export const windowKey = (provider: string, label: string): string => `${provider}|${label}`;

/** Fold one reading into a window's log. Pure; returns the new log. */
export function appendSample(log: WindowLog | undefined, t: number, used: number): WindowLog {
  const kept = (log?.samples ?? []).filter((s) => s.t >= t - KEEP_MS);
  const last = kept.at(-1);
  // A drop is a new window: what came before describes a week that is over.
  if (last && used < last.used) return { seen: t, samples: [{ t, used }] };
  if (last && last.used === used) return { seen: t, samples: kept };
  const gap = !log || t - log.seen > GAP_MS;
  return { seen: t, samples: [...kept, gap ? { t, used, gap: true } : { t, used }] };
}

function load(): SampleLog {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return raw && typeof raw === "object" ? (raw as SampleLog) : {};
  } catch { return {}; }
}

/** Keep a reading of every window in this snapshot. */
export function recordSnapshot(rows: ProviderUsage[], now = Date.now()): void {
  const log = load();
  for (const u of rows) {
    if (!u.available) continue;
    for (const w of u.windows) {
      const k = windowKey(u.provider, w.label);
      // Stamped when the provider took it, not when we asked: Codex's is the last
      // rollout, and a poll stamping it "now" would move a days-old jump to today.
      log[k] = appendSample(log[k], Math.min(now, u.observedAt ?? now), w.usedPercent);
    }
  }
  try { localStorage.setItem(KEY, JSON.stringify(log)); } catch { /* private mode: pace falls back to the week's average */ }
}

/** This window's readings since it began; earlier ones are another window's. */
export function samplesFor(provider: string, label: string, windowStart: number): PaceSample[] {
  return (load()[windowKey(provider, label)]?.samples ?? []).filter((s) => s.t >= windowStart);
}

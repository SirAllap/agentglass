import { api } from "./api.ts";
import type { ProviderUsage } from "../../../shared/types.ts";

/**
 * Plan quota for every provider, polled once for the whole app.
 *
 * A module store rather than a hook: the answer belongs to the app, not to
 * whichever gauge happens to be mounted. Three surfaces read this now — the
 * dashboard box, the Stats modal and the notch — and a per-component fetch
 * would mean three timers racing an endpoint that talks to a rate-limited API
 * on our behalf.
 */

let snapshot: ProviderUsage[] | null = null;
let firstFetchDone = false;
const listeners = new Set<() => void>();
let poller: ReturnType<typeof setInterval> | null = null;

/** Five minutes: these are 5-hour and weekly windows, and the fastest of them
 *  moves by a fraction of a percent a minute. Polling harder than this once
 *  earned a 429 that made the meters vanish entirely. */
const EVERY_MS = 5 * 60_000;

export const providerUsage = (): ProviderUsage[] | null => snapshot;

export const usageOf = (p: ProviderUsage["provider"]): ProviderUsage | null =>
  snapshot?.find((u) => u.provider === p) ?? null;

/** Whether the first fetch has come back, so a surface can tell "loading" from
 *  "nothing to show" — the distinction the About pane bug was made of. */
export const usageLoaded = (): boolean => firstFetchDone;

export function subscribeProviderUsage(fn: () => void): () => void {
  listeners.add(fn);
  if (!poller) {
    const load = () => api.providerUsage()
      // A failed poll leaves the last good answer standing: the meters must
      // never blink out because one request lost.
      .then((next) => { snapshot = next; })
      .catch(() => { /* offline — keep what we have */ })
      .finally(() => { firstFetchDone = true; for (const l of listeners) l(); });
    load();
    poller = setInterval(load, EVERY_MS);
  } else if (firstFetchDone) {
    queueMicrotask(fn);
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size && poller) { clearInterval(poller); poller = null; }
  };
}

/** Colour escalates with consumption — the "used" mental model. */
export function usedColor(used: number): string {
  if (used >= 85) return "var(--error)";
  if (used >= 60) return "var(--warning)";
  return "var(--success)";
}

/** "in 1h 44m" when soon, else "Wed 3:00 PM". */
export function resetLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const d = new Date(iso);
  const ms = d.getTime() - now;
  if (ms <= 0) return "now";
  if (ms < 24 * 3_600_000) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return h >= 1 ? `in ${h}h ${m}m` : `in ${m}m`;
  }
  const day = d.toLocaleDateString([], { weekday: "short" });
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${day} ${time}`;
}

/**
 * How old a reading is.
 *
 * Load-bearing for Codex, whose number is written only when a turn runs and can
 * be days old with nothing on screen to suggest it. Anything under a couple of
 * minutes reads as "just now" rather than "1m ago", because a precise age on a
 * fresh number is noise.
 */
export function ageLabel(observedAt: number | undefined, now = Date.now()): string {
  if (!observedAt) return "";
  const ms = now - observedAt;
  if (ms < 2 * 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 24 * 3_600_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / (24 * 3_600_000))}d ago`;
}

/** Test seam: forget everything this module remembers. */
export function __resetUsageStore(): void {
  snapshot = null;
  firstFetchDone = false;
  if (poller) { clearInterval(poller); poller = null; }
}

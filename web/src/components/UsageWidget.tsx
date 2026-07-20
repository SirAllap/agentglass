import { useEffect, useState } from "react";
import { api, type UsagePayload } from "../lib/api.ts";

// Human reset label: "in 1h 44m" when soon, else "Wed 3:00 PM".
export function resetLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const ms = d.getTime() - Date.now();
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
 * The last usage we saw, shared by every consumer and outliving all of them.
 *
 * The server already caches for a minute, so this isn't about the network — it's
 * about the mount. Both the header widget and the terminal island keep the
 * payload in component state, which resets to null every time they unmount, so
 * opening the terminal panel showed a spinner for a value the app had fetched
 * thirty seconds earlier and still held. Hoisting it out of React means the
 * second mount paints the real numbers immediately, and only ever shows a
 * spinner on the genuinely cold first fetch of the session.
 */
let lastUsage: UsagePayload | null = null;
/** Why the meters are missing, when they are. A feature that silently shows
 *  nothing is indistinguishable from a feature that is broken. */
let lastError: string | null = null;
let firstFetchDone = false;
const listeners = new Set<(u: UsagePayload | null) => void>();
let poller: ReturnType<typeof setInterval> | null = null;

/**
 * One poll for the whole app, however many meters are on screen.
 *
 * The header widget and the terminal island each ran their own 30s interval, so
 * two components meant a request every fifteen seconds on average — against an
 * endpoint that answers 429 when asked too often, and whose 429 then made both
 * of them render nothing. Sharing the timer halves the traffic and, more
 * importantly, makes the rate a property of the app rather than of how many
 * places happen to be showing the number.
 */
export function subscribeUsage(fn: (u: UsagePayload | null) => void): () => void {
  listeners.add(fn);
  if (!poller) {
    const load = () => api.usage()
      .then((next) => { if (next.available) { lastUsage = next; lastError = null; } else lastError = next.error ?? "unavailable"; })
      .catch(() => { /* offline — the meters keep the last good reading */ })
      .finally(() => { firstFetchDone = true; listeners.forEach((l) => l(lastUsage)); });
    load();
    /*
     * Five minutes, not thirty seconds.
     *
     * These are a 5-hour window and a weekly one — the fastest of them moves by
     * a fraction of a percent per minute. Polling twice a minute asked an
     * endpoint that rate-limits roughly 600 times a day for a number that
     * changes meaningfully a handful of times, and duly earned a 429 that made
     * the meters vanish entirely. Being briefly stale about "83% of your week"
     * costs nothing; being throttled costs the whole feature.
     */
    poller = setInterval(load, 5 * 60_000);
  } else if (firstFetchDone) {
    // A late subscriber gets what we already have instead of waiting a cycle.
    queueMicrotask(() => fn(lastUsage));
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size && poller) { clearInterval(poller); poller = null; }
  };
}

// Colour escalates with consumption (matches the "used" mental model).
export function usedColor(used: number): string {
  if (used >= 85) return "var(--error)";
  if (used >= 60) return "var(--warning)";
  return "var(--success)";
}

// One-line meter that matches the header's h-8 controls; the reset time
// lives in the hover tooltip so the widget stays button-sized.
function Meter({ label, used, resets }: { label: string; used: number; resets: string | null }) {
  const color = usedColor(used);
  return (
    <div className="flex items-center gap-1.5" title={`${label}: ${used}% used — resets ${resetLabel(resets)}`}>
      <span className="text-[9px] uppercase tracking-[0.14em] t-dim2">{label}</span>
      <div className="h-1.5 w-14 rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${used}%`, background: color }} />
      </div>
      <span className="text-[11px] font-semibold tabular-nums" style={{ color }}>{used}%</span>
    </div>
  );
}

/** The most recent usage error the shared poll saw, so the island can say
 *  "rate limited, retrying" instead of blanking out. Read after subscribing. */
export const usageError = (): string | null => lastError;

export function UsageWidget() {
  const [u, setU] = useState<UsagePayload | null>(lastUsage);
  const [loading, setLoading] = useState(!lastUsage);
  // Keep the last good payload through transient failures — the meters should
  // never blink out because one poll errored.
  useEffect(() => subscribeUsage((next) => { if (next) setU(next); setLoading(false); }), []);

  // First fetch in flight — show a spinner so it's clearly loading, not missing.
  if (loading && !u) {
    return (
      <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-xl" title="loading Anthropic plan usage…"
        style={{ background: "color-mix(in srgb, var(--bg3) 30%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
        <span className="h-3 w-3 rounded-full animate-spin" style={{ border: "2px solid color-mix(in srgb, var(--primary) 25%, transparent)", borderTopColor: "var(--primary)" }} />
        <span className="text-[10px] t-dim2">Anthropic usage…</span>
      </div>
    );
  }
  if (!u?.available) return null;
  return (
    <div
      className="flex items-center gap-4 px-3.5 py-1.5 rounded-xl"
      style={{ background: "color-mix(in srgb, var(--bg3) 30%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}
      title="Anthropic plan usage — % of the limit used"
    >
      {u.five_hour && <Meter label="5h window" used={u.five_hour.utilization} resets={u.five_hour.resets_at} />}
      {u.seven_day && (
        <div className="pl-4 border-l" style={{ borderColor: "color-mix(in srgb, var(--border) 45%, transparent)" }}>
          <Meter label="weekly" used={u.seven_day.utilization} resets={u.seven_day.resets_at} />
        </div>
      )}
    </div>
  );
}

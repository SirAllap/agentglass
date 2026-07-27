import { useState } from "react";
import { api, type UsagePayload } from "../lib/api.ts";
import { usePoll } from "../lib/usePoll.ts";

// Human reset label: "in 1h 44m" when soon, else "Wed 3:00 PM".
function resetLabel(iso: string | null): string {
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

// Colour escalates with consumption (matches the "used" mental model).
function usedColor(used: number): string {
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

export function UsageWidget() {
  const [u, setU] = useState<UsagePayload | null>(null);
  const [loading, setLoading] = useState(true);
  // Keep the last good payload through transient failures — the meters should
  // never blink out because one poll errored.
  usePoll(true, () => api
    .usage()
    .then((next) => setU((prev) => (next.available ? next : prev?.available ? prev : next)))
    .catch(() => {})
    .finally(() => setLoading(false)), 30_000, true);

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

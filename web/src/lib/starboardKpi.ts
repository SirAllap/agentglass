// The numbers behind the Starboard tiles that need a little arithmetic, apart
// from the screen so a test can hold them.
import type { ProviderUsage, TimeBucket } from "../../../shared/types.ts";
import type { LanternRow } from "../components/LanternView.tsx";

/** Per-bucket estimated cost for the Spend sparkline, oldest first. Null when
 *  there is no line to draw: under two buckets, or nothing spent. */
export function spendSeries(timeline: TimeBucket[] | undefined): number[] | null {
  const v = (timeline ?? []).map((b) => b.cost_usd);
  return v.length >= 2 && v.some((x) => x > 0) ? v : null;
}

/** SVG path for a series in a w x h box (y up), padded so the stroke is not clipped. */
export function sparkPath(vals: number[], w = 100, h = 40, pad = 3): string {
  const max = Math.max(...vals) * 1.05 || 1;
  return vals.map((v, i) => `${i ? "L" : "M"}${(i / (vals.length - 1) * w).toFixed(1)} ${(h - pad - (v / max) * (h - 2 * pad)).toFixed(1)}`).join(" ");
}

/** The 5-hour window of the first provider that reports one, as the provider said it. */
export function fiveHour(rows: ProviderUsage[] | null): { used: number; resetsAt: string | null; observedAt?: number; label: string } | null {
  for (const r of rows ?? []) {
    const w = r.available ? r.windows.find((x) => x.minutes === 300) : undefined;
    if (w) return { used: w.usedPercent, resetsAt: w.resetsAt, observedAt: r.observedAt, label: r.label };
  }
  return null;
}

/** One line per provider that reports windows: "Claude · 5 h 12% · week 30%". This is where per-provider
 *  quota lives on Starboard (the QUOTA tile's tooltip); a provider that joins later adds a row, not a panel. */
export function quotaLines(rows: ProviderUsage[] | null): string[] {
  const win = (m: number) => (m === 300 ? "5 h" : m === 10080 ? "week" : m % 1440 === 0 ? `${m / 1440} d` : `${m / 60} h`);
  return (rows ?? []).filter((r) => r.available && r.windows.length).map((r) => `${r.label} · ${r.windows.map((w) => `${win(w.minutes)} ${Math.round(w.usedPercent)}%`).join(" · ")}`);
}

/** "1 h 52 m" until a reset, or null when the provider gave none or it has passed. */
export function untilReset(resetsAt: string | null, now: number): string | null {
  const ms = resetsAt ? Date.parse(resetsAt) - now : NaN;
  if (!(ms > 0)) return null;
  const m = Math.ceil(ms / 60_000);
  return m < 60 ? `${m} m` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} m`;
}

/** A Lantern card that carries the engine's own stalled verdict. The engine does
 *  not send one yet: until a row does, the Stalled? tile is not drawn. */
export type StalledRow = LanternRow & { stalled?: boolean };
export function stalledCount(rows: StalledRow[]): number | null {
  return rows.some((r) => typeof r.stalled === "boolean") ? rows.filter((r) => r.stalled).length : null;
}

/** 24-hour clock "14:05" and a short date, from the same `now` the cards age by. */
export const clockWords = (now: number): { time: string; date: string } => {
  const d = new Date(now);
  return {
    time: d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
    date: d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }),
  };
};

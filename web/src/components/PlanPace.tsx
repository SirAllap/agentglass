import { useEffect, useState } from "react";
import { pct } from "../../../shared/pace.ts";
import type { UsageDay } from "../../../shared/types.ts";
import { EQ_SUFFIX, fmtTokens } from "../lib/format.ts";
import { dayCells, lastWeek, stripState, STRIP_HEIGHT, warmDayStrip } from "../lib/dayStrip.ts";

/** Where the bar should be by now. Drawn inside the bar's own box so it is
 *  measured on the same scale as the fill and cannot drift from it. */
export function PaceMarker({ expected }: { expected: number }) {
  return (
    <span className="absolute rounded-full" aria-hidden
      title={`Budget: ${pct(expected)} of this window is earned by now`}
      style={{
        left: `${Math.max(0, Math.min(100, expected))}%`, top: -2, width: 2, height: 8,
        transform: "translateX(-1px)", background: "var(--text)", opacity: 0.85,
      }} />
  );
}

/**
 * The last seven days of activity, one bar each.
 *
 * It is every agent on this machine, not one plan: the plan endpoint reports a
 * percentage and never a token count, so this is the nearest thing to "where
 * did the week go" that the cockpit itself has seen. Days are UTC, as the
 * server keeps them.
 *
 * It owns STRIP_HEIGHT in every state. Loading pulses seven quiet slots and
 * empty says so in the same box; neither may change the popover's size.
 */
export function DayStrip({ provider, all }: { provider: string; all?: boolean }) {
  // `all`: the bank's sheet asks for the same all-agents week on every tab,
  // because the chart is this machine's activity, not one plan's.
  const wanted = all || provider === "anthropic";
  const [days, setDays] = useState<UsageDay[] | null>(lastWeek());
  useEffect(() => {
    if (!wanted) return;
    // The fold unmounts this and mounts it again on every open; without this
    // guard each expand was another GET for a chart that changes daily.
    if (lastWeek()?.length) return;
    let live = true;
    warmDayStrip().then((d) => { if (live) setDays(d); }).catch(() => { if (live) setDays((d) => d ?? []); });
    return () => { live = false; };
  }, [wanted]);
  if (!wanted) return null;
  const state = stripState(days);
  const loading = state === "loading";
  const cells = dayCells(days ?? [], Date.now());
  const top = Math.max(1, ...cells.map((c) => c.tokens));
  return (
    <div>
      <div className="text-[10px] mb-1" style={{ color: "var(--text4)" }}>Weighted tokens by day · all agents</div>
      <div className="flex items-end gap-1 relative" style={{ height: STRIP_HEIGHT }}>
        {cells.map((c, i) => (
          <div key={c.key} className="flex-1 flex flex-col items-center justify-end gap-0.5 h-full"
            title={state === "data" ? `${c.key}: ${fmtTokens(c.tokens)} ${EQ_SUFFIX}` : undefined}>
            <span className={`w-full rounded-sm${loading ? " agx-daybar-pulse" : ""}`} style={{
              height: loading ? 8 : state === "data" && c.tokens ? Math.max(2, Math.round((c.tokens / top) * 22)) : 1,
              background: state === "data" && i === 6 ? "var(--primary)" : "color-mix(in srgb, var(--text) 30%, transparent)",
              animationDelay: loading ? `${i * 80}ms` : undefined,
            }} />
            <span className="text-[8.5px] leading-none" style={{ color: "var(--text4)" }}>{c.wd}</span>
          </div>
        ))}
        {state === "empty" && (
          <span className="absolute inset-x-0 top-0 text-center text-[10px]" style={{ color: "var(--text4)" }}>
            No activity in the last 7 days
          </span>
        )}
      </div>
    </div>
  );
}

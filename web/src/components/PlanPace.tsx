import { useEffect, useState } from "react";
import { budgetLine, hourLabel, pct, projectionText, verdictText, type PaceConfig, type Verdict } from "../../../shared/pace.ts";
import type { UsageDay } from "../../../shared/types.ts";
import type { WindowPace } from "../lib/usagePace.ts";
import { EQ_SUFFIX, fmtTokens } from "../lib/format.ts";
import { dayCells, lastWeek, stripState, STRIP_HEIGHT, warmDayStrip } from "../lib/dayStrip.ts";

/** The verdict wears the colour of what to do about it, not of how full the bar is.
 *  This is TEXT sitting directly on the popover's own surface, not a chip
 *  fill — so it reads through the `-ink` variant `inkTints` already computes,
 *  never the raw tint (which is picked to sit on a dark chip fill and fails
 *  4.5:1 read as plain text on a light theme's cream). */
const VERDICT_COLOR: Record<Verdict, string> = {
  room: "var(--success-ink)",
  "on-pace": "var(--text2)",
  "cut-back": "var(--warning-ink)",
  "used-up": "var(--error-ink)",
  over: "var(--error-ink)",
  "day-off": "var(--text4)",
};

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

/** Under the bar: how it compares, what is left today, where it is heading. */
export function PaceLines({ wp, now, cfg, oldReading }: { wp: WindowPace; now: number; cfg: PaceConfig; oldReading?: boolean }) {
  const { pace: p, resetsAt } = wp;
  const tz = cfg.timeZone;
  const dim = { color: "var(--text4)" };
  return (
    <div className="mt-1 flex flex-col gap-0.5 text-[10px] leading-snug">
      <span style={dim}>{budgetLine(p)}</span>
      {/* A days-old reading (Codex writes it only when a turn runs) says where the
          budget is, not what is left today: that would be today's verdict on
          last week's number. */}
      {oldReading ? null : <>
      <span className="text-[11px] font-medium" style={{ color: VERDICT_COLOR[p.today.verdict] }}>
        {verdictText(p, now, tz)}
      </span>
      {p.today.working && (
        <span style={dim}>
          Today's share {pct(p.today.share)}{p.today.endsAtHour ? ` · ends ${hourLabel(p.today.endsAtHour)}` : ""}
        </span>
      )}
      <span style={dim}>{projectionText(p, now, resetsAt, tz)}</span>
      </>}
      {p.fellBackToEveryHour && cfg.spread === "working" && (
        <span style={dim}>No working day is ticked, so every hour counts. Settings › Budgets.</span>
      )}
    </div>
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
export function DayStrip({ provider }: { provider: string }) {
  const wanted = provider === "anthropic";
  const [days, setDays] = useState<UsageDay[] | null>(lastWeek());
  useEffect(() => {
    if (!wanted) return;
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

import { useEffect, useState } from "react";
import { budgetLine, hourLabel, pct, projectionText, verdictText, type PaceConfig, type Verdict } from "../../../shared/pace.ts";
import type { UsageDay } from "../../../shared/types.ts";
import type { WindowPace } from "../lib/usagePace.ts";
import { api } from "../lib/api.ts";
import { EQ_SUFFIX, fmtTokens } from "../lib/format.ts";

/** The verdict wears the colour of what to do about it, not of how full the bar is. */
const VERDICT_COLOR: Record<Verdict, string> = {
  room: "var(--success)",
  "on-pace": "var(--text2)",
  "cut-back": "var(--warning)",
  "used-up": "var(--error)",
  over: "var(--error)",
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

const WEEKDAY = ["S", "M", "T", "W", "T", "F", "S"];

/** Weighted tokens where the server has them, the three that cost input otherwise. */
const dayTokens = (d: UsageDay): number => d.equiv_tokens ?? d.input_tokens + d.output_tokens + d.cache_creation_tokens;

/**
 * The last seven days of activity, one bar each.
 *
 * It is every agent on this machine, not one plan: the plan endpoint reports a
 * percentage and never a token count, so this is the nearest thing to "where
 * did the week go" that the cockpit itself has seen. Days are UTC, as the
 * server keeps them.
 */
export function DayStrip({ provider }: { provider: string }) {
  const [days, setDays] = useState<UsageDay[] | null>(null);
  const wanted = provider === "anthropic";
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    api.usageDaily(7).then((h) => { if (live) setDays(h.days); }).catch(() => { /* the strip just does not show */ });
    return () => { live = false; };
  }, [wanted]);
  if (!wanted || !days) return null;
  const byDay = new Map(days.map((d) => [d.day, dayTokens(d)]));
  const now = Date.now();
  const cells = Array.from({ length: 7 }, (_, i) => {
    const t = new Date(now - (6 - i) * 86_400_000);
    const key = t.toISOString().slice(0, 10);
    return { key, wd: WEEKDAY[t.getUTCDay()]!, tokens: byDay.get(key) ?? 0 };
  });
  const top = Math.max(1, ...cells.map((c) => c.tokens));
  if (!cells.some((c) => c.tokens > 0)) return null;
  return (
    <div>
      <div className="text-[10px] mb-1" style={{ color: "var(--text4)" }}>Weighted tokens by day · all agents</div>
      <div className="flex items-end gap-1" style={{ height: 34 }}>
        {cells.map((c, i) => (
          <div key={c.key} className="flex-1 flex flex-col items-center justify-end gap-0.5 h-full"
            title={`${c.key}: ${fmtTokens(c.tokens)} ${EQ_SUFFIX}`}>
            <span className="w-full rounded-sm" style={{
              height: c.tokens ? Math.max(2, Math.round((c.tokens / top) * 22)) : 1,
              background: i === 6 ? "var(--primary)" : "color-mix(in srgb, var(--text) 30%, transparent)",
            }} />
            <span className="text-[8.5px] leading-none" style={{ color: "var(--text4)" }}>{c.wd}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

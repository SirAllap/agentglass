import type { Trigger, UsageProviderId } from "../../../../shared/orchestration.ts";
import { clockLabel, clockSegments, meterGeometry, meterLabel, nowPct } from "./orchestrationCopy.ts";

/**
 * The two pictures of a condition. An hours rule is a 24 h strip with the
 * stretches it covers shaded and the time now in red; a usage rule is a meter
 * of how much of the plan is left with a mark where the rule switches on. Every
 * position is a percent worked out in orchestrationCopy.ts, so the table test
 * holds the geometry and this only places it. Both carry their meaning in a
 * label too, never in colour alone.
 */
const MARK = "absolute w-0.5";
const WIDE = { maxWidth: 520 } as const;

export function ClockStrip({ t, now }: { t: Extract<Trigger, { kind: "hours" }>; now: Date }) {
  return (
    <div role="img" aria-label={clockLabel(t, now)} data-strip="clock" className="grid gap-1" style={WIDE}>
      <div className="relative overflow-hidden rounded-md" style={{ height: 26, background: "var(--bg3)" }}>
        {clockSegments(t.from, t.to).map((s) => (
          <span key={s.left} className="absolute inset-y-0"
            style={{ left: `${s.left}%`, width: `${s.width}%`, background: "color-mix(in srgb, var(--info) 30%, transparent)", borderLeft: "2px solid var(--info)", borderRight: "2px solid var(--info)" }} />
        ))}
        <span className={MARK} data-mark="now" style={{ left: `${nowPct(now)}%`, top: 0, bottom: 0, background: "var(--error)" }} />
      </div>
      <div aria-hidden className="t-mono flex justify-between text-[10px] tabular-nums" style={{ color: "var(--text3)" }}>
        <span>0</span><span>6</span><span>12</span><span>18</span><span>24</span>
      </div>
    </div>
  );
}

export function MeterStrip({ left, threshold }: { left: number | null; threshold: number }) {
  const g = meterGeometry(left, threshold);
  return (
    <div role="img" aria-label={meterLabel(left, threshold)} data-strip="meter" className="grid gap-1" style={WIDE}>
      <div className="relative rounded-lg" style={{ height: 14, background: "var(--bg3)" }}>
        {g.fill !== null && <span className="absolute inset-y-0 left-0 rounded-lg" style={{ width: `${g.fill}%`, background: "var(--success)" }} />}
        <span className={MARK} data-mark="threshold" style={{ left: `${g.mark}%`, top: -4, bottom: -4, background: "var(--warning)" }} />
      </div>
      <div aria-hidden className="flex justify-between text-[10px] tabular-nums" style={{ color: "var(--text3)" }}>
        <span>0%</span><span>{g.fill === null ? "no reading yet" : `${g.fill}% left now`}</span><span>100%</span>
      </div>
    </div>
  );
}

/** The strip a rule's first picturable condition draws, or nothing for the kinds with no picture. */
export function RuleStrip({ when, now, left }: { when: readonly Trigger[]; now: Date; left: Partial<Record<UsageProviderId, number>> }) {
  return (
    <>
      {when.map((t, i) => t.kind === "hours" ? <ClockStrip key={i} t={t} now={now} />
        : t.kind === "usage" ? <MeterStrip key={i} left={left[t.provider] ?? null} threshold={t.remainingAtMost} /> : null)}
    </>
  );
}

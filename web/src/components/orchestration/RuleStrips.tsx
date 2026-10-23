import { EDGE } from "../workspace/Chrome.tsx";
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
const TRACK = "relative h-2 rounded-full";
const MARK = "absolute w-0.5 rounded-full";

export function ClockStrip({ t, now }: { t: Extract<Trigger, { kind: "hours" }>; now: Date }) {
  return (
    <div role="img" aria-label={clockLabel(t, now)} data-strip="clock" className="grid gap-1">
      <div className={TRACK} style={{ background: "var(--surface-card)", border: EDGE }}>
        {clockSegments(t.from, t.to).map((s) => (
          <span key={s.left} className="absolute inset-y-0 rounded-full"
            style={{ left: `${s.left}%`, width: `${s.width}%`, background: "color-mix(in srgb, var(--primary) 55%, transparent)" }} />
        ))}
        <span className={MARK} data-mark="now" style={{ left: `${nowPct(now)}%`, top: -2, bottom: -2, background: "var(--error)" }} />
      </div>
      <div aria-hidden className="flex justify-between text-[10px] tabular-nums" style={{ color: "var(--text3)" }}>
        <span>0</span><span>6</span><span>12</span><span>18</span><span>24</span>
      </div>
    </div>
  );
}

export function MeterStrip({ left, threshold }: { left: number | null; threshold: number }) {
  const g = meterGeometry(left, threshold);
  return (
    <div role="img" aria-label={meterLabel(left, threshold)} data-strip="meter" className="grid gap-1">
      <div className={TRACK} style={{ background: "var(--surface-card)", border: EDGE }}>
        {g.fill !== null && <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${g.fill}%`, background: "var(--success)" }} />}
        <span className={MARK} data-mark="threshold" style={{ left: `${g.mark}%`, top: -2, bottom: -2, background: "var(--warning)" }} />
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

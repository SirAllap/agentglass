import type { BarGeom, Chart } from "../../lib/insightsModel.ts";
import { dayLabel } from "../../lib/insightsModel.ts";

const UP = "color-mix(in srgb, var(--success) 78%, transparent)";
const DOWN = "color-mix(in srgb, var(--error) 62%, transparent)";

export const Legend = () => (
  <span className="inline-flex items-center gap-3 text-[11px]" style={{ color: "var(--text3)" }}>
    {[["added", UP, 2], ["removed", DOWN, 2], ["commits", "var(--text3)", 99]].map(([t, c, r]) => (
      <span key={t as string} className="inline-flex items-center gap-1.5"><i aria-hidden style={{ width: 8, height: 8, borderRadius: r as number, background: c as string, display: "inline-block" }} />{t}</span>
    ))}
  </span>
);

const title = (b: BarGeom) => (b.commits ? `${dayLabel(b.date)}: ${b.commits} commit${b.commits === 1 ? "" : "s"}` : `${dayLabel(b.date)}: no commits`);

/** Lines added up, removed down, one dot per day under the axis for commits. */
export function DayBars({ chart }: { chart: Chart }) {
  const { w, h, mid } = chart;
  return (
    <svg viewBox={`0 0 ${w} ${h + 16}`} className="block w-full h-auto" role="img" aria-label="Lines added and removed per day">
      <line x1={0} x2={w} y1={mid} y2={mid} stroke="var(--surface-line)" />
      {chart.bars.map((b) => (
        <g key={b.date}>
          <title>{title(b)}</title>
          {!b.commits ? <rect x={b.x} y={mid - 1} width={b.w} height={2} rx={1} fill="var(--surface-line)" /> : (
            <>
              <rect x={b.x} y={mid - b.up} width={b.w} height={Math.max(b.up, 1.5)} rx={Math.min(2, b.w / 2)} fill={UP} />
              {b.down > 0 && <rect x={b.x} y={mid + 1} width={b.w} height={b.down} rx={Math.min(2, b.w / 2)} fill={DOWN} />}
              <circle cx={b.x + b.w / 2} cy={h - 4} r={Math.min(2.2, b.w / 2)} fill="var(--text3)" opacity={0.25 + Math.min(b.commits, 5) * 0.15} />
            </>
          )}
        </g>
      ))}
      {chart.labels.map((l) => (
        <text key={l.x} x={l.x} y={h + 12} fontSize={10} fontFamily="ui-monospace, monospace" fill="var(--text3)">{l.text}</text>
      ))}
    </svg>
  );
}

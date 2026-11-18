import { EDGE } from "../workspace/Chrome.tsx";
import type { GitTone } from "../../lib/gitDialog.ts";
import { laneDots, useLowWindow, type StripDot } from "../../lib/gitStrips.ts";

const INK: Record<GitTone, string> = {
  primary: "var(--text)", neutral: "var(--text2)", warn: "var(--warning)", danger: "var(--error)", merge: "var(--merged)",
};

/**
 * Dots on a line, the Git dialogs' shared strip (rebase, blame). Shape and
 * words carry the meaning, never colour alone. In a low window the drawing goes
 * and only the caption stays.
 */
export function DotStrip({ dots, tone = "primary", caption, label }: { dots: readonly StripDot[]; tone?: GitTone; caption?: string; label: string }) {
  const low = useLowWindow();
  const ink = INK[tone], step = 26, x0 = 12, w = x0 * 2 + Math.max(0, dots.length - 1) * step;
  return (
    <div className="rounded-lg px-3 flex flex-col gap-1.5" style={{ background: "var(--surface-inset)", border: EDGE, paddingBlock: low ? 6 : 10 }}>
      {!low && dots.length > 0 && (
        <div className="agx-scroll overflow-x-auto">
          <svg viewBox={`0 0 ${w} 30`} width={w} height={30} role="img" aria-label={label}>
            <line x1={x0} x2={w - x0} y1={14} y2={14} stroke="var(--border)" strokeWidth={1.5} />
            {dots.map((d, i) => {
              const cx = x0 + i * step;
              return (
                <g key={i}>
                  {d.state === "ring" && <circle cx={cx} cy={14} r={9} fill={ink} opacity={0.16} />}
                  <circle cx={cx} cy={d.state === "merged" ? 20 : 14} r={d.state === "merged" ? 3 : 4.5}
                    fill={d.state === "hollow" || d.state === "off" ? "var(--surface-inset)" : ink}
                    stroke={d.state === "off" ? "var(--text3)" : ink} strokeWidth={1.5} strokeDasharray={d.state === "hollow" ? "2 2" : undefined} />
                  {d.state === "merged" && <path d={`M ${cx} 17 C ${cx} 14, ${cx - 4} 14, ${cx - step + 4} 14`} fill="none" stroke={ink} strokeWidth={1} />}
                </g>
              );
            })}
          </svg>
        </div>
      )}
      {caption && <div className="text-[11px]" style={{ color: "var(--text2)" }}>{caption}</div>}
    </div>
  );
}

/** Bisect: a good…bad bar whose unknown middle narrows with each answer. */
export function RangeStrip({ share, caption }: { share: number; caption: string }) {
  const low = useLowWindow();
  const pct = Math.round(share * 100);
  return (
    <div className="rounded-lg px-3 flex flex-col gap-1.5" style={{ background: "var(--surface-inset)", border: EDGE, paddingBlock: low ? 6 : 10 }}>
      {!low && (
        <div role="img" aria-label={`${pct}% of the range is still untested`} className="flex items-center text-[10px]" style={{ height: 18 }}>
          <span className="shrink-0 pr-1.5" style={{ color: "var(--success-ink)" }}>good</span>
          <div className="flex-1 h-2 rounded-full overflow-hidden flex" style={{ background: "var(--surface-card)", border: EDGE }}>
            <span style={{ flex: `${(1 - share) / 2} 0 0`, background: "var(--success)" }} />
            <span style={{ flex: `${share} 0 0`, background: "repeating-linear-gradient(90deg, var(--text3) 0 3px, transparent 3px 6px)", transition: "flex .2s" }} />
            <span style={{ flex: `${(1 - share) / 2} 0 0`, background: "var(--error)" }} />
          </div>
          <span className="shrink-0 pl-1.5" style={{ color: "var(--error-ink)" }}>bad</span>
        </div>
      )}
      <div className="text-[11px]" style={{ color: "var(--text2)" }}>{caption}</div>
    </div>
  );
}

/** Rescue: one tile per worktree with its kept-file count. */
export function TileStrip({ tiles }: { tiles: readonly { name: string; kept: number; total: number }[] }) {
  const low = useLowWindow();
  if (low) return null;
  return (
    <div className="flex flex-wrap gap-2 px-4 pt-3" role="list" aria-label="Worktrees and the files kept from each">
      {tiles.map((t) => (
        <div key={t.name} role="listitem" className="rounded-lg px-2.5 py-1.5 min-w-0 max-w-[220px]" style={{ background: "var(--surface-inset)", border: EDGE }}>
          <div className="truncate text-[11px] font-mono" data-tip={t.name} style={{ color: "var(--text)" }}>{t.name}</div>
          <div className="text-[10px] tabular-nums" style={{ color: t.kept ? "var(--success-ink)" : "var(--text3)" }}>{t.kept} of {t.total} kept</div>
        </div>
      ))}
    </div>
  );
}

/** Compare: two lanes, commits the other side is ahead by above, behind by below. */
export function LaneStrip({ ahead, behind, other, base }: { ahead: number; behind: number; other: string; base: string }) {
  const low = useLowWindow();
  const lane = (n: number, up: boolean, color: string, text: string) => {
    const { shown, more } = laneDots(n);
    return (
      <div className="flex items-center gap-2 text-[11px]" style={{ minHeight: 16 }}>
        <span className="shrink-0 w-4 text-center" aria-hidden style={{ color }}>{up ? "↑" : "↓"}</span>
        {!low && <svg width={Math.max(8, shown * 14)} height={10} role="img" aria-label={`${n} commits`}>
          {Array.from({ length: shown }, (_, i) => <circle key={i} cx={5 + i * 14} cy={5} r={3.5} fill={color} />)}
        </svg>}
        {!low && more > 0 && <span className="tabular-nums" style={{ color: "var(--text3)" }}>+{more}</span>}
        <span className="min-w-0 truncate" style={{ color: "var(--text2)" }}>{text}</span>
      </div>
    );
  };
  return (
    <div className="mt-3 rounded-lg px-3 flex flex-col gap-1" style={{ background: "var(--surface-inset)", border: EDGE, paddingBlock: low ? 6 : 10 }}>
      {lane(ahead, true, "var(--success)", `${ahead} ahead: on ${other}, not on ${base}`)}
      {lane(behind, false, "var(--warning)", `${behind} behind: on ${base}, not on ${other}`)}
    </div>
  );
}

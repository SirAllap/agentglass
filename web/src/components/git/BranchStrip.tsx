import { BranchIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { EDGE } from "../workspace/Chrome.tsx";
import type { GitTone } from "../../lib/gitDialog.ts";
import { useLowWindow } from "../../lib/gitStrips.ts";

/**
 * The drawing under a Git question: the base as grey dots on a line, the new
 * work in the dialog's tone, the landing dot ringed. `hollow` redraws the last
 * grey dot as an outline (a commit about to be replaced). Pure shape: the
 * words next to it carry the meaning, so colour is never the only sign.
 */
const INK: Record<GitTone, string> = {
  primary: "var(--text)", neutral: "var(--text2)", warn: "var(--warning)", danger: "var(--error)", merge: "var(--merged)",
};
const MONO = "var(--font-mono, ui-monospace, monospace)";

export function BranchStrip({ base = 5, ahead = 0, tone = "primary", landing, hollow, loading, branch, into, become, slot, files, additions, deletions }: {
  base?: number;
  /** Commits already on the branch beyond origin, drawn filled. */
  ahead?: number;
  tone?: GitTone;
  /** The label under the landing dot ("this commit"). */
  landing?: string;
  hollow?: boolean;
  loading?: boolean;
  branch?: string;
  /** The base the branch lands on: drawn as `branch → into`, the head truncating, the base a whole chip. */
  into?: string;
  /** N commits drawn as dots on a lower lane that rejoin the line as one (a squash). */
  become?: number;
  /** The landing dot is a dotted slot, not a ringed dot: nothing is there yet. */
  slot?: boolean;
  files?: number;
  additions?: number;
  deletions?: number;
}) {
  const ink = INK[tone];
  const low = useLowWindow();
  const step = 44, x0 = 14;
  const dots = base + ahead;
  const w = x0 * 2 + (dots + 1) * step;
  const y = 22;
  return (
    <div className="rounded-lg px-3 flex flex-col gap-2" style={{ background: "var(--surface-inset)", border: EDGE, paddingBlock: low ? 6 : 10 }}>
      {low ? (
        // Low window: the drawing shrinks to one thin line (dots only), the chips and the count stay.
        <svg viewBox={`0 0 ${w} 16`} width="100%" height={16} preserveAspectRatio="xMinYMid meet" role="img" aria-label={become && become > 0 ? `${become} become 1` : landing ?? "branch"}>
          <line x1={x0} x2={w - x0} y1={8} y2={8} stroke="var(--border)" strokeWidth={1.5} />
          {Array.from({ length: dots }, (_, i) => <circle key={i} cx={x0 + i * step} cy={8} r={3} fill={i >= base ? ink : "var(--surface-inset)"} stroke={i >= base ? ink : "var(--text3)"} strokeWidth={1.5} />)}
          <circle cx={x0 + dots * step} cy={8} r={4.5} fill="var(--surface-inset)" stroke={ink} strokeWidth={2} strokeDasharray={slot ? "2 2" : undefined} />
        </svg>
      ) : loading ? (
        <div className="motion-safe:animate-pulse rounded" style={{ height: 40, background: "var(--surface-card)" }} role="status" aria-label="Reading" />
      ) : (
        <svg viewBox={`0 0 ${w} 48`} width="100%" height={48} preserveAspectRatio="xMinYMid meet" role="img" aria-label={landing ?? "branch"}>
          <line x1={x0} x2={w - x0} y1={y} y2={y} stroke="var(--border)" strokeWidth={1.5} />
          {Array.from({ length: dots }, (_, i) => {
            const x = x0 + i * step;
            const mine = i >= base;
            const last = i === dots - 1;
            const gone = hollow && last;
            return <circle key={i} cx={x} cy={y} r={4} fill={gone ? "var(--surface-inset)" : mine ? ink : "var(--surface-inset)"}
              stroke={gone ? ink : mine ? ink : "var(--text3)"} strokeWidth={1.5} strokeDasharray={gone ? "2 2" : undefined} />;
          })}
          {become && become > 0 ? (() => {
            const xa = x0 + (dots - 1) * step, xb = x0 + dots * step, ly = 38, n = Math.min(become, 6);
            const lx = (i: number) => xa + 14 + ((xb - xa - 28) * (i + 0.5)) / n;
            return (<>
              <path d={`M ${xa} ${y} C ${xa + 10} ${y}, ${xa + 8} ${ly}, ${xa + 18} ${ly} L ${xb - 18} ${ly} C ${xb - 8} ${ly}, ${xb - 10} ${y}, ${xb} ${y}`} fill="none" stroke={ink} strokeWidth={2} />
              {Array.from({ length: n }, (_, i) => <circle key={i} cx={lx(i)} cy={ly} r={3.5} fill={ink} />)}
              <text x={(xa + xb) / 2} y={ly - 8} textAnchor="middle" fontSize={10} fontWeight={600} fill={ink}>{become} become 1</text>
            </>);
          })() : <line x1={x0 + (dots - 1) * step} x2={x0 + dots * step} y1={y} y2={y} stroke={ink} strokeWidth={slot ? 1.5 : 2} strokeDasharray={slot ? "2 3" : undefined} />}
          {slot ? <circle cx={x0 + dots * step} cy={y} r={5} fill="none" stroke="var(--text3)" strokeWidth={1.5} strokeDasharray="2 2" /> : <>
            <circle cx={x0 + dots * step} cy={y} r={9} fill={ink} opacity={0.14} />
            <circle cx={x0 + dots * step} cy={y} r={5} fill="var(--surface-inset)" stroke={ink} strokeWidth={2} />
            <circle cx={x0 + dots * step} cy={y} r={2} fill={ink} />
          </>}
          {landing && !become && <text x={x0 + dots * step} y={44} textAnchor="end" fontSize={10} fontWeight={600} fill={ink}>{landing}</text>}
        </svg>
      )}
      <div className="flex items-center gap-2 min-w-0 text-[11px]">
        {branch && (
          <span className="inline-flex items-center gap-1.5 px-2 rounded-md min-w-0" data-tip={branch}
            style={{ height: 22, color: "var(--text)", border: EDGE, fontFamily: MONO, background: "var(--surface-card)" }}>
            <BranchIcon size={ICON.xs} /><span className="truncate">{branch}</span>
          </span>
        )}
        {branch && into && (
          <>
            <span aria-label="into" style={{ color: "var(--text3)" }}>→</span>
            <span className="inline-flex items-center gap-1.5 px-2 rounded-md shrink-0" data-tip={into}
              style={{ height: 22, color: "var(--text)", border: EDGE, fontFamily: MONO, background: "var(--surface-card)" }}>
              <BranchIcon size={ICON.xs} />{into}
            </span>
          </>
        )}
        <span className="flex-1" />
        {files !== undefined && (
          <span className="shrink-0" style={{ fontFamily: MONO, color: "var(--text3)" }}>
            {files} file{files === 1 ? "" : "s"}
            {additions !== undefined && <> <span style={{ color: "var(--success-ink, var(--success))" }}>+{additions}</span> <span style={{ color: "var(--error-ink)" }}>−{deletions ?? 0}</span></>}
          </span>
        )}
      </div>
    </div>
  );
}

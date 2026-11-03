import { HIT, ICON } from "../../lib/iconSize.ts";
import type { ChecksView, ReviewState } from "../../lib/paneChip.ts";
import { EDGE, LINE } from "../workspace/Chrome.tsx";
import { HaloRing, PR_COLOR, PR_GLYPH } from "./PaneChipStatus.tsx";
import type { PaneChipStatusCard, PaneChipStatusPr } from "./PaneChipStatus.tsx";

/** The pull request's hover card: what the segment cannot say in its width. The
 *  hero is the same ring the segment wears, and every line says its state in
 *  words, so nothing here is colour alone. The checks come from the rollup the
 *  store read once on reach (and holds for a minute). */
export function PaneChipHover({ pr, checks, review, reviewWord, card, behind }: {
  pr: PaneChipStatusPr; checks: ChecksView; review: ReviewState; reviewWord?: string; card: PaneChipStatusCard | null; behind?: number;
}) {
  const frozen = pr.state === "merged" || pr.state === "closed";
  const line =
    checks.state === "failing" ? `${checks.failing.length} of ${checks.total} checks failing · ${checks.failing.join(", ")}`
    : checks.state === "passing" ? `${checks.passed} of ${checks.total} checks passed`
    : checks.state === "running" ? `Checks running · ${checks.passed} of ${checks.total} done`
    : checks.state === "error" ? "Could not read the checks"
    : "Checks not read yet";
  const ink = (k: "error" | "success" | "warning") => `var(--${k}-ink, var(--${k}))`;
  const checkIcon = checks.state === "failing" ? { c: ink("error"), g: <path d="M18 6 6 18M6 6l12 12" /> }
    : checks.state === "passing" ? { c: ink("success"), g: <path d="M20 6 9 17l-5-5" /> }
    : checks.state === "running" ? { c: ink("warning"), g: <circle cx="12" cy="12" r="5" /> }
    : { c: "var(--text3)", g: <circle cx="12" cy="12" r="6" strokeDasharray="3 3" /> };
  const reviewIcon = review === "changes" ? { c: ink("warning"), g: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></> }
    : review === "approved" ? { c: ink("success"), g: <path d="M20 6 9 17l-5-5" /> }
    : { c: "var(--text3)", g: <circle cx="12" cy="12" r="5" /> };
  const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, fontSize: 11.5 };
  const Icon = ({ c, g }: { c: string; g: React.ReactNode }) => (
    <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">{g}</svg>
  );
  return (
    <div role="status" className="absolute z-20 text-left"
      style={{
        bottom: HIT + 8, right: 0, width: 316, padding: "12px 12px 10px", borderRadius: 14, background: "var(--bg)", border: EDGE,
        boxShadow: "0 0 0 1px rgba(0,0,0,.06), 0 3px 3px -1.5px rgba(0,0,0,.06), 0 12px 12px -6px rgba(0,0,0,.06), 0 24px 24px -12px rgba(0,0,0,.06)",
        color: "var(--text2)", fontSize: 12, lineHeight: 1.45, whiteSpace: "normal", transformOrigin: "bottom right",
        animation: "agx-chip-card .125s cubic-bezier(.23,1,.32,1)",
      }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="agx-halo-ring" style={{ ["--sc" as string]: PR_COLOR[pr.state], transform: "scale(1.45)", margin: "6px 8px 6px 6px" }}>
          <HaloRing checks={checks} frozen={frozen} />
          <span className="agx-halo-pi"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>{PR_GLYPH[pr.state]}</svg></span>
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, color: "var(--text)", fontSize: 12.5, lineHeight: 1.3 }}>{pr.title || `Pull request #${pr.number}`}</div>
          <div className="t-mono" style={{ fontSize: 10.5, color: "var(--text3)", marginTop: 2 }}>#{pr.number} · {pr.state}{pr.author ? ` · ${pr.author}` : ""}{pr.base ? ` → ${pr.base}` : ""}</div>
        </div>
      </div>
      <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
        <div style={row}><Icon {...checkIcon} /><span>{line}</span></div>
        {reviewWord && review !== "none" && <div style={row}><Icon {...reviewIcon} /><span>{reviewWord}</span></div>}
        {(behind ?? 0) > 0 && <div style={row}><Icon c="var(--text3)" g={<circle cx="12" cy="12" r="5" />} /><span>{behind} commit{behind === 1 ? "" : "s"} behind its upstream</span></div>}
        {card && <div style={row}><Icon c="var(--text3)" g={<><path d="M4 22V4" /><path d="M4 4h13l-2 4 2 4H4" /></>} /><span>{card.id}{card.priority ? ` · ${card.priority}` : ""}{card.status ? ` · ${card.status}` : ""}</span></div>}
      </div>
      <div className="t-mono flex justify-between" style={{ marginTop: 10, paddingTop: 8, borderTop: LINE, fontSize: 10.5, color: "var(--text3)" }}>
        <span>Enter opens in Pull requests</span><span>Esc</span>
      </div>
    </div>
  );
}

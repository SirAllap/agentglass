/*
 * After a reboot: one pill over the top of the pane that says what came back.
 *
 * Nothing resumes by itself. The banner says how many windows were rebuilt with
 * their scrollback and how many of them were running an agent, and offers the
 * one action for all of them. "Not now" only puts the pill away (remembered
 * against that restore, so a reload does not bring it back and the next
 * restore does); each window keeps its own card until it is answered.
 */
import { ClockIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { LAYER } from "../../lib/layers.ts";
import type { RestoredBanner } from "../../lib/restoreCards.ts";
import { Button, tintEdge } from "../workspace/Chrome.tsx";

export function RestoreBannerPill({ banner, onResumeAll, onNotNow }: {
  banner: RestoredBanner;
  onResumeAll: () => void;
  onNotNow: () => void;
}) {
  return (
    <div role="status" className="agx-card-in absolute flex items-center gap-2 rounded-xl pl-3 pr-2 py-1.5"
      style={{
        top: 10, left: "50%", translate: "-50% 0", width: "max-content", maxWidth: "calc(100% - 140px)", zIndex: LAYER.pane,
        color: "var(--text2)", background: "color-mix(in srgb, var(--primary) 7%, var(--bg))",
        border: tintEdge("var(--primary)", 28), backdropFilter: "blur(10px)",
        boxShadow: "var(--surface-lift), 0 12px 32px -12px var(--shadow)",
      }}>
      <span aria-hidden className="shrink-0" style={{ color: "var(--primary-ink)" }}><ClockIcon size={ICON.sm} /></span>
      <span className="min-w-0 text-[12px] leading-snug">{banner.text}</span>
      {banner.resumeLabel && <Button size="compact" tone="primary" onClick={onResumeAll}>{banner.resumeLabel}</Button>}
      <Button size="compact" tone="quiet" onClick={onNotNow}>Not now</Button>
    </div>
  );
}

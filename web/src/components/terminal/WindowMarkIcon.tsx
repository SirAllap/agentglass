/*
 * The one mark a window can carry (lib/windowMark.ts decides which), drawn the
 * same in the tab and in the Go list.
 *
 * Amber is a question for you, red is a window that failed, the breathing ring
 * is work in progress, the clock is a window that came back after a restart
 * with nothing running in it. Shape and colour both: amber, red and green are
 * three of the colours most often seen as one.
 */
import { ClockIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { sharedPhase } from "../../lib/sharedPhase.ts";
import type { Mark } from "../../lib/windowMark.ts";

export function WindowMarkIcon({ mark, label }: { mark: Mark; label: string }) {
  if (mark === "restored") return <span className="flex shrink-0" style={{ color: "var(--text4)" }} role="img" aria-label={label}><ClockIcon size={ICON.xs} /></span>;
  if (mark === "working") {
    // The phone mark's breathe, on the shared clock, so a screen of busy
    // windows steps in phase. It is a ring, not a disc: a disc is "done" in
    // the tick's family and a ring that moves reads as still going.
    return (
      <span className="shrink-0 w-2 h-2 mx-0.5 rounded-full" role="img" aria-label={label}
        style={{ boxShadow: "inset 0 0 0 2px var(--primary)", animation: "agx-phone-pulse 1.8s ease-in-out infinite", animationDelay: sharedPhase(1800) }} />
    );
  }
  const amber = mark === "needs-you";
  const hue = amber ? "var(--warning)" : "var(--error)";
  return (
    <span className="shrink-0 w-3.5 h-3.5 rounded-full grid place-items-center" role="img" aria-label={label}
      style={{ background: hue, color: "var(--on-primary)", boxShadow: amber ? `0 0 0 3px color-mix(in srgb, ${hue} 20%, transparent)` : undefined }}>
      <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden>
        {amber ? <path d="M6 3v3.4M6 8.8v.1" /> : <path d="M4.2 4.2l3.6 3.6M7.8 4.2L4.2 7.8" />}
      </svg>
    </span>
  );
}

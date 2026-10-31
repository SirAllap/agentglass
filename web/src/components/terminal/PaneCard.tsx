/*
 * A card drawn over the pane: the one shape the Terminal uses to say "this
 * window is not what it was" (restored after a reboot, its process exited) and
 * "there is no window to show" (empty, connecting, tmux unreachable).
 *
 * It sits in the pane area on the pane layer, under the strip, so the tabs, the
 * gear and the Commands button stay reachable. The sheet dims what is behind it
 * without hiding it: the scrollback a restore brought back is still readable
 * through the veil.
 */
import type { ReactNode } from "react";
import { LAYER } from "../../lib/layers.ts";
import { EDGE, tintEdge } from "../workspace/Chrome.tsx";

export function PaneSheet({ veil = 40, children }: { veil?: number; children: ReactNode }) {
  return (
    <div className="absolute inset-0 grid place-items-center p-4 pointer-events-none"
      style={{ zIndex: LAYER.pane, background: `color-mix(in srgb, var(--bg) ${veil}%, transparent)` }}>
      {children}
    </div>
  );
}

/** The small square an icon sits in, tinted the card's colour. */
export function IconTile({ tint, size = 28, children }: { tint: string; size?: number; children: ReactNode }) {
  return (
    <span aria-hidden className="shrink-0 inline-flex items-center justify-center rounded-lg"
      style={{ width: size, height: size, color: tint, background: `color-mix(in srgb, ${tint} 12%, var(--bg))`, border: tintEdge(tint, 24) }}>
      {children}
    </span>
  );
}

export function PaneCard({ icon, tint, title, role = "group", label, late = false, children, actions }: {
  icon: ReactNode;
  tint: string;
  title: string;
  role?: "group" | "status" | "alert";
  /** The card's accessible name, when the title alone is not it. */
  label?: string;
  /** Arrive after a beat, for a state that is usually over in a blink. */
  late?: boolean;
  /** The sentence under the title. */
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div role={role} aria-label={label ?? title}
      className={`${late ? "agx-card-late" : "agx-card-in"} pointer-events-auto flex flex-col gap-3 rounded-xl p-4`}
      style={{
        width: 420, maxWidth: "100%",
        background: `color-mix(in srgb, ${tint} 5%, var(--bg))`,
        border: tint === "var(--text3)" ? EDGE : tintEdge(tint, 28),
        boxShadow: "var(--surface-lift), 0 18px 44px -14px var(--shadow)",
      }}>
      <div className="flex items-start gap-3 min-w-0">
        <IconTile tint={tint}>{icon}</IconTile>
        <div className="min-w-0 flex flex-col gap-1">
          <h3 className="m-0 text-[13px] font-semibold leading-snug" style={{ color: "var(--text)" }}>{title}</h3>
          {children && <p className="m-0 text-[12px] leading-relaxed" style={{ color: "var(--text2)" }}>{children}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 pl-10">{actions}</div>}
    </div>
  );
}

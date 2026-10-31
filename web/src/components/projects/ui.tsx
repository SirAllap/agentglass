// The small parts the Open projects modal is drawn from: a tinted tile, a
// badge, a key cap, a state card and a pane header. Colours are theme tokens
// only (`--primary`, `--success`, …), so dark is the same markup.
import type { CSSProperties, ReactNode } from "react";
import { Button, LINE } from "../workspace/Chrome.tsx";
import { ICON } from "../../lib/iconSize.ts";

export const wash = (hue: string, pct = 12) => `color-mix(in srgb, ${hue} ${pct}%, transparent)`;
export const ring = (hue: string, pct = 26) => `inset 0 0 0 1px color-mix(in srgb, ${hue} ${pct}%, transparent)`;
export const HAIR = LINE;

export type Hue = "primary" | "success" | "warning" | "error" | "info" | "muted";
export const HUE: Record<Hue, string> = {
  primary: "var(--primary)", success: "var(--success)", warning: "var(--warning)", error: "var(--error)", info: "var(--info, #3b82f6)", muted: "var(--text3)",
};

/** A square tile that centres its icon: 22 for a row, 40 for a state card. */
export function Tile({ hue = "primary", size = 22, children, spin }: { hue?: Hue; size?: number; children: ReactNode; spin?: boolean }) {
  return (
    <span className="shrink-0 grid place-items-center" aria-hidden="true"
      style={{ width: size, height: size, borderRadius: size > 30 ? 11 : 7, color: HUE[hue], background: wash(HUE[hue], 13), boxShadow: ring(HUE[hue], 24) }}>
      <span className={spin ? "agx-spin inline-flex" : "inline-flex"}>{children}</span>
    </span>
  );
}

/** A status pill. `title` says what it means in full when the text is short. */
export function Status({ hue = "muted", children, title, style }: { hue?: Hue; children: ReactNode; title?: string; style?: CSSProperties }) {
  return (
    <span title={title} className="inline-flex items-center gap-1 whitespace-nowrap rounded-full font-semibold"
      style={{ height: 19, padding: "0 8px", fontSize: 11, color: HUE[hue], background: wash(HUE[hue], 11), boxShadow: ring(HUE[hue], 22), ...style }}>
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="font-mono font-semibold rounded-md"
      style={{ fontSize: 10, padding: "2px 6px", color: "var(--text3)", background: "var(--bg2, transparent)", boxShadow: ring("var(--text)", 14) }}>{children}</kbd>
  );
}

/** A card that says what is happening or what went wrong, on the row grid's left edge. */
export function StateCard({ hue, icon, title, badge, children, actions, spin, mono }: {
  hue: Hue; icon: ReactNode; title: ReactNode; badge?: ReactNode; children?: ReactNode; actions?: ReactNode; spin?: boolean; mono?: boolean;
}) {
  return (
    <div role="status" className="grid gap-x-3.5 rounded-xl" data-state-card
      style={{ margin: "10px 18px", padding: 14, gridTemplateColumns: "40px minmax(0,1fr)", background: wash(HUE[hue], 6), boxShadow: ring(HUE[hue], 26) }}>
      <Tile hue={hue} size={40} spin={spin}>{icon}</Tile>
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap" style={{ minHeight: 24 }}>
          <b className={`text-[13px] min-w-0 ${mono ? "font-mono" : ""}`} style={{ overflowWrap: "anywhere", color: "var(--text)" }}>{title}</b>
          {badge}
        </div>
        {children && <div className="text-[12px] mt-1" style={{ color: "var(--text2)", overflowWrap: "anywhere" }}>{children}</div>}
        {actions && <div className="flex items-center gap-2 flex-wrap mt-3">{actions}</div>}
      </div>
    </div>
  );
}

/** The header of a pane that is not the list: Back, a title, a quiet subtitle. */
export function PaneHead({ title, sub, onBack, backDisabled }: { title: string; sub?: string; onBack: () => void; backDisabled?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 shrink-0 pm-px" style={{ height: 46 }}>
      <Button size="compact" onClick={onBack} disabled={backDisabled} title="Back (Esc)">‹ Back</Button>
      <h3 className="m-0 text-[14px] font-bold min-w-0 truncate" style={{ color: "var(--text)" }}>{title}</h3>
      {sub && <span className="text-[12px] truncate ml-auto" style={{ color: "var(--text3)" }}>{sub}</span>}
    </div>
  );
}

/** A disabled control that says why: the reason rides on the wrapper, because a
 *  disabled button gets no hover of its own. */
export function Why({ reason, children }: { reason?: string; children: ReactNode }) {
  return <span title={reason || undefined} className="inline-flex" aria-label={reason}>{children}</span>;
}

/** Footer bar: keys on the left, actions on the right, fixed at the bottom of its pane. */
export function Foot({ hint, children }: { hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 shrink-0 pm-px py-2.5 min-w-0" style={{ borderTop: HAIR, background: "var(--surface-card)" }}>
      {hint && <span className="flex items-center gap-2.5 whitespace-nowrap min-w-0 overflow-hidden text-[11px]" style={{ color: "var(--text4)" }}>{hint}</span>}
      <span className="flex-1" />
      {children}
    </div>
  );
}

export const ICON_TILE = ICON.sm;

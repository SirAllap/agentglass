/*
 * The strip between two hunks (and above the first, and below the last) that
 * stands for the lines the diff leaves out. Its buttons reveal them, the way
 * github.com's do: twenty at a time towards the hunk they hang off, or all of
 * them once few enough remain.
 *
 * The lines themselves are not drawn here: `expandHunks` splices them into the
 * neighbouring hunks as context, so the two diff views number, colour and wrap
 * them like any other line. This is only the control.
 */
import type { CSSProperties } from "react";
import { EXPAND_STEP, type OpenGap } from "../../../../shared/diffGaps.ts";
import { CaretIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";

const BTN = "agx-btn inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px]";

export function GapRow({ gap, busy, error, onExpand }: {
  gap: OpenGap; busy?: boolean; error?: string | null;
  onExpand: (dir: "up" | "down" | "all") => void;
}) {
  const n = gap.hidden;
  // Few enough that stepping would be a click or two for nothing.
  const small = n != null && n <= EXPAND_STEP;
  const style: CSSProperties = { color: "var(--text3)" };
  const label = (dir: "up" | "down") => `Show ${EXPAND_STEP} more lines ${dir === "up" ? "above" : "below"}`;
  return (
    // `sticky left-0` so the buttons stay in view when a long line scrolls the pane sideways.
    <div className="py-0.5" style={{ background: "color-mix(in srgb, var(--border) 10%, transparent)" }}>
      <span className="sticky left-0 inline-flex items-center gap-1 px-3">
        {small ? (
          <button type="button" disabled={busy} onClick={() => onExpand("all")} className={BTN} style={style}
            title={`Show the ${n} hidden line${n === 1 ? "" : "s"}`}>
            <CaretIcon size={ICON.xs} />{n} hidden line{n === 1 ? "" : "s"}
          </button>
        ) : (
          <>
            {gap.down && (
              <button type="button" disabled={busy} onClick={() => onExpand("down")} className={BTN} style={style} title={label("down")} aria-label={label("down")}>
                <CaretIcon size={ICON.xs} />{n == null ? "Show lines below" : ""}
              </button>
            )}
            {gap.up && (
              <button type="button" disabled={busy} onClick={() => onExpand("up")} className={BTN} style={style} title={label("up")} aria-label={label("up")}>
                <span style={{ display: "inline-flex", transform: "rotate(180deg)" }}><CaretIcon size={ICON.xs} /></span>
              </button>
            )}
            {n != null && (
              <button type="button" disabled={busy} onClick={() => onExpand("all")} className={BTN} style={style} title={`Show all ${n} hidden lines`}>
                {n} hidden lines
              </button>
            )}
          </>
        )}
        {error && <span className="text-[10.5px]" style={{ color: "var(--error)" }}>{error}</span>}
      </span>
    </div>
  );
}

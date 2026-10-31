/*
 * One window in the strip, kept quiet.
 *
 * A name, a pin when it is pinned, an x on hover. The only other ink is ONE
 * mark, and only when it matters (lib/windowMark.ts): you are wanted, it
 * failed, it is working, it was restored. New output is a bold name rather
 * than a second mark, so it can sit beside one. Alt and the armed prefix put a
 * number inside the tab; it is inside, not above, so nothing is ever clipped
 * by the row above or the edge of the strip.
 *
 * The phone badge, the zoom flag and the rename / move boxes are the tab's
 * from before the redesign, kept where they were. A bell is the bold name.
 */
import type { HTMLAttributes } from "react";
import type { TmuxWindow } from "../../../../shared/types.ts";
import { ExpandIcon, PinIcon } from "../../lib/glyphIcons.tsx";
import { ICON, MIN_BOX } from "../../lib/iconSize.ts";
import { sharedPhase } from "../../lib/sharedPhase.ts";
import type { WindowMark } from "../../lib/windowMark.ts";
import { CloseButton } from "../CloseButton.tsx";
import { CTRL_H, EDGE, tintEdge } from "../workspace/Chrome.tsx";
import { WindowMarkIcon } from "./WindowMarkIcon.tsx";

export interface WindowTabProps {
  w: TmuxWindow;
  active: boolean;
  mark: WindowMark;
  /** The Alt / prefix number to draw inside the tab, or null. */
  no: number | null;
  /** The tab is being carried, or is where the carried one would land. */
  dragging: boolean;
  dropBefore: boolean;
  /** The rename box and the move box are the tab's own inputs. */
  renaming: boolean;
  moving: boolean;
  /** For the phone badge's tooltip: this terminal's width, when known. */
  clientCols: number | null;
  /** Drag and drop handlers, built by the strip so one path sends the commands. */
  dnd: HTMLAttributes<HTMLDivElement>;
  onSelect: () => void;
  onClose: () => void;
  onStartRename: () => void;
  onRename: (name: string | null) => void;
  onMove: (to: string | null) => void;
  onMenu: (x: number, y: number) => void;
}

const BOX = "bg-transparent outline-none text-[11.5px]";
const BOX_STYLE = { color: "var(--text)", height: 20, borderRadius: 5, border: tintEdge("var(--primary)", 100), paddingInline: 4 } as const;

export function WindowTab({
  w, active, mark, no, dragging, dropBefore, renaming, moving, clientCols, dnd,
  onSelect, onClose, onStartRename, onRename, onMove, onMenu,
}: WindowTabProps) {
  const zoomed = w.flags.includes("Z");
  return (
    <div
      {...dnd}
      role="tab"
      data-window={w.id}
      aria-selected={active}
      aria-label={mark.label}
      tabIndex={active ? 0 : -1}
      draggable={!renaming && !moving}
      onClick={onSelect}
      onDoubleClick={onStartRename}
      // Middle-click closes, like a browser tab. Prevented on mousedown so the
      // platform's autoscroll does not start under the pointer.
      onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}
      onContextMenu={(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY); }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); }
      }}
      className={`group relative flex items-center gap-1.5 pl-2 pr-1 shrink-0 rounded-lg text-[11.5px] cursor-pointer select-none transition-colors ${active ? "" : "hover:bg-[var(--surface-inset)]"}`}
      style={{
        height: CTRL_H.strip,
        maxWidth: 200,
        color: active || mark.unread ? "var(--text)" : mark.mark === "restored" ? "var(--text3)" : "var(--text2)",
        background: active ? "var(--bg)" : undefined,
        border: active ? EDGE : tintEdge("var(--text)", 0),
        boxShadow: active ? "0 1px 2px color-mix(in srgb, #000 8%, transparent)" : undefined,
        // The carried tab fades; the one it would land before takes a line on
        // its leading edge, which is where it will actually go.
        opacity: dragging ? 0.4 : undefined,
        ...(dropBefore ? { boxShadow: "-2px 0 0 0 var(--primary)" } : null),
      }}>
      {no !== null && (
        <span className="shrink-0 min-w-3.5 h-3.5 px-0.5 rounded-md grid place-items-center text-[9.5px] font-semibold tabular-nums leading-none"
          style={{ background: "var(--text)", color: "var(--bg)" }}>{no}</span>
      )}
      {mark.mark && <WindowMarkIcon mark={mark.mark} label={mark.title} />}
      {moving ? (
        // The number it moves to: `prefix .` asks which, and the box is right
        // here on the tab it is asking about.
        <input
          autoFocus
          defaultValue={String(w.index)}
          inputMode="numeric"
          aria-label="Move this window to number"
          onClick={(e) => e.stopPropagation()}
          onBlur={() => onMove(null)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { onMove(null); return; }
            if (e.key === "Enter") onMove((e.target as HTMLInputElement).value.trim());
          }}
          className={`${BOX} w-10 tabular-nums text-center`} style={BOX_STYLE} />
      ) : renaming ? (
        <input
          autoFocus
          defaultValue={w.name}
          aria-label="Window name"
          onClick={(e) => e.stopPropagation()}
          onBlur={() => onRename(null)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { onRename(null); return; }
            if (e.key === "Enter") onRename((e.target as HTMLInputElement).value.trim());
          }}
          className={`${BOX} w-24`} style={BOX_STYLE} />
      ) : (
        // Cut at 16 characters: one long name used to push every tab after it
        // off the row. The whole name is in the tab's tooltip.
        <span className={`inline-block max-w-[16ch] truncate ${mark.unread ? "font-semibold" : ""}`}>{w.name || "shell"}</span>
      )}
      {w.pinned && <span className="flex shrink-0" style={{ color: "var(--text4)" }} role="img" aria-label="pinned"><PinIcon size={ICON.xs} /></span>}
      {zoomed && <span className="flex shrink-0" style={{ color: "var(--text4)" }} title="A pane in this window is zoomed"><ExpandIcon size={ICON.xs} /></span>}
      {/* A phone is watching a pane in this window. The only mark in the strip
          that is about a PERSON rather than the work: a phone joins as a grouped
          session, so whatever it does arrives looking like the machine did it by
          itself, and this is what says otherwise. The title names both grids,
          because "a phone is here" and "a phone is costing you 140 columns" are
          different news in the same pixels. */}
      {w.phone && (
        <span className="inline-flex items-center shrink-0"
          title={w.cols && clientCols
            ? `Your phone is on a pane in this window — it is ${w.cols} columns and your terminal is ${clientCols}`
            : "Your phone is on a pane in this window"}>
          {/* A mark to notice rather than a target to hit.
              icon-floor-exempt: a status badge, not a control */}
          <svg width="9" height="13" viewBox="0 0 10 14" aria-label="phone attached"
            style={{ color: "var(--phone)", animation: "agx-phone-pulse 1.8s ease-in-out infinite", animationDelay: sharedPhase(1800) }}>
            <rect x="0.7" y="0.7" width="8.6" height="12.6" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="5" cy="10.8" r="0.9" fill="currentColor" />
          </svg>
        </span>
      )}
      <span className={`shrink-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ${active ? "opacity-70" : "opacity-0"}`}>
        <CloseButton onClick={(e) => { e.stopPropagation(); onClose(); }} title="Close window" size={ICON.xs} hit={MIN_BOX} tabIndex={active ? 0 : -1} />
      </span>
      {active && <span aria-hidden className="absolute left-2 right-2 -bottom-[1.5px] h-[1.5px]" style={{ background: "var(--primary)", clipPath: "polygon(0 50%, 5% 0, 95% 0, 100% 50%, 95% 100%, 5% 100%)" }} />}
    </div>
  );
}

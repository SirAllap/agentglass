import { useSyncExternalStore, useState } from "react";
import { VIEWS, loadViewOrder, saveViewOrder, subscribeViewOrder, type ViewId } from "./views.ts";
import { MOD_KEY } from "../../lib/format.ts";

export type RailPip = { dot?: boolean; count?: number };

/** Icon-only switcher down the side of the workspace.
 *
 *  Deliberately 52px and wordless: this is the frame around every view, so
 *  every pixel it takes is taken from the thing you actually came to look at.
 *  The name lives in a hover tooltip, and after a day nobody uses the rail
 *  anyway — the letter keys are faster. Status (a live shell, a chat that
 *  replied) rides as a corner pip so it costs no width at all.
 */
export function ViewRail({
  view, onSelect, onClose, pips,
}: {
  view: ViewId;
  onSelect: (v: ViewId) => void;
  onClose: () => void;
  pips?: Partial<Record<ViewId, RailPip>>;
}) {
  // Arrow keys move between tabs, matching the tablist pattern. Without this
  // the rail is reachable by Tab but not traversable, which is the usual way
  // an icon rail fails a keyboard user.
  // The rail's order is the user's. Read through a store so a drag updates
  // every mounted rail at once rather than only the one being dragged.
  const order = useSyncExternalStore(subscribeViewOrder, loadViewOrder, () => VIEWS);
  const [dragId, setDragId] = useState<ViewId | null>(null);

  const moveTo = (from: ViewId, to: ViewId) => {
    if (from === to) return;
    const ids = order.map((v) => v.id).filter((id) => id !== from);
    ids.splice(ids.indexOf(to), 0, from);
    saveViewOrder(ids);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = order.findIndex((v) => v.id === view);
    const n = order[(i + (e.key === "ArrowDown" ? 1 : order.length - 1)) % order.length];
    onSelect(n.id);
    (e.currentTarget.querySelector(`[data-view="${n.id}"]`) as HTMLElement | null)?.focus();
  };

  return (
    <nav
      role="tablist"
      aria-label="Workspace views"
      onKeyDown={onKeyDown}
      className="w-[52px] shrink-0 flex flex-col gap-[3px] p-2 overflow-visible"
      style={{
        borderRight: "1px solid color-mix(in srgb, var(--primary) 14%, transparent)",
        background: "color-mix(in srgb, var(--bg) 55%, transparent)",
      }}
    >
      {order.map((v, i) => {
        const on = v.id === view;
        const pip = pips?.[v.id];
        const Icon = v.icon;
        return (
          <button
            key={v.id}
            data-view={v.id}
            role="tab"
            aria-selected={on}
            aria-label={v.label}
            tabIndex={on ? 0 : -1}
            onClick={() => onSelect(v.id)}
            // Drag to reorder. HTML5 dnd rather than pointer maths: this is a
            // single column of five, the browser already handles the pickup,
            // the ghost and the drop, and reimplementing that by hand buys
            // nothing here.
            draggable
            onDragStart={(e) => { setDragId(v.id); e.dataTransfer.effectAllowed = "move"; }}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
            onDrop={(e) => { e.preventDefault(); if (dragId) moveTo(dragId, v.id); setDragId(null); }}
            onDragEnd={() => setDragId(null)}
            className="agw-tip relative h-10 w-full grid place-items-center rounded-[10px] transition-colors"
            // The modifier binding, not the bare letter. Inside the workspace
            // the letters no longer navigate — they belong to whatever has
            // focus, usually a shell — and a tooltip advertising a key that
            // does nothing is worse than no tooltip.
            data-tip={`${v.label} · ${MOD_KEY}${i + 1}`}
            style={{
              color: on ? "var(--primary-hover)" : "var(--text4)",
              background: on ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "transparent",
              // The one being dragged fades, so the gap it will leave is legible.
              opacity: dragId === v.id ? 0.4 : undefined,
              cursor: dragId ? "grabbing" : undefined,
            }}
          >
            <Icon size={17} />
            {/* the 3px edge marker: reads as "you are here" from the far side
                of the screen, where a background tint alone doesn't. */}
            {on && (
              <span className="absolute left-[-8px] top-[9px] bottom-[9px] w-[3px] rounded-r-[3px]"
                style={{ background: "var(--primary)" }} />
            )}
            {pip?.count ? (
              <span className="absolute top-[5px] right-[6px] min-w-[14px] h-[14px] px-[3px] grid place-items-center rounded-full text-[9px] font-bold tabular-nums"
                style={{ background: "var(--success)", color: "#06281c" }}>{pip.count}</span>
            ) : pip?.dot ? (
              <span className="absolute top-[7px] right-[9px] w-[6px] h-[6px] rounded-full"
                style={{ background: "var(--success)", boxShadow: "0 0 0 3px color-mix(in srgb, var(--success) 22%, transparent)" }} />
            ) : null}
          </button>
        );
      })}

      <div className="mt-auto pt-2" style={{ borderTop: "1px solid color-mix(in srgb, var(--primary) 10%, transparent)" }}>
        <button
          onClick={onClose}
          aria-label="Close workspace"
          data-tip="close · esc"
          className="agw-tip relative h-10 w-full grid place-items-center rounded-[10px] transition-colors"
          style={{ color: "var(--text4)" }}
        >
          <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </nav>
  );
}

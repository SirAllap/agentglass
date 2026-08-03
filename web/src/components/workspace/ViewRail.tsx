import { useSyncExternalStore, useState } from "react";
import { VIEWS, loadViewOrder, saveViewOrder, subscribeViewOrder, type ViewId } from "./views.ts";
import { chordFor, chordLabel, chords, subscribeBindings } from "../../lib/keybindings.ts";
import { SkillsIcon } from "./icons.tsx";
import { PortsIcon, ResourcesIcon } from "../Header.tsx";

const EMPTY_CHORDS = {};

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
  view, onSelect, onSkills, onSettings, onMachine, pips,
}: {
  view: ViewId;
  onSelect: (v: ViewId) => void;
  onSkills: () => void;
  /** Preferences, reachable from in here.
   *
   *  The workspace covers the whole window, so until now opening it meant
   *  giving up every control in the header — including the only route to
   *  settings. "Close the workspace to change a setting, then open it again"
   *  is not a workflow, it is a missing button. */
  onSettings: () => void;
  /** Ports and resources, the same pair the header carries, in the same order —
   *  so the machine is looked at from one place whichever surface you are on. */
  onMachine: (tab: "ports" | "resources") => void;
  pips?: Partial<Record<ViewId, RailPip>>;
}) {
  // Arrow keys move between tabs, matching the tablist pattern. Without this
  // the rail is reachable by Tab but not traversable, which is the usual way
  // an icon rail fails a keyboard user.
  // The rail's order is the user's. Read through a store so a drag updates
  // every mounted rail at once rather than only the one being dragged.
  const order = useSyncExternalStore(subscribeViewOrder, loadViewOrder, () => VIEWS);
  // Re-render when a shortcut is rebound, so the tooltips keep telling the
  // truth. chordFor reads the store itself; this only supplies the signal.
  useSyncExternalStore(subscribeBindings, chords, () => EMPTY_CHORDS);
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
            data-tip={`${v.label} · ${chordLabel(chordFor(v.id, order.map((x) => x.id)) || `mod+${i + 1}`)}`}
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

      <div className="mt-auto pt-2 flex flex-col gap-[3px]" style={{ borderTop: "1px solid color-mix(in srgb, var(--primary) 10%, transparent)" }}>
        {/* The window's own controls, not the fleet's — which is why they live
            below the divider with close, rather than among the tabs where they
            would imply a view you can come back to. Same three, same order, as
            the dashboard header. */}
        <button
          onClick={() => onMachine("ports")}
          aria-label="Ports"
          data-tip="Ports · what is listening, and from which checkout"
          className="agw-tip relative h-10 w-full grid place-items-center rounded-[10px] transition-colors"
          style={{ color: "var(--text4)" }}
        >
          <PortsIcon size={16} />
        </button>
        <button
          onClick={() => onMachine("resources")}
          aria-label="Resources"
          data-tip="Resources · CPU, memory and disk, by checkout"
          className="agw-tip relative h-10 w-full grid place-items-center rounded-[10px] transition-colors"
          style={{ color: "var(--text4)" }}
        >
          <ResourcesIcon size={16} />
        </button>
        <button
          onClick={onSettings}
          aria-label="Settings"
          data-tip="Settings · preferences, exports, shortcuts"
          className="agw-tip relative h-10 w-full grid place-items-center rounded-[10px] transition-colors"
          style={{ color: "var(--text4)" }}
        >
          <RailGear size={16} />
        </button>
        {/* The catalog is reference, not a view: it opens over the workspace and
            hands it straight back, so it belongs down here with close rather
            than among the tabs, where it would imply state you can return to. */}
        <button
          onClick={onSkills}
          aria-label="Skills catalog"
          data-tip="Skills catalog · what this fleet can do"
          className="agw-tip relative h-10 w-full grid place-items-center rounded-[10px] transition-colors"
          style={{ color: "var(--text4)" }}
        >
          <SkillsIcon size={16} />
        </button>
      </div>
    </nav>
  );
}

/** The same cog the header uses. Kept here rather than exported from Header
 *  alongside the other two: that one is styled for an 8px button and this rail
 *  draws at 16, and a shared icon that needs a size prop per caller is just two
 *  icons with extra steps. */
function RailGear({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
    </svg>
  );
}

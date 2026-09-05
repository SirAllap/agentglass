import { useSyncExternalStore, useState, useEffect, useRef, type ReactNode } from "react";
import {
  VIEWS, SHIPPED_RAIL, loadRail, saveRail, subscribeRail, railIds, withMove, moveView,
  type RailPlace, type ViewDef, type ViewId,
} from "./views.ts";
import { chordFor, chordLabel, chords, subscribeBindings } from "../../lib/keybindings.ts";
import { SkillsIcon } from "./icons.tsx";
import { PortsIcon, ResourcesIcon } from "../Header.tsx";
import { ContextMenu as RailMenu, MenuItem } from "../ContextMenu.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { railActiveColor } from "../../lib/railAccent.ts";

const EMPTY_CHORDS = {};
const BY_ID = new Map(VIEWS.map((v) => [v.id, v] as const));

/** Where the ghost currently sits: a drawer, and an index into that drawer's
 *  list with the dragged view taken out. */
type Slot = { place: RailPlace; index: number };

export type RailPip = { dot?: boolean; count?: number };

/** Icon-only switcher down the side of the workspace.
 *
 *  Deliberately 52px and wordless: this is the frame around every view, so
 *  every pixel it takes is taken from the thing you actually came to look at.
 *  The name lives in a hover tooltip, and after a day nobody uses the rail
 *  anyway — the letter keys are faster. Status (a live shell, a chat that
 *  replied) rides as a corner pip so it costs no width at all.
 *
 *  Two drawers and a back pocket. The top is where you work, the bottom is
 *  what you go and look at, and anything you never open can leave the rail
 *  altogether — by drag, by right-click, or from Settings → Rail. Nothing is
 *  ever destroyed: hidden views collect behind one button that only exists
 *  while there is something in it.
 */
/** The active icon's colour, kept in step with the theme and the accent. */
function useRailActive(): string {
  const read = () => {
    const cs = getComputedStyle(document.documentElement);
    return railActiveColor(
      cs.getPropertyValue("--primary").trim(),
      cs.getPropertyValue("--bg").trim(),
      cs.getPropertyValue("--text").trim(),
      cs.getPropertyValue("--text4").trim(),
    );
  };
  const [colour, setColour] = useState<string>(() =>
    (typeof document === "undefined" ? "var(--primary)" : read()));
  useEffect(() => {
    // applyTheme and applyAccent both set variables on the root element, and
    // neither announces itself. Watching the attribute they write is how this
    // stays true across a theme switch without a bespoke event to subscribe to.
    const ob = new MutationObserver(() => setColour(read()));
    ob.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
    setColour(read());
    return () => ob.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return colour;
}

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
  // The rail's layout is the user's. Read through a store so a drag updates
  // every mounted rail at once rather than only the one being dragged.
  const rail = useSyncExternalStore(subscribeRail, loadRail, () => SHIPPED_RAIL);
  // The ink the active icon is drawn in — the accent, unless the accent is a
  // grey a shade away from the rail, in which case the theme's text colour.
  // See railActiveColor. Re-read when the root's style attribute changes,
  // which is what applyTheme and applyAccent both write to.
  const active = useRailActive();
  // Re-render when a shortcut is rebound, so the tooltips keep telling the
  // truth. chordFor reads the store itself; this only supplies the signal.
  useSyncExternalStore(subscribeBindings, chords, () => EMPTY_CHORDS);

  const [dragId, setDragId] = useState<ViewId | null>(null);
  // Set one tick after the drag starts, never in the handler itself: the
  // browser snapshots the source element for the drag image *after* dragstart
  // returns, and collapsing it synchronously means the thing following the
  // cursor is a 0×0 nothing.
  const [lifted, setLifted] = useState(false);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [menu, setMenu] = useState<{ id: ViewId; x: number; y: number } | null>(null);
  const [restoreAt, setRestoreAt] = useState<{ x: number; y: number } | null>(null);

  const base = railIds(rail);
  const dragging = dragId !== null && lifted;

  const endDrag = () => { setDragId(null); setLifted(false); setSlot(null); };

  const at = (p: Slot | null, place: RailPlace, index: number) => !!p && p.place === place && p.index === index;
  // Same slot, same object: dragover fires many times a second, and a fresh
  // object each time is a re-render each time.
  const aim = (place: RailPlace, index: number) =>
    setSlot((cur) => (cur && cur.place === place && cur.index === index ? cur : { place, index }));

  /**
   * Which index of `place` the pointer is asking for.
   *
   * Measured off the buttons actually in the flow — the dragged one is out of
   * it, and the ghost carries no marker — so the answer settles instead of
   * oscillating: inserting the ghost pushes the item under the cursor away
   * from the cursor, which is its own hysteresis.
   */
  const indexAt = (host: HTMLElement, y: number) => {
    const kids = Array.from(host.querySelectorAll<HTMLElement>("[data-rail-item]"));
    for (let i = 0; i < kids.length; i++) {
      const r = kids[i]!.getBoundingClientRect();
      if (y < r.top + r.height / 2) return i;
    }
    return kids.length;
  };

  const overDrawer = (e: React.DragEvent, place: RailPlace) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    aim(place, indexAt(e.currentTarget as HTMLElement, e.clientY));
  };

  const commit = (e: React.DragEvent) => {
    e.preventDefault();
    if (dragId && slot) saveRail(withMove(base, dragId, slot.place, slot.index));
    endDrag();
  };

  // Alt+Arrow moves the focused tab, so the layout is not a mouse-only feature.
  // Past either end of a drawer it steps into the next one, which is also the
  // only way to reach "hidden" without a pointer.
  const nudge = (id: ViewId, dir: 1 | -1) => {
    const order: RailPlace[] = ["work", "utility", "hidden"];
    const place = order.find((p) => base[p].includes(id));
    if (!place) return;
    const i = base[place].indexOf(id);
    const next = i + dir;
    if (next >= 0 && next < base[place].length) { moveView(id, place, next); return; }
    const p2 = order[order.indexOf(place) + dir];
    if (!p2) return;
    moveView(id, p2, dir === 1 ? 0 : base[p2].length);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const dir = e.key === "ArrowDown" ? 1 : -1;
    const host = e.currentTarget as HTMLElement;
    if (e.altKey) {
      const focused = (document.activeElement as HTMLElement | null)?.dataset?.view as ViewId | undefined;
      if (!focused) return;
      e.preventDefault();
      nudge(focused, dir);
      // The button moved in the DOM; put focus back on it rather than on
      // whatever now occupies the position it left.
      requestAnimationFrame(() => host.querySelector<HTMLElement>(`[data-view="${focused}"]`)?.focus());
      return;
    }
    e.preventDefault();
    const cycle = [...base.work, ...base.utility];
    if (!cycle.length) return;
    const i = cycle.indexOf(view);
    const n = cycle[(i + (dir === 1 ? 1 : cycle.length - 1) + cycle.length) % cycle.length]!;
    onSelect(n);
    host.querySelector<HTMLElement>(`[data-view="${n}"]`)?.focus();
  };

  /** One rail button. Shared by both drawers so a tooltip, a pip or a drag
   *  handle can never exist in one and not the other. */
  const tab = (v: ViewDef) => {
    const on = v.id === view;
    const pip = pips?.[v.id];
    const Icon = v.icon;
    const chord = chordFor(v.id);
    // Out of the flow rather than out of the tree while it is being dragged:
    // dragend fires on the source element, and an unmounted source never gets
    // it — which leaves the rail stuck mid-drag if you press Escape. Absolute
    // rather than zero-height so it contributes no flex gap either.
    const lift = dragId === v.id && lifted;
    return (
      <button
        key={v.id}
        data-view={v.id}
        {...(lift ? {} : { "data-rail-item": "" })}
        role="tab"
        aria-selected={on}
        aria-label={v.label}
        tabIndex={on ? 0 : -1}
        onClick={() => onSelect(v.id)}
        onContextMenu={(e) => { e.preventDefault(); setRestoreAt(null); setMenu({ id: v.id, x: e.clientX, y: e.clientY }); }}
        // Drag to rearrange. HTML5 dnd rather than pointer maths: the browser
        // already handles the pickup, the drag image and the drop, and the only
        // thing it does not give you is where the thing will land — which is
        // what the ghost below is for.
        draggable
        onDragStart={(e) => {
          setDragId(v.id);
          e.dataTransfer.effectAllowed = "move";
          // Some targets refuse a drag carrying no data at all.
          try { e.dataTransfer.setData("text/plain", v.id); } catch { /* not fatal */ }
          setTimeout(() => setLifted(true), 0);
        }}
        onDragEnd={endDrag}
        className={`${dragging ? "" : "agw-tip "}relative h-11 w-full grid place-items-center rounded-[10px] transition-colors`}
        // The modifier binding, not the bare letter. Inside the workspace the
        // letters no longer navigate — they belong to whatever has focus,
        // usually a shell — and a tooltip advertising a key that does nothing
        // is worse than no tooltip. Which is also why the bottom drawer shows
        // none: down there a view has no number, by design.
        data-tip={chord ? `${v.label} · ${chordLabel(chord)}` : v.label}
        // No box any more. At 16px the glyph needed a tinted panel behind it
        // to be findable; at 22 it carries the state itself, and the box was a
        // second shape competing with the only one that matters. The inactive
        // ones go quieter to match — the contrast between "on" and "off" is
        // now entirely in the ink.
        style={lift ? LIFTED : { color: on ? active : "var(--text4)", background: "transparent" }}
      >
        <Icon size={ICON.rail} />
        {/* the 3px edge marker: reads as "you are here" from the far side
        of the screen, where a background tint alone doesn't. */}
        {on && (
          <span className="absolute left-[-8px] top-[9px] bottom-[9px] w-[3px] rounded-r-[3px]"
            style={{ background: "var(--primary)" }} />
        )}
        {pip?.count ? (
          <span className="absolute top-[5px] right-[6px] min-w-[14px] h-[14px] px-1 grid place-items-center rounded-full text-[10px] font-bold tabular-nums"
            style={{ background: "var(--success)", color: "#06281c" }}>{pip.count}</span>
        ) : pip?.dot ? (
          <span className="absolute top-[7px] right-[9px] w-[6px] h-[6px] rounded-full"
            style={{ background: "var(--success)", boxShadow: "0 0 0 3px color-mix(in srgb, var(--success) 22%, transparent)" }} />
        ) : null}
      </button>
    );
  };

  /** The gap that opens up under the cursor, wearing the icon of whatever is
   *  going into it. The whole point of the exercise: a drag that only fades the
   *  thing you picked up tells you it left, not where it is going. */
  const ghost = () => {
    const v = dragId ? BY_ID.get(dragId) : null;
    if (!v) return null;
    const Icon = v.icon;
    return (
      <div key="ghost" aria-hidden className="h-10 w-full grid place-items-center rounded-[10px] pointer-events-none"
        style={{
          border: "1px dashed color-mix(in srgb, var(--primary) 55%, transparent)",
          background: "color-mix(in srgb, var(--primary) 10%, transparent)",
          color: "color-mix(in srgb, var(--primary-hover) 70%, transparent)",
        }}>
        <Icon size={ICON.rail} />
      </div>
    );
  };

  /** A drawer's buttons, with the ghost spliced in at the aimed index.
   *  The dragged button is still emitted, in its committed position — it is
   *  just out of the flow, so it takes no room and skips the count. */
  const drawer = (place: RailPlace): ReactNode[] => {
    const out: ReactNode[] = [];
    let i = 0;
    for (const id of base[place]) {
      const v = BY_ID.get(id);
      if (!v) continue;
      if (dragId === id && lifted) { out.push(tab(v)); continue; }
      if (at(slot, place, i)) out.push(ghost());
      out.push(tab(v));
      i++;
    }
    if (at(slot, place, i)) out.push(ghost());
    return out;
  };

  const hiddenViews = rail.hidden;
  /** The drop target is aimed at, so the button can turn red before the drop
   *  rather than after it. */
  const aimingHidden = slot?.place === "hidden";

  return (
    <nav
      role="tablist"
      aria-label="Workspace views"
      onKeyDown={onKeyDown}
      onDragOver={(e) => { if (dragId) e.preventDefault(); }}
      onDragLeave={(e) => {
        // Only when the pointer has actually left the rail, not on every hop
        // between two children of it.
        if (dragId && !e.currentTarget.contains(e.relatedTarget as Node | null)) setSlot(null);
      }}
      onDrop={commit}
      className="w-[52px] shrink-0 flex flex-col gap-1 p-2 overflow-visible"
      style={{
        /* THE RAIL IS CHROME, and it was painting the content's own colour.
         *
         * Measured across the whole window: 98.4% of every pixel this app
         * paints was one tone — `--bg` — because the rail's fill was
         * `color-mix(--bg 55%, transparent)`, which is --bg blended with the
         * --bg behind it and therefore --bg. A navigation strip that is
         * literally the same colour as the pane beside it is not a strip, and
         * "it all looks like the same view" is the accurate reading of that.
         *
         * --surface-nav is the same token the settings navigation uses, and it
         * leans toward --bg2 rather than away from it, so it lifts on a dark
         * palette and sinks on a light one without a second value. */
        borderRight: "1px solid var(--surface-line)",
        background: "var(--surface-nav)",
      }}
    >
      {/* flex-1 so the empty run below the last icon still belongs to this
          drawer: dropping into the blank middle of the rail obviously means
          "put it at the bottom of the top group", and a container sized to its
          contents would have quietly refused. */}
      <div
        className="flex-1 min-h-0 flex flex-col gap-1"
        onDragOver={(e) => overDrawer(e, "work")}
        onDrop={commit}
      >
        {drawer("work")}
      </div>

      <div
        className="pt-2 flex flex-col gap-1"
        style={{ borderTop: "1px solid color-mix(in srgb, var(--primary) 10%, transparent)" }}
        onDragOver={(e) => overDrawer(e, "utility")}
        onDrop={commit}
      >
        {/* The views you visit rather than work in — the dashboard, a web page,
            a conversation — sit with the app's own controls instead of among
            the tools. Not a demotion: it is the difference between "where I am
            working" and "what I am looking at", and mixing the two is what made
            the rail a list of eight things with no shape. Which of your views
            live here is yours to say; this is only where they start. */}
        {drawer("utility")}
        {/* Empty and mid-drag, this drawer would be a hairline nobody can aim
            at. Only while dragging: the rest of the time an empty drawer should
            take up nothing at all. */}
        {dragging && !base.utility.length && !at(slot, "utility", 0) && <div className="h-6" />}
      </div>

      {/* `shrink-0`: this cluster is the way back — Ports, Resources, Settings —
          and it is the one thing on the rail that must never be the part that
          gets pushed off the bottom. Reported from a short window: the
          Resources button "looks cutoff". */}
      <div className="shrink-0 flex flex-col gap-1">
        {/* A second hairline, because everything below is not a view at all:
            these open OVER whatever you are in and hand it straight back. A
            divider is the cheapest way to say "these do not change where you
            are", and without it the cluster reads as tabs of which several
            mysteriously never highlight. */}
        <span className="my-0.5 mx-2 h-px shrink-0" style={{ background: "color-mix(in srgb, var(--primary) 12%, transparent)" }} />

        {/* Exists only while something is hidden, and that is the whole
            contract: nothing you take off the rail is gone, and the way back is
            on the rail rather than buried in preferences. */}
        {/*
          * One button, two jobs — because they are the same job seen from each
          * end: this is where a view goes when you put it away, and where it
          * comes back from.
          *
          * It used to be two. A drag raised a dashed bin of its own directly
          * ABOVE this button, so the moment you picked something up there were
          * two dashed squares stacked in the corner of the rail: one to drop it
          * into and one that opens the drawer it lands in. Reported as "es muy
          * raro… ese botón debería ser el de agregar" — which it now is, in both
          * directions.
          *
          * Shown while dragging even with nothing hidden yet, or the first view
          * you ever put away would have nowhere to be dropped.
          */}
        {(hiddenViews.length > 0 || dragging) && (
          <button
            onDragOver={(e) => {
              if (!dragId) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              aim("hidden", base.hidden.length);
            }}
            onDrop={commit}
            onClick={(e) => {
              // Off the far edge of the rail, not of the button: 8px past a
              // button inset by the nav's own padding lands flush on the
              // divider, which reads as the menu growing out of the border.
              const nav = (e.currentTarget as HTMLElement).closest("nav")!.getBoundingClientRect();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setMenu(null);
              setRestoreAt((cur) => (cur ? null : { x: nav.right + 8, y: r.top - 6 }));
            }}
            aria-label={dragging ? "Drop here to take it off the rail" : "Hidden views"}
            aria-expanded={!!restoreAt}
            data-tip={dragging
              ? "Drop to take it off the rail — it comes back from here"
              : `Hidden views · ${hiddenViews.length} put away`}
            className="agw-tip relative h-10 min-h-[30px] shrink w-full grid place-items-center rounded-[10px] transition-colors"
            style={{
              color: aimingHidden ? "var(--error)" : restoreAt ? "var(--primary-hover)" : "var(--text4)",
              // Only while something is in the air. A dashed outline the rest of
              // the time is a permanent invitation to a destructive-looking
              // action that is neither permanent nor destructive.
              border: dragging
                ? `1px dashed ${aimingHidden ? "var(--error)" : "color-mix(in srgb, var(--text4) 45%, transparent)"}`
                : "1px solid transparent",
              background: aimingHidden ? "color-mix(in srgb, var(--error) 14%, transparent)" : "transparent",
            }}
          >
            {/* The icon says which of the two jobs is live: a plus to bring one
                back, an eye crossed out for the one on its way out. */}
            {dragging ? <EyeOffIcon size={ICON.rail} /> : <PlusIcon size={ICON.rail} />}
            {hiddenViews.length > 0 && !dragging && (
              <span className="absolute top-[5px] right-[6px] min-w-[14px] h-[14px] px-1 grid place-items-center rounded-full text-[10px] font-bold tabular-nums"
                style={{ background: "color-mix(in srgb, var(--primary) 70%, transparent)", color: "var(--bg)" }}>{hiddenViews.length}</span>
            )}
          </button>
        )}

        <button
          onClick={() => onMachine("ports")}
          aria-label="Ports"
          data-tip="Ports · what is listening, and from which checkout"
          className="agw-tip relative h-10 min-h-[30px] shrink w-full grid place-items-center rounded-[10px] transition-colors"
          style={{ color: "var(--text4)" }}
        >
          <PortsIcon size={ICON.rail} />
        </button>
        <button
          onClick={() => onMachine("resources")}
          aria-label="Resources"
          data-tip="Resources · CPU, memory and disk, by checkout"
          className="agw-tip relative h-10 min-h-[30px] shrink w-full grid place-items-center rounded-[10px] transition-colors"
          style={{ color: "var(--text4)" }}
        >
          <ResourcesIcon size={ICON.rail} />
        </button>
        <button
          onClick={onSettings}
          aria-label="Settings"
          data-tip="Settings · preferences, exports, shortcuts"
          className="agw-tip relative h-10 min-h-[30px] shrink w-full grid place-items-center rounded-[10px] transition-colors"
          style={{ color: "var(--text4)" }}
        >
          <RailGear size={ICON.rail} />
        </button>
        {/* The catalog is reference, not a view: it opens over the workspace and
            hands it straight back, so it belongs down here with close rather
            than among the tabs, where it would imply state you can return to. */}
        <button
          onClick={onSkills}
          aria-label="Skills catalog"
          data-tip="Skills catalog · what this fleet can do"
          className="agw-tip relative h-10 min-h-[30px] shrink w-full grid place-items-center rounded-[10px] transition-colors"
          style={{ color: "var(--text4)" }}
        >
          <SkillsIcon size={ICON.rail} />
        </button>
      </div>

      {menu && (
        <RailMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {(["work", "utility", "hidden"] as RailPlace[])
            .filter((p) => !base[p].includes(menu.id))
            .map((p) => (
              <MenuItem key={p} danger={p === "hidden"}
                onClick={() => { moveView(menu.id, p, p === "work" ? base.work.length : 0); setMenu(null); }}>
                {p === "work" ? "Move to top group" : p === "utility" ? "Move to bottom group" : "Hide from rail"}
              </MenuItem>
            ))}
          {/* Says what the move costs before you make it: a number is a
              property of the top group, not of the view. */}
          <div className="mt-1 pt-1.5 px-2 pb-0.5 text-[9.5px]"
            style={{ color: "var(--text3)", borderTop: "1px solid color-mix(in srgb, var(--text) 16%, transparent)" }}>
            {chordFor(menu.id)
              ? `${chordLabel(chordFor(menu.id))} · drag to rearrange`
              : "no number outside the top group · drag to rearrange"}
          </div>
        </RailMenu>
      )}

      {restoreAt && (
        <RailMenu x={restoreAt.x} y={restoreAt.y} onClose={() => setRestoreAt(null)}>
          <div className="px-2 pt-1 pb-1 text-[9.5px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>Put back</div>
          {hiddenViews.map((v) => {
            const Icon = v.icon;
            return (
              <MenuItem key={v.id} onClick={() => { moveView(v.id, "work", base.work.length); setRestoreAt(null); }}>
                <span className="flex items-center gap-2">
                  <Icon size={ICON.sm} />
                  <span>{v.label}</span>
                </span>
              </MenuItem>
            );
          })}
          {hiddenViews.length > 1 && (
            <MenuItem onClick={() => {
              saveRail({ work: [...base.work, ...base.hidden], utility: base.utility, hidden: [] });
              setRestoreAt(null);
            }}>Put all back</MenuItem>
          )}
        </RailMenu>
      )}
    </nav>
  );
}

/** Out of the flow, still in the tree. See the note at its only use. */
const LIFTED: React.CSSProperties = {
  position: "absolute", left: 0, top: 0, width: 0, height: 0,
  opacity: 0, overflow: "hidden", pointerEvents: "none",
};

/** A small panel pinned to the viewport beside the rail.
 *
 *  Portalled, and fixed rather than absolute: the rail is 52px wide and sits
 *  inside a couple of overflow-hidden panes, so anything wider drawn in place
 *  would be clipped to the rail it came out of. Styled to match the panel
 *  menus (PrPanel's filter dropdown) — one menu look for the app. */
function EyeOffIcon({ size = ICON.md }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.9 5.1A9.7 9.7 0 0 1 12 4.9c5 0 9 5.1 9 5.1a15 15 0 0 1-2.9 3.2M6.5 6.6A15.6 15.6 0 0 0 3 10s4 5.1 9 5.1a9.4 9.4 0 0 0 3.4-.6" />
      <path d="M10.6 8.6a2.5 2.5 0 0 0 3.4 3.4" />
      <path d="M3 3l18 18" />
    </svg>
  );
}

function PlusIcon({ size = ICON.md }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" strokeDasharray="3.4 2.6" />
      <path d="M12 8.4v7.2M8.4 12h7.2" />
    </svg>
  );
}

/** The same cog the header uses. Kept here rather than exported from Header
 *  alongside the other two: that one is styled for an 8px button and this rail
 *  draws at 16, and a shared icon that needs a size prop per caller is just two
 *  icons with extra steps. */
function RailGear({ size = ICON.md }: { size?: number }) {
  return (
    <svg viewBox="-2.34 -2.34 28.67 28.67" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2.39} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
    </svg>
  );
}

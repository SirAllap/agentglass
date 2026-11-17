import { useEffect, useRef, useState, type KeyboardEvent as ReactKey, type MouseEvent } from "react";
import { LAYER } from "../../../lib/layers.ts";
import { useFurnitureFloor } from "../../../lib/furnitureFloor.ts";
import type { BoardSource } from "../../../lib/boardSource.ts";
import type { ProviderTask } from "../../../../../shared/providers.ts";
import { JiraCard } from "../JiraCard.tsx";
import { JiraHead } from "../JiraFacts.tsx";
import { LINE } from "../../workspace/Chrome.tsx";
import { DockChromeCtx, type DockChromeProps } from "./DockChrome.tsx";
import { DockWidthGrip } from "./DockWidthGrip.tsx";
import { dockKey, escStep, floatHome, floatSize, clampFloat, BOTTOM_H, POP_W, useDockState, type DockMode, type DockState, type FloatBox } from "../../../lib/jiraDockMode.ts";
import { useModalDialog } from "../../../lib/focusTrap.ts";
import { DOCK_MIN } from "./tabsModel.ts";

/**
 * Slot: the card dock, 620 wide. Empty it says so; with a card it is the Jira card drawn straight into the dock.
 * The panel has three places (docked right, a floating window, popped out over the board) and maximize, kept per window
 * in `lib/jiraDockMode.ts`; the card is the same element in the first two, so a drag from the dock keeps what was typed.
 * Docked, the width rule is the list's: the dock never under 380 and the board never under two columns, the rail folds first.
 */
export interface JiraDockProps {
  source: BoardSource;
  card: ProviderTask | null;
  writable: boolean;
  /** A write changed the card: what the site now says. */
  onTask: (t: ProviderTask) => void;
  onClose: () => void;
  onAllow: () => void;
  /** Open a related card (a sub-task of this one, the parent above it) in place, without leaving the list. */
  onOpenCard?: (t: ProviderTask) => void;
  /** The same, from only a key (a sub-task's "Parent" field, the breadcrumb above the title): found on the page
   *  if it is already there, else read on its own. */
  onOpenByKey?: (key: string) => void;
  /** The space / epic in the card's header: load that place in the main view, the card stays open. */
  onOpenSpace?: (spaceKey: string) => void;
  onOpenEpic?: (epicKey: string) => void;
  /** The card opened before this one, if any: the panel's own Back. */
  onBack?: () => void;
  /** A right-click on a sub-task row, for the list's own menu. */
  onSubtaskMenu?: (e: MouseEvent, sub: ProviderTask) => void;
  /** The docked width; the list works it out so the board keeps three columns, or the view's own hand-dragged choice. Absent: DOCK_W. */
  width?: number;
  /** The row's own width, for the resize grip's ceiling (tabsModel.dockResizeMax). Absent: no grip. */
  rowW?: number;
  /** The grip let go at this width: the caller remembers it (per view). */
  onResizeWidth?: (px: number) => void;
  /** Double-click, or Home/End on the grip's keyboard ends: back to the computed width. */
  onResetWidth?: () => void;
}

export const DOCK_W = 620;

const inField = (el: HTMLElement | null) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/** Esc closes the card, unless it is leaving a field, a menu or a dialog that already took the key. */
export function escCloses(e: Pick<KeyboardEvent, "key" | "defaultPrevented" | "target">): boolean {
  if (e.key !== "Escape" || e.defaultPrevented) return false;
  const el = e.target as HTMLElement | null;
  if (inField(el)) return false;
  /* The over-the-list card is itself a dialog (data-slot="dock"); Esc inside it is the card's own. */
  return !(el && el.closest?.('[role="dialog"]:not([data-slot="dock"]),[role="menu"],[role="listbox"]'));
}

export function JiraDock(props: JiraDockProps) {
  const ctl = useDockState();
  return <DockLayout {...props} over={ctl.mode === "pop"} mode={ctl.mode} maximized={ctl.maximized} ctl={ctl} />;
}

const NONE = { w: 1280, h: 800 };
const viewNow = () => (typeof window === "undefined" ? NONE : { w: window.innerWidth, h: window.innerHeight });

/** The layout apart from where the choice is stored, so a test can ask for either (the server render always says "dock"). */
export function DockLayout({ card, writable, onTask, onClose, onAllow, onOpenCard, onOpenByKey, onOpenSpace, onOpenEpic, onBack, onSubtaskMenu, over, width, rowW, onResizeWidth, onResetWidth, mode: asked, maximized = false, ctl }: JiraDockProps & {
  over: boolean; mode?: DockMode; maximized?: boolean; ctl?: DockState;
}) {
  const live = useRef<number | null>(null);
  const mode: DockMode = over ? "pop" : asked ?? "dock";
  const open = !!card;
  const dialog = useModalDialog(open && mode === "pop", card?.title ?? "Card");
  const box = useRef<HTMLElement>(null);
  const [view, setView] = useState(viewNow);
  const [drag, setDrag] = useState<FloatBox | null>(null);
  const origin = useRef<FloatBox>({ x: 0, y: 0 });
  useEffect(() => {
    if (mode !== "float") return;
    const on = () => setView(viewNow());
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [mode]);
  const size = floatSize(view);
  const at = clampFloat(drag ?? ctl?.at ?? floatHome(view), size, view);

  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => {
      if (dockKey(e) === "cycle") { e.preventDefault(); ctl?.cycle(); return; }
      if (onBack && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === "ArrowLeft" && !inField(e.target as HTMLElement)) { e.preventDefault(); onBack(); return; }
      if (!escCloses(e)) return;
      const step = escStep(mode, maximized);
      if (step === "restore") ctl?.setMax(false);
      else if (step === "return" && ctl) ctl.back();
      else onClose();
    };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, [open, onClose, onBack, mode, maximized, ctl]);
  /* `f` maximizes while focus is inside the panel and not in a field. */
  const onKeyDown = (e: ReactKey<HTMLElement>) => {
    if (dockKey(e.nativeEvent) === "max" && !inField(e.target as HTMLElement)) { e.preventDefault(); ctl?.toggleMax(); }
  };

  /* The panel's buttons live in the card header (one group top-right); the card reads them from here. */
  const chrome: DockChromeProps | null = ctl ? {
    mode, maximized, onMode: ctl.setMode, onMax: ctl.toggleMax,
    onDrag: (dx, dy, first) => {
        if (first) {
          const r = box.current?.getBoundingClientRect();
          origin.current = mode === "float" ? at : r ? { x: r.left, y: r.top } : at;
          if (mode !== "float") { ctl.setMode("float"); setView(viewNow()); }
        }
        setDrag(clampFloat({ x: origin.current.x + dx, y: origin.current.y + dy }, size, viewNow()));
    },
    onDragEnd: () => { if (drag) ctl.moveTo(drag); setDrag(null); },
    onNudge: (dx, dy) => { if (mode === "float") ctl.moveTo(clampFloat({ x: at.x + dx, y: at.y + dy }, size, view)); },
  } : null;
  // Keep the panel's bottom clear of the floating bench button, wherever it is parked.
  const [floorRef, floor] = useFurnitureFloor<HTMLDivElement>([card?.id, mode, maximized, at.x, at.y, size.w, size.h]);
  const content = card && (
    <DockChromeCtx.Provider value={chrome}>
      <div ref={floorRef} className="flex-1 min-h-0 overflow-hidden text-[11.5px] flex flex-col" style={floor ? { marginBottom: floor } : undefined}>
        <JiraCard key={card.id} t={card} writes={writable} onTask={onTask} onAllow={onAllow} onSubtaskMenu={onSubtaskMenu}
          onOpenCard={onOpenCard} onOpenByKey={onOpenByKey} onOpenSpace={onOpenSpace} onOpenEpic={onOpenEpic}
          onBack={onBack}
          header={(r) => <JiraHead t={card} writable={writable} onTask={r.onTask} onRefresh={r.onRefresh} refreshing={r.refreshing} ed={r.ed} follow={r.follow} onClose={onClose} updatedAt={r.updatedAt} />} />
      </div>
    </DockChromeCtx.Provider>
  );
  if (mode === "pop") {
    if (!content) return null;
    /* Over the whole list pane (the root is `relative`), not over the table inside it, so the toolbar is dimmed too. */
    return (
      <div className="absolute inset-0 z-30 flex items-stretch justify-center p-2" data-testid="jira-card-over"
        style={{ background: "color-mix(in srgb, var(--bg) 62%, transparent)" }} onClick={onClose}>
        <aside data-slot="dock" data-mode="pop" {...dialog} onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown} className="flex flex-col min-h-0 rounded-xl overflow-hidden outline-none"
          style={{ width: `min(${POP_W}px, 100%)`, background: "var(--bg)", border: LINE, boxShadow: "var(--surface-lift)" }}>
          {content}
        </aside>
      </div>
    );
  }
  /* No card, no pane: an empty dock beside the board only took the board's width away. */
  if (!content) return null;
  /* One element for the dock and the float: switching between them by a drag keeps the card's state. */
  const style = maximized && content
    ? { position: "absolute" as const, inset: 0, zIndex: LAYER.pane, background: "var(--bg)", border: LINE }
    : mode === "float"
      ? { position: "fixed" as const, left: at.x, top: at.y, width: size.w, height: size.h, zIndex: LAYER.pane, background: "var(--bg)", border: LINE, borderRadius: 12, overflow: "hidden", boxShadow: "var(--surface-lift)" }
      : mode === "bottom"
        ? { position: "absolute" as const, left: 0, right: 0, bottom: 0, height: BOTTOM_H, zIndex: LAYER.pane, background: "var(--bg)", borderTop: LINE }
        : { position: "relative" as const, width: width ?? DOCK_W, minWidth: DOCK_MIN, maxWidth: "55%", borderLeft: LINE, background: "var(--bg)" };
  const canResize = mode === "dock" && !maximized && !!rowW && onResizeWidth && onResetWidth;
  return (
    <aside ref={box} data-slot="dock" data-mode={maximized && content ? "max" : mode} onKeyDown={onKeyDown}
      className={`flex flex-col min-h-0 ${mode === "float" || mode === "bottom" || (maximized && content) ? "" : "min-w-0 shrink-0"}`} style={style}>
      {canResize && (
        <DockWidthGrip dock={box} live={live} width={width ?? DOCK_W} rowW={rowW!} onCommit={onResizeWidth!} onReset={onResetWidth!} />
      )}
      {content}
    </aside>
  );
}

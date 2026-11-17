/*
 * The saved-view tabs along the top of the board, as the mockup draws them: the first views as tabs with their counts
 * (an en dash while asked), the rest under "More", a "+" that saves the search in the box, and the sprint chip at the
 * right. Folding is the container's: the labels shrink to tooltips and "+ Save view" / "More views" to "+" / "More"
 * (index.css, `jira board r3`). Saved searches among the tabs carry the "..." menu: hover it, or Shift+F10 / the Menu key.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { SavedView } from "../../../../../shared/providers.ts";
import { MoreIcon, PlusIcon } from "../../../lib/glyphIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { INPUT, INPUT_STYLE } from "../../workspace/Chrome.tsx";
import { showTabCount } from "./headerModel.ts";
import { countLabel, type ViewCount } from "../../../lib/jiraTree.ts";
import type { SavedViewsCtl } from "../../../lib/useJiraSavedViews.ts";
import { AnchoredMenu } from "../../AnchoredMenu.tsx";
import { MenuRow } from "../../ContextMenu.tsx";
import { QueryMenu, QueryPopover } from "./QueryParts.tsx";
import { splitTabs, TAB_PREFIX, type SavedQuery } from "./tabsModel.ts";
import { tipAttr } from "../../../lib/tip.ts";

export interface JiraTabsProps {
  views: readonly SavedView[];
  current: string | null;
  counts: Record<string, ViewCount>;
  ctl: SavedViewsCtl;
  /** The box holds a JQL search that "+" can save. */
  canSave: boolean;
  onPick: (id: string) => void;
  onSaveCurrent: () => void;
  /** Open the view builder on a saved view's search. */
  onEditQuery?: (q: SavedQuery) => void;
  onNote?: (text: string) => void;
  /** How many of `views` are tabs (the rest fold into More); defaults to the old five. */
  max?: number;
  /** The default views can be dragged, renamed, hidden and brought back; omitted, they are fixed tabs. */
  edit?: { onMove: (id: string, before: string | null) => void; onRename: (id: string, name: string) => void; onDuplicate: (id: string) => void; onHide: (id: string) => void; onReset: () => void };
  /** The identity row's left edge (the sprint chip), before the tab strip. */
  left?: ReactNode;
  /** The identity row's right edge, after the strip's own flex-1 (Workflow, how fresh the read is). */
  right?: ReactNode;
}

type Shown = { kind: "menu" | "pop"; q: SavedQuery } | null;

export function JiraTabs({ views, current, counts, ctl, canSave, onPick, onSaveCurrent, onEditQuery, onNote, max, edit, left, right }: JiraTabsProps) {
  const { tabs, more } = splitTabs(views, current, max);
  const strip = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ l: false, r: false });
  const measure = useCallback(() => {
    const el = strip.current;
    if (!el) return;
    const next = { l: el.scrollLeft > 1, r: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 };
    setEdge((c) => (c.l === next.l && c.r === next.r ? c : next));
  }, []);
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, tabs.length]);
  /* The strip scrolls sideways under a plain wheel (no tab is ever half-reachable), and the open view is kept in sight. */
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault(); el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  useEffect(() => {
    const on = strip.current?.querySelector<HTMLElement>(".agx-jt-tabw[data-on]");
    on?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current]);

  const anchor = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState<Shown>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [defMenu, setDefMenu] = useState<string | null>(null);
  const dragId = useRef<string | null>(null);
  const isDefault = (id: string) => !!edit && id.startsWith(TAB_PREFIX);
  const queryOf = (id: string) => ctl.queries.find((q) => q.id === id) ?? null;
  const openMenu = (id: string, el: HTMLElement) => { const q = queryOf(id); if (q) { anchor.current = el; setShown({ kind: "menu", q }); } };
  const onTabKey = (e: KeyboardEvent<HTMLElement>, id: string) => {
    if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") { e.preventDefault(); openMenu(id, e.currentTarget); }
  };
  const onTabContext = (e: MouseEvent<HTMLElement>, id: string) => {
    if (queryOf(id)) { e.preventDefault(); openMenu(id, e.currentTarget); }
    else if (isDefault(id)) { e.preventDefault(); anchor.current = e.currentTarget; setDefMenu(id); }
  };

  return (
    <div className="agx-jt" data-slot="tabs" data-testid="jira-tabs">
      {left}
      <div className="agx-jt-wrap" data-l={edge.l ? "" : undefined} data-r={edge.r ? "" : undefined}>
        <div ref={strip} className="agx-jt-strip" role="tablist" aria-label="Saved views" onScroll={measure}>
          {tabs.map((v) => {
            const on = v.id === current;
            const isQuery = !!queryOf(v.id);
            return (
              <span key={v.id} className="agx-jt-tabw" data-on={on ? "" : undefined} data-testid={isDefault(v.id) ? "jira-view-tab" : undefined}
                draggable={isDefault(v.id) && renaming !== v.id}
                onDragStart={() => { dragId.current = v.id; }}
                onDragOver={(e) => { if (dragId.current && isDefault(v.id)) e.preventDefault(); }}
                onDrop={(e) => { e.preventDefault(); const d = dragId.current; dragId.current = null; if (d && d !== v.id) edit?.onMove(d, v.id); }}>
                {isDefault(v.id) && <span aria-hidden className="agx-jt-grip" data-tip={tipAttr("Drag to reorder")}>⋮⋮</span>}
                <button type="button" role="tab" aria-selected={on} className="agx-jt-tab" data-tip={tipAttr(v.name)}
                  onClick={() => onPick(v.id)} onDoubleClick={() => { if (isDefault(v.id)) setRenaming(v.id); }} onKeyDown={(e) => onTabKey(e, v.id)} onContextMenu={(e) => onTabContext(e, v.id)}>
                  {renaming === v.id ? (
                    <input autoFocus defaultValue={v.name} aria-label="Rename view" className={`${INPUT} agx-jt-name`} style={{ ...INPUT_STYLE, width: `calc(${Math.max(6, v.name.length + 1)}ch + 20px)` }}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => { edit?.onRename(v.id, e.currentTarget.value); setRenaming(null); }}
                      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setRenaming(null); }} />
                  ) : <span className="agx-jt-name">{v.name}</span>}
                  {showTabCount(counts[v.id]) && <span className="agx-jt-n tabular-nums">{countLabel(counts[v.id])}</span>}
                </button>
                {(isQuery || isDefault(v.id)) && (
                  <button type="button" className="agx-jtab-dots" aria-label={`Menu for ${v.name}`} data-tip={tipAttr(isQuery ? "Rename, duplicate, share or remove - Shift+F10" : "Rename or delete")}
                    onClick={(e) => { if (isQuery) openMenu(v.id, e.currentTarget); else { anchor.current = e.currentTarget; setDefMenu(v.id); } }}>
                    <MoreIcon size={ICON.sm} />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      </div>
      <button ref={moreBtn} type="button" className="agx-jtab-act" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}
        data-tip={tipAttr(more.length ? `${more.length} more saved ${more.length === 1 ? "view" : "views"}` : "No other saved views yet")} aria-label="More views">
        <span className="agx-jt-lbl">More</span> <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3.4 5.4 7 9l3.6-3.6" /></svg>
      </button>
      <button type="button" className="agx-jtab-act agx-jt-plus" disabled={!canSave} onClick={onSaveCurrent}
        data-tip={tipAttr({ name: "New view", text: "Build a Jira search with recipes, suggestions and a live count." })} aria-label="Save view">
        <PlusIcon size={ICON.sm} />
      </button>
      <span className="flex-1" />
      {right}
      {moreOpen && (
        <AnchoredMenu anchor={moreBtn} align="left" minWidth={240} onClose={() => setMoreOpen(false)}>
          {more.length === 0 && <MenuRow onClick={() => setMoreOpen(false)}>No other saved views yet. Star a filter in Jira, or type a search and press Save view.</MenuRow>}
          {edit && <MenuRow onClick={() => { setMoreOpen(false); edit.onReset(); }}>Reset to defaults</MenuRow>}
          {more.map((v) => (
            <MenuRow key={v.id} hint={counts[v.id] ? countLabel(counts[v.id]) : undefined} onClick={() => { setMoreOpen(false); onPick(v.id); }}>{v.name}</MenuRow>
          ))}
        </AnchoredMenu>
      )}
      {defMenu && edit && (
        <AnchoredMenu anchor={anchor} align="left" minWidth={180} onClose={() => setDefMenu(null)}>
          <MenuRow onClick={() => { setRenaming(defMenu); setDefMenu(null); }}>Rename</MenuRow>
          <MenuRow onClick={() => { edit.onDuplicate(defMenu); setDefMenu(null); }}>Duplicate</MenuRow>
          <MenuRow danger onClick={() => { edit.onHide(defMenu); setDefMenu(null); }}>Delete view</MenuRow>
        </AnchoredMenu>
      )}
      {shown?.kind === "menu" && (
        <QueryMenu anchor={anchor} query={shown.q} ctl={ctl} onNote={onNote} onRename={() => setShown({ kind: "pop", q: shown.q })} onEdit={onEditQuery} onClose={() => setShown(null)} />
      )}
      {shown?.kind === "pop" && <QueryPopover anchor={anchor} query={shown.q} ctl={ctl} heading="Rename" onClose={() => setShown(null)} />}
    </div>
  );
}

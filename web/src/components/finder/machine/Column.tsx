// One column of the Miller view: a folder's name and count over its rows.
//
// The header carries the four things Strata's columns carry — refresh, sort,
// options, filter — and a count badge that is known from the first page, so a
// 100,000-entry folder says so before it has drawn its first row. Selection is
// by NAME, not by index: the rows arrive in pages and are re-sorted, so an index
// would point at a different file a moment later.
import { useEffect, useRef, useState } from "react";
import { CaretIcon, CrossIcon, LinkIcon, LockIcon, MoreIcon, SearchIcon, SwapIcon } from "../../../lib/glyphIcons.tsx";
import { glyphFor } from "../../../lib/finderGlyphs.ts";
import { ArrowDownIcon, ArrowUpIcon, GlyphIcon, TONE_INK } from "../../../lib/finderIcons.tsx";
import { HIT, ICON } from "../../../lib/iconSize.ts";
import { formatSize, isFolder, itemsLabel, type Display, type Prefs, type Row, type SortKey } from "../../../lib/finderMiller.ts";
import type { FolderState } from "../../../lib/finderFolders.ts";
import { INPUT, INPUT_STYLE, LINE, RefreshButton } from "../../workspace/Chrome.tsx";
import { MenuCap, MenuItem, MenuRule, Popover } from "./Popover.tsx";
import { VirtualList } from "./VirtualList.tsx";
import { dragWidth, splitName } from "../../../lib/finderColumns.ts";

/** Ctrl and Shift on a click: what makes it a choice of several rows. */
export interface Mod { ctrl: boolean; shift: boolean }
export const modOf = (e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): Mod => ({ ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
/** A Shift-click would also select the text between the two rows. */
export const noRange = (e: React.MouseEvent) => { if (e.shiftKey || e.ctrlKey || e.metaKey) e.preventDefault(); };

export function RowIcon({ row, size = ICON.sm }: { row: Row; size?: number }) {
  if (row.locked) return <LockIcon size={size} />;
  if (row.kind === "link" && !isFolder(row)) return <LinkIcon size={size} />;
  const g = glyphFor(row.name, isFolder(row));
  return <span className="flex" style={{ color: TONE_INK[g.tone] }}><GlyphIcon glyph={g.glyph} size={size} /></span>;
}

export function Column({ title, closable, onClosePane, filterSignal, width, onResize, onFit, state, display, selName, chosen, focused, prefs, rowH, filter, onFilter, onPick, onOpen, onFocusCol, onRefresh, onSort, onPref, scrollTop, onScrollTop }: {
  title: string;
  /** Not the first column: it can be closed, which drops it and what is to its right. */
  closable: boolean;
  onClosePane: () => void;
  /** Bumped by Ctrl+F when this is the column with the keyboard. */
  filterSignal: number;
  /** Pixels: the longest name, a dragged width, or the free room (see lib/finderColumns). */
  width: number;
  onResize: (w: number) => void;
  /** Double-click on the edge: back to the width the names ask for. */
  onFit: () => void;
  state: FolderState | undefined;
  display: Display;
  selName: string | null;
  /** More than one row chosen (Ctrl or Shift): every name in it is drawn selected. */
  chosen: ReadonlySet<string> | null;
  focused: boolean;
  prefs: Prefs;
  rowH: number;
  filter: string;
  onFilter: (v: string) => void;
  onPick: (row: Row, mod?: Mod) => void;
  onOpen: (row: Row) => void;
  onFocusCol: () => void;
  onRefresh: () => void;
  onSort: (k: SortKey) => void;
  onPref: (p: Partial<Prefs>) => void;
  /** Where this column was scrolled when the finder was last closed, and where it is now. */
  scrollTop?: number;
  onScrollTop?: (top: number) => void;
}) {
  const [menu, setMenu] = useState<{ kind: "sort" | "opts"; at: DOMRect } | null>(null);
  const [finding, setFinding] = useState(filter !== "");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (filterSignal > 0) { setFinding(true); setTimeout(() => input.current?.focus(), 0); } }, [filterSignal]);
  const selItem = (() => { const i = display.rows.findIndex((r) => r.name === selName); return i < 0 ? null : display.itemOfRow[i]!; })();
  const loading = !state || !state.done;
  const btn = "agx-btn rounded-md grid place-items-center shrink-0";
  const open = (kind: "sort" | "opts") => (e: React.MouseEvent<HTMLButtonElement>) => setMenu({ kind, at: e.currentTarget.getBoundingClientRect() });

  return (
    <section aria-label={`Folder ${title}`} onMouseDown={onFocusCol} className="relative flex flex-col min-h-0 shrink-0"
      style={{ width, borderRight: LINE, scrollSnapAlign: "start" }}>
      {/* The column that has the keyboard wears a bar on top; a colour alone would not survive a theme that has no accent to spare. */}
      <div aria-hidden className="absolute left-0 right-0 top-0" style={{ height: 3, background: focused ? "var(--primary)" : "transparent", zIndex: 2 }} />
      <div role="separator" aria-orientation="vertical" aria-label={`Resize ${title}`} aria-valuenow={Math.round(width)} tabIndex={0}
        title="Drag to resize, double-click to fit"
        className="absolute top-0 bottom-0 agx-col-edge" style={{ right: 0, width: 6, cursor: "col-resize", zIndex: 3, touchAction: "none" }}
        onDoubleClick={onFit}
        onPointerDown={(e) => {
          e.preventDefault(); e.stopPropagation();
          const x0 = e.clientX, w0 = width, el = e.currentTarget;
          el.setPointerCapture(e.pointerId);
          const move = (ev: PointerEvent) => onResize(dragWidth(w0, ev.clientX - x0));
          const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); };
          el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); onResize(dragWidth(width, e.key === "ArrowLeft" ? -16 : 16)); }
          else if (e.key === "Enter" || e.key === "0") { e.preventDefault(); e.stopPropagation(); onFit(); }
        }} />
      <header className="flex items-center gap-1 px-2.5 pt-2 pb-1.5 shrink-0" style={{ borderBottom: LINE }}>
        <b className="flex-1 min-w-0 truncate text-[12px]" title={title}>{title}</b>
        {state && (
          <span className="shrink-0 tabular-nums text-[10px] px-1.5 rounded-md" aria-live="polite"
            style={{ background: "color-mix(in srgb, var(--text) 9%, transparent)", color: "var(--text3)" }}>
            {state.total.toLocaleString()}{loading ? "…" : ""}
          </span>
        )}
        <RefreshButton onRefresh={onRefresh} title="Reload this folder (F5)" />
        <button className={btn} style={{ width: HIT, height: HIT, color: "var(--text3)" }} aria-label={prefs.sortDir === "asc" ? "Ascending — click to reverse" : "Descending — click to reverse"}
          title={prefs.sortDir === "asc" ? "Ascending — click to reverse" : "Descending — click to reverse"} onClick={() => onSort(prefs.sortKey)}>
          {prefs.sortDir === "asc" ? <ArrowUpIcon size={ICON.sm} /> : <ArrowDownIcon size={ICON.sm} />}
        </button>
        <button className={btn} style={{ width: HIT, height: HIT, color: "var(--text3)" }} title="Sort this folder" aria-label="Sort this folder" aria-haspopup="menu" onClick={open("sort")}><SwapIcon size={ICON.sm} /></button>
        <button className={btn} style={{ width: HIT, height: HIT, color: "var(--text3)" }} title="Options" aria-label="Options" aria-haspopup="menu" onClick={open("opts")}><MoreIcon size={ICON.sm} /></button>
        <button className={btn} aria-pressed={finding} style={{ width: HIT, height: HIT, color: finding ? "var(--primary-ink)" : "var(--text3)" }} title="Filter this pane (Ctrl+F)" aria-label="Filter this pane"
          onClick={() => { const on = !finding; setFinding(on); if (!on) onFilter(""); else setTimeout(() => input.current?.focus(), 0); }}><SearchIcon size={ICON.sm} /></button>
        {closable && <button className={btn} style={{ width: HIT, height: HIT, color: "var(--text3)" }} title="Close this pane" aria-label="Close this pane" onClick={onClosePane}><CrossIcon size={ICON.sm} /></button>}
      </header>
      {finding && (
        <div className="px-2.5 py-1.5 shrink-0" style={{ borderBottom: LINE }}>
          <input ref={input} value={filter} onChange={(e) => onFilter(e.target.value)} placeholder="Filter this column…" spellCheck={false} aria-label={`Filter ${title}`}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") { onFilter(""); setFinding(false); } }}
            className={`${INPUT} w-full`} style={INPUT_STYLE} />
        </div>
      )}

      {state?.error ? (
        <div className="p-3 text-[12px]" role="alert" style={{ color: "var(--warning-ink)" }}>{state.error}</div>
      ) : display.items.length === 0 ? (
        <div className="p-3 text-[12px]" style={{ color: "var(--text3)" }}>
          {loading ? "Reading…" : filter ? `Nothing here is called “${filter}”.` : state && state.hiddenSkipped ? `This directory is empty. ${state.hiddenSkipped} hidden ${state.hiddenSkipped === 1 ? "item" : "items"} left out.` : "This directory is empty"}
        </div>
      ) : (
        <VirtualList count={display.items.length} rowH={rowH} label={`Entries of ${title}`} className="flex-1" keepInView={selItem} initialTop={scrollTop} onTop={onScrollTop}
          render={(i) => {
            const it = display.items[i]!;
            if (it.header) {
              return <div key={`h:${it.header}`} className="flex items-end px-3 pb-1 text-[9.5px] uppercase tracking-[0.14em]" style={{ height: rowH, color: "var(--text4)", fontWeight: 600 }}>{it.header}</div>;
            }
            const r = it.row!;
            const sel = r.name === selName || !!chosen?.has(r.name);
            const dir = isFolder(r);
            return (
              <div key={r.name} role="option" aria-selected={sel} aria-disabled={r.locked || undefined} title={r.why ?? r.name}
                onMouseDown={noRange} onClick={(e) => onPick(r, modOf(e))} onDoubleClick={() => onOpen(r)}
                className="agx-fm-row flex items-center gap-2 px-2.5 mx-1 rounded-md cursor-pointer"
                style={{
                  height: rowH, color: r.locked ? "var(--text4)" : "var(--text)", fontWeight: sel ? 600 : 400,
                  background: sel ? "color-mix(in srgb, var(--primary) 16%, transparent)" : undefined,
                  boxShadow: sel ? "inset 0 0 0 1px color-mix(in srgb, var(--primary) 38%, transparent)" : undefined,
                }}>
                <span className="shrink-0 flex"><RowIcon row={r} /></span>
                <NameCell name={r.name} />
                {dir ? (
                  <>
                    {r.items !== null && <span className="shrink-0 tabular-nums text-[10px] px-1.5 rounded-md" style={{ background: "color-mix(in srgb, var(--text) 9%, transparent)", color: "var(--text3)", fontWeight: 400 }}>{itemsLabel(r.items)}</span>}
                    <span className="shrink-0 flex" style={{ color: "var(--text4)", transform: "rotate(-90deg)" }}><CaretIcon size={ICON.xs} /></span>
                  </>
                ) : prefs.sizes && r.bytes !== null ? (
                  <span className="shrink-0 tabular-nums text-[10.5px]" style={{ color: "var(--text4)", fontWeight: 400 }}>{formatSize(r.bytes)}</span>
                ) : null}
              </div>
            );
          }} />
      )}

      {menu?.kind === "sort" && (
        <Popover anchor={menu.at} onClose={() => setMenu(null)} width={200} label="Sort">
          <MenuCap>Sort by</MenuCap>
          {(["name", "size", "modified"] as const).map((k) => (
            <MenuItem key={k} on={prefs.sortKey === k} hint={prefs.sortKey === k ? (prefs.sortDir === "asc" ? "↑" : "↓") : undefined} onClick={() => { onSort(k); setMenu(null); }}>
              {k === "name" ? "Name" : k === "size" ? "Size" : "Modified"}
            </MenuItem>
          ))}
        </Popover>
      )}
      {menu?.kind === "opts" && (
        <Popover anchor={menu.at} onClose={() => setMenu(null)} width={230} label="Column options">
          <MenuItem on={prefs.group} onClick={() => onPref({ group: !prefs.group })}>Group by file type</MenuItem>
          <MenuItem on={prefs.hidden} hint="Ctrl+H" onClick={() => onPref({ hidden: !prefs.hidden })}>Hidden files</MenuItem>
          <MenuItem on={prefs.sizes} onClick={() => onPref({ sizes: !prefs.sizes })}>Show sizes</MenuItem>
          <MenuRule />
          <MenuItem onClick={() => { onRefresh(); setMenu(null); }}>Reload this folder</MenuItem>
        </Popover>
      )}
    </section>
  );
}

/** The name, its middle given up first when the column is narrower than it. */
function NameCell({ name }: { name: string }) {
  const [head, tail] = splitName(name);
  return (
    <span className="flex flex-1 min-w-0">
      <span className="truncate" style={{ flexShrink: 1, minWidth: 0 }}>{head}</span>
      {tail && <span className="shrink-0 whitespace-pre">{tail}</span>}
    </span>
  );
}

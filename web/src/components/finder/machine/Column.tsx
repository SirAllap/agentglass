// One column of the Miller view: a folder's name and count over its rows.
//
// The header carries the four things Strata's columns carry — refresh, sort,
// options, filter — and a count badge that is known from the first page, so a
// 100,000-entry folder says so before it has drawn its first row. Selection is
// by NAME, not by index: the rows arrive in pages and are re-sorted, so an index
// would point at a different file a moment later.
import { useEffect, useRef, useState } from "react";
import { CaretIcon } from "../../../lib/glyphIcons.tsx";
import { FileTypeIcon, PathIcon, StrataIcon } from "./StrataIcon.tsx";
import { HIT, ICON } from "../../../lib/iconSize.ts";
import { filterPlaceholder, formatSize, isDefaultSort, isFolder, isThumbable, joinPath, itemsLabel, rowLabel, makeDefaultSort, resetSort, type Display, type Prefs, type Row, type SortKey } from "../../../lib/finderMiller.ts";
import type { FolderState } from "../../../lib/finderFolders.ts";
import { EDGE, INPUT, INPUT_STYLE, LINE } from "../../workspace/Chrome.tsx";
import { MenuCap, MenuItem, MenuRule, Popover } from "./Popover.tsx";
import { InlineName, type InlineEdit } from "./FinderOpsUI.tsx";
import { Thumb } from "./Thumb.tsx";
import { VirtualList } from "./VirtualList.tsx";
import { TIGHT_W, dragWidth } from "../../../lib/finderColumns.ts";
import { COLUMNS_SURFACE, rowPaint, rowTone, showsBadge, titleColor } from "../../../lib/finderContrast.ts";

/** Strata draws an image in its row as a 17 px square in place of the file icon. */
const ROW_THUMB = 17;

/** Ctrl and Shift on a click: what makes it a choice of several rows. */
export interface Mod { ctrl: boolean; shift: boolean }
export const modOf = (e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): Mod => ({ ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
/** A Shift-click would also select the text between the two rows. */
export const noRange = (e: React.MouseEvent) => { if (e.shiftKey || e.ctrlKey || e.metaKey) e.preventDefault(); };

/** Strata's drawing for the row: a folder, a broken link (a cross) or what the name says it is. A folder that cannot be read is still a folder; the row itself says it is disabled. */
export function RowIcon({ row, size = ICON.sm, dir }: { row: Row; size?: number; dir?: string }) {
  return <PathIcon path={dir ? joinPath(dir, row.name) : undefined} name={row.name} isDir={isFolder(row)} broken={row.broken === true} size={size} />;
}

export function Column({ dir: folderPath, title, filterSignal, width, onResize, onFit, state, display, selName, chosen, focused, prefs, rowH, filter, onFilter, onPick, onOpen, onFocusCol, onRefresh, onSort, onPref, scrollTop, onScrollTop, edit }: {
  /** The folder this column lists: a right click in it says where it landed. */
  dir: string;
  title: string;
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
  /** A name being typed in this column: a new row on top, or the chosen row renamed in place. */
  edit?: InlineEdit | null;
}) {
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [finding, setFinding] = useState(filter !== "");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (filterSignal > 0) { setFinding(true); setTimeout(() => input.current?.focus(), 0); } }, [filterSignal]);
  const selItem = (() => { const i = display.rows.findIndex((r) => r.name === selName); return i < 0 ? null : display.itemOfRow[i]!; })();
  const loading = !state || !state.done;
  const btn = "agx-btn rounded-md grid place-items-center shrink-0";
  // Under this a row has no room for a count or a size beside the name, and the name comes first.
  const tight = width < TIGHT_W;
  const toggleFilter = () => { const on = !finding; setFinding(on); if (!on) onFilter(""); else setTimeout(() => input.current?.focus(), 0); };
  const open = (e: React.MouseEvent<HTMLButtonElement>) => setMenu(e.currentTarget.getBoundingClientRect());

  return (
    <section aria-label={`Folder ${title}`} data-dir={folderPath} onMouseDown={onFocusCol} className="relative flex flex-col min-h-0 shrink-0"
      style={{ width, borderRight: LINE, scrollSnapAlign: "start", background: COLUMNS_SURFACE }}>
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
        <b className="flex-1 min-w-0 truncate text-[12px]" title={title} style={{ color: titleColor(focused) }}>{title}</b>
        <button className={btn} style={{ width: HIT, height: HIT, color: "var(--primary-ink)" }} title="Refresh (F5)" aria-label="Refresh" onClick={onRefresh}><StrataIcon set="act" name="refresh" size={ICON.md} /></button>
        <button className={btn} style={{ width: HIT, height: HIT, color: "var(--primary-ink)" }} aria-label={prefs.sortDir === "asc" ? "Ascending — click to reverse" : "Descending — click to reverse"}
          title={prefs.sortDir === "asc" ? "Ascending — click to reverse" : "Descending — click to reverse"} onClick={() => onSort(prefs.sortKey)}>
          <StrataIcon set="act" name={prefs.sortDir === "asc" ? "arrow-up-narrow-wide" : "arrow-down-wide-narrow"} size={ICON.md} />
        </button>
        <button className={btn} style={{ width: HIT, height: HIT, color: "var(--primary-ink)" }} title="Sort options" aria-label="Sort options" aria-haspopup="menu" onClick={open}><StrataIcon set="act" name="sliders-horizontal" size={ICON.md} /></button>
        <button className={btn} aria-pressed={finding} style={{ width: HIT, height: HIT, color: "var(--primary-ink)", background: finding ? "color-mix(in srgb, var(--primary) 16%, transparent)" : undefined }} title="Filter this pane (Ctrl+F)" aria-label="Filter this pane"
          onClick={toggleFilter}><StrataIcon set="act" name="funnel" size={ICON.md} /></button>
      </header>
      {finding && (
        <div className="px-2.5 py-1.5 shrink-0" style={{ borderBottom: LINE }}>
          <input ref={input} value={filter} onChange={(e) => onFilter(e.target.value)} placeholder={filterPlaceholder(state?.total ?? display.rows.length)} spellCheck={false} aria-label={`Filter ${title}`}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") { onFilter(""); setFinding(false); } }}
            className={`${INPUT} w-full`} style={INPUT_STYLE} />
        </div>
      )}

      {state?.error ? (
        <div className="flex-1 min-h-0 grid place-items-center p-6 text-center text-[12px]" role="alert">
          <div className="flex flex-col items-center gap-2">
            <b style={{ fontWeight: 600 }}>Unable to read this directory</b>
            <span style={{ color: "var(--text3)" }}>{state.error}</span>
            <button className="agx-btn rounded-md px-3" style={{ minHeight: HIT, border: EDGE }} onClick={onRefresh}>Retry</button>
          </div>
        </div>
      ) : display.items.length === 0 && !(edit && edit.was === null) ? (
        <div className="flex-1 min-h-0 grid place-items-center p-6 text-center text-[12px]" style={{ color: "var(--text3)" }}>
          {loading ? "Reading…" : filter ? `Nothing here is called “${filter}”.` : state && state.hiddenSkipped ? `This directory is empty. ${state.hiddenSkipped} hidden ${state.hiddenSkipped === 1 ? "item" : "items"} left out.` : "This directory is empty"}
        </div>
      ) : (
        <>
        {edit && edit.was === null && <div className="shrink-0 pt-1"><InlineName key="new" edit={edit} rowH={rowH} icon={<FileTypeIcon name={edit.initial} isDir={edit.isDir} broken={false} size={ICON.sm} />} /></div>}
        <VirtualList count={display.items.length} rowH={rowH} label={`Entries of ${title}`} className="flex-1" keepInView={selItem} initialTop={scrollTop} onTop={onScrollTop}
          render={(i) => {
            const it = display.items[i]!;
            if (it.header) {
              return <div key={`h:${it.header}`} className="flex items-end px-3 pb-1 text-[9.5px] uppercase tracking-[0.14em]" style={{ height: rowH, color: "var(--text4)", fontWeight: 600 }}>{it.header}</div>;
            }
            const r = it.row!;
            const sel = r.name === selName || !!chosen?.has(r.name);
            const dir = isFolder(r);
            const badge = r.name === selName && showsBadge(true, focused);
            return (
              <div key={r.name} role="option" data-row={r.name} data-folder={dir && !r.locked ? "" : undefined} draggable={!r.locked && !(edit && edit.was === r.name)} aria-selected={sel} aria-disabled={r.locked || undefined} title={r.why ?? r.name}
                onMouseDown={noRange} onClick={(e) => onPick(r, modOf(e))} onDoubleClick={() => onOpen(r)}
                className="agx-fm-row flex items-center gap-2 px-2.5 mx-1 rounded-md cursor-pointer"
                style={{ height: rowH, color: r.locked ? "var(--text4)" : "var(--text)", ...rowPaint(rowTone(sel, focused)) }}>
                <span className="shrink-0 flex">{!r.locked && !dir && isThumbable(r.name) ? <Thumb path={joinPath(folderPath, r.name)} size={ROW_THUMB} radius={3} fallback={<RowIcon row={r} dir={folderPath} />} /> : <RowIcon row={r} dir={folderPath} />}</span>
                {edit && edit.was === r.name ? <InlineName key="ren" edit={edit} rowH={rowH - 4} icon={null} /> : <NameCell name={rowLabel(r.name)} />}
                {dir ? (
                  <>
                    {r.items !== null && !tight && badge && <span className="shrink-0 tabular-nums text-[10px] px-1.5 rounded-md" style={{ background: "color-mix(in srgb, var(--text) 9%, transparent)", color: "var(--text3)", fontWeight: 400 }}>{itemsLabel(r.items)}</span>}
                    <span className="shrink-0 flex" style={{ color: "var(--text4)", transform: "rotate(-90deg)" }}><CaretIcon size={ICON.xs} /></span>
                  </>
                ) : prefs.sizes && r.bytes !== null && !tight && badge ? (
                  <span className="shrink-0 tabular-nums text-[10px] px-1.5 rounded-md" style={{ background: "color-mix(in srgb, var(--text) 9%, transparent)", color: "var(--text3)", fontWeight: 400 }}>{formatSize(r.bytes)}</span>
                ) : null}
              </div>
            );
          }} />
        </>
      )}

      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)} width={240} label="Sort">
          <MenuCap>Sort by</MenuCap>
          {(["name", "size", "modified", "type"] as const).map((k) => (
            <MenuItem key={k} on={prefs.sortKey === k} onClick={() => { onSort(k); setMenu(null); }}>
              {k === "name" ? "Name" : k === "size" ? "Size" : k === "modified" ? "Modified" : "Type"}
            </MenuItem>
          ))}
          <MenuRule />
          <MenuItem on={prefs.foldersFirst} onClick={() => onPref({ foldersFirst: !prefs.foldersFirst })}>Folders first</MenuItem>
          <MenuRule />
          <MenuItem disabled={isDefaultSort(prefs) && !!prefs.defSort} onClick={() => { onPref(makeDefaultSort(prefs)); setMenu(null); }}>Make this the default sort</MenuItem>
          <MenuItem disabled={isDefaultSort(prefs)} onClick={() => { onPref(resetSort(prefs)); setMenu(null); }}>Reset to default sort</MenuItem>
        </Popover>
      )}
    </section>
  );
}

/** The name, ending in an ellipsis when the column is narrower than it, as Strata's does. */
function NameCell({ name }: { name: string }) {
  return <span className="flex-1 min-w-0 truncate">{name}</span>;
}

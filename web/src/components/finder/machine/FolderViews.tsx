// The Icons and List views: one folder, the last column, as tiles or as a table.
//
// Both are the same data as the columns and the same selection — switching view
// never moves you. Both draw only what is on screen: the list is a
// VirtualList, and the tiles are a VirtualList of tile ROWS (a row holds as
// many tiles as fit, so the window is still arithmetic).
import { useRef, useState } from "react";
import { api } from "../../../lib/api.ts";
import { inTrash, TIP_REST_MS, tipMoved } from "../../../lib/finderPointer.ts";
import { LAYER } from "../../../lib/layers.ts";
import { Portal } from "../../Portal.tsx";
import { Thumb } from "./Thumb.tsx";
import { iconsFirstItem, iconsTopOf, formatSize, strataWhen, isFolder, isThumbable, itemsLabel, joinPath, kindWord, rowLabel, tileSize, tilesPerRow, type Display, type Prefs, type Row, type RecentSort, type SortKey } from "../../../lib/finderMiller.ts";
import { ICON } from "../../../lib/iconSize.ts";
import { EDGE, LINE } from "../../workspace/Chrome.tsx";
import { RowIcon, noRange, rowPointer, type Mod } from "./Column.tsx";
import { VirtualList } from "./VirtualList.tsx";
import type { PeekBinder } from "./FolderPeek.tsx";

export { tilesPerRow };

const selStyle = (sel: boolean) => sel
  ? { background: "color-mix(in srgb, var(--primary) 22%, transparent)" }
  : {};

export function IconsView({ display, dir, thumb, selName, chosen, width, onPick, onOpen, onTab, onReveal, onSlow, onSlowCancel, label, peek, firstItem, onFirstItem, filtered }: {
  /** A filter is narrowing the view: a click acts at once. */
  filtered?: boolean;
  /** The first item at the top when it was left, and told when it changes. */
  firstItem?: number; onFirstItem?: (i: number) => void;
  peek?: PeekBinder | null; display: Display; dir: string; thumb: number; selName: string | null; chosen: ReadonlySet<string> | null; width: number; onPick: (r: Row, mod?: Mod) => void; onOpen: (r: Row) => void; onTab?: (r: Row) => void; onReveal?: (r: Row) => void; onSlow?: (r: Row, e: React.MouseEvent) => void; onSlowCancel?: () => void; label: string;
}) {
  const per = tilesPerRow(width, thumb);
  const tile = tileSize(thumb);
  const rows = display.rows;
  const lines = Math.ceil(rows.length / per);
  const at = rows.findIndex((r) => r.name === selName);
  const tip = useCaptionTip();
  return (
    <>
    <VirtualList count={lines} rowH={tile.h} label={label} className="flex-1" keepInView={at < 0 ? null : Math.floor(at / per)}
      ready={width > 0} initialTop={firstItem === undefined ? undefined : iconsTopOf(firstItem, tile.h, per)} onTop={(t) => onFirstItem?.(iconsFirstItem(t, tile.h, per))}
      render={(i) => (
        <div key={i} className="flex px-2" style={{ height: tile.h }}>
          {rows.slice(i * per, i * per + per).map((r) => (
            <div key={r.name} role="option" {...(isFolder(r) && !r.locked ? peek?.bind(joinPath(dir, r.name), r.name) : undefined)} data-row={r.name} data-folder={isFolder(r) && !r.locked ? "" : undefined} draggable={!r.locked} aria-selected={r.name === selName || !!chosen?.has(r.name)} onMouseDown={noRange} {...rowPointer("icons", r, { onPick, onOpen, onTab, onReveal, onSlow, onSlowCancel, filtered, trash: inTrash(dir) })}
              className="flex flex-col items-center justify-center gap-1.5 rounded-lg cursor-pointer px-1 min-w-0"
              style={{ width: tile.w, height: tile.h - 4, color: r.locked ? "var(--text4)" : "var(--text)", ...selStyle(r.name === selName || !!chosen?.has(r.name)) }}>
              <span data-icon className="agx-tile-part flex rounded-md" style={{ color: isFolder(r) ? "var(--warning-ink)" : "var(--text3)" }}>
                {!r.locked && !isFolder(r) && isThumbable(r.name) ? <Thumb path={joinPath(dir, r.name)} size={thumb} radius={6} fallback={<RowIcon row={r} dir={dir} size={ICON.xl} />} /> : <RowIcon row={r} dir={dir} size={Math.max(ICON.xl, Math.round(thumb * 0.6))} />}
              </span>
              <span data-name className="agx-tile-part w-full text-center text-[11.5px] leading-tight line-clamp-2 break-all rounded-md" {...tip.bind(r.name)}>{rowLabel(r.name)}</span>
            </div>
          ))}
        </div>
      )} />
    {tip.node}
    </>
  );
}

/**
 * Strata's caption tooltip: the full name once the pointer has rested 900 ms
 * (4 px of slop) on a caption that is cut, gone on any press or move away.
 * Not the browser's `title`, which shows after its own delay on every caption.
 */
function useCaptionTip() {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rest = useRef({ x: 0, y: 0 });
  const stop = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; setTip(null); };
  const bind = (name: string) => ({
    onMouseMove: (e: React.MouseEvent<HTMLElement>) => {
      const el = e.currentTarget, at = { x: e.clientX, y: e.clientY };
      if (tip || timer.current) { if (!tipMoved(rest.current, at)) return; stop(); }
      rest.current = at;
      if (el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1) return;
      timer.current = setTimeout(() => { timer.current = null; setTip({ ...rest.current, text: name }); }, TIP_REST_MS);
    },
    onMouseLeave: stop,
    onMouseDown: stop,
  });
  const node = tip && (
    <Portal z={LAYER.menu}>
      <div role="tooltip" className="fixed rounded-md px-2 py-1 text-[11.5px] pointer-events-none" style={{ left: tip.x + 12, top: tip.y + 18, maxWidth: 320, background: "var(--surface-card)", border: EDGE, color: "var(--text)", wordBreak: "break-all" }}>{tip.text}</div>
    </Portal>
  );
  return { bind, node };
}

const COLS = "minmax(0,1fr) 92px 112px 112px";

export function ListView({ dir, display, selName, chosen, rowH, prefs, onPick, onOpen, onTab, onReveal, onSlow, onSlowCancel, onSort, label, peek, scrollTop, onScrollTop, recent, filtered }: {
  filtered?: boolean;
  /** Set in Recent: its own sort; on Recency no header carries a mark. */
  recent?: RecentSort;
  scrollTop?: number; onScrollTop?: (t: number) => void;
  peek?: PeekBinder | null; dir: string; display: Display; selName: string | null; chosen: ReadonlySet<string> | null; rowH: number; prefs: Prefs; onPick: (r: Row, mod?: Mod) => void; onOpen: (r: Row) => void; onTab?: (r: Row) => void; onReveal?: (r: Row) => void; onSlow?: (r: Row, e: React.MouseEvent) => void; onSlowCancel?: () => void; onSort: (k: SortKey | "recency") => void; label: string;
}) {
  const at = display.rows.findIndex((r) => r.name === selName);
  const sortBy = recent ? recent.key : prefs.sortKey, sortWay = recent ? recent.dir : prefs.sortDir;
  const head = (k: SortKey, t: string, right?: boolean) => (
    <button className="agx-btn text-left px-1 rounded" style={{ color: sortBy === k ? "var(--text)" : "var(--text3)", textAlign: right ? "right" : "left" }} onClick={() => onSort(k)} aria-sort={sortBy === k ? (sortWay === "asc" ? "ascending" : "descending") : "none"}>
      {t}{sortBy === k ? (sortWay === "asc" ? " ↑" : " ↓") : ""}
    </button>
  );
  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col">
      <div data-heading className="grid items-center gap-2 px-3.5 text-[11px] shrink-0" style={{ gridTemplateColumns: COLS, minHeight: 28, borderBottom: LINE }}>
        {head("name", "Name")}{head("size", "Size", true)}{head("type", "Type")}{head("modified", "Modified")}
      </div>
      <VirtualList count={display.items.length} rowH={rowH} label={label} className="flex-1" keepInView={at < 0 ? null : display.itemOfRow[at]} initialTop={scrollTop} onTop={onScrollTop}
        render={(i) => {
          const it = display.items[i]!;
          if (it.header) return <div key={`h:${it.header}`} data-heading className="flex items-end px-3.5 pb-1 text-[12px]" style={{ height: rowH, color: "var(--text3)", fontWeight: 700, borderBottom: LINE }}>{it.header}</div>;
          const r = it.row!;
          return (
            <div key={r.name} role="option" {...(isFolder(r) && !r.locked ? peek?.bind(joinPath(dir, r.name), r.name) : undefined)} data-row={r.name} data-folder={isFolder(r) && !r.locked ? "" : undefined} draggable={!r.locked} aria-selected={r.name === selName || !!chosen?.has(r.name)} onMouseDown={noRange} {...rowPointer("list", r, { onPick, onOpen, onTab, onReveal, onSlow, onSlowCancel, filtered, trash: inTrash(dir) })}
              className="grid items-center gap-2 px-3.5 mx-1 rounded-md cursor-pointer"
              style={{ gridTemplateColumns: COLS, height: rowH, color: r.locked ? "var(--text4)" : "var(--text)", ...selStyle(r.name === selName || !!chosen?.has(r.name)) }}>
              <span className="flex items-center gap-2 min-w-0"><span data-icon className="shrink-0 flex"><RowIcon row={r} dir={dir} /></span><span data-name className="truncate">{rowLabel(r.name)}</span></span>
              <span className="text-right tabular-nums text-[11px]" style={{ color: "var(--text3)" }}>{isFolder(r) ? itemsLabel(r.items) : r.bytes !== null ? formatSize(r.bytes) : ""}</span>
              <span className="text-[11px] truncate" style={{ color: "var(--text3)" }}>{kindWord(r)}</span>
              <span className="text-[11px] truncate" style={{ color: "var(--text3)" }} title={new Date(r.mtime).toLocaleString()}>{strataWhen(r.mtime)}</span>
            </div>
          );
        }} />
    </div>
  );
}

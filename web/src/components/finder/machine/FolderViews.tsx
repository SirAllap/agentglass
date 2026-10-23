// The Icons and List views: one folder, the last column, as tiles or as a table.
//
// Both are the same data as the columns and the same selection — switching view
// never moves you. Both draw only what is on screen: the list is a
// VirtualList, and the tiles are a VirtualList of tile ROWS (a row holds as
// many tiles as fit, so the window is still arithmetic).
import { useRef, useState } from "react";
import { api } from "../../../lib/api.ts";
import { activates, inTrash, TIP_REST_MS, tipMoved } from "../../../lib/finderPointer.ts";
import { fitList, listMinWidth, listTemplate, resizeList } from "../../../lib/finderList.ts";
import { PREVIEW_SURFACE } from "../../../lib/finderContrast.ts";
import { StrataIcon } from "./StrataIcon.tsx";
import { LAYER } from "../../../lib/layers.ts";
import { Portal } from "../../Portal.tsx";
import { Thumb } from "./Thumb.tsx";
import { CARD, iconsFirstItem, iconsTopOf, formatSize, strataWhen, isFolder, isThumbable, itemsLabel, joinPath, kindWord, rowLabel, tileSize, tilesPerRow, type Display, type Prefs, type Row, type RecentSort, type SortKey } from "../../../lib/finderMiller.ts";
import { ICON } from "../../../lib/iconSize.ts";
import { EDGE, LINE } from "../../workspace/Chrome.tsx";
import { CUT_OPACITY, RowIcon, noRange, rowPointer, type Mod } from "./Column.tsx";
import { VirtualList } from "./VirtualList.tsx";
import type { PeekBinder } from "./FolderPeek.tsx";

export { tilesPerRow };

const selStyle = (sel: boolean) => sel
  ? { background: "color-mix(in srgb, var(--primary) 22%, transparent)" }
  : {};

export function IconsView({ cut, density, display, dir, thumb, selName, chosen, width, onPick, onOpen, onTab, onReveal, onSlow, onSlowCancel, label, peek, firstItem, onFirstItem, filtered }: {
  /** A filter is narrowing the view: a click acts at once. */
  filtered?: boolean;
  cut?: ReadonlySet<string>;
  density?: Prefs["density"];
  /** The first item at the top when it was left, and told when it changes. */
  firstItem?: number; onFirstItem?: (i: number) => void;
  peek?: PeekBinder | null; display: Display; dir: string; thumb: number; selName: string | null; chosen: ReadonlySet<string> | null; width: number; onPick: (r: Row, mod?: Mod) => void; onOpen: (r: Row) => void; onTab?: (r: Row) => void; onReveal?: (r: Row) => void; onSlow?: (r: Row, e: React.MouseEvent) => void; onSlowCancel?: () => void; label: string;
}) {
  const airy = density === "airy";
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
        <div key={i} className="flex" style={{ height: tile.h, padding: airy ? "0 5px" : "0 8px" }}>
          {rows.slice(i * per, i * per + per).map((r) => (
            <div key={r.name} role="option" {...(isFolder(r) && !r.locked ? peek?.bind(joinPath(dir, r.name), r.name) : undefined)} data-row={r.name} data-folder={isFolder(r) && !r.locked ? "" : undefined} draggable={!r.locked} aria-selected={r.name === selName || !!chosen?.has(r.name)} onMouseDown={noRange} {...rowPointer("icons", r, { onPick, onOpen, onTab, onReveal, onSlow, onSlowCancel, filtered, trash: inTrash(dir) })}
              className="flex flex-col items-center justify-start rounded-lg cursor-pointer min-w-0"
              style={{ opacity: cut?.has(r.name) ? CUT_OPACITY : undefined, width: tile.w - (airy ? 6 : CARD.spacing), height: tile.h - (airy ? 6 : CARD.spacing), ...(airy ? { padding: "5px 7px", margin: 3 } : { padding: "2px 4px", marginRight: CARD.spacing }), color: r.locked ? "var(--text4)" : "var(--text)", ...selStyle(r.name === selName || !!chosen?.has(r.name)) }}>
              <span data-icon className="agx-tile-part flex items-center justify-center rounded-md shrink-0" style={{ padding: CARD.pad, color: isFolder(r) ? "var(--warning-ink)" : "var(--text3)" }}>
                {!r.locked && !isFolder(r) && isThumbable(r.name) ? <Thumb path={joinPath(dir, r.name)} size={thumb} radius={6} fallback={<RowIcon row={r} dir={dir} size={ICON.xl} />} /> : <RowIcon row={r} dir={dir} size={Math.max(ICON.xl, Math.round(thumb * 0.6))} />}
              </span>
              <span data-name className="agx-tile-part w-full text-center text-[11.5px] line-clamp-2 break-all rounded-md shrink-0" style={{ marginTop: CARD.gap, lineHeight: `${CARD.line}px`, maxHeight: CARD.line * CARD.lines }} {...tip.bind(r.name)}>{rowLabel(r.name)}</span>
              <span data-details className="w-full text-center truncate text-[0.82em] shrink-0" style={{ height: CARD.details, lineHeight: `${CARD.details}px`, color: "var(--text3)" }}>{isFolder(r) ? itemsLabel(r.items) : r.bytes !== null ? formatSize(r.bytes) : ""}</span>
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

export function ListView({ widths, onWidths, cut, dir, display, selName, chosen, rowH, prefs, onPick, onOpen, onTab, onReveal, onSlow, onSlowCancel, onSort, label, peek, scrollTop, onScrollTop, recent, filtered }: {
  /** Name (0 = the rest), Size, Type, Modified, in pixels (lib/finderList). */
  widths: readonly number[]; onWidths: (w: number[]) => void;
  filtered?: boolean;
  cut?: ReadonlySet<string>;
  /** Set in Recent: its own sort; on Recency no header carries a mark. */
  recent?: RecentSort;
  scrollTop?: number; onScrollTop?: (t: number) => void;
  peek?: PeekBinder | null; dir: string; display: Display; selName: string | null; chosen: ReadonlySet<string> | null; rowH: number; prefs: Prefs; onPick: (r: Row, mod?: Mod) => void; onOpen: (r: Row) => void; onTab?: (r: Row) => void; onReveal?: (r: Row) => void; onSlow?: (r: Row, e: React.MouseEvent) => void; onSlowCancel?: () => void; onSort: (k: SortKey | "recency") => void; label: string;
}) {
  const at = display.rows.findIndex((r) => r.name === selName);
  const sortBy = recent ? recent.key : prefs.sortKey, sortWay = recent ? recent.dir : prefs.sortDir;
  const tpl = listTemplate(widths);
  const box = useRef<HTMLDivElement>(null);
  /* One heading: a sort button with Strata's arrow, and a 7 px handle on its right edge that drags the column and fits it on a double-click. */
  const head = (col: number, k: SortKey, t: string, right?: boolean) => {
    const here = sortBy === k;
    return (
      <div data-hcell={col} className="relative flex" style={{ borderRight: "1px solid color-mix(in srgb, var(--surface-line) 26%, transparent)", minWidth: 0 }}>
        <button className="agx-list-heading flex-1 min-w-0 flex items-center gap-1 text-left" style={{ color: here ? "var(--text)" : undefined, minHeight: 28, padding: "0 12px" }} onClick={() => onSort(k)} aria-sort={here ? (sortWay === "asc" ? "ascending" : "descending") : "none"}>
          <span className="flex-1 min-w-0 truncate" style={{ textAlign: right ? "right" : "left" }}>{t}</span>
          {here && <StrataIcon set="act" name={sortWay === "asc" ? "arrow-up" : "arrow-down"} size={12} />}
        </button>
        <div role="separator" aria-orientation="vertical" aria-label={`Resize ${t}`} title="Drag to resize, double-click to fit" className="absolute top-0 bottom-0" style={{ right: 0, width: 7, cursor: "col-resize", touchAction: "none" }}
          onDoubleClick={() => {
            const cells = [...(box.current?.querySelectorAll<HTMLElement>(`[data-cell="${col}"] > span`) ?? [])];
            const label = box.current?.querySelector<HTMLElement>(`[data-hcell="${col}"] button > span`);
            onWidths(fitList(widths, col, Math.max(label?.scrollWidth ?? 0, ...cells.map((c) => c.scrollWidth))));
          }}
          onPointerDown={(e) => {
            if (!activates(e.button, "mousedown")) return;
            e.preventDefault(); e.stopPropagation();
            const x0 = e.clientX, el = e.currentTarget, w0 = el.parentElement!.getBoundingClientRect().width;
            el.setPointerCapture(e.pointerId);
            const move = (ev: PointerEvent) => onWidths(resizeList(widths, col, w0, ev.clientX - x0));
            const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); };
            el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
          }} />
      </div>
    );
  };
  return (
    <div className="flex-1 min-h-0 min-w-0 agx-scroll overflow-x-auto overflow-y-hidden">
    {/* Under the columns' own widths the table scrolls sideways, as Strata's list does, instead of cutting the last column. */}
    <div ref={box} className="h-full min-h-0 flex flex-col" style={{ minWidth: listMinWidth(widths) }}>
      <div data-heading className="grid items-stretch shrink-0 px-1" style={{ gridTemplateColumns: tpl, minHeight: 28, fontSize: "0.82em", fontWeight: 700, color: "var(--text3)", background: PREVIEW_SURFACE, borderBottom: "1px solid color-mix(in srgb, var(--surface-line) 60%, transparent)" }}>
        {head(0, "name", "Name")}{head(1, "size", "Size", true)}{head(2, "type", "Type")}{head(3, "modified", "Modified")}
      </div>
      <VirtualList count={display.items.length} rowH={rowH} label={label} className="flex-1" keepInView={at < 0 ? null : display.itemOfRow[at]} initialTop={scrollTop} onTop={onScrollTop}
        render={(i) => {
          const it = display.items[i]!;
          if (it.header) return <div key={`h:${it.header}`} data-heading className="flex items-end px-3.5 pb-1 text-[12px]" style={{ height: rowH, color: "var(--text3)", fontWeight: 700, borderBottom: LINE }}>{it.header}</div>;
          const r = it.row!;
          return (
            <div key={r.name} role="option" {...(isFolder(r) && !r.locked ? peek?.bind(joinPath(dir, r.name), r.name) : undefined)} data-row={r.name} data-folder={isFolder(r) && !r.locked ? "" : undefined} draggable={!r.locked} aria-selected={r.name === selName || !!chosen?.has(r.name)} onMouseDown={noRange} {...rowPointer("list", r, { onPick, onOpen, onTab, onReveal, onSlow, onSlowCancel, filtered, trash: inTrash(dir) })}
              className="grid items-center mx-1 rounded-md cursor-pointer"
              style={{ opacity: cut?.has(r.name) ? CUT_OPACITY : undefined, gridTemplateColumns: tpl, height: rowH, color: r.locked ? "var(--text4)" : "var(--text)", ...selStyle(r.name === selName || !!chosen?.has(r.name)) }}>
              <span data-cell={0} className="flex items-center gap-2 min-w-0" style={{ padding: "0 12px" }}><span data-icon className="shrink-0 flex"><RowIcon row={r} dir={dir} /></span><span data-name className="truncate">{rowLabel(r.name)}</span></span>
              <span data-cell={1} className="min-w-0" style={{ padding: "0 12px", textAlign: "right" }}><span className="inline-block max-w-full truncate tabular-nums text-[11px] align-middle" style={{ color: "var(--text3)" }}>{isFolder(r) ? itemsLabel(r.items) : r.bytes !== null ? formatSize(r.bytes) : ""}</span></span>
              <span data-cell={2} className="min-w-0" style={{ padding: "0 12px" }}><span className="inline-block max-w-full truncate text-[11px] align-middle" style={{ color: "var(--text3)" }}>{kindWord(r)}</span></span>
              <span data-cell={3} className="min-w-0" style={{ padding: "0 12px" }}><span className="inline-block max-w-full truncate text-[11px] align-middle" style={{ color: "var(--text3)" }} title={new Date(r.mtime).toLocaleString()}>{strataWhen(r.mtime)}</span></span>
            </div>
          );
        }} />
    </div>
    </div>
  );
}

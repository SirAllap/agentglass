// The Icons and List views: one folder, the last column, as tiles or as a table.
//
// Both are the same data as the columns and the same selection — switching view
// never moves you. Both draw only what is on screen: the list is a
// VirtualList, and the tiles are a VirtualList of tile ROWS (a row holds as
// many tiles as fit, so the window is still arithmetic).
import { ago } from "../../../lib/fileRecents.ts";
import { api } from "../../../lib/api.ts";
import { Thumb } from "./Thumb.tsx";
import { formatSize, isFolder, isThumbable, itemsLabel, joinPath, kindWord, tileSize, tilesPerRow, type Display, type Prefs, type Row, type SortKey } from "../../../lib/finderMiller.ts";
import { ICON } from "../../../lib/iconSize.ts";
import { LINE } from "../../workspace/Chrome.tsx";
import { RowIcon, modOf, noRange, type Mod } from "./Column.tsx";
import { VirtualList } from "./VirtualList.tsx";

export { tilesPerRow };

const selStyle = (sel: boolean) => sel
  ? { background: "color-mix(in srgb, var(--primary) 16%, transparent)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--primary) 38%, transparent)" }
  : {};

export function IconsView({ display, dir, thumb, selName, chosen, width, onPick, onOpen, label }: {
  display: Display; dir: string; thumb: number; selName: string | null; chosen: ReadonlySet<string> | null; width: number; onPick: (r: Row, mod?: Mod) => void; onOpen: (r: Row) => void; label: string;
}) {
  const per = tilesPerRow(width, thumb);
  const tile = tileSize(thumb);
  const rows = display.rows;
  const lines = Math.ceil(rows.length / per);
  const at = rows.findIndex((r) => r.name === selName);
  return (
    <VirtualList count={lines} rowH={tile.h} label={label} className="flex-1" keepInView={at < 0 ? null : Math.floor(at / per)}
      render={(i) => (
        <div key={i} className="flex px-2" style={{ height: tile.h }}>
          {rows.slice(i * per, i * per + per).map((r) => (
            <div key={r.name} role="option" data-row={r.name} data-folder={isFolder(r) && !r.locked ? "" : undefined} draggable={!r.locked} aria-selected={r.name === selName || !!chosen?.has(r.name)} title={r.name} onMouseDown={noRange} onClick={(e) => onPick(r, modOf(e))} onDoubleClick={() => onOpen(r)}
              className="flex flex-col items-center justify-center gap-1.5 rounded-lg cursor-pointer px-1 min-w-0"
              style={{ width: tile.w, height: tile.h - 4, color: r.locked ? "var(--text4)" : "var(--text)", ...selStyle(r.name === selName || !!chosen?.has(r.name)) }}>
              <span className="flex" style={{ color: isFolder(r) ? "var(--warning-ink)" : "var(--text3)" }}>
                {!r.locked && !isFolder(r) && isThumbable(r.name) ? <Thumb path={joinPath(dir, r.name)} size={thumb} radius={6} fallback={<RowIcon row={r} size={ICON.xl} />} /> : <RowIcon row={r} size={Math.max(ICON.xl, Math.round(thumb * 0.6))} />}
              </span>
              <span className="w-full text-center text-[11.5px] leading-tight line-clamp-2 break-all">{r.name}</span>
            </div>
          ))}
        </div>
      )} />
  );
}

const COLS = "minmax(0,1fr) 92px 112px 112px";

export function ListView({ display, selName, chosen, rowH, prefs, onPick, onOpen, onSort, label }: {
  display: Display; selName: string | null; chosen: ReadonlySet<string> | null; rowH: number; prefs: Prefs; onPick: (r: Row, mod?: Mod) => void; onOpen: (r: Row) => void; onSort: (k: SortKey) => void; label: string;
}) {
  const at = display.rows.findIndex((r) => r.name === selName);
  const head = (k: SortKey, t: string, right?: boolean) => (
    <button className="agx-btn text-left px-1 rounded" style={{ color: prefs.sortKey === k ? "var(--text)" : "var(--text3)", textAlign: right ? "right" : "left" }} onClick={() => onSort(k)} aria-sort={prefs.sortKey === k ? (prefs.sortDir === "asc" ? "ascending" : "descending") : "none"}>
      {t}{prefs.sortKey === k ? (prefs.sortDir === "asc" ? " ↑" : " ↓") : ""}
    </button>
  );
  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col">
      <div className="grid items-center gap-2 px-3.5 text-[11px] shrink-0" style={{ gridTemplateColumns: COLS, minHeight: 28, borderBottom: LINE }}>
        {head("name", "Name")}{head("size", "Size", true)}<span className="px-1" style={{ color: "var(--text3)" }}>Type</span>{head("modified", "Modified")}
      </div>
      <VirtualList count={display.items.length} rowH={rowH} label={label} className="flex-1" keepInView={at < 0 ? null : display.itemOfRow[at]}
        render={(i) => {
          const it = display.items[i]!;
          if (it.header) return <div key={`h:${it.header}`} className="flex items-end px-3.5 pb-1 text-[9.5px] uppercase tracking-[0.14em]" style={{ height: rowH, color: "var(--text4)", fontWeight: 600 }}>{it.header}</div>;
          const r = it.row!;
          return (
            <div key={r.name} role="option" data-row={r.name} data-folder={isFolder(r) && !r.locked ? "" : undefined} draggable={!r.locked} aria-selected={r.name === selName || !!chosen?.has(r.name)} onMouseDown={noRange} onClick={(e) => onPick(r, modOf(e))} onDoubleClick={() => onOpen(r)}
              className="grid items-center gap-2 px-3.5 mx-1 rounded-md cursor-pointer"
              style={{ gridTemplateColumns: COLS, height: rowH, color: r.locked ? "var(--text4)" : "var(--text)", ...selStyle(r.name === selName || !!chosen?.has(r.name)) }}>
              <span className="flex items-center gap-2 min-w-0"><span className="shrink-0 flex"><RowIcon row={r} /></span><span className="truncate">{r.name}</span></span>
              <span className="text-right tabular-nums text-[11px]" style={{ color: "var(--text3)" }}>{isFolder(r) ? itemsLabel(r.items) : r.bytes !== null ? formatSize(r.bytes) : ""}</span>
              <span className="text-[11px] truncate" style={{ color: "var(--text3)" }}>{kindWord(r)}</span>
              <span className="text-[11px] truncate" style={{ color: "var(--text3)" }} title={new Date(r.mtime).toLocaleString()}>{ago(r.mtime)}</span>
            </div>
          );
        }} />
    </div>
  );
}

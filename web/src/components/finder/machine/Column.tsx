// One column of the Miller view: a folder's name and count over its rows.
//
// The header carries the four things Strata's columns carry — refresh, sort,
// options, filter — and a count badge that is known from the first page, so a
// 100,000-entry folder says so before it has drawn its first row. Selection is
// by NAME, not by index: the rows arrive in pages and are re-sorted, so an index
// would point at a different file a moment later.
import { useRef, useState } from "react";
import { CaretIcon, CodeFileIcon, FileIcon, FolderIcon, ImageFileIcon, LinkIcon, LockIcon, MoreIcon, NoteIcon, SearchIcon, SwapIcon } from "../../../lib/glyphIcons.tsx";
import { HIT, ICON } from "../../../lib/iconSize.ts";
import { fileKind, humanBytes } from "../../../lib/paletteModel.ts";
import { isFolder, itemsLabel, type Display, type Prefs, type Row, type SortKey } from "../../../lib/finderMiller.ts";
import type { FolderState } from "../../../lib/finderFolders.ts";
import { INPUT, INPUT_STYLE, LINE, RefreshButton } from "../../workspace/Chrome.tsx";
import { MenuCap, MenuItem, MenuRule, Popover } from "./Popover.tsx";
import { VirtualList } from "./VirtualList.tsx";

export function RowIcon({ row, size = ICON.sm }: { row: Row; size?: number }) {
  if (row.locked) return <LockIcon size={size} />;
  if (row.kind === "link") return <LinkIcon size={size} />;
  if (isFolder(row)) return <FolderIcon size={size} />;
  const k = fileKind(row.name, false);
  return k === "code" || k === "data" ? <CodeFileIcon size={size} /> : k === "image" ? <ImageFileIcon size={size} /> : k === "markdown" ? <NoteIcon size={size} /> : <FileIcon size={size} />;
}

export function Column({ title, state, display, selName, focused, prefs, rowH, filter, onFilter, onPick, onOpen, onFocusCol, onRefresh, onSort, onPref }: {
  title: string;
  state: FolderState | undefined;
  display: Display;
  selName: string | null;
  focused: boolean;
  prefs: Prefs;
  rowH: number;
  filter: string;
  onFilter: (v: string) => void;
  onPick: (row: Row) => void;
  onOpen: (row: Row) => void;
  onFocusCol: () => void;
  onRefresh: () => void;
  onSort: (k: SortKey) => void;
  onPref: (p: Partial<Prefs>) => void;
}) {
  const [menu, setMenu] = useState<{ kind: "sort" | "opts"; at: DOMRect } | null>(null);
  const [finding, setFinding] = useState(filter !== "");
  const input = useRef<HTMLInputElement>(null);
  const selItem = (() => { const i = display.rows.findIndex((r) => r.name === selName); return i < 0 ? null : display.itemOfRow[i]!; })();
  const loading = !state || !state.done;
  const btn = "agx-btn rounded-md grid place-items-center shrink-0";
  const open = (kind: "sort" | "opts") => (e: React.MouseEvent<HTMLButtonElement>) => setMenu({ kind, at: e.currentTarget.getBoundingClientRect() });

  return (
    <section aria-label={`Folder ${title}`} onMouseDown={onFocusCol} className="relative flex flex-col min-h-0 shrink-0"
      style={{ width: 232, borderRight: LINE }}>
      {/* The column that has the keyboard wears a bar on top; a colour alone would not survive a theme that has no accent to spare. */}
      <div aria-hidden className="absolute left-0 right-0 top-0" style={{ height: 3, background: focused ? "var(--primary)" : "transparent", zIndex: 2 }} />
      <header className="flex items-center gap-1 px-2.5 pt-2 pb-1.5 shrink-0" style={{ borderBottom: LINE }}>
        <b className="flex-1 min-w-0 truncate text-[12px]" title={title}>{title}</b>
        {state && (
          <span className="shrink-0 tabular-nums text-[10px] px-1.5 rounded-md" aria-live="polite"
            style={{ background: "color-mix(in srgb, var(--text) 9%, transparent)", color: "var(--text3)" }}>
            {state.total.toLocaleString()}{loading ? "…" : ""}
          </span>
        )}
        <RefreshButton onRefresh={onRefresh} title="Reload this folder" />
        <button className={btn} style={{ width: HIT, height: HIT, color: "var(--text3)" }} title="Sort this folder" aria-label="Sort this folder" aria-haspopup="menu" onClick={open("sort")}><SwapIcon size={ICON.sm} /></button>
        <button className={btn} style={{ width: HIT, height: HIT, color: "var(--text3)" }} title="Options" aria-label="Options" aria-haspopup="menu" onClick={open("opts")}><MoreIcon size={ICON.sm} /></button>
        <button className={btn} aria-pressed={finding} style={{ width: HIT, height: HIT, color: finding ? "var(--primary-ink)" : "var(--text3)" }} title="Filter by name" aria-label="Filter by name"
          onClick={() => { const on = !finding; setFinding(on); if (!on) onFilter(""); else setTimeout(() => input.current?.focus(), 0); }}><SearchIcon size={ICON.sm} /></button>
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
          {loading ? "Reading…" : filter ? `Nothing here is called “${filter}”.` : state && state.hiddenSkipped ? `Empty. ${state.hiddenSkipped} hidden ${state.hiddenSkipped === 1 ? "item" : "items"} left out.` : "Empty folder."}
        </div>
      ) : (
        <VirtualList count={display.items.length} rowH={rowH} label={`Entries of ${title}`} className="flex-1" keepInView={selItem}
          render={(i) => {
            const it = display.items[i]!;
            if (it.header) {
              return <div key={`h:${it.header}`} className="flex items-end px-3 pb-1 text-[9.5px] uppercase tracking-[0.14em]" style={{ height: rowH, color: "var(--text4)", fontWeight: 600 }}>{it.header}</div>;
            }
            const r = it.row!;
            const sel = r.name === selName;
            const dir = isFolder(r);
            return (
              <div key={r.name} role="option" aria-selected={sel} aria-disabled={r.locked || undefined} title={r.why ?? r.name}
                onClick={() => onPick(r)} onDoubleClick={() => onOpen(r)}
                className="flex items-center gap-2 px-2.5 mx-1 rounded-md cursor-pointer"
                style={{
                  height: rowH, color: r.locked ? "var(--text4)" : "var(--text)", fontWeight: sel ? 600 : 400,
                  background: sel ? "color-mix(in srgb, var(--primary) 16%, transparent)" : undefined,
                  boxShadow: sel ? "inset 0 0 0 1px color-mix(in srgb, var(--primary) 38%, transparent)" : undefined,
                }}>
                <span className="shrink-0 flex" style={{ color: dir ? "var(--warning-ink)" : "var(--text3)" }}><RowIcon row={r} /></span>
                <span className="flex-1 min-w-0 truncate">{r.name}</span>
                {dir ? (
                  <>
                    {r.items !== null && <span className="shrink-0 tabular-nums text-[10px] px-1.5 rounded-md" style={{ background: "color-mix(in srgb, var(--text) 9%, transparent)", color: "var(--text3)", fontWeight: 400 }}>{itemsLabel(r.items)}</span>}
                    <span className="shrink-0 flex" style={{ color: "var(--text4)", transform: "rotate(-90deg)" }}><CaretIcon size={ICON.xs} /></span>
                  </>
                ) : prefs.sizes && r.bytes !== null ? (
                  <span className="shrink-0 tabular-nums text-[10.5px]" style={{ color: "var(--text4)", fontWeight: 400 }}>{humanBytes(r.bytes)}</span>
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

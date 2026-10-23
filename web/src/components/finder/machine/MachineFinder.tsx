// The Machine tab, as a file manager: sidebar, path bar, Miller columns (or
// icons, or a list) and a preview panel.
//
// The design and behaviour are Strata's (MIT, github.com/lgse/strata), carried
// over as ideas — Strata is Rust and GTK, this is React over the engine's own
// folder reads. What it deliberately is not: an editor. "Open in nvim" opens the
// bench, and nothing here changes a file.
//
// Where the pieces live: the order, windowing and key decisions are in
// lib/finderMiller.ts and lib/finderKeys.ts, where they are tested; the reading
// of a folder a page at a time is lib/finderFolders.ts. This file only holds the
// state and draws it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../lib/api.ts";
import { FolderStore, type FolderState } from "../../../lib/finderFolders.ts";
import { finderKey } from "../../../lib/finderKeys.ts";
import {
  DEFAULT_PREFS, canEditRow, displayRows, gridStep, indexOfName, isFolder, itemsLabel, joinPath, keyStep, parentOf, readPrefs, rowHeight, writePrefs,
  type ColShape, type Display, type Prefs, type Row, type SortKey,
} from "../../../lib/finderMiller.ts";
import { CopyIcon, GridIcon, KeyboardIcon, TreeIcon } from "../../../lib/glyphIcons.tsx";
import { HIT, ICON } from "../../../lib/iconSize.ts";
import { isAppChord } from "../../../lib/keybindings.ts";
import { humanBytes } from "../../../lib/paletteModel.ts";
import type { DiskPlace } from "../../../../../shared/types.ts";
import { EDGE, LINE } from "../../workspace/Chrome.tsx";
import { Column } from "./Column.tsx";
import { AppearanceMenu, HelpSheet } from "./FinderChrome.tsx";
import { FinderPathBar } from "./FinderPathBar.tsx";
import { IconsView, ListView, tilesPerRow } from "./FolderViews.tsx";
import { QuickLook } from "./QuickLook.tsx";
import { Sidebar, placesFor } from "./Sidebar.tsx";
import { useBox } from "./useBox.ts";

const PREFS_KEY = "agentglass.finder.machine.prefs";
const loadPrefs = (): Prefs => { try { return readPrefs(localStorage.getItem(PREFS_KEY)); } catch { return DEFAULT_PREFS; } };
const savePrefs = (p: Prefs) => { try { localStorage.setItem(PREFS_KEY, writePrefs(p)); } catch { /* a private window forgets; the finder still works */ } };

/** Wide enough for the sidebar and the columns side by side. */
const SIDE_MIN = 640;
/** Wide enough to keep the preview beside the columns. */
const PREVIEW_MIN = 900;
/** Past this many rows a folder that is still arriving is not re-sorted on every page. */
const BIG = 2000;

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1) || "/";

export function MachineFinder({ home, start, places, onPlace, onBench, onRecent }: {
  home: string;
  /** Where to open, and where to go when the palette's own place changes. */
  start: string;
  places: readonly DiskPlace[];
  /** The finder went somewhere on purpose (sidebar, path bar, up): the palette remembers it as the place. */
  onPlace: (path: string) => void;
  onBench: (path: string, mode: "edit" | "terminal") => void;
  onRecent: () => void;
}) {
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const setPrefs = useCallback((p: Partial<Prefs>) => setPrefsState((cur) => { const n = { ...cur, ...p }; savePrefs(n); return n; }), []);

  const [trail, setTrail] = useState<string[]>([start || home || "/"]);
  const [sel, setSel] = useState<(string | null)[]>([null]);
  const [focusCol, setFocusCol] = useState(0);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [peek, setPeek] = useState(false);
  const [sidePage, setSidePage] = useState(false);
  const [help, setHelp] = useState(false);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pathSignal, setPathSignal] = useState(0);
  const [version, setVersion] = useState(0);
  const wantFirst = useRef<number | null>(null);

  const root = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const box = useBox(root);
  const mainBox = useBox(main);
  const compact = box.w > 0 && box.w < SIDE_MIN;
  const wide = box.w >= PREVIEW_MIN;

  /* Made and torn down by the effect, not at first render: React runs a dev effect
     twice (mount, cleanup, mount), and a store disposed by the first cleanup and
     reused by the second would ignore every folder it was asked for. */
  const store = useRef<FolderStore | null>(null);
  const [ready, setReady] = useState(0);
  useEffect(() => {
    const s = new FolderStore((p, c, h, l, sig) => api.browseList(p, c, h, sig, l), () => setVersion((v) => v + 1));
    store.current = s;
    setReady((n) => n + 1);
    return () => { s.dispose(); if (store.current === s) store.current = null; };
  }, []);
  useEffect(() => { for (const p of trail) store.current?.load(p, prefs.hidden); }, [trail, prefs.hidden, ready]);

  /* The palette's own place moved (a chip, a link): follow it. A move this finder made itself is already here. */
  const seen = useRef(start);
  useEffect(() => {
    if (!start || start === seen.current) return;
    seen.current = start;
    setTrail([start]); setSel([null]); setFocusCol(0);
  }, [start]);

  const go = useCallback((path: string) => {
    seen.current = path;
    setTrail([path]); setSel([null]); setFocusCol(0); setPeek(false); setSidePage(false);
    onPlace(path);
  }, [onPlace]);

  const goUp = useCallback(() => {
    const p = parentOf(trail[0]!);
    if (!p) return;
    seen.current = p;
    setTrail((t) => [p, ...t]); setSel((s) => [basename(trail[0]!), ...s]); setFocusCol(0);
    onPlace(p);
  }, [trail, onPlace]);

  /* ---- what each column draws ---- */
  const cache = useRef(new Map<string, { rows: Row[]; sig: string; display: Display }>());
  const columns = useMemo(() => trail.map((path) => {
    const state: FolderState | undefined = store.current?.get(path);
    const needle = filters[path] ?? "";
    const big = !!state && !state.done && state.rows.length > BIG;
    const sig = `${needle}|${prefs.hidden}|${prefs.group}|${prefs.sortKey}|${prefs.sortDir}|${big}`;
    const hit = cache.current.get(path);
    if (state && hit && hit.rows === state.rows && hit.sig === sig) return { path, state, display: hit.display };
    const display = displayRows(state?.rows ?? [], { needle, hidden: prefs.hidden, group: prefs.group, sortKey: prefs.sortKey, sortDir: prefs.sortDir, unsorted: big });
    if (state) cache.current.set(path, { rows: state.rows, sig, display });
    return { path, state, display };
    // `version` is how the store says its rows changed.
  }), [trail, version, ready, filters, prefs.hidden, prefs.group, prefs.sortKey, prefs.sortDir]);

  /* ---- selection ---- */
  const pick = useCallback((col: number, row: Row) => {
    setSel((s) => [...s.slice(0, col), row.name]);
    setTrail((t) => (isFolder(row) && !row.locked ? [...t.slice(0, col + 1), joinPath(t[col]!, row.name)] : t.slice(0, col + 1)));
    setFocusCol(col);
  }, []);

  const last = trail.length - 1;
  // A folder row that is selected has its own column; the selection that matters for the preview is the deepest one.
  const deepest = (() => {
    for (let c = trail.length - 1; c >= 0; c--) {
      const name = sel[c];
      if (name) { const row = columns[c]?.display.rows.find((r) => r.name === name) ?? null; return row ? { col: c, row, path: joinPath(trail[c]!, name) } : null; }
    }
    return null;
  })();

  const enterFolder = useCallback((col: number) => {
    const name = sel[col];
    const row = name ? columns[col]?.display.rows.find((r) => r.name === name) : null;
    if (!row || !isFolder(row) || row.locked) return;
    wantFirst.current = col + 1;
    setFocusCol(col + 1);
    setTrail((t) => [...t.slice(0, col + 1), joinPath(t[col]!, row.name)]);
    setSel((s) => [...s.slice(0, col + 1), null]);
  }, [sel, columns]);

  // The folder just entered has no rows until its first page lands; select its first row then.
  useEffect(() => {
    const c = wantFirst.current;
    if (c === null) return;
    const col = columns[c];
    if (!col?.state) return;
    if (col.display.rows.length) { wantFirst.current = null; pick(c, col.display.rows[0]!); }
    else if (col.state.done) wantFirst.current = null;
  }, [columns, pick]);

  const shapes: ColShape[] = useMemo(() => columns.map((c, i) => {
    const at = indexOfName(c.display.rows, sel[i] ?? null);
    return { rows: c.display.rows.length, sel: at < 0 ? null : at, dirs: c.display.rows.flatMap((r, ix) => (isFolder(r) && !r.locked ? [ix] : [])) };
  }), [columns, sel]);

  const move = useCallback((key: string) => {
    if (prefs.view !== "columns") {
      const c = columns[last]; if (!c) return;
      const rows = c.display.rows;
      const at = indexOfName(rows, sel[last] ?? null);
      if (key === "ArrowLeft" && prefs.view === "list") { goUp(); return; }
      const per = prefs.view === "icons" ? tilesPerRow(mainBox.w) : 1;
      const next = prefs.view === "list" && key === "ArrowRight" ? at : gridStep(at < 0 ? 0 : at, rows.length, per, key);
      const row = rows[at < 0 && (key === "ArrowDown" || key === "ArrowRight") ? 0 : next]; if (row) pick(last, row);
      return;
    }
    const col = columns[focusCol]; if (!col) return;
    if (key === "ArrowLeft" && focusCol === 0) { goUp(); return; }
    const at = Math.max(0, shapes[focusCol]!.sel ?? 0);
    const to = keyStep({ col: focusCol, row: at }, key, shapes);
    if (to.col !== focusCol) {
      if (to.col > focusCol) { enterFolder(focusCol); return; }
      setFocusCol(to.col); return;
    }
    if (key === "ArrowDown" && shapes[focusCol]!.sel === null) { const r = col.display.rows[0]; if (r) pick(focusCol, r); return; }
    const row = col.display.rows[to.row]; if (row) pick(focusCol, row);
  }, [prefs.view, columns, last, focusCol, sel, shapes, mainBox.w, goUp, pick, enterFolder]);

  const copy = useCallback((p: string) => {
    void navigator.clipboard?.writeText(p).then(() => setNote(`Copied ${p}`)).catch(() => setNote("Could not copy"));
  }, []);
  const currentPath = deepest?.path ?? trail[focusCol] ?? trail[0]!;

  const toggleSide = useCallback(() => (compact ? setSidePage((v) => !v) : setPrefs({ sidebar: !prefs.sidebar })), [compact, prefs.sidebar, setPrefs]);

  const act = useCallback((a: NonNullable<ReturnType<typeof finderKey>>) => {
    switch (a.t) {
      case "move": move(a.key); break;
      case "enter": {
        if (!deepest) break;
        if (isFolder(deepest.row)) { if (prefs.view === "columns") enterFolder(deepest.col); else { go(deepest.path); } }
        else if (canEditRow(deepest.row)) onBench(deepest.path, "edit");
        break;
      }
      case "up": goUp(); break;
      case "preview": if (wide) setPrefs({ preview: !prefs.preview }); else setPeek((p) => !p); break;
      case "hidden": setPrefs({ hidden: !prefs.hidden }); break;
      case "sidebar": toggleSide(); break;
      case "path": setPathSignal((n) => n + 1); break;
      case "copy": copy(currentPath); break;
      case "help": setHelp((h) => !h); break;
    }
  }, [move, deepest, prefs, enterFolder, go, goUp, onBench, wide, toggleSide, setPrefs, copy, currentPath]);

  // On the window, capture phase: the palette keeps focus in its own search box, and ↓ there must still move the list.
  const actRef = useRef(act); actRef.current = act;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (isAppChord(e)) return;
      const t = e.target as HTMLElement | null;
      const field = !!t && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable);
      const own = !!t?.closest?.("[data-finder-box]");
      const inField = field && !(own && (t as HTMLInputElement).value === "");
      if (!own && !root.current?.contains(t) && t !== document.body) return;
      const a = finderKey({ key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey }, { inField, hasSelection: !!window.getSelection()?.toString() });
      if (!a) return;
      e.preventDefault(); e.stopPropagation();
      actRef.current(a);
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, []);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 1800); return () => clearTimeout(t); }, [note]);

  const refresh = (p: string) => store.current?.load(p, prefs.hidden, true);
  const onSort = (k: SortKey) => setPrefs(prefs.sortKey === k ? { sortDir: prefs.sortDir === "asc" ? "desc" : "asc" } : { sortKey: k, sortDir: "asc" });
  const rowH = rowHeight(prefs.density, prefs.textSize);

  /* ---- layout ---- */
  const sideOn = compact ? sidePage : prefs.sidebar;
  const previewInline = wide && prefs.preview;
  const previewOnly = !previewInline && peek;
  const lastCol = columns[last];
  const preview = (
    <QuickLook path={deepest?.path ?? null} row={deepest?.row ?? null}
      rows={deepest && isFolder(deepest.row) ? (columns[deepest.col + 1]?.state?.rows ?? null) : null}
      onBench={onBench} onCopy={copy} />
  );

  const status = (() => {
    if (note) return note;
    const n = lastCol?.state;
    const where = n ? `${n.total.toLocaleString()} ${n.total === 1 ? "item" : "items"}${n.done ? "" : " so far"}` : "Reading…";
    if (!deepest) return `${where} · ↑↓ move · → open folder · Space preview · F1 help`;
    const r = deepest.row;
    const what = isFolder(r) ? `${itemsLabel(r.items)}` : r.bytes !== null ? humanBytes(r.bytes) : "";
    return `${where} · ${r.name}${what ? ` · ${what}` : ""} · ${isFolder(r) ? "→ open folder" : r.locked ? "not opened here" : canEditRow(r) ? "⏎ open in nvim" : "no text to edit"} · Ctrl+C copy path`;
  })();

  const tool = "agx-btn rounded-md grid place-items-center shrink-0";
  return (
    <div ref={root} data-machine-finder className="relative flex-1 min-h-0 min-w-0 flex flex-col" style={{ fontSize: prefs.textSize, color: "var(--text)" }}>
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 shrink-0" style={{ borderBottom: LINE }}>
        <button className={tool} style={{ width: HIT, height: HIT, border: EDGE, color: sideOn ? "var(--text)" : "var(--text3)" }} aria-pressed={sideOn} title="Show or hide the sidebar (Ctrl+B)" aria-label="Show or hide the sidebar"
          onClick={toggleSide}><TreeIcon size={ICON.sm} /></button>
        <FinderPathBar path={trail[last] ?? trail[0]!} home={home} onGo={go} signalEdit={pathSignal} />
        <button className={tool} style={{ width: HIT, height: HIT, border: EDGE, color: "var(--text2)" }} title="Copy the selected path (Ctrl+C)" aria-label="Copy path" onClick={() => copy(currentPath)}><CopyIcon size={ICON.sm} /></button>
        <button className={tool} style={{ width: HIT, height: HIT, border: EDGE, color: "var(--text2)" }} title="Appearance" aria-label="Appearance" aria-haspopup="menu" onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())}><GridIcon size={ICON.sm} /></button>
        <button className={tool} style={{ width: HIT, height: HIT, border: EDGE, color: "var(--text2)" }} title="Shortcuts (F1)" aria-label="Shortcuts" onClick={() => setHelp(true)}><KeyboardIcon size={ICON.sm} /></button>
      </div>

      <div className="flex-1 min-h-0 flex">
        {sideOn && <Sidebar places={placesFor(home, places)} here={trail[0]!} onGo={go} onRecent={onRecent} />}
        {!(compact && sidePage) && (
          <>
            <div ref={main} className="flex-1 min-w-0 min-h-0 flex">
              {previewOnly ? (
                <div className="flex-1 min-w-0 min-h-0 flex flex-col">
                  <button className="agx-btn text-left px-3 text-[11px] shrink-0" style={{ minHeight: HIT, color: "var(--text3)", borderBottom: LINE }} onClick={() => setPeek(false)}>← Back to the folder (Space)</button>
                  {preview}
                </div>
              ) : prefs.view === "columns" ? (
                <ColumnsRow>
                  {columns.map((c, i) => (
                    <Column key={c.path} title={basename(c.path)} state={c.state} display={c.display} selName={sel[i] ?? null} focused={i === focusCol} prefs={prefs} rowH={rowH}
                      filter={filters[c.path] ?? ""} onFilter={(v) => setFilters((f) => ({ ...f, [c.path]: v }))}
                      onPick={(r) => pick(i, r)} onOpen={(r) => { if (isFolder(r) && !r.locked) { pick(i, r); enterFolder(i); } else if (canEditRow(r)) onBench(joinPath(c.path, r.name), "edit"); }}
                      onFocusCol={() => setFocusCol(i)} onRefresh={() => refresh(c.path)} onSort={onSort} onPref={setPrefs} />
                  ))}
                </ColumnsRow>
              ) : lastCol ? (
                <div className="flex-1 min-w-0 min-h-0 flex flex-col">
                  {lastCol.state?.error ? <div className="p-3 text-[12px]" role="alert" style={{ color: "var(--warning-ink)" }}>{lastCol.state.error}</div>
                    : prefs.view === "icons"
                      ? <IconsView display={lastCol.display} selName={sel[last] ?? null} width={mainBox.w} label={`Entries of ${basename(lastCol.path)}`} onPick={(r) => pick(last, r)} onOpen={(r) => (isFolder(r) && !r.locked ? go(joinPath(lastCol.path, r.name)) : canEditRow(r) && onBench(joinPath(lastCol.path, r.name), "edit"))} />
                      : <ListView display={lastCol.display} selName={sel[last] ?? null} rowH={rowH} prefs={prefs} label={`Entries of ${basename(lastCol.path)}`} onSort={onSort} onPick={(r) => pick(last, r)} onOpen={(r) => (isFolder(r) && !r.locked ? go(joinPath(lastCol.path, r.name)) : canEditRow(r) && onBench(joinPath(lastCol.path, r.name), "edit"))} />}
                </div>
              ) : null}
            </div>
            {previewInline && (
              <div className="shrink-0 min-h-0 flex" style={{ width: Math.max(300, Math.min(460, Math.round(box.w * 0.36))), borderLeft: LINE, background: "var(--surface-card)" }}>{preview}</div>
            )}
          </>
        )}
      </div>

      <div className="flex items-center px-3 shrink-0 text-[11px] truncate" style={{ minHeight: 26, borderTop: LINE, color: "var(--text3)" }} aria-live="polite">{status}</div>
      {help && <HelpSheet onClose={() => setHelp(false)} />}
      {menu && <AppearanceMenu anchor={menu} prefs={prefs} onPref={setPrefs} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** The columns, scrolled to the right-hand end whenever one is added so the newest is the one in view. */
function ColumnsRow({ children }: { children: React.ReactNode }) {
  const el = useRef<HTMLDivElement>(null);
  const n = Array.isArray(children) ? children.length : 1;
  useEffect(() => { if (el.current) el.current.scrollLeft = el.current.scrollWidth; }, [n]);
  return <div ref={el} className="agx-scroll flex-1 min-w-0 min-h-0 flex overflow-x-auto overflow-y-hidden">{children}</div>;
}

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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../lib/api.ts";
import { FolderStore, type FolderState } from "../../../lib/finderFolders.ts";
import { columnWidth, fitWidth, previewFits, stripLayout, previewWidth, sidebarWidth } from "../../../lib/finderColumns.ts";
import { back as histBack, canBack, canForward, forward as histForward, here as histHere, startHistory, visit, type History } from "../../../lib/finderHistory.ts";
import { readMachineSnap, writeMachineSnap } from "../../../lib/finderMachineState.ts";
import { finderKey } from "../../../lib/finderKeys.ts";
import { clickSelect, extendBy, extendSelect, selectAll, selectedFooter, single, toggleCursor, type Choice } from "../../../lib/finderSelect.ts";
import {
  DEFAULT_PREFS, canEditRow, displayRows, opensOnPick, footerCount, gridStep, indexOfName, isFolder, joinPath, keyStep, nextSidebar, parentOf, readPrefs, rowHeight, sidebarMode, sidebarPrefs, sidebarTip, writePrefs,
  type ColShape, type Display, type Prefs, type Row, type SortKey,
} from "../../../lib/finderMiller.ts";
import { HIT } from "../../../lib/iconSize.ts";
import { isAppChord } from "../../../lib/keybindings.ts";
import type { DiskPlace } from "../../../../../shared/types.ts";
import { EDGE, LINE } from "../../workspace/Chrome.tsx";
import { Column, type Mod } from "./Column.tsx";
import { AppearanceMenu, FinderSettings, HelpSheet } from "./FinderChrome.tsx";
import { clearDraft, dirtyPaths, exitDecision, saveDrafts, type Exit } from "../../../lib/finderEdit.ts";
import { FinderPathBar } from "./FinderPathBar.tsx";
import { FinderSearch } from "./FinderSearch.tsx";
import type { HitTarget } from "../../../lib/finderSearch.ts";
import { IconsView, ListView, tilesPerRow } from "./FolderViews.tsx";
import { StrataIcon } from "./StrataIcon.tsx";
import { QuickLook } from "./QuickLook.tsx";
import { Sidebar, placesFor } from "./Sidebar.tsx";
import { useBox } from "./useBox.ts";

const PREFS_KEY = "agentglass.finder.machine.prefs";
const loadPrefs = (): Prefs => { try { return readPrefs(localStorage.getItem(PREFS_KEY)); } catch { return DEFAULT_PREFS; } };
const savePrefs = (p: Prefs) => { try { localStorage.setItem(PREFS_KEY, writePrefs(p)); } catch { /* a private window forgets; the finder still works */ } };

const SNAP_KEY = "agentglass.finder.machine.state";
const loadSnap = () => { try { return readMachineSnap(localStorage.getItem(SNAP_KEY)); } catch { return null; } };

/** How long a one-line answer ("Copied …") stays in the footer: Strata's FEEDBACK_FLASH. */
const FEEDBACK_MS = 2000;

/** Wide enough for the sidebar and the columns side by side. */
const SIDE_MIN = 640;
/** Past this many rows a folder that is still arriving is not re-sorted on every page. */
const BIG = 2000;

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1) || "/";

export function MachineFinder({ home, start, places, target, onPlace, onBench, onRecent, onClose: closeNow }: {
  home: string;
  /** Where to open, and where to go when the palette's own place changes. */
  start: string;
  /** A path somebody clicked in a terminal: its folder opens and it is selected. Null when there is none. */
  target?: string | null;
  places: readonly DiskPlace[];
  /** The finder went somewhere on purpose (sidebar, path bar, up): the palette remembers it as the place. */
  onPlace: (path: string) => void;
  onBench: (path: string, mode: "edit" | "terminal") => void;
  onRecent: () => void;
  /** The way out of the finder: it lives at the end of the path-bar row, where Strata has its close. */
  onClose: () => void;
}) {
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  /* Every way out of an edit that was never saved asks first (lib/finderEdit.EXITS): the move is held in `held`
     and runs once the person has said Save or Discard. */
  const [held, setHeld] = useState<{ exit: Exit; run: () => void } | null>(null);
  const [heldErr, setHeldErr] = useState<string | null>(null);
  const guarded = useCallback(<A extends unknown[]>(exit: Exit, fn: (...a: A) => void) => (...a: A) => {
    if (exitDecision(dirtyPaths().length, exit) === "go") fn(...a); else { setHeldErr(null); setHeld({ exit, run: () => fn(...a) }); }
  }, []);
  const onClose = useMemo(() => guarded("finder-close", closeNow), [guarded, closeNow]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || exitDecision(dirtyPaths().length, "finder-close") === "go" || (e.target as HTMLElement | null)?.tagName === "TEXTAREA") return;
      e.preventDefault(); e.stopImmediatePropagation(); setHeldErr(null); setHeld({ exit: "finder-close", run: closeNow });
    };
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [closeNow]);
  const setPrefs = useCallback((p: Partial<Prefs>) => setPrefsState((cur) => { const n = { ...cur, ...p }; savePrefs(n); return n; }), []);

  /* Where it was left, if that is still where the palette says it is: a chip or a link that moved the place wins over the memory. */
  const [back] = useState(() => { const s = loadSnap(); return s && s.trail[0] === (start || home || "/") ? s : null; });
  const [trail, setTrail] = useState<string[]>(() => back?.trail ?? [start || home || "/"]);
  const [sel, setSel] = useState<(string | null)[]>(() => back?.sel ?? [null]);
  const selRef = useRef(sel); selRef.current = sel;
  const [focusCol, setFocusCol] = useState(() => back?.focusCol ?? 0);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [peek, setPeek] = useState(() => back?.peek ?? false);
  const [sidePage, setSidePage] = useState(false);
  const [help, setHelp] = useState(false);
  const [searching, setSearching] = useState(false);
  const openSearch = useMemo(() => guarded("search-open", () => setSearching(true)), [guarded]);
  const searchingRef = useRef(false); searchingRef.current = searching;
  /** The panel's own width once somebody has dragged its edge. */
  const [prevDrag, setPrevDrag] = useState<number | undefined>(() => back?.prevDrag);
  const [filterTick, setFilterTick] = useState({ col: 0, n: 0 });
  const [hist, setHist] = useState<History>(() => startHistory(start || home || "/"));
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [settings, setSettings] = useState<DOMRect | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pathSignal, setPathSignal] = useState(0);
  const [version, setVersion] = useState(0);
  /** Columns somebody dragged, by folder: their width wins over the names' until they double-click the edge. */
  const [dragged, setDragged] = useState<Record<string, number>>(() => back?.dragged ?? {});
  /* How far each column is scrolled: read on the way out, so it is a ref and not a render. */
  const scrolls = useRef<Record<string, number>>({ ...back?.scroll });
  /* More than one row of one column chosen. Held by the folder it was chosen in, so a column that is gone or replaced takes it with it. */
  const [multi, setMulti] = useState<{ col: number; path: string; choice: Choice } | null>(null);
  const wantFirst = useRef<number | null>(null);
  const snapNow = useRef<() => string>(() => "");
  snapNow.current = () => writeMachineSnap({ v: 1, trail, sel, focusCol, scroll: scrolls.current, dragged, peek, ...(prevDrag === undefined ? {} : { prevDrag }) });
  const save = useCallback(() => { try { localStorage.setItem(SNAP_KEY, snapNow.current()); } catch { /* a private window forgets; the finder still works */ } }, []);
  useEffect(() => { save(); }, [trail, sel, focusCol, dragged, peek, prevDrag, save]);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onScrollTop = useCallback((path: string, top: number) => {
    scrolls.current[path] = top;
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(save, 300);
  }, [save]);
  // Closing the finder unmounts it: what is scrolled right now must be in the store before it goes.
  useEffect(() => () => { if (scrollTimer.current) clearTimeout(scrollTimer.current); save(); }, [save]);

  const root = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const box = useBox(root);
  const mainBox = useBox(main);
  const compact = box.w > 0 && box.w < SIDE_MIN;

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
    seen.current = start; setHist((h) => visit(h, start));
    setTrail([start]); setSel([null]); setFocusCol(0);
  }, [start]);

  /* A typed path goes where the path bar goes, and a file also gets selected so
     its preview shows. It asks what the path is before moving: a half-typed name
     is nothing yet, and the finder stays where it was until the path is real. */
  useEffect(() => {
    if (!target) return;
    let live = true;
    const t = setTimeout(() => {
      void api.previewFacts(target).then((f) => {
        if (!live || !f.ok) return;
        const at = f.kind === "dir" ? target : parentOf(target);
        if (!at) return;
        seen.current = at; setHist((h) => visit(h, at));
        setTrail([at]); setSel([f.kind === "dir" ? null : basename(target)]); setFocusCol(0); setPeek(false); setSidePage(false);
      }).catch(() => { /* not a place yet */ });
    }, 150);
    return () => { live = false; clearTimeout(t); };
  }, [target]);

  const goRaw = useCallback((path: string) => {
    seen.current = path; setHist((h) => visit(h, path));
    setTrail([path]); setSel([null]); setFocusCol(0); setPeek(false); setSidePage(false);
    onPlace(path);
  }, [onPlace]);
  const go = useMemo(() => guarded("folder", goRaw), [guarded, goRaw]);

  /* A search hit: a folder becomes the place; a file selects itself inside its own folder, so its preview shows. */
  const revealRaw = useCallback((t: HitTarget) => {
    const at = t.kind === "open-folder" ? t.path : t.dir;
    seen.current = at; setHist((h) => visit(h, at));
    setTrail([at]); setSel([t.kind === "select" ? t.name : null]); setFocusCol(0); setPeek(false); setSidePage(false);
    onPlace(at);
  }, [onPlace]);
  const reveal = useMemo(() => guarded("search-hit", revealRaw), [guarded, revealRaw]);

  const goUpRaw = useCallback(() => {
    const p = parentOf(trail[0]!);
    if (!p) return;
    seen.current = p; setHist((h) => visit(h, p));
    setTrail((t) => [p, ...t]); setSel((s) => [basename(trail[0]!), ...s]); setFocusCol(0);
    onPlace(p);
  }, [trail, onPlace]);
  const goUp = useMemo(() => guarded("up", goUpRaw), [guarded, goUpRaw]);

  /* Back and forward land on a place already in the history without adding to it. */
  const goHistRaw = useCallback((h: History) => {
    const p = histHere(h);
    seen.current = p; setHist(h);
    setTrail([p]); setSel([null]); setFocusCol(0); setPeek(false); setSidePage(false);
    onPlace(p);
  }, [onPlace]);
  const goHist = useMemo(() => guarded("history", goHistRaw), [guarded, goHistRaw]);

  /* ---- what each column draws ---- */
  const cache = useRef(new Map<string, { rows: Row[]; sig: string; display: Display }>());
  const columns = useMemo(() => trail.map((path) => {
    const state: FolderState | undefined = store.current?.get(path);
    const needle = filters[path] ?? "";
    const big = !!state && !state.done && state.rows.length > BIG;
    const sig = `${needle}|${prefs.hidden}|${prefs.group}|${prefs.sortKey}|${prefs.sortDir}|${prefs.foldersFirst}|${big}`;
    const hit = cache.current.get(path);
    if (state && hit && hit.rows === state.rows && hit.sig === sig) return { path, state, display: hit.display };
    const display = displayRows(state?.rows ?? [], { needle, hidden: prefs.hidden, group: prefs.group, sortKey: prefs.sortKey, sortDir: prefs.sortDir, foldersFirst: prefs.foldersFirst, unsorted: big });
    if (state) cache.current.set(path, { rows: state.rows, sig, display });
    return { path, state, display };
    // `version` is how the store says its rows changed.
  }), [trail, version, ready, filters, prefs.hidden, prefs.group, prefs.sortKey, prefs.sortDir, prefs.foldersFirst]);

  /* ---- selection ---- */
  const pickRaw = useCallback((col: number, row: Row) => {
    setMulti(null);
    setSel((s) => [...s.slice(0, col), row.name]);
    setTrail((t) => (opensOnPick(row, prefs.mirror) ? [...t.slice(0, col + 1), joinPath(t[col]!, row.name)] : t.slice(0, col + 1)));
    setFocusCol(col);
  }, [prefs.mirror]);
  const pickHeld = useMemo(() => guarded("row", pickRaw), [guarded, pickRaw]);
  /* Choosing the row that is already chosen is not leaving it. */
  const pick = useCallback((col: number, row: Row): void => ((selRef.current[col] ?? null) === row.name ? pickRaw(col, row) : pickHeld(col, row)), [pickRaw, pickHeld]);

  const last = trail.length - 1;
  const chosenOf = (col: number): Choice => (multi && multi.col === col && trail[col] === multi.path ? multi.choice : single(sel[col] ?? null));
  const liveMulti = multi && trail[multi.col] === multi.path && multi.choice.names.size > 1 ? multi : null;

  /* A choice of several rows has no child column: the preview follows the cursor row alone. */
  const chooseRaw = useCallback((col: number, c: Choice) => {
    const rows = columns[col]?.display.rows ?? [];
    setFocusCol(col);
    if (c.names.size <= 1) { const row = rows.find((r) => r.name === c.cursor); if (row) pick(col, row); return; }
    setMulti({ col, path: trail[col]!, choice: c });
    setSel((s) => [...s.slice(0, col), c.cursor]);
    setTrail((t) => t.slice(0, col + 1));
  }, [columns, trail, pick]);
  const chooseHeld = useMemo(() => guarded("row", chooseRaw), [guarded, chooseRaw]);
  /* Choosing the row that is already chosen is not leaving it. */
  const choose = useCallback((col: number, c: Choice): void => ((selRef.current[col] ?? null) === c.cursor ? chooseRaw(col, c) : chooseHeld(col, c)), [chooseRaw, chooseHeld]);
  const onPickMod = useCallback((col: number, row: Row, mod?: Mod) => {
    if (!mod || (!mod.ctrl && !mod.shift)) { pick(col, row); return; }
    choose(col, clickSelect(columns[col]?.display.rows ?? [], chosenOf(col), row.name, mod));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, choose, multi, sel, trail, pick]);
  /* Each column as wide as its longest name asks, the free room going to the last
     one; a dragged column keeps the width it was given. Measured with the font the
     rows are drawn in, so "fits" means fits. */
  const measure = useMemo(() => {
    const ctx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
    const family = root.current ? getComputedStyle(root.current).fontFamily : "monospace";
    if (ctx) ctx.font = `500 ${prefs.textSize}px ${family}`;
    return (t: string) => (ctx ? ctx.measureText(t).width : t.length * prefs.textSize * 0.62);
    // `box.w` changes from 0 once the root is mounted, which is when the family can be read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.textSize, box.w > 0]);
  const widths = useMemo(
    () => columns.map((c) => columnWidth(dragged[c.path], mainBox.w || undefined)),
    [columns, dragged, mainBox.w]);
  // A folder row that is selected has its own column; the selection that matters for the preview is the deepest one.
  const deepest = (() => {
    for (let c = trail.length - 1; c >= 0; c--) {
      const name = sel[c];
      if (name) { const row = columns[c]?.display.rows.find((r) => r.name === name) ?? null; return row ? { col: c, row, path: joinPath(trail[c]!, name) } : null; }
    }
    return null;
  })();

  const enterFolderRaw = useCallback((col: number) => {
    const name = sel[col];
    const row = name ? columns[col]?.display.rows.find((r) => r.name === name) : null;
    if (!row || !isFolder(row) || row.locked) return;
    wantFirst.current = col + 1;
    setFocusCol(col + 1);
    setTrail((t) => [...t.slice(0, col + 1), joinPath(t[col]!, row.name)]);
    setSel((s) => [...s.slice(0, col + 1), null]);
  }, [sel, columns]);
  const enterFolder = useMemo(() => guarded("folder", enterFolderRaw), [guarded, enterFolderRaw]);

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
      const per = prefs.view === "icons" ? tilesPerRow(mainBox.w, prefs.thumb) : 1;
      const next = prefs.view === "list" && key === "ArrowRight" ? at : gridStep(at < 0 ? 0 : at, rows.length, per, key);
      const row = rows[at < 0 && (key === "ArrowDown" || key === "ArrowRight") ? 0 : next]; if (row) pick(last, row);
      return;
    }
    const col = columns[focusCol]; if (!col) return;
    if (key === "ArrowLeft" && focusCol === 0) { goUp(); return; }
    const at = Math.max(0, shapes[focusCol]!.sel ?? 0);
    const to = keyStep({ col: focusCol, row: at }, key, shapes, Math.max(1, Math.floor(mainBox.h / rowHeight(prefs.density, prefs.textSize)) - 2));
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
  /* With several rows chosen, Ctrl+C copies every path, one a line. */
  const copyChosen = () => {
    if (!liveMulti) { copy(currentPath); return; }
    const dir = trail[liveMulti.col]!;
    const paths = (columns[liveMulti.col]?.display.rows ?? []).filter((r) => liveMulti.choice.names.has(r.name)).map((r) => joinPath(dir, r.name));
    void navigator.clipboard?.writeText(paths.join("\n")).then(() => setNote(`Copied ${paths.length} paths`)).catch(() => setNote("Could not copy"));
  };
  const currentPath = deepest?.path ?? trail[focusCol] ?? trail[0]!;

  const sideMode = sidebarMode(prefs);
  /* Strata's rule: beside the browser only when what the sidebar leaves still holds a column and the preview's own floor. */
  const wide = box.w > 0 && !(compact && sidePage) && previewFits(box.w - ((compact ? sidePage : sideMode !== "hidden") ? sidebarWidth(sideMode === "rail" ? "rail" : "full", prefs.sideW, box.w) : 0), prefs.view);
  /* One step for the button and Ctrl+B alike, as in Strata: full, the icon rail, hidden, full. */
  const toggleSide = useCallback(() => (compact ? setSidePage((v) => !v) : setPrefs(sidebarPrefs(nextSidebar(sideMode)))), [compact, sideMode, setPrefs]);

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
      case "back": if (canBack(hist)) goHist(histBack(hist)); break;
      case "forward": if (canForward(hist)) goHist(histForward(hist)); break;
      case "home": go(home); break;
      case "refresh": store.current?.load(trail[focusCol] ?? trail[0]!, prefs.hidden, true); break;
      case "filter": if (prefs.view === "columns") setFilterTick((t) => ({ col: focusCol, n: t.n + 1 })); break;
      case "view": setPrefs({ view: a.view }); break;
      case "preview": if (wide) setPrefs({ preview: !prefs.preview }); else setPeek((p) => !p); break;
      case "hidden": setPrefs({ hidden: !prefs.hidden }); break;
      case "sidebar": toggleSide(); break;
      case "path": setPathSignal((n) => n + 1); break;
      case "copy": copyChosen(); break;
      case "help": setHelp((h) => !h); break;
      case "extend": {
        const col = prefs.view === "columns" ? focusCol : last;
        const rows = columns[col]?.display.rows ?? [];
        const page = Math.max(1, Math.floor(mainBox.h / rowHeight(prefs.density, prefs.textSize)) - 2);
        const per = prefs.view === "icons" ? tilesPerRow(mainBox.w, prefs.thumb) : 1;
        choose(col, extendSelect(rows, chosenOf(col), extendBy(a.by, page, per)));
        break;
      }
      case "all": { const col = prefs.view === "columns" ? focusCol : last; choose(col, selectAll(columns[col]?.display.rows ?? [], chosenOf(col))); break; }
      case "toggle": { const col = prefs.view === "columns" ? focusCol : last; choose(col, toggleCursor(columns[col]?.display.rows ?? [], chosenOf(col))); break; }
    }
  }, [move, choose, columns, multi, sel, mainBox.w, mainBox.h, last, deepest, prefs, enterFolder, go, goUp, hist, goHist, home, trail, focusCol, onBench, wide, toggleSide, setPrefs, copy, currentPath]);

  // On the window, capture phase: the palette keeps focus in its own search box, and ↓ there must still move the list.
  const actRef = useRef(act); actRef.current = act;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (searchingRef.current) return; // the search overlay has the keys while it is up
      // Ctrl+K is the app's command palette everywhere else; inside the finder it is Strata's search.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k" && root.current && (root.current.contains(e.target as Node) || e.target === document.body || (e.target as HTMLElement | null)?.closest?.('[role="dialog"]') === root.current.closest('[role="dialog"]'))) {
        e.preventDefault(); e.stopPropagation(); openSearch(); return;
      }
      if (isAppChord(e)) return;
      const t = e.target as HTMLElement | null;
      const field = !!t && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable);
      const own = !!t?.closest?.("[data-finder-box]");
      const inField = field && !(own && (t as HTMLInputElement).value === "");
      // With no search box the palette's own panel holds the focus, so the panel counts as inside.
      const panel = root.current?.closest('[role="dialog"]') ?? null;
      if (!own && !root.current?.contains(t) && t !== document.body && !(panel && t === panel)) return;
      // A resize grip owns its arrow keys; the window listener runs first, in capture, and would walk the rows instead.
      if (t?.closest?.('[role="separator"]')) return;
      const a = finderKey({ key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey }, { inField, hasSelection: !!window.getSelection()?.toString() });
      if (!a) return;
      e.preventDefault(); e.stopPropagation();
      actRef.current(a);
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, []);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), FEEDBACK_MS); return () => clearTimeout(t); }, [note]);

  const refresh = (p: string) => store.current?.load(p, prefs.hidden, true);
  const onSort = (k: SortKey) => setPrefs(prefs.sortKey === k ? { sortDir: prefs.sortDir === "asc" ? "desc" : "asc" } : { sortKey: k, sortDir: "asc" });
  const rowH = rowHeight(prefs.density, prefs.textSize);

  /* ---- layout ---- */
  const sideOn = compact ? sidePage : sideMode !== "hidden";
  const previewInline = wide && prefs.preview;
  const previewOnly = !previewInline && peek;
  const lastCol = columns[last];
  const preview = (
    <QuickLook path={deepest?.path ?? null} row={deepest?.row ?? null}
      rows={deepest && isFolder(deepest.row) ? (columns[deepest.col + 1]?.state?.rows ?? null) : null}
      onBench={onBench} onCopy={copy} onClose={guarded("preview-close", () => (wide ? setPrefs({ preview: false }) : setPeek(false)))} />
  );

  /* Strata's footer: the shortcuts button on the left, what is here or selected on the right. */
  const count = (() => {
    const n = lastCol?.state;
    if (!n) return "Reading…";
    if (liveMulti) return selectedFooter(columns[liveMulti.col]?.display.rows ?? [], liveMulti.choice);
    return `${footerCount(n.total, deepest?.row ?? null)}${!deepest && !n.done ? " so far" : ""}`;
  })();

  const tool = "agx-btn rounded-md grid place-items-center shrink-0";
  return (
    <div ref={root} data-machine-finder className="relative flex-1 min-h-0 min-w-0 flex flex-col" style={{ fontSize: prefs.textSize, color: "var(--text)" }}>
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 shrink-0" style={{ borderBottom: LINE }}>
        <button className={tool} style={{ width: HIT, height: HIT, color: "var(--primary-ink)", opacity: sideOn ? 1 : 0.7 }} aria-pressed={sideOn} title={sidebarTip(compact ? (sidePage ? "full" : "hidden") : sideMode, "Ctrl+B")} aria-label="Toggle sidebar (Ctrl+B)"
          onClick={toggleSide}><StrataIcon set="act" name="panel-left-symbolic" size={17} /></button>
        {prefs.view !== "columns" && <>
          <button className={tool} disabled={!canBack(hist)} style={{ width: HIT, height: HIT, color: "var(--primary-ink)", opacity: canBack(hist) ? 1 : 0.4 }} title="Back (Alt+Left)" aria-label="Back" onClick={() => goHist(histBack(hist))}><StrataIcon set="act" name="arrow-left" size={17} /></button>
          <button className={tool} disabled={!canForward(hist)} style={{ width: HIT, height: HIT, color: "var(--primary-ink)", opacity: canForward(hist) ? 1 : 0.4 }} title="Forward (Alt+Right)" aria-label="Forward" onClick={() => goHist(histForward(hist))}><StrataIcon set="act" name="arrow-right" size={17} /></button>
          <button className={tool} disabled={!parentOf(trail[0]!)} style={{ width: HIT, height: HIT, color: "var(--primary-ink)", opacity: parentOf(trail[0]!) ? 1 : 0.4 }} title="Parent folder (Alt+Up)" aria-label="Parent folder" onClick={goUp}><StrataIcon set="act" name="arrow-up" size={17} /></button>
        </>}
        <FinderPathBar path={trail[last] ?? trail[0]!} home={home} onGo={go} signalEdit={pathSignal} />
        <button className={tool} style={{ width: HIT, height: HIT, color: "var(--primary-ink)" }} title="Search (Ctrl+K)" aria-label="Search" onClick={openSearch}><StrataIcon set="act" name="search" size={17} /></button>
        <button className={tool} style={{ width: HIT, height: HIT, color: "var(--primary-ink)" }} title="Appearance" aria-label="Appearance" aria-haspopup="menu" onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())}><StrataIcon set="act" name={prefs.view} size={17} /></button>
        <button className={tool} style={{ width: HIT, height: HIT, color: "var(--primary-ink)" }} title="Settings" aria-label="Settings" aria-haspopup="menu" onClick={(e) => setSettings(e.currentTarget.getBoundingClientRect())}><StrataIcon set="act" name="settings" size={17} /></button>
        <button className={tool} style={{ width: HIT, height: HIT, color: "var(--primary-ink)" }} title="Close (Esc)" aria-label="Close the finder" onClick={onClose}><StrataIcon set="act" name="x" size={17} /></button>
      </div>

      <div className="flex-1 min-h-0 flex">
        {sideOn && <Sidebar places={placesFor(home, places)} here={trail[0]!} mode={compact || sideMode === "hidden" ? "full" : sideMode} width={sidebarWidth(compact || sideMode === "hidden" ? "full" : sideMode === "rail" ? "rail" : "full", prefs.sideW, box.w)} onResize={(w) => setPrefs({ sideW: sidebarWidth("full", w, box.w) })} onGo={go} onRecent={onRecent} />}
        {!(compact && sidePage) && (
          <>
            {/* With the preview beside the columns and nothing dragged, the columns take what their names ask for and the preview takes all that is left, as Strata's does; a gap between the two was the free room with nowhere to go. */}
            <div ref={main} className="min-w-0 min-h-0 flex" style={{ flex: previewInline && prefs.view === "columns" && prevDrag === undefined ? "0 1 auto" : "1 1 0%" }}>
              {previewOnly ? (
                <div className="flex-1 min-w-0 min-h-0 flex flex-col">
                  <button className="agx-btn text-left px-3 text-[11px] shrink-0" style={{ minHeight: HIT, color: "var(--text3)", borderBottom: LINE }} onClick={() => setPeek(false)}>← Back to the folder (Space)</button>
                  {preview}
                </div>
              ) : prefs.view === "columns" ? (
                <ColumnsRow widths={widths} active={focusCol}>
                  {columns.map((c, i) => (
                    <Column key={c.path} title={basename(c.path)} filterSignal={filterTick.col === i ? filterTick.n : 0} width={widths[i]!} onResize={(w) => setDragged((d) => ({ ...d, [c.path]: w }))} onFit={() => setDragged((d) => ({ ...d, [c.path]: fitWidth(c.state?.rows.map((r) => r.name) ?? [], measure, mainBox.w || undefined) }))} state={c.state} display={c.display} selName={sel[i] ?? null} chosen={liveMulti?.col === i ? liveMulti.choice.names : null} focused={i === focusCol} prefs={prefs} rowH={rowH}
                      filter={filters[c.path] ?? ""} onFilter={(v) => setFilters((f) => ({ ...f, [c.path]: v }))}
                      scrollTop={scrolls.current[c.path]} onScrollTop={(t) => onScrollTop(c.path, t)} onPick={(r, m) => onPickMod(i, r, m)} onOpen={(r) => { if (isFolder(r) && !r.locked) { pick(i, r); enterFolder(i); } else if (canEditRow(r)) onBench(joinPath(c.path, r.name), "edit"); }}
                      onFocusCol={() => setFocusCol(i)} onRefresh={() => refresh(c.path)} onSort={onSort} onPref={setPrefs} />
                  ))}
                </ColumnsRow>
              ) : lastCol ? (
                <div className="flex-1 min-w-0 min-h-0 flex flex-col">
                  {lastCol.state?.error ? <div className="p-3 text-[12px]" role="alert" style={{ color: "var(--warning-ink)" }}>{lastCol.state.error}</div>
                    : prefs.view === "icons"
                      ? <IconsView display={lastCol.display} dir={lastCol.path} thumb={prefs.thumb} selName={sel[last] ?? null} chosen={liveMulti?.col === last ? liveMulti.choice.names : null} width={mainBox.w} label={`Entries of ${basename(lastCol.path)}`} onPick={(r, m) => onPickMod(last, r, m)} onOpen={(r) => (isFolder(r) && !r.locked ? go(joinPath(lastCol.path, r.name)) : canEditRow(r) && onBench(joinPath(lastCol.path, r.name), "edit"))} />
                      : <ListView display={lastCol.display} selName={sel[last] ?? null} chosen={liveMulti?.col === last ? liveMulti.choice.names : null} rowH={rowH} prefs={prefs} label={`Entries of ${basename(lastCol.path)}`} onSort={onSort} onPick={(r, m) => onPickMod(last, r, m)} onOpen={(r) => (isFolder(r) && !r.locked ? go(joinPath(lastCol.path, r.name)) : canEditRow(r) && onBench(joinPath(lastCol.path, r.name), "edit"))} />}
                </div>
              ) : null}
            </div>
            {previewInline && (
              <div className="relative min-h-0 flex" style={{ flex: `${prevDrag === undefined && prefs.view === "columns" ? 1 : 0} 0 ${previewWidth(box.w, prevDrag)}px`, minWidth: 0, borderLeft: LINE, background: "var(--surface-card)" }}>
                <div role="separator" aria-orientation="vertical" aria-label="Resize the preview" tabIndex={0} title="Drag to resize, double-click to reset"
                  className="absolute top-0 bottom-0" style={{ left: 0, width: 6, cursor: "col-resize", zIndex: 3, touchAction: "none" }}
                  onDoubleClick={() => setPrevDrag(undefined)}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    const x0 = e.clientX, w0 = previewWidth(box.w, prevDrag), el = e.currentTarget;
                    el.setPointerCapture(e.pointerId);
                    const move = (ev: PointerEvent) => setPrevDrag(previewWidth(box.w, w0 - (ev.clientX - x0)));
                    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); };
                    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
                  }}
                  onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); setPrevDrag(previewWidth(box.w, previewWidth(box.w, prevDrag) + (e.key === "ArrowLeft" ? 16 : -16))); } }} />
                {preview}
              </div>
            )}
          </>
        )}
      </div>

      <footer className="flex items-center gap-3 px-2.5 shrink-0 text-[11px]" style={{ minHeight: 26, borderTop: LINE, color: "var(--text3)" }}>
        {prefs.f1 && (
          <button type="button" className="agx-btn rounded-md px-2 inline-flex items-center gap-1.5" style={{ minHeight: HIT - 6, color: "var(--text2)" }}
            title="Show all file-view shortcuts (F1)" onClick={() => setHelp(true)}><kbd className="text-[10px]" style={{ fontFamily: "inherit", fontWeight: 600 }}>F1</kbd> Shortcuts</button>
        )}
        <span className="flex-1" />
        <span className="truncate" aria-live="polite">{note ?? count}</span>
      </footer>
      {held && (
        <div role="alertdialog" aria-label="Unsaved changes" className="absolute inset-0 grid place-items-center p-4" style={{ background: "color-mix(in srgb, var(--bg) 70%, transparent)", zIndex: 9 }}
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setHeld(null); } }}>
          <div className="rounded-xl p-4 text-[12px]" style={{ background: "var(--surface-card)", border: EDGE, width: 380, maxWidth: "100%" }}>
            <b className="block text-[13px] mb-1">Unsaved changes</b>
            <p className="m-0 mb-3" style={{ color: "var(--text3)" }}>{dirtyPaths().map(basename).join(", ")} {dirtyPaths().length === 1 ? "has" : "have"} edits that were not saved.</p>
            {heldErr && <p role="alert" className="m-0 mb-3" style={{ color: "var(--warning-ink)" }}>Not saved: {heldErr}.</p>}
            <div className="flex justify-end gap-2">
              <button autoFocus className="agx-btn rounded-md px-3" style={{ minHeight: HIT, border: EDGE }} onClick={() => setHeld(null)}>Cancel</button>
              <button className="agx-btn rounded-md px-3" style={{ minHeight: HIT, border: EDGE, color: "var(--warning-ink)" }} onClick={() => { const h = held; for (const p of dirtyPaths()) clearDraft(p); setHeld(null); h.run(); }}>Discard</button>
              <button className="agx-btn rounded-md px-3" style={{ minHeight: HIT, background: "var(--text)", color: "var(--bg)" }}
                onClick={() => { const h = held; void saveDrafts(api.previewSave).then((r) => { if (r.ok) { setHeld(null); h.run(); } else setHeldErr(`${basename(r.path)}: ${r.error}`); }); }}>Save</button>
            </div>
          </div>
        </div>
      )}
      {help && <HelpSheet onClose={() => setHelp(false)} />}
      {searching && <FinderSearch home={home} onTarget={reveal} onClose={() => setSearching(false)} />}
      {settings && <FinderSettings anchor={settings} prefs={prefs} onPref={setPrefs} onReset={() => { setPrefsState(DEFAULT_PREFS); savePrefs(DEFAULT_PREFS); setNote("Finder settings reset"); }} onClose={() => setSettings(null)} />}
      {menu && <AppearanceMenu anchor={menu} prefs={prefs} onPref={setPrefs} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** The columns, scrolled so the active one is whole in view and the leftmost visible column is not sliced (see finderColumns.revealScroll). */
function ColumnsRow({ children, widths, active }: { children: React.ReactNode; widths: number[]; active: number }) {
  const el = useRef<HTMLDivElement>(null);
  const pad = useRef<HTMLDivElement>(null);
  const key = widths.join(",");
  /* The room after the last column is written straight onto its element, not
     kept in state: a state that the same effect reads and sets looped (React
     error 185) when a column was dragged — see finderColumns.stripLayout. */
  useLayoutEffect(() => {
    const e = el.current, p = pad.current; if (!e || !p) return;
    const t = stripLayout(widths, active, e.clientWidth, e.scrollLeft);
    p.style.width = `${t.pad}px`;
    e.scrollLeft = t.scroll;
    // `key` is the widths themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active]);
  return (
    <div ref={el} className="agx-scroll flex-1 min-w-0 min-h-0 flex overflow-x-auto overflow-y-hidden" style={{ scrollSnapType: "x proximity" }}>
      {children}
      <div ref={pad} aria-hidden className="shrink-0" style={{ width: 0 }} />
    </div>
  );
}

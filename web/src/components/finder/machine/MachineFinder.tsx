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
import { columnWidth, fitWidth, previewFits, stripLayout, stripRoom, previewWidth, dragPreviewWidth, sidebarWidth, sidePageWidth, wholeColumnsWidth } from "../../../lib/finderColumns.ts";
import { back as histBack, canBack, canForward, forward as histForward, here as histHere, startHistory, visit, type History } from "../../../lib/finderHistory.ts";
import { readMachineSnap, openingOf, scrollWithout, writeMachineSnap } from "../../../lib/finderMachineState.ts";
import { backspaceAct, escapeAct, finderKey, finderOwnsChord, leftAct, upFromFirst, windowChord } from "../../../lib/finderKeys.ts";
import { boxOf, dismissChoice, marqueeChoice, type Box } from "../../../lib/finderSelect.ts";
import { clickSelect, extendBy, extendSelect, footerDescription, selectAll, selectedFooter, single, toggleCursor, type Choice } from "../../../lib/finderSelect.ts";
import {
  DEFAULT_PREFS, TEXT_MAX, TEXT_MIN, tileSize, canEditRow, footerTotal, selectsHidden, displayRows, opensOnPick, footerCount, gridStep, indexOfName, isFolder, joinPath, keyStep, nextSidebar, parentOf, readPrefs, rowHeight, sidebarMode, sidebarPrefs, sidebarTip, writePrefs,
  type ColShape, type Display, type Prefs, type Row, type SortKey,
} from "../../../lib/finderMiller.ts";
import { activates, bandRows, EDGE_TICK_MS, edgeStep, emptyClickSelectsFirst, fileUris, historyClaims, inTrash, MARQUEE_SLOP, pointerAction, SLOW_CLICK_MS, slowClickRenames, springMs, startsMarqueeAt, wheelTextStep, type BandLayout, type DropKind } from "../../../lib/finderPointer.ts";
import { HIT } from "../../../lib/iconSize.ts";
import { isAppChord } from "../../../lib/keybindings.ts";
import type { DiskPlace } from "../../../../../shared/types.ts";
import { EDGE, LINE } from "../../workspace/Chrome.tsx";
import { Column, FilterField, focusEnd, type Mod } from "./Column.tsx";
import { COLUMNS_SURFACE, PREVIEW_SURFACE } from "../../../lib/finderContrast.ts";
import { AppearanceMenu, FinderSettings, HelpSheet } from "./FinderChrome.tsx";
import { externalPlace, folderTargetMove, isRecent, nextRecentSort, recentDisplay, RECENT, RECENT_SORT, type RecentSort } from "../../../lib/finderMiller.ts";
import { exitDecision, type Exit } from "../../../lib/finderEdit.ts";
import { FinderPathBar } from "./FinderPathBar.tsx";
import { ErrorDialog } from "./VolumeDialogs.tsx";
import { FinderTabs } from "./FinderTabs.tsx";
import { closeTab, moveTab, openTab, selectTab, showHere, stepTab, tabsOf } from "../../../lib/finderTabs.ts";
import { loadVisited, recordVisit, saveVisited, type Visit } from "../../../lib/finderVisited.ts";
import { nothingTo } from "../../../lib/finderOps.ts";
import { useFinderOps, type Chosen } from "./useFinderOps.tsx";
import { FinderSearch } from "./FinderSearch.tsx";
import type { HitTarget } from "../../../lib/finderSearch.ts";
import { useFolderPeek } from "./FolderPeek.tsx";
import { IconsView, ListView, tilesPerRow } from "./FolderViews.tsx";
import { StrataIcon } from "./StrataIcon.tsx";
import { QuickLook } from "./QuickLook.tsx";
import { Sidebar, placesFor } from "./Sidebar.tsx";
import { useVolumeFlow } from "./useVolumeFlow.tsx";
import { toggleLook, reopensPreview } from "../../../lib/finderPreview.ts";
import { useBookmarks } from "./useBookmarks.ts";
import { withHidden, type SideAct, type SideTarget } from "../../../lib/finderSidebarMenu.ts";
import { useBox } from "./useBox.ts";

/** Cmd stands in for Ctrl only on a Mac; on Linux and Windows Super is a modifier of its own (lib/finderKeys). */
const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
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

export function MachineFinder({ home, workspace, start, wantFile, onWanted, places, target, onTargetDone, onPlace, onBench, onClose: closeNow }: {
  home: string;
  /** Where to open, and where to go when the palette's own place changes. */
  start: string;
  /** A path somebody clicked in a terminal: its folder opens and it is selected. Null when there is none. */
  target?: string | null;
  /** The finder has acted on `target`: the palette forgets it, so the next opening comes back where the finder was closed instead of replaying it. */
  onTargetDone?: () => void;
  places: readonly DiskPlace[];
  /** The finder went somewhere on purpose (sidebar, path bar, up): the palette remembers it as the place. */
  onPlace: (path: string) => void;
  /** A file the request named (a path clicked in a terminal): selected in `start`, its preview open. */
  wantFile?: { dir: string; name: string } | null;
  /** The request has been applied: the palette forgets it, so reopening the finder by hand does not replay it. */
  onWanted?: () => void;
  /** The workspace root: the key of the Editing tab's nvim session. */
  workspace: string;
  onBench: (path: string, mode: "edit" | "terminal") => void;
  /** The way out of the finder: it lives at the end of the path-bar row, where Strata has its close. */
  onClose: () => void;
}) {
  const [saved, setPrefsState] = useState<Prefs>(loadPrefs);
  /* A link to a dotted file lists the dotted entries for that visit only, as Strata's does; the stored preference is not touched. */
  const [visitHidden, setVisitHidden] = useState(false);
  const prefs = useMemo<Prefs>(() => (visitHidden && !saved.hidden ? { ...saved, hidden: true } : saved), [saved, visitHidden]);
  /* Every way out of the Editing tab asks first when nvim holds unsaved changes (lib/finderEdit.EXITS). The move is
     held in `held` and runs once the person has said Save or Discard; leaving ends the editor's session either way. */
  const editing = useRef<string | null>(null);
  const [held, setHeld] = useState<{ exit: Exit; run: () => void } | null>(null);
  const [heldErr, setHeldErr] = useState<string | null>(null);
  const guarded = useCallback(<A extends unknown[]>(exit: Exit, fn: (...a: A) => void) => (...a: A) => {
    if (!editing.current) { fn(...a); return; }
    void api.finderEditState(workspace).then((st) => {
      if (exitDecision(st.ok && st.live ? st.modified : null, exit) === "go") fn(...a); else { setHeldErr(null); setHeld({ exit, run: () => fn(...a) }); }
    }).catch(() => fn(...a));
  }, [workspace]);
  const onClose = useMemo(() => guarded("finder-close", closeNow), [guarded, closeNow]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !editing.current || (e.target as HTMLElement | null)?.closest?.("[data-finder-nvim]")) return;
      e.preventDefault(); e.stopImmediatePropagation(); onClose();
    };
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [onClose]);
  const setPrefs = useCallback((p: Partial<Prefs>) => { if ("hidden" in p) setVisitHidden(false); setPrefsState((cur) => { const n = { ...cur, ...p }; savePrefs(n); return n; }); }, []);

  /* Where it was left, if that is still where the palette says it is: a chip or a link that moved the place wins over the memory. */
  const [back] = useState(() => {
    const s = loadSnap(), at = start || home || "/";
    const o = openingOf(s, at, target ?? null);
    // One line per opening, so a finder that came back somewhere else says why.
    console.debug(`[finder] opens from ${o.from}`, o.from === "snapshot" ? o.snap.trail[o.snap.trail.length - 1] : o.at);
    /* A pending request moves the finder once its path is checked (below); until then, and for widths and scroll, the memory stands. */
    const mem = openingOf(s, at, null);
    return mem.from === "snapshot" ? mem.snap : null;
  });
  const [trail, setTrail] = useState<string[]>(() => back?.trail ?? [start || home || "/"]);
  const [sel, setSel] = useState<(string | null)[]>(() => back?.sel ?? [null]);
  /* Folder tabs: each is only the folder it shows; the active one follows wherever the finder goes. */
  const [tabs, setTabs] = useState(() => tabsOf(back?.trail[back.trail.length - 1] ?? (start || home || "/")));
  /* Strata folds the sidebar to its icon rail while the path is typed. */
  const [pathEditing, setPathEditing] = useState(false);
  const [pathFailed, setPathFailed] = useState<string | null>(null);
  const selRef = useRef(sel); selRef.current = sel;
  const trailRef = useRef(trail); trailRef.current = trail;
  const [focusCol, setFocusCol] = useState(() => back?.focusCol ?? 0);
  const [filters, setFilters] = useState<Record<string, string>>({});
  /** The one pane whose filter is open (Strata: opening one turns the others off, and so does leaving the folder). */
  const [findAt, setFindAt] = useState<string | null>(null);
  const openFind = useCallback((path: string, on: boolean) => {
    setFindAt((a) => (on ? path : a === path ? null : a));
    if (on) setFilters((f) => (Object.keys(f).every((k) => k === path || f[k] === "") ? f : { [path]: f[path] ?? "" }));
  }, []);
  const [peek, setPeek] = useState(() => back?.peek ?? false);
  /* Which view (Rendered, Source...) the preview was on, for the file it was on: remembered with the rest of where the finder was. */
  const [previewTab, setPreviewTab] = useState(() => back?.previewTab);
  const [sidePage, setSidePage] = useState(false);
  const [help, setHelp] = useState(false);
  const [searching, setSearching] = useState(false);
  const openSearch = useMemo(() => guarded("search-open", () => setSearching(true)), [guarded]);
  /** Ctrl+Shift+K: the same overlay over the folders visited before. Each folder the finder stands in adds a visit. */
  const [jumping, setJumping] = useState(false);
  const openJump = useMemo(() => guarded("search-open", () => setJumping(true)), [guarded]);
  const [visited, setVisited] = useState<Visit[]>(loadVisited);
  const searchingRef = useRef(false); searchingRef.current = searching || jumping;
  /** The panel's own width once somebody has dragged its edge. */
  const [prevDrag, setPrevDrag] = useState<number | undefined>(() => back?.prevDrag);
  const [filterTick, setFilterTick] = useState({ col: 0, n: 0 });
  /* Icons and List have one pane, and its filter field is drawn while it is in use (Ctrl+F, or a letter typed). */
  const [paneFind, setPaneFind] = useState(false);
  const paneInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (filterTick.n > 0 && prefs.view !== "columns") { setPaneFind(true); setTimeout(() => focusEnd(paneInput.current), 0); } }, [filterTick]); // eslint-disable-line react-hooks/exhaustive-deps
  /* A filter is off once its folder leaves the trail. */
  const trailKey = trail.join("\0");
  useEffect(() => {
    setFilters((f) => (Object.keys(f).every((k) => trail.includes(k)) ? f : Object.fromEntries(Object.entries(f).filter(([k]) => trail.includes(k)))));
    setFindAt((a) => (a && !trail.includes(a) ? null : a));
    setPaneFind(false);
  }, [trailKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [hist, setHist] = useState<History>(() => startHistory(start || home || "/"));
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [settings, setSettings] = useState<DOMRect | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /* Enter and double-click on a file do what Strata does: hand it to the application the desktop has for its type. The bench opens only from the preview's "Open in nvim". */
  const openDefault = useCallback((path: string) => { void api.previewOpen(path).then((r) => { if (!r.ok) setNote(r.error || "Could not open that file"); }).catch(() => setNote("Could not open that file")); }, []);
  const { places: pinned, pins, toggle: togglePinned, remove: removePinned } = useBookmarks(setNote);
  const [pathSignal, setPathSignal] = useState(0);
  const [version, setVersion] = useState(0);
  /** Columns somebody dragged, by folder: their width wins over the names' until they double-click the edge. */
  const [dragged, setDragged] = useState<Record<string, number>>(() => back?.dragged ?? {});
  /* How far each column is scrolled: read on the way out, so it is a ref and not a render. */
  /* A request that names a file wants it in view: the scroll remembered for its folder is not restored over it. */
  const asked = [target, target ? parentOf(target) : null, wantFile?.dir];
  const scrolls = useRef<Record<string, number>>(scrollWithout(back?.scroll, asked));
  const iconsFirst = useRef<Record<string, number>>(scrollWithout(back?.iconsFirst, asked));
  /* More than one row of one column chosen. Held by the folder it was chosen in, so a column that is gone or replaced takes it with it. */
  const [multi, setMulti] = useState<{ col: number; path: string; choice: Choice } | null>(null);
  const wantFirst = useRef<number | null>(null);
  const snapNow = useRef<() => string>(() => "");
  snapNow.current = () => writeMachineSnap({ v: 1, origin: start || home || "/", trail, sel, focusCol, scroll: scrolls.current, iconsFirst: iconsFirst.current, dragged, peek, ...(prevDrag === undefined ? {} : { prevDrag }), ...(previewTab ? { previewTab } : {}) });
  const save = useCallback(() => { try { localStorage.setItem(SNAP_KEY, snapNow.current()); } catch { /* a private window forgets; the finder still works */ } }, []);
  useEffect(() => { save(); }, [trail, sel, focusCol, dragged, peek, prevDrag, previewTab, start, home, save]);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onScrollTop = useCallback((path: string, top: number) => {
    scrolls.current[path] = top;
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(save, 300);
  }, [save]);
  const onIconsFirst = useCallback((path: string, item: number) => {
    iconsFirst.current[path] = item;
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(save, 300);
  }, [save]);
  /* A request that arrives while the finder is open wants its file in view just as one that opened it does: the column it lands in is drawn fresh, and a remembered scroll there would skip the pass that scrolls to the selection. */
  const forgetScroll = useCallback((dir: string) => {
    scrolls.current = scrollWithout(scrolls.current, [dir]);
    iconsFirst.current = scrollWithout(iconsFirst.current, [dir]);
  }, []);
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
    seen.current = start;
    const at = externalPlace(start, wantFile ?? null);
    forgetScroll(at.dir);
    guarded("external", () => { setHist((h) => visit(h, at.dir)); setTrail([at.dir]); setSel([at.name]); setFocusCol(0); setPeek(false); })();
  }, [start, guarded, forgetScroll]);

  useEffect(() => { setVisitHidden(false); }, [trail[0]]);
  useEffect(() => { const p = trail[0]; if (p) setVisited((v) => { const next = recordVisit(v, p, Date.now()); saveVisited(next); return next; }); }, [trail[0]]);
  useEffect(() => { if (!saved.hidden && selectsHidden(sel)) setVisitHidden(true); }, [sel, saved.hidden]);

  /* A request that names a file in the place the finder is already in changes no `start`, so it is read on its own. */
  const wanted = useRef<typeof wantFile>(null);
  /* The file the request named, kept until the path field has echoed the folder back (below): that echo is a folder target and must not clear the selection. */
  const wantedNow = useRef<typeof wantFile>(null);
  useEffect(() => {
    if (!wantFile || wantFile === wanted.current) return;
    wanted.current = wantFile;
    const at = externalPlace(start, wantFile);
    if (!at.name) return;
    wantedNow.current = wantFile;
    seen.current = at.dir;
    forgetScroll(at.dir);
    guarded("external", () => { setHist((h) => visit(h, at.dir)); setTrail([at.dir]); setSel([at.name]); setFocusCol(0); setPeek(false); setSidePage(false); })();
    onWanted?.();
  }, [wantFile, start, guarded, onWanted, forgetScroll]);

  /* A typed path goes where the path bar goes, and a file also gets selected so
     its preview shows. It asks what the path is before moving: a half-typed name
     is nothing yet, and the finder stays where it was until the path is real. */
  const targetDone = useRef(onTargetDone); targetDone.current = onTargetDone;
  useEffect(() => {
    if (!target) return;
    let live = true;
    const t = setTimeout(() => {
      void api.previewFacts(target).then((f) => {
        if (!live || !f.ok) return;
        const at = f.kind === "dir" ? target : parentOf(target);
        if (!at) return;
        seen.current = at;
        const file = f.kind === "dir" ? externalPlace(at, wantedNow.current ?? null).name : basename(target);
        wantedNow.current = null;
        const move = folderTargetMove(trailRef.current[0]!, at, file);
        targetDone.current?.();
        if (move === "stay") return;
        forgetScroll(move.dir);
        guarded("external", () => { setHist((h) => visit(h, move.dir)); setTrail([move.dir]); setSel([move.name]); setFocusCol(0); setPeek(false); setSidePage(false); })();
      }).catch(() => { /* not a place yet */ });
    }, 150);
    return () => { live = false; clearTimeout(t); };
  }, [target, guarded, forgetScroll]);

  /** A sidebar row opened by the keyboard selects the first entry of the place once it has rows (Strata); a click selects none. */
  const keyGoTo = useRef<string | null>(null), firstAt = useRef<string | null>(null);
  const goRaw = useCallback((path: string) => {
    firstAt.current = keyGoTo.current === path ? path : null; keyGoTo.current = null;
    seen.current = path; setHist((h) => visit(h, path));
    setTrail([path]); setSel([null]); setFocusCol(0); setPeek(false); setSidePage(false);
    /* Recent is a list, not a place the palette can start from: it is not remembered as one. */
    if (!isRecent(path)) onPlace(path);
  }, [onPlace]);
  const go = useMemo(() => guarded("folder", goRaw), [guarded, goRaw]);
  const devices = useVolumeFlow({ here: trail[0]!, home, go });

  /* A search hit: a folder becomes the place; a file selects itself inside its own folder, so its preview shows. */
  const revealRaw = useCallback((t: HitTarget) => {
    const at = t.kind === "open-folder" ? t.path : t.dir;
    seen.current = at; setHist((h) => visit(h, at));
    setTrail([at]); setSel([t.kind === "select" ? t.name : null]); setFocusCol(0); setPeek(false); setSidePage(false);
    onPlace(at);
  }, [onPlace]);
  const reveal = useMemo(() => guarded("search-hit", revealRaw), [guarded, revealRaw]);
  /* Folder peeking is an Icons and List thing: Columns already shows what is inside a folder. */
  /* Strata peeks a folder only after the pointer was the last thing that moved the person: any press sets it, any key clears it. */
  const pointerNav = useRef(true);
  /* The folder of the column the pointer is over: where Ctrl+V pastes while the pointer was the last thing used (Strata's "indicated directory"). */
  const pointerDir = useRef<string | null>(null);
  const folderPeek = useFolderPeek(prefs.peek && prefs.view !== "columns", prefs.hidden, reveal, () => pointerNav.current);

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
  /* Recent's own sort: Recency until the person picks another, and Recency again on the next visit. */
  const [recentSort, setRecentSort] = useState<RecentSort>(RECENT_SORT);
  const columns = useMemo(() => trail.map((path) => {
    const state: FolderState | undefined = store.current?.get(path);
    const needle = filters[path] ?? "";
    const big = !!state && !state.done && state.rows.length > BIG;
    const sig = `${needle}|${prefs.hidden}|${prefs.group}|${prefs.sortKey}|${prefs.sortDir}|${prefs.foldersFirst}|${big}|${isRecent(path) ? `${recentSort.key}${recentSort.dir}` : ""}`;
    const hit = cache.current.get(path);
    if (state && hit && hit.rows === state.rows && hit.sig === sig) return { path, state, display: hit.display };
    const display = isRecent(path)
      ? recentDisplay(state?.rows ?? [], { needle, hidden: prefs.hidden, group: prefs.group }, recentSort)
      : displayRows(state?.rows ?? [], { needle, hidden: prefs.hidden, group: prefs.group, sortKey: prefs.sortKey, sortDir: prefs.sortDir, foldersFirst: prefs.foldersFirst, unsorted: big });
    if (state) cache.current.set(path, { rows: state.rows, sig, display });
    return { path, state, display };
    // `version` is how the store says its rows changed.
  }), [trail, version, ready, filters, prefs.hidden, prefs.group, prefs.sortKey, prefs.sortDir, prefs.foldersFirst, recentSort]);

  /* ---- selection ---- */
  /** A folder shows as the next column only for the primary click in Columns (`show`); a right click and Icons or List only select, so the folder shown never moves. */
  const pickRaw = useCallback((col: number, row: Row, show = prefs.view === "columns") => {
    setMulti(null);
    setSel((s) => [...s.slice(0, col), row.name]);
    setTrail((t) => (opensOnPick(row, prefs.mirror && show) ? [...t.slice(0, col + 1), joinPath(t[col]!, row.name)] : t.slice(0, col + 1)));
    setFocusCol(col);
  }, [prefs.mirror, prefs.view]);
  const pickHeld = useMemo(() => guarded("row", pickRaw), [guarded, pickRaw]);
  /* Choosing the row that is already chosen is not leaving it. */
  const pick = useCallback((col: number, row: Row): void => ((selRef.current[col] ?? null) === row.name ? pickRaw(col, row) : pickHeld(col, row)), [pickRaw, pickHeld]);
  /* Choosing a row without showing it as a column: a key in Icons and List, and Enter with nothing chosen there. */
  const selectOnly = useCallback((col: number, row: Row): void => ((selRef.current[col] ?? null) === row.name ? pickRaw(col, row, false) : pickHeld(col, row, false)), [pickRaw, pickHeld]);
  useEffect(() => {
    const at = firstAt.current, c = columns[0];
    if (!at || !c || c.path !== at) return;
    const r = c.display.rows[0];
    if (r) { firstAt.current = null; selectOnly(0, r); } else if (c.state?.done) firstAt.current = null;
  });

  const last = trail.length - 1;
  const here = trail[last] ?? trail[0]!;
  useEffect(() => { setTabs((t) => showHere(t, here)); }, [here]);
  const newTab = useCallback((path?: string) => {
    setTabs((t) => openTab(t, path ?? tabsRef.current.paths[tabsRef.current.active]!));
    if (path) go(path);
  }, [go]);
  const tabsRef = useRef(tabs); tabsRef.current = tabs;
  const toTab = useCallback((t: ReturnType<typeof tabsOf>) => { setTabs(t); go(t.paths[t.active]!); }, [go]);
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
  /* Set once `wide` is known, below: a click on a file opens a closed preview again. */
  const reopen = useRef<(row: Row) => void>(() => {});
  const onPickMod = useCallback((col: number, row: Row, mod?: Mod) => {
    if (!mod || (!mod.ctrl && !mod.shift)) {
      reopen.current(row);
      pick(col, row); return;
    }
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
  const sideMode = sidebarMode(prefs);
  /* Strata's rule: beside the browser only when what the sidebar leaves still holds a column and the preview's own floor. */
  const wide = box.w > 0 && !(compact && sidePage) && previewFits(box.w - ((compact ? sidePage : sideMode !== "hidden") ? sidebarWidth(sideMode === "rail" ? "rail" : "full", prefs.sideW, box.w) : 0), prefs.view);
  const sideOn = compact ? sidePage : sideMode !== "hidden";
  const previewInline = wide && prefs.preview;
  const sideW = sidePageWidth(compact && sidePage, box.w) ?? sidebarWidth(compact || sideMode === "hidden" ? "full" : pathEditing || sideMode === "rail" ? "rail" : "full", prefs.sideW, box.w);
  const sideTaken = sideOn ? sideW : 0;
  /* Beside the preview the strip is as many whole columns as fit, so it shrinks to its first column: that is no measure of what a column may take. The room is what the finder leaves. */
  const stripAvail = previewInline && prefs.view === "columns" && prevDrag === undefined ? stripRoom(box.w, sideTaken) : undefined;
  const columnRoom = stripAvail ?? (mainBox.w || undefined);
  /* Columns opened after the first moment slide in; the ones that come back with the finder do not. */
  const [settled, setSettled] = useState(false);
  useEffect(() => { const t = setTimeout(() => setSettled(true), 900); return () => clearTimeout(t); }, []);
  const widths = useMemo(
    () => columns.map((c) => columnWidth(dragged[c.path] ?? prefs.colW, columnRoom)),
    [columns, dragged, columnRoom, prefs.colW]);
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

  /* The keyboard into the sidebar and back (Strata's Left from the files, Right from the sidebar, Ctrl+Shift+B). */
  const sideOnRef = useRef(true);
  const focusSidebar = () => {
    const nav = root.current?.querySelector("[data-finder-sidebar]");
    (nav?.querySelector<HTMLElement>('[data-side-row][aria-current="true"]') ?? nav?.querySelector<HTMLElement>("[data-side-row]:not(:disabled)"))?.focus();
  };
  /** The top bar's own buttons, left to right; the path bar's crumbs are not among them. */
  const topBarButtons = () => [...(root.current?.querySelectorAll<HTMLButtonElement>("[data-finder-topbar] button:not(:disabled)") ?? [])].filter((b) => !b.closest('[role="navigation"]'));
  const topFromSide = useRef(false);
  const focusFiles = () => {
    const path = trail[prefs.view === "columns" ? focusCol : last] ?? "";
    [...(root.current?.querySelectorAll<HTMLElement>("[data-dir]") ?? [])].find((d) => d.dataset.dir === path)?.querySelector<HTMLElement>("[role=listbox], [data-surface]")?.focus();
  };
  /* Up on the first row leaves the rows (lib/finderKeys upFromFirst): for the pane's open filter, or its header's first button. */
  const upFrom = (col: number): boolean => {
    const pane = [...(root.current?.querySelectorAll<HTMLElement>("[data-dir]") ?? [])].find((d) => d.dataset.dir === trail[col]);
    const rows = columns[col]?.display.rows ?? [];
    if (!pane || (rows.length && indexOfName(rows, sel[col] ?? null) > 0)) return false;
    const filter = pane.querySelector<HTMLInputElement>('input[aria-label^="Filter"]');
    const to = upFromFirst({ filterOpen: !!filter, header: !!pane.querySelector("header button") });
    if (to === "filter") { focusEnd(filter); return true; }
    if (to === "header") { pane.querySelector<HTMLElement>("header button")?.focus(); return true; }
    return false;
  };
  const move = useCallback((key: string) => {
    if (prefs.view !== "columns") {
      const c = columns[last]; if (!c) return;
      const rows = c.display.rows;
      const at = indexOfName(rows, sel[last] ?? null);
      const per = prefs.view === "icons" ? tilesPerRow(mainBox.w, prefs.thumb) : 1;
      if (key === "ArrowLeft") {
        const l = leftAct({ view: prefs.view, col: last, atLineStart: prefs.view === "list" || at <= 0 || at % per === 0, sidebar: sideOnRef.current });
        if (l === "sidebar") { focusSidebar(); return; }
        if (l === "stay") return;
      }
      if (prefs.view === "list" && key === "ArrowRight") return; // List has no right (Strata swallows it)
      if (key === "ArrowUp" && at === 0 && upFrom(last)) return;
      const lineH = prefs.view === "icons" ? tileSize(prefs.thumb).h : rowHeight(prefs.density, prefs.textSize);
      const next = gridStep(at < 0 ? 0 : at, rows.length, per, key, Math.max(1, Math.floor(mainBox.h / lineH) - 1));
      // Selecting is all a key does here: the folder shown never changes under an arrow (Enter or Space opens).
      const row = rows[at < 0 && (key === "ArrowDown" || key === "ArrowRight") ? 0 : next]; if (row) selectOnly(last, row);
      return;
    }
    const col = columns[focusCol]; if (!col) return;
    if (key === "ArrowUp" && upFrom(focusCol)) return;
    if (key === "ArrowLeft" && focusCol === 0) { if (leftAct({ view: "columns", col: 0, atLineStart: true, sidebar: sideOnRef.current }) === "sidebar") focusSidebar(); return; }
    const at = Math.max(0, shapes[focusCol]!.sel ?? 0);
    const to = keyStep({ col: focusCol, row: at }, key, shapes, Math.max(1, Math.floor(mainBox.h / rowHeight(prefs.density, prefs.textSize)) - 2));
    if (to.col !== focusCol) {
      if (to.col > focusCol) { enterFolder(focusCol); return; }
      setFocusCol(to.col); return;
    }
    if (key === "ArrowDown" && shapes[focusCol]!.sel === null) { const r = col.display.rows[0]; if (r) pick(focusCol, r); return; }
    const row = col.display.rows[to.row]; if (row) pick(focusCol, row);
  }, [prefs.view, prefs.thumb, prefs.density, prefs.textSize, columns, last, focusCol, sel, shapes, mainBox.w, mainBox.h, pick, selectOnly, enterFolder]);

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

  reopen.current = (row) => { if (reopensPreview({ open: wide ? prefs.preview : peek, folder: isFolder(row), modified: false })) { if (wide) setPrefs({ preview: true }); else setPeek(true); } };
  /* One step for the button and Ctrl+B alike, as in Strata: full, the icon rail, hidden, full. */
  const toggleSide = useCallback(() => (compact ? setSidePage((v) => !v) : setPrefs(sidebarPrefs(nextSidebar(sideMode)))), [compact, sideMode, setPrefs]);

  /* The file operations (Strata's menu and keys): what they act on and how the finder answers, here; the doing is /fs/op. */
  const chosenNow = (): Chosen | null => {
    if (liveMulti) {
      const rows = (columns[liveMulti.col]?.display.rows ?? []).filter((r) => liveMulti.choice.names.has(r.name));
      return rows.length ? { dir: trail[liveMulti.col]!, rows } : null;
    }
    return deepest ? { dir: trail[deepest.col]!, rows: [deepest.row] } : null;
  };
  /** Ctrl+A: every row of the focused folder; an empty one says so, as Strata's footer does. */
  const selectEvery = () => {
    const col = prefs.view === "columns" ? focusCol : last;
    const rows = columns[col]?.display.rows ?? [];
    if (!rows.length) { setNote("Nothing to select"); return; }
    choose(col, selectAll(rows, chosenOf(col)));
  };
  const ops = useFinderOps({
    chosen: chosenNow,
    rowsIn: (dir) => columns[trail.indexOf(dir)]?.display.rows ?? [],
    here: () => trail[prefs.view === "columns" ? focusCol : last] ?? trail[0]!,
    choose: (dir, name) => { const col = trail.indexOf(dir); const row = columns[col]?.display.rows.find((r) => r.name === name); if (row && sel[col] !== row.name) pickHeld(col, row, false); },
    reload: (dir) => store.current?.load(dir, prefs.hidden, true),
    say: setNote,
    hidden: prefs.hidden,
    columnsView: prefs.view === "columns",
    home,
    pins,
    togglePin: togglePinned,
    toggleHidden: () => setPrefs({ hidden: !prefs.hidden }),
    selectAll: () => selectEvery(),
    open: (dir, row) => { const col = trail.indexOf(dir); if (isFolder(row) && !row.locked) { if (prefs.view === "columns") { pick(col, row); enterFolder(col); } else go(joinPath(dir, row.name)); } else if (!row.locked) openDefault(joinPath(dir, row.name)); },
    preview: () => { if (wide) setPrefs({ preview: !prefs.preview }); else setPeek((p) => !p); },
    copyText: (text, said) => { void navigator.clipboard?.writeText(text).then(() => setNote(said)).catch(() => setNote("Could not copy")); },
    terminal: (dir) => onBench(dir, "terminal"),
    openTab: (path) => newTab(path),
    pasteDir: () => (pointerNav.current ? pointerDir.current : null),
    clearFilter: (dir) => setFilters((f) => (f[dir] ? { ...f, [dir]: "" } : f)),
  });
  const opsOpen = useRef(false); opsOpen.current = ops.hasMenu;
  const renaming = useRef(false); renaming.current = !!ops.edit;

  /** Closes column `i` and every one beyond it (Strata's close_column); the keyboard goes to the one before. */
  const closeColumn = useCallback((i: number) => { setTrail((t) => t.slice(0, i)); setSel((x) => x.slice(0, i)); setFocusCol(i - 1); setMulti(null); }, []);
  const act = useCallback((a: NonNullable<ReturnType<typeof finderKey>>) => {
    // Ctrl+Enter and Ctrl+Shift+Enter: the cursor row's folder in a new tab, a file as Enter (Strata), whatever else is chosen with it.
    if (a.t === "opentab" && deepest) { if (!deepest.row.locked) { if (isFolder(deepest.row)) newTab(deepest.path); else openDefault(deepest.path); } return; }
    if (ops.key(a.t)) return;
    switch (a.t) {
      case "move": move(a.key); break;
      case "enter": {
        // Nothing chosen: Enter chooses the first row (Strata's activate with no cursor).
        if (!deepest) { const col = prefs.view === "columns" ? focusCol : last; const r = columns[col]?.display.rows[0]; if (r) (prefs.view === "columns" ? pick : selectOnly)(col, r); break; }
        if (isFolder(deepest.row)) { if (prefs.view === "columns") enterFolder(deepest.col); else { go(deepest.path); } }
        else if (!deepest.row.locked) openDefault(deepest.path);
        break;
      }
      case "up": {
        if (backspaceAct(prefs.view, focusCol) === "close-column") closeColumn(focusCol);
        else goUp();
        break;
      }
      case "space": {
        if (deepest && isFolder(deepest.row) && !deepest.row.locked) { if (prefs.view === "columns") enterFolder(deepest.col); else go(deepest.path); }
        else if (wide) setPrefs({ preview: !prefs.preview }); else setPeek((p) => !p);
        break;
      }
      case "escape": {
        switch (escRef.current()) {
          case "preview-page": setPeek(false); break;
          case "multi": setMulti((m) => (m ? { ...m, choice: dismissChoice(m.choice) } : m)); break;
        }
        break;
      }
      case "find": {
        const col = prefs.view === "columns" ? focusCol : last;
        const path = trail[col]; if (path === undefined) break;
        setFilters((f) => ({ ...f, [path]: a.ch }));
        setFilterTick((t) => ({ col, n: t.n + 1 }));
        break;
      }
      case "text": setPrefs({ textSize: a.by === 0 ? DEFAULT_PREFS.textSize : Math.min(TEXT_MAX, Math.max(TEXT_MIN, prefs.textSize + a.by)) }); break;
      case "sidefocus": {
        if (document.activeElement?.closest("[data-finder-sidebar]")) { focusFiles(); break; }
        // Strata reveals a hidden sidebar to put the keyboard in it.
        if (!sideOnRef.current) { if (compact) setSidePage(true); else setPrefs(sidebarPrefs("full")); setTimeout(focusSidebar, 0); } else focusSidebar();
        break;
      }
      case "menu": {
        const col = prefs.view === "columns" ? focusCol : last;
        const dir = trail[col]; if (dir === undefined) break;
        const name = liveMulti?.col === col ? liveMulti.choice.cursor : sel[col] ?? null;
        const pane = [...(root.current?.querySelectorAll<HTMLElement>("[data-dir]") ?? [])].find((d) => d.dataset.dir === dir);
        const at = (name ? [...(pane?.querySelectorAll<HTMLElement>("[data-row]") ?? [])].find((r) => r.dataset.row === name) : null) ?? pane;
        const r = at?.getBoundingClientRect();
        if (r) ops.contextAt(r.left + 24, name ? r.bottom - 4 : r.top + 24, dir, name);
        break;
      }
      case "settings": setSettings(new DOMRect(0, 0, 1, 1)); break;
      case "tabnum": if (a.i < tabs.paths.length) toTab(selectTab(tabs, a.i)); break;
      case "tabmove": setTabs((t) => moveTab(t, a.by)); break;
      case "shiftside": {
        if (prefs.view === "columns") { if (a.by < 0) move("ArrowLeft"); break; }
        if (prefs.view === "icons") choose(last, extendSelect(columns[last]?.display.rows ?? [], chosenOf(last), a.by));
        break;
      }
      case "back": if (canBack(hist)) goHist(histBack(hist)); break;
      case "forward": if (canForward(hist)) goHist(histForward(hist)); break;
      case "home": go(home); break;
      case "refresh": store.current?.load(trail[focusCol] ?? trail[0]!, prefs.hidden, true); break;
      case "pfind": root.current?.querySelector("[data-finder-preview]")?.dispatchEvent(new CustomEvent("agx-preview-find", { detail: a.do })); break;
      case "filter": setFilterTick((t) => ({ col: prefs.view === "columns" ? focusCol : last, n: t.n + 1 })); break;
      case "view": setPrefs({ view: a.view }); break;
      case "preview": if (!chosenNow()) { setNote(nothingTo("preview")); break; } if (wide) setPrefs({ preview: !prefs.preview }); else setPeek((p) => !p); break;
      case "hidden": setPrefs({ hidden: !prefs.hidden }); break;
      case "terminal": onBench(trail[focusCol] ?? trail[0]!, "terminal"); break;
      case "sidebar": toggleSide(); break;
      case "path": setPathSignal((n) => n + 1); break;
      case "copy": copyChosen(); break;
      case "help": setHelp((h) => !h); break;
      case "newtab": newTab(); break;
      case "closetab": if (tabs.paths.length > 1) toTab(closeTab(tabs, tabs.active)); break;
      case "tab": if (tabs.paths.length > 1) toTab(stepTab(tabs, a.by)); break;
      case "extend": {
        const col = prefs.view === "columns" ? focusCol : last;
        const rows = columns[col]?.display.rows ?? [];
        const page = Math.max(1, Math.floor(mainBox.h / rowHeight(prefs.density, prefs.textSize)) - 2);
        const per = prefs.view === "icons" ? tilesPerRow(mainBox.w, prefs.thumb) : 1;
        choose(col, extendSelect(rows, chosenOf(col), extendBy(a.by, page, per)));
        break;
      }
      case "all": selectEvery(); break;
      case "toggle": { const col = prefs.view === "columns" ? focusCol : last; choose(col, toggleCursor(columns[col]?.display.rows ?? [], chosenOf(col))); break; }
    }
  }, [closeColumn, move, choose, columns, multi, sel, mainBox.w, mainBox.h, last, deepest, prefs, enterFolder, go, goUp, hist, goHist, home, trail, focusCol, onBench, wide, toggleSide, setPrefs, copy, currentPath, ops]);

  // On the window, capture phase: the palette keeps focus in its own search box, and ↓ there must still move the list.
  const actRef = useRef(act); actRef.current = act;
  const helpRef = useRef(help); helpRef.current = help;
  const focusFilesRef = useRef(focusFiles); focusFilesRef.current = focusFiles;
  const focusSidebarRef = useRef(focusSidebar); focusSidebarRef.current = focusSidebar;
  const escRef = useRef(() => escapeAct({ previewPage: false, multi: false }));
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (searchingRef.current) return; // the search overlay has the keys while it is up
      if ((e.target as HTMLElement | null)?.closest?.("[data-finder-nvim]")) return; // nvim has every key typed into its own pane
      const mine = !!root.current && (root.current.contains(e.target as Node) || e.target === document.body || (e.target as HTMLElement | null)?.closest?.('[role="dialog"]') === root.current.closest('[role="dialog"]'));
      const win = { key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey, code: e.code };
      // A name being typed, a menu, a question or a dialog of the finder's own: F5, Ctrl+K and the rest of the window's chords do nothing, here or in the app behind (Strata's).
      const modal = opsOpen.current || !!root.current?.querySelector('[role="dialog"], [role="alertdialog"]');
      if (modal && mine && windowChord(win)) { e.preventDefault(); e.stopPropagation(); return; }
      if (opsOpen.current) return; // a menu or a question has the keys while it is up
      // Ctrl+K is the app's command palette everywhere else; inside the finder it is Strata's search.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k" && mine) {
        e.preventDefault(); e.stopPropagation(); if (e.shiftKey) openJump(); else openSearch(); return;
      }
      if (!["Shift", "Control", "Alt", "Meta"].includes(e.key)) pointerNav.current = false;
      cancelSlowRef.current(); // any key cancels a pending slow-click rename, as in Strata
      const k = win;
      if (isAppChord(e) && !finderOwnsChord(k)) return;
      // A dialog or a sheet of the finder's own has the keys while it is up; F1 still closes the shortcuts sheet.
      if (root.current?.querySelector('[role="dialog"], [role="alertdialog"]') && !(e.key === "F1" && helpRef.current)) return;
      const t = e.target as HTMLElement | null;
      // The sidebar, once the keyboard is in it (Left from the files, Ctrl+Shift+B): Up and Down walk its rows, Right goes back to the files.
      if (t?.closest?.("[data-finder-sidebar]") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const rows = [...(root.current?.querySelectorAll<HTMLButtonElement>("[data-finder-sidebar] [data-side-row]:not(:disabled)") ?? [])];
        const at = rows.indexOf(t.closest("[data-side-row]") as HTMLButtonElement);
        // Up from the first row goes to the top bar (Strata's focus order); Down from the last stays.
        if (e.key === "ArrowUp" && at <= 0) { e.preventDefault(); e.stopPropagation(); topFromSide.current = true; topBarButtons()[0]?.focus(); return; }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); rows[Math.min(rows.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus(); return; }
        if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); focusFilesRef.current(); return; }
        if (e.key === "Enter" || e.key === " " || e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) return; // the row's own button and menu
      }
      // The top bar, once the keyboard is in it: Left and Right walk its buttons, Down goes back to the sidebar it came from or to the files. Ceiling: the crumbs are not stops, Ctrl+L types a path.
      if (t instanceof HTMLButtonElement && t.closest("[data-finder-topbar]") && !t.closest('[role="navigation"]') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
        e.preventDefault(); e.stopPropagation();
        if (e.key === "ArrowDown") { const side = topFromSide.current && sideOnRef.current; topFromSide.current = false; if (side) focusSidebarRef.current(); else focusFilesRef.current(); return; }
        if (e.key === "ArrowUp") return;
        const bs = topBarButtons(); const i = bs.indexOf(t);
        bs[Math.min(bs.length - 1, Math.max(0, i + (e.key === "ArrowRight" ? 1 : -1)))]?.focus();
        return;
      }
      const field = !!t && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable);
      const own = !!t?.closest?.("[data-finder-box]");
      const inField = field && !(own && (t as HTMLInputElement).value === "");
      // With no search box the palette's own panel holds the focus, so the panel counts as inside.
      const panel = root.current?.closest('[role="dialog"]') ?? null;
      if (!own && !root.current?.contains(t) && t !== document.body && !(panel && t === panel)) return;
      // A resize grip owns its arrow keys; the window listener runs first, in capture, and would walk the rows instead.
      if (t?.closest?.('[role="separator"]')) return;
      // A focused button, tab or menu row takes Enter and Space itself (Strata hands them to GTK there).
      if ((e.key === "Enter" || e.key === " ") && !e.ctrlKey && !e.altKey && !e.metaKey && t?.closest?.('button, a, [role="tab"], [role="menuitem"]')) return;
      // A pane's header, once the keyboard is in it (Up from the first row): Left and Right walk its buttons, Down goes back to the rows.
      const head = t?.closest?.("[data-dir] header");
      if (head && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowDown")) {
        e.preventDefault(); e.stopPropagation();
        if (e.key === "ArrowDown") { focusFilesRef.current(); return; }
        const bs = [...head.querySelectorAll<HTMLElement>("button")];
        bs[Math.min(bs.length - 1, Math.max(0, bs.indexOf(t as HTMLElement) + (e.key === "ArrowRight" ? 1 : -1)))]?.focus();
        return;
      }
      // A preview document has the focus when the press is inside the preview and not on one of its buttons, or when the text selected is the preview's.
      const previewEl = root.current?.querySelector("[data-finder-preview]") ?? null;
      const selNode = window.getSelection()?.anchorNode ?? null;
      const inPreview = !!previewEl && (t?.closest?.("[data-finder-preview]") ? !t.closest("button, a, input, select, [role=tab], [role=menuitem]") : (t === document.body || t === root.current) && !!selNode && previewEl.contains(selNode));
      const a = finderKey(k, { inField, inFilter: !!t?.matches?.('input[aria-label^="Filter"]'), inPreview, previewFind: previewEl?.getAttribute("data-find-open") === "1", mac: MAC, hasSelection: !!window.getSelection()?.toString() });
      if (!a) return;
      // Esc with nothing left to take away is the app's: it closes the finder.
      if (a.t === "escape" && escRef.current() === "none") return;
      e.preventDefault(); e.stopPropagation();
      actRef.current(a);
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, []);
  /* When a menu, a question, the search, Settings, the shortcuts or the typed path goes away, the keyboard goes back to the files, as Strata returns it to the cursor. */
  const overlay = ops.hasMenu || searching || jumping || !!settings || help || pathEditing || !!held;
  const hadOverlay = useRef(overlay);
  useEffect(() => { if (hadOverlay.current && !overlay) setTimeout(() => { if (!document.activeElement?.closest("[data-finder-sidebar]")) focusFilesRef.current(); }, 0); hadOverlay.current = overlay; }, [overlay]);
  /* Ctrl and the wheel over the finder: its text size, as Strata's (a listener that is not passive, or the browser zooms the page instead). */
  const textRef = useRef(prefs.textSize); textRef.current = prefs.textSize;
  useEffect(() => {
    const el = root.current; if (!el) return;
    const on = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const by = wheelTextStep(e.deltaY);
      if (by) setPrefs({ textSize: Math.min(TEXT_MAX, Math.max(TEXT_MIN, textRef.current + by)) });
    };
    el.addEventListener("wheel", on, { passive: false });
    return () => el.removeEventListener("wheel", on);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), FEEDBACK_MS); return () => clearTimeout(t); }, [note]);

  const refresh = (p: string) => store.current?.load(p, prefs.hidden, true);
  const onSort = (k: SortKey) => setPrefs(prefs.sortKey === k ? { sortDir: prefs.sortDir === "asc" ? "desc" : "asc" } : { sortKey: k, sortDir: "asc" });
  const onRecentSort = (k: SortKey | "recency") => setRecentSort((s) => nextRecentSort(s, k));
  const rowH = rowHeight(prefs.density, prefs.textSize);
  /** The rows of a folder that a Cut holds: drawn faded until they are pasted. */
  const cutIn = (path: string): ReadonlySet<string> | undefined => (ops.clip?.mode === "cut" && ops.clip.dir === path ? new Set(ops.clip.names) : undefined);

  /* The middle button on a file: its own folder, with it selected (in Recent the name is the whole path). */
  const revealRow = (dir: string, r: Row) => { const p = joinPath(dir, r.name); reveal({ kind: "select", dir: parentOf(p) ?? "/", name: basename(p) }); };
  /* The column a press landed in: its own, or, on the blank strip after the last column, the last one (Strata's marquee origin is shared there). */
  const dirOf = (t: HTMLElement): HTMLElement | null => {
    const own = t.closest<HTMLElement>("[data-dir]"); if (own) return own;
    const all = t.closest("[data-strip]")?.querySelectorAll<HTMLElement>("[data-dir]");
    return all && all.length ? all[all.length - 1]! : null;
  };
  /* Where the keyboard was when the press began: the press itself moves it to the column pressed. */
  const pressFocus = useRef(0);
  /* A primary click on the empty space of a folder's view (lib/finderPointer "clear"): no selection, and nothing open to its right.
     Coming back to a column from another, with nothing filtered, the cursor goes to its first row. Strata keeps the columns
     beyond that child open; a trail here is one chain from the selection, so there is nowhere to keep them. */
  const onEmpty = (e: React.MouseEvent) => {
    if (bandEnded.current) { bandEnded.current = false; return; } // the click that ends a rubber band clears nothing
    const t = e.target as HTMLElement;
    if (t.closest("[data-row], header, input, button, [role=\"separator\"]")) return;
    const dir = dirOf(t)?.dataset.dir;
    const col = dir === undefined ? -1 : trail.indexOf(dir);
    if (col < 0 || pointerAction(prefs.view, "empty", e.button, e.detail || 1) !== "clear" || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const first = emptyClickSelectsFirst(pressFocus.current !== col, (filters[dir!] ?? "") !== "") ? columns[col]?.display.rows[0] : undefined;
    setMulti(null); setSel((s) => [...s.slice(0, col), first?.name ?? null]); setTrail((tr) => tr.slice(0, col + 1)); setFocusCol(col);
  };
  /* Strata's rubber band (lib/finderSelect marqueeChoice): a drag from the empty space of a view, the blank of an unselected row,
     a column's header or the strip after the last column, or from anywhere with Alt, selects the rows it touches. It scrolls the
     list within 28 px of its edge, and finds the rows from the layout, not the DOM, so rows scrolled out of the window still count.
     Its ceiling: one column's rows; a band does not carry sideways into the next column. */
  const [band, setBand] = useState<Box | null>(null);
  const bandEnded = useRef(false);
  const onBandDown = (e: React.MouseEvent) => {
    cancelSlow();
    pointerNav.current = true; pressFocus.current = focusCol;
    const t = e.target as HTMLElement;
    if (t.closest("input, button, [role=\"separator\"]")) return;
    const dirEl = dirOf(t); if (!dirEl) return;
    const rowEl = t.closest<HTMLElement>("[data-row]");
    const onRow = rowEl ? { selected: rowEl.getAttribute("aria-selected") === "true", onContent: !!t.closest("[data-name], [data-icon]") } : null;
    if (!startsMarqueeAt(e.button, onRow, e.altKey)) return;
    const col = trail.indexOf(dirEl.dataset.dir!); if (col < 0) return;
    const scroller = dirEl.querySelector<HTMLElement>("[role=listbox]"); if (!scroller) return;
    // A band, not a drag of the row, and no text selected on the way; the list still gets the keyboard.
    if (rowEl || t.closest("header")) { e.preventDefault(); if (rowEl) scroller.focus({ preventScroll: true }); }
    const rows = columns[col]?.display.rows ?? [];
    const tile = tileSize(prefs.thumb);
    const lay: BandLayout = prefs.view === "icons"
      ? { rowH: tile.h, hitH: tile.h - 4, per: tilesPerRow(mainBox.w, prefs.thumb), tileW: tile.w, padX: 8 }
      : { rowH, slotOf: columns[col]?.display.itemOfRow };
    const initial = chosenOf(col);
    const mod = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
    const r0 = scroller.getBoundingClientRect();
    const anchor = { x: e.clientX - r0.left, y: e.clientY - r0.top + scroller.scrollTop };
    let px = e.clientX, py = e.clientY, live = false, tick: ReturnType<typeof setInterval> | null = null;
    const apply = () => {
      const r = scroller.getBoundingClientRect(), top = scroller.scrollTop;
      setBand(boxOf({ x: anchor.x + r.left, y: anchor.y - top + r.top }, { x: px, y: py }));
      const box = boxOf(anchor, { x: px - r.left, y: py - r.top + top });
      const hit = new Set(bandRows(lay, rows.length, box).map((i) => rows[i]!.name));
      const c = marqueeChoice(rows, hit, initial, mod);
      if (c.names.size > 1) choose(col, c);
      else { const one = rows.find((x) => c.names.has(x.name)); if (one) selectOnly(col, one); else { setMulti(null); setSel((x) => [...x.slice(0, col), null]); setTrail((tr) => tr.slice(0, col + 1)); } }
    };
    const move = (ev: MouseEvent) => {
      px = ev.clientX; py = ev.clientY;
      if (!live && Math.hypot(px - e.clientX, py - e.clientY) < MARQUEE_SLOP) return;
      if (!live) {
        live = true;
        tick = setInterval(() => { const r = scroller.getBoundingClientRect(), d = edgeStep(py, r.top, r.bottom); if (d) { scroller.scrollTop += d; apply(); } }, EDGE_TICK_MS);
      }
      window.getSelection()?.removeAllRanges();
      apply();
    };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); if (tick) clearInterval(tick); if (live) { bandEnded.current = true; setBand(null); } };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };

  /* Strata's slow click (lib/finderPointer slowClickRenames): a second click on the name of the only selected row renames it once the double-click time has passed. */
  const slow = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelSlow = () => { if (slow.current) clearTimeout(slow.current); slow.current = null; };
  const cancelSlowRef = useRef(cancelSlow); cancelSlowRef.current = cancelSlow;
  const onSlowClick = (col: number, r: Row, e: React.MouseEvent) => {
    cancelSlow();
    const dir = trail[col] ?? "";
    const place = isRecent(dir) ? "recent" : inTrash(dir) ? "trash" : "folder";
    if (slowClickRenames({ soleSelected: !liveMulti && sel[col] === r.name && !r.locked, onName: !!(e.target as HTMLElement).closest("[data-name]"), clicks: e.detail, mods: e.ctrlKey || e.metaKey || e.shiftKey || e.altKey, place }))
      slow.current = setTimeout(() => { slow.current = null; ops.key("rename"); }, SLOW_CLICK_MS);
  };

  /* Strata has no menu where it has none of its own (a column's header, the tabs, the preview, the toolbar): the browser's never shows there either. A text field keeps its own. */
  const noNativeMenu = (e: React.MouseEvent) => { if (!(e.target as HTMLElement).closest("input, textarea, [contenteditable=\"true\"]")) e.preventDefault(); };
  /* The mouse's back and forward buttons walk the history from anywhere in the finder, as Strata's do. */
  const onHistoryButton = (e: React.MouseEvent) => {
    const a = pointerAction(prefs.view, "empty", e.button, 1);
    if (!historyClaims(a, { back: canBack(hist), forward: canForward(hist) })) return;
    e.preventDefault();
    if (a === "back" && canBack(hist)) goHist(histBack(hist));
    if (a === "forward" && canForward(hist)) goHist(histForward(hist));
  };

  /* A right click anywhere in the browser: the row it landed on, or the empty space of its column (rows and columns carry data-row and data-dir). */
  const onContext = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    const dirEl = t.closest<HTMLElement>("[data-dir]");
    if (!dirEl || t.closest("header, input, [data-heading], [role=\"separator\"]")) return; // Strata gives a list's headings no menu
    e.preventDefault();
    ops.contextAt(e.clientX, e.clientY, dirEl.dataset.dir!, t.closest<HTMLElement>("[data-row]")?.dataset.row ?? null);
  };

  /* Drag and drop inside the finder, by delegation as the right click is: a row is picked up, and a folder row, a column, a sidebar place or the Trash takes it. Ctrl copies. */
  const dropMark = useRef<Element | null>(null);
  const unmark = () => { dropMark.current?.removeAttribute("data-drop-on"); dropMark.current = null; };
  const dropTarget = (t: HTMLElement): { el: Element; path: string; trash: boolean; kind: DropKind } | null => {
    const tr = t.closest("[data-drop-trash]"); if (tr) return { el: tr, path: "", trash: true, kind: "trash" };
    const pl = t.closest<HTMLElement>("[data-drop-path]"); if (pl) return { el: pl, path: pl.dataset.dropPath!, trash: false, kind: (pl.dataset.dropKind as DropKind | undefined) ?? "place" };
    const dirEl = t.closest<HTMLElement>("[data-dir]"); if (!dirEl) return null;
    const row = t.closest<HTMLElement>("[data-row][data-folder]");
    return row && dirEl.contains(row) ? { el: row, path: joinPath(dirEl.dataset.dir!, row.dataset.row!), trash: false, kind: "folder" } : { el: dirEl, path: dirEl.dataset.dir!, trash: false, kind: "pane" };
  };
  /* Where the mounted volumes are, so a drop across them copies (Strata's rule). */
  const mountsNow = () => devices.volumes.flatMap((v) => (v.mountPoint ? [v.mountPoint] : []));
  /* Spring-loaded targets (lib/finderPointer springMs): resting a drag on a folder, a place, a crumb or a tab opens it. */
  const spring = useRef<{ el: Element; t: ReturnType<typeof setTimeout> } | null>(null);
  const unspring = () => { if (spring.current) clearTimeout(spring.current.t); spring.current = null; };
  const springOpen = (d: { el: Element; path: string; kind: DropKind }) => {
    if (d.kind === "tab") { const i = tabs.paths.indexOf(d.path); if (i >= 0) toTab(selectTab(tabs, i)); return; }
    if (d.kind === "folder" && prefs.view === "columns") {
      const dir = (d.el.closest("[data-dir]") as HTMLElement | null)?.dataset.dir ?? "";
      const col = trail.indexOf(dir); const row = columns[col]?.display.rows.find((r) => r.name === (d.el as HTMLElement).dataset.row);
      if (row) { pick(col, row); return; }
    }
    go(d.path);
  };
  const dnd = {
    onDragStart: (e: React.DragEvent) => {
      const t = e.target as HTMLElement, row = t.closest<HTMLElement>("[data-row]"), dirEl = t.closest<HTMLElement>("[data-dir]");
      const file = t.closest<HTMLElement>("[data-preview-drag]")?.dataset.previewDrag; // the preview's header drags the file it shows
      const src = file ? { dir: parentOf(file) ?? "/", name: basename(file) } : row && dirEl ? { dir: dirEl.dataset.dir!, name: row.dataset.row! } : null;
      if (!src) return;
      const names = ops.dragStart(src.dir, src.name);
      const paths = names.map((n) => (isRecent(src.dir) ? n : joinPath(src.dir, n)));
      e.dataTransfer.effectAllowed = "copyMove";
      // Other programs take the uri-list; the plain list is kept for a text field. Ceiling: no FileList, which a page cannot make.
      e.dataTransfer.setData("text/uri-list", fileUris(paths));
      e.dataTransfer.setData("text/plain", paths.join("\n"));
    },
    onDragOver: (e: React.DragEvent) => {
      const d = dropTarget(e.target as HTMLElement);
      const allowed = d ? (d.trash ? "move" : ops.dropAllows(d.path, e.ctrlKey, { shift: e.shiftKey, mounts: mountsNow() })) : null;
      if (!d || !allowed) { unmark(); unspring(); return; }
      e.preventDefault(); e.dataTransfer.dropEffect = allowed;
      if (dropMark.current !== d.el) { unmark(); d.el.setAttribute("data-drop-on", ""); dropMark.current = d.el; }
      if (spring.current?.el !== d.el) { unspring(); const ms = springMs(d.kind); if (ms !== null) spring.current = { el: d.el, t: setTimeout(() => { spring.current = null; springOpen(d); }, ms) }; }
    },
    onDragLeave: (e: React.DragEvent) => { if (!(e.currentTarget as Element).contains(e.relatedTarget as Node | null)) { unmark(); unspring(); } },
    onDrop: (e: React.DragEvent) => {
      const d = dropTarget(e.target as HTMLElement); unmark(); unspring();
      if (!d) return;
      e.preventDefault(); ops.dropOn(d.path, e.ctrlKey, d.trash, { shift: e.shiftKey, mounts: mountsNow() });
    },
    onDragEnd: () => { unmark(); unspring(); ops.dragEnd(); },
  };

  /* ---- layout ---- */
  /* Beside the preview the strip is as many whole columns as fit, so no column is cut by the preview's edge; the preview takes what is left. */
  const stripMax = stripAvail === undefined ? undefined : wholeColumnsWidth(widths, stripAvail);
  const previewOnly = !previewInline && peek;
  sideOnRef.current = sideOn;
  escRef.current = () => escapeAct({ previewPage: previewOnly, multi: !!liveMulti });
  const lastCol = columns[last];
  const preview = (
    <QuickLook autoplay={prefs.autoplay} renderDocs={prefs.renderDocs} root={workspace} savedTab={previewTab} onTab={(path, tab) => setPreviewTab({ path, tab })} onEditing={(p) => { editing.current = p; }} path={deepest?.path ?? null} row={deepest?.row ?? null}
      rows={deepest && isFolder(deepest.row) ? (columns[deepest.col + 1]?.state?.rows ?? null) : null}
      onBench={onBench} readW={prefs.readW} onReadW={(w) => setPrefs({ readW: w })} onClose={guarded("preview-close", () => (wide ? setPrefs({ preview: false }) : setPeek(false)))} />
  );

  /* Strata's footer: the shortcuts button on the left, what is here or selected on the right. */
  const count = (() => {
    const n = lastCol?.state;
    if (!n) return "Reading…";
    if (liveMulti) return selectedFooter(columns[liveMulti.col]?.display.rows ?? [], liveMulti.choice);
    return `${footerCount(footerTotal(n.total, lastCol?.display.rows.length ?? 0, filters[lastCol?.path ?? ""] ?? ""), deepest?.row ?? null)}${!deepest && !n.done ? " so far" : ""}`;
  })();

  /* The screen reader's second sentence for the count: the breakdown, or how much of the folder is chosen. */
  const describedCount = (() => {
    const col = liveMulti ? liveMulti.col : deepest ? deepest.col : last;
    const rows = columns[col]?.display.rows ?? [];
    return footerDescription(rows, liveMulti ? liveMulti.choice.names.size : deepest ? 1 : 0);
  })();

  const tool = "agx-btn rounded-md grid place-items-center shrink-0";
  /** What a sidebar row's menu does: hiding a place is Strata's Unpin on it, and Settings turns it back on. */
  const onSideAct = (act: SideAct, t: SideTarget) => {
    if (act === "unpin") {
      if (t.kind === "place") { setPrefs({ hiddenPlaces: withHidden(prefs.hiddenPlaces, t.id, true) }); setNote(`Hid ${t.id[0]!.toUpperCase() + t.id.slice(1)} from the sidebar (Settings turns it back on)`); }
      else if (t.kind === "pin") { if (t.path) togglePinned(t.path); else removePinned(t.uri); }
      return;
    }
    const path = t.kind === "device" ? t.volume.mountPoint : t.path;
    if (act === "customize" && path) ops.openCustomize(path);
    else if (act === "properties" && path) ops.openProps(path);
    else if (t.kind === "device" && act !== "customize" && act !== "properties") devices.onVolumeAct(t.volume, act);
  };
  return (
    <div ref={root} data-machine-finder onAuxClick={onHistoryButton} onContextMenu={noNativeMenu} {...dnd} onMouseMove={(e) => { pointerDir.current = (e.target as HTMLElement).closest<HTMLElement>("[data-dir]")?.dataset.dir ?? null; }} onMouseUp={(e) => { if (historyClaims(pointerAction(prefs.view, "empty", e.button, 1), { back: canBack(hist), forward: canForward(hist) })) e.preventDefault(); }} className="relative flex-1 min-h-0 min-w-0 flex flex-col" style={{ fontSize: prefs.textSize, color: "var(--text)" }}>
      <FinderTabs tabs={tabs} home={home} onNew={() => newTab()} onSelect={(i) => toTab(selectTab(tabs, i))} onClose={(i) => toTab(closeTab(tabs, i))} />
      <div data-finder-topbar className="flex items-center gap-1.5 px-2.5 py-1.5 shrink-0" style={{ borderBottom: LINE }}>
        <button className={tool} style={{ width: HIT, height: HIT, color: "var(--primary-ink)", opacity: sideOn ? 1 : 0.7 }} aria-pressed={sideOn} title={sidebarTip(compact ? (sidePage ? "full" : "hidden") : sideMode, "Ctrl+B")} aria-label="Toggle sidebar (Ctrl+B)"
          onClick={toggleSide}><StrataIcon set="act" name="panel-left-symbolic" size={17} /></button>
        {prefs.view !== "columns" && <>
          <button className={tool} disabled={!canBack(hist)} style={{ width: HIT, height: HIT, color: "var(--primary-ink)", opacity: canBack(hist) ? 1 : 0.4 }} title="Back (Alt+Left)" aria-label="Back" onClick={() => goHist(histBack(hist))}><StrataIcon set="act" name="arrow-left" size={17} /></button>
          <button className={tool} disabled={!canForward(hist)} style={{ width: HIT, height: HIT, color: "var(--primary-ink)", opacity: canForward(hist) ? 1 : 0.4 }} title="Forward (Alt+Right)" aria-label="Forward" onClick={() => goHist(histForward(hist))}><StrataIcon set="act" name="arrow-right" size={17} /></button>
          <button className={tool} disabled={!parentOf(trail[0]!)} style={{ width: HIT, height: HIT, color: "var(--primary-ink)", opacity: parentOf(trail[0]!) ? 1 : 0.4 }} title="Parent folder (Alt+Up)" aria-label="Parent folder" onClick={goUp}><StrataIcon set="act" name="arrow-up" size={17} /></button>
        </>}
        <FinderPathBar path={trail[last] ?? trail[0]!} home={home} onGo={go} signalEdit={pathSignal} onEditing={setPathEditing} volumes={devices.volumes} onRemote={devices.openAddress} onFail={setPathFailed} />
        <button className={tool} style={{ width: HIT, height: HIT, color: "var(--primary-ink)" }} title="New tab (Ctrl+T)" aria-label="New tab" onClick={() => newTab()}><StrataIcon set="act" name="plus" size={17} /></button>
        <button className={tool} style={{ width: HIT, height: HIT, color: "var(--primary-ink)" }} title="Search (Ctrl+K)" aria-label="Search" onClick={openSearch}><StrataIcon set="act" name="search" size={17} /></button>
        <button className={tool} style={{ width: HIT, height: HIT, color: "var(--primary-ink)" }} title="Appearance" aria-label="Appearance" aria-haspopup="menu" onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())}><StrataIcon set="act" name={prefs.view} size={17} /></button>
        {/* The way back after the preview's own ×: lit while the panel is open, one click either way (Space does the same). */}
        <button className={tool} style={{ width: HIT, height: HIT, color: "var(--primary-ink)", ...toggleLook(wide ? prefs.preview : peek) }} aria-pressed={wide ? prefs.preview : peek} title="Preview panel (Space)" aria-label="Toggle the preview panel (Space)" onClick={() => (wide ? setPrefs({ preview: !prefs.preview }) : setPeek((p) => !p))}><StrataIcon set="act" name="panel-right-close" size={17} /></button>
        <button className={tool} style={{ width: HIT, height: HIT, color: "var(--primary-ink)" }} title="Settings" aria-label="Settings" aria-haspopup="menu" onClick={(e) => setSettings(e.currentTarget.getBoundingClientRect())}><StrataIcon set="act" name="settings" size={17} /></button>
        <button className={tool} style={{ width: HIT, height: HIT, color: "var(--primary-ink)" }} title="Close window" aria-label="Close the finder" onClick={onClose}><StrataIcon set="act" name="x" size={17} /></button>
      </div>

      <div className="flex-1 min-h-0 flex" style={{ background: COLUMNS_SURFACE }}>
        {sideOn && <Sidebar places={placesFor(home, places)} pins={pinned} onRemote={devices.openAddress} here={trail[0]!} mode={compact || sideMode === "hidden" ? "full" : pathEditing ? "rail" : sideMode} width={sideW} onResize={(w) => setPrefs({ sideW: sidebarWidth("full", w, box.w) })} onGo={(p, byKey) => { keyGoTo.current = byKey ? p : null; go(p); }} onRecent={() => go(RECENT)} onTrash={ops.openTrash} onNetwork={devices.openNetwork} volumes={devices.volumes} busy={devices.busy} onVolume={devices.onVolume} onVolumeAct={devices.onVolumeAct} hidden={prefs.hiddenPlaces} onSideAct={onSideAct} dnd={dnd} />}
        {!(compact && sidePage) && (
          <>
            {/* With the preview beside the columns and nothing dragged, the columns take what their names ask for and the preview takes all that is left, as Strata's does; a gap between the two was the free room with nowhere to go. */}
            <div ref={main} className="min-w-0 min-h-0 flex" onContextMenu={onContext} onClick={onEmpty} onMouseDown={onBandDown} {...dnd} style={{ flex: previewInline && prefs.view === "columns" && prevDrag === undefined ? "0 1 auto" : "1 1 0%", maxWidth: stripMax }}>
              {previewOnly ? (
                <div className="flex-1 min-w-0 min-h-0 flex flex-col">
                  <button className="agx-btn text-left px-3 text-[11px] shrink-0" style={{ minHeight: HIT, color: "var(--text3)", borderBottom: LINE }} onClick={() => setPeek(false)}>← Back to the folder (Space)</button>
                  {preview}
                </div>
              ) : prefs.view === "columns" ? (
                <ColumnsRow widths={widths} active={focusCol}>
                  {columns.map((c, i) => (
                    <Column key={c.path} enter={settled} cut={cutIn(c.path)} fill={!previewInline && i === columns.length - 1} dir={c.path} title={isRecent(c.path) ? "Recent" : basename(c.path)} filterSignal={filterTick.col === i ? filterTick.n : 0} width={widths[i]!} onResize={(w) => { setDragged((d) => ({ ...d, [c.path]: w })); setPrefs({ colW: w }); }} onFit={() => { const w = fitWidth(c.state?.rows.map((r) => r.name) ?? [], measure, columnRoom); setDragged((d) => ({ ...d, [c.path]: w })); setPrefs({ colW: w }); }} state={c.state} display={c.display} selName={sel[i] ?? null} chosen={liveMulti?.col === i ? liveMulti.choice.names : null} focused={i === focusCol} prefs={prefs} rowH={rowH}
                      filter={filters[c.path] ?? ""} onFilter={(v) => setFilters((f) => ({ ...f, [c.path]: v }))}
                      scrollTop={scrolls.current[c.path]} onScrollTop={(t) => onScrollTop(c.path, t)} onPick={(r, m) => onPickMod(i, r, m)} onTab={(r) => newTab(joinPath(c.path, r.name))} onReveal={(r) => revealRow(c.path, r)} onSlow={(r, e) => onSlowClick(i, r, e)} onSlowCancel={cancelSlow} onFocusChild={() => { if (trail.length > i + 1) setFocusCol(i + 1); }} onOpen={(r) => { if (!r.locked) { if (isFolder(r)) go(joinPath(c.path, r.name)); else openDefault(joinPath(c.path, r.name)); } }}
                      finding={findAt === c.path} onFinding={(on) => openFind(c.path, on)} onClosePane={i > 0 ? () => closeColumn(i) : undefined} onSpace={() => act({ t: "space" })}
                      onFocusCol={() => setFocusCol(i)} onRefresh={() => refresh(c.path)} recent={isRecent(c.path) ? recentSort : undefined} onSort={(k) => (isRecent(c.path) ? onRecentSort(k) : k !== "recency" && onSort(k))} onPref={setPrefs} edit={ops.edit?.dir === c.path ? ops.edit : null} />
                  ))}
                </ColumnsRow>
              ) : lastCol ? (
                <div className="flex-1 min-w-0 min-h-0 flex flex-col" data-dir={lastCol.path}>
                  {paneFind && <FilterField inputRef={paneInput} value={filters[lastCol.path] ?? ""} total={lastCol.state?.total ?? lastCol.display.rows.length} title={basename(lastCol.path)} onChange={(v) => setFilters((f) => ({ ...f, [lastCol.path]: v }))} onDone={() => { setFilters((f) => ({ ...f, [lastCol.path]: "" })); setPaneFind(false); }}
                    nav={{ results: lastCol.display.rows.length, selected: !!deepest, onSpace: () => act({ t: "space" }), onDown: () => { const r = lastCol.display.rows[0]; if (r && !deepest) selectOnly(last, r); }, onActivate: () => { const r = deepest?.row ?? lastCol.display.rows[0]; if (!r || r.locked) return; const p = joinPath(lastCol.path, r.name); if (isFolder(r)) go(p); else openDefault(p); } }} />}
                  {lastCol.state?.error ? <div className="p-3 text-[12px]" role="alert" style={{ color: "var(--warning-ink)" }}>{lastCol.state.error}</div>
                    : prefs.view === "icons"
                      ? <IconsView cut={cutIn(lastCol.path)} density={prefs.density} firstItem={iconsFirst.current[lastCol.path]} onFirstItem={(i) => onIconsFirst(lastCol.path, i)} filtered={(filters[lastCol.path] ?? "") !== ""} peek={folderPeek.peek} display={lastCol.display} dir={lastCol.path} thumb={prefs.thumb} selName={sel[last] ?? null} chosen={liveMulti?.col === last ? liveMulti.choice.names : null} width={mainBox.w} label={`Entries of ${basename(lastCol.path)}`} onPick={(r, m) => onPickMod(last, r, m)} onTab={(r) => newTab(joinPath(lastCol.path, r.name))} onReveal={(r) => revealRow(lastCol.path, r)} onSlow={(r, e) => onSlowClick(last, r, e)} onSlowCancel={cancelSlow} onOpen={(r) => (isFolder(r) && !r.locked ? go(joinPath(lastCol.path, r.name)) : !r.locked && openDefault(joinPath(lastCol.path, r.name)))} />
                      : <ListView cut={cutIn(lastCol.path)} scrollTop={scrolls.current[lastCol.path]} onScrollTop={(t) => onScrollTop(lastCol.path, t)} widths={prefs.listW} onWidths={(w) => setPrefs({ listW: w })} filtered={(filters[lastCol.path] ?? "") !== ""} peek={folderPeek.peek} dir={lastCol.path} display={lastCol.display} selName={sel[last] ?? null} chosen={liveMulti?.col === last ? liveMulti.choice.names : null} rowH={rowH} prefs={prefs} label={`Entries of ${basename(lastCol.path)}`} recent={isRecent(lastCol.path) ? recentSort : undefined} onSort={(k) => (isRecent(lastCol.path) ? onRecentSort(k) : k !== "recency" && onSort(k))} onPick={(r, m) => onPickMod(last, r, m)} onTab={(r) => newTab(joinPath(lastCol.path, r.name))} onReveal={(r) => revealRow(lastCol.path, r)} onSlow={(r, e) => onSlowClick(last, r, e)} onSlowCancel={cancelSlow} onOpen={(r) => (isFolder(r) && !r.locked ? go(joinPath(lastCol.path, r.name)) : !r.locked && openDefault(joinPath(lastCol.path, r.name)))} />}
                </div>
              ) : null}
            </div>
            {previewInline && (
              <div className="relative min-h-0 flex" style={{ flex: `${prevDrag === undefined && prefs.view === "columns" ? 1 : 0} 0 ${previewWidth(box.w, prevDrag, sideTaken)}px`, minWidth: 0, borderLeft: LINE, background: PREVIEW_SURFACE }}>
                <div role="separator" aria-orientation="vertical" aria-label="Resize the preview" tabIndex={0} title="Drag to resize, double-click to reset"
                  className="absolute top-0 bottom-0 agx-col-edge" style={{ left: 0, width: 6, cursor: "col-resize", zIndex: 3, touchAction: "none" }}
                  onDoubleClick={() => setPrevDrag(undefined)}
                  onPointerDown={(e) => {
                    if (!activates(e.button, "mousedown")) return;
                    e.preventDefault();
                    const x0 = e.clientX, el = e.currentTarget, w0 = el.parentElement?.getBoundingClientRect().width ?? previewWidth(box.w, prevDrag, sideTaken);
                    el.setPointerCapture(e.pointerId);
                    const move = (ev: PointerEvent) => setPrevDrag(dragPreviewWidth(box.w, w0, x0, ev.clientX, sideTaken));
                    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); };
                    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
                  }}
                  onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); setPrevDrag(previewWidth(box.w, previewWidth(box.w, prevDrag, sideTaken) + (e.key === "ArrowLeft" ? 16 : -16), sideTaken)); } }} />
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
        <span className="truncate" aria-live="polite" aria-description={describedCount}>{note ?? count}</span>
        {ops.jobsIndicator}
      </footer>
      {band && <div aria-hidden className="fixed pointer-events-none rounded-sm" style={{ left: band.left, top: band.top, width: band.right - band.left, height: band.bottom - band.top, zIndex: 3, background: "color-mix(in srgb, var(--primary) 14%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 55%, transparent)" }} />}
      {held && (
        <div role="alertdialog" aria-label="Unsaved changes" className="absolute inset-0 grid place-items-center p-4" style={{ background: "color-mix(in srgb, var(--bg) 70%, transparent)", zIndex: 9 }}
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setHeld(null); } }}>
          <div className="rounded-xl p-4 text-[12px]" style={{ background: "var(--surface-card)", border: EDGE, width: 380, maxWidth: "100%" }}>
            <b className="block text-[13px] mb-1">Unsaved changes</b>
            <p className="m-0 mb-3" style={{ color: "var(--text3)" }}>{basename(editing.current ?? "")} has changes in nvim that were not written.</p>
            {heldErr && <p role="alert" className="m-0 mb-3" style={{ color: "var(--warning-ink)" }}>Not saved: {heldErr}.</p>}
            <div className="flex justify-end gap-2">
              <button autoFocus className="agx-btn rounded-md px-3" style={{ minHeight: HIT, border: EDGE }} onClick={() => setHeld(null)}>Cancel</button>
              <button className="agx-btn rounded-md px-3" style={{ minHeight: HIT, border: EDGE, color: "var(--warning-ink)" }} onClick={() => { const h = held; setHeld(null); h.run(); }}>Discard</button>
              <button className="agx-btn rounded-md px-3" style={{ minHeight: HIT, background: "var(--text)", color: "var(--bg)" }}
                onClick={() => { const h = held; void api.finderEditSave(workspace).then((r) => { if (r.ok && !r.modified) { setHeld(null); h.run(); } else setHeldErr(r.error ?? "nvim still has unwritten changes"); }).catch(() => setHeldErr("the server did not answer")); }}>Save</button>
            </div>
          </div>
        </div>
      )}
      {devices.dialogs}
      {pathFailed !== null && <ErrorDialog title="Cannot open that path" message={pathFailed} onClose={() => setPathFailed(null)} />}
      {ops.nodes}
      {folderPeek.node}
      {help && <HelpSheet onClose={() => setHelp(false)} />}
      {searching && <FinderSearch home={home} onTarget={reveal} onClose={() => setSearching(false)} />}
      {jumping && <FinderSearch home={home} jump={{ visited, here: trail[0] ?? "" }} onTarget={reveal} onClose={() => setJumping(false)} />}
      {settings && <FinderSettings say={setNote} prefs={prefs} onPref={setPrefs} onReset={() => { setPrefsState(DEFAULT_PREFS); savePrefs(DEFAULT_PREFS); setNote("Finder settings reset"); }} onForget={() => { try { localStorage.removeItem(SNAP_KEY); } catch { /* nothing kept */ } setDragged({}); scrolls.current = {}; setNote("Remembered places cleared"); }} onClose={() => setSettings(null)} />}
      {menu && <AppearanceMenu anchor={menu} prefs={prefs} onPref={setPrefs} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** The columns, scrolled so the active one is whole in view and the leftmost visible column is not sliced (see finderColumns.revealScroll). */
function ColumnsRow({ children, widths, active }: { children: React.ReactNode; widths: number[]; active: number }) {
  const el = useRef<HTMLDivElement>(null);
  const pad = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  const key = widths.join(",");
  /* The strip's own width is part of the layout: the preview and the sidebar settle after the first pass, and a scroll worked out against the old width left the leftmost column sliced. */
  const { w: page } = useBox(el);
  /* The room after the last column is written straight onto its element, not
     kept in state: a state that the same effect reads and sets looped (React
     error 185) when a column was dragged — see finderColumns.stripLayout. */
  useLayoutEffect(() => {
    const e = el.current, p = pad.current; if (!e || !p) return;
    const t = stripLayout(widths, active, e.clientWidth, e.scrollLeft);
    p.style.width = `${t.pad}px`;
    // Strata scrolls to a column it opens; the first layout, and a person who asked for less motion, jump.
    if (placed.current && Math.abs(e.scrollLeft - t.scroll) > 1 && !matchMedia("(prefers-reduced-motion: reduce)").matches) e.scrollTo({ left: t.scroll, behavior: "smooth" });
    else e.scrollLeft = t.scroll;
    placed.current = true;
    // `key` is the widths themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active, page]);
  return (
    <div ref={el} data-strip className="agx-scroll flex-1 min-w-0 min-h-0 flex overflow-x-auto overflow-y-hidden" style={{ scrollSnapType: "x mandatory" }}>
      {children}
      <div ref={pad} aria-hidden className="shrink-0" style={{ width: 0 }} />
    </div>
  );
}

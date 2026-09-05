/*
 * What the floating bench is holding, and where it is.
 *
 * A store rather than component state, for the reason every other cross-view
 * thing in this app has one: the bench is mounted at the shell and is opened
 * from everywhere — a chord, a diff's Open, the viewer's edit toggle, a menu in
 * the tab bar. A component that owned this would make each of those callers
 * reach into it.
 *
 * Three things live here and they have different lifetimes, which is why they
 * are not one blob:
 *
 *   the window    where it sits and how big it is. ONE of these for the app,
 *                 because there is one window — that decision is in the design
 *                 notes: several floating windows is a desktop to tidy, and you
 *                 already have one of those.
 *   the button    where you dragged it to. Kept as a PERCENTAGE of the viewport
 *                 and not in pixels: this machine runs a 1.5 scale on one
 *                 monitor and 1 on the other, and a button remembered in pixels
 *                 comes back off-screen.
 *   the tabs      per CHECKOUT, not per app. Switching worktree switches which
 *                 set you are looking at, and the other set is not closed — it
 *                 is somewhere else, still running, because its tabs are tmux
 *                 sessions on the engine.
 *
 * Nothing here talks to the server. A tab is a description of what should be on
 * screen; the components below it are what connect.
 */

export type BenchTabKind = "term" | "file" | "note" | "web" | "agent";

/**
 * Every file of a checkout shares ONE editor, and this is its session.
 *
 * Not one nvim per file, which is what a viewer does: the buffers accumulate in
 * a single instance, so `:b#` jumps between the two files you are comparing,
 * the jumplist survives you going to the terminal and back, and the second file
 * opens in the time it takes to type `:e` rather than the time it takes to load
 * your plugins. The bench's file tabs are that editor's buffer list.
 *
 * 90 rather than the next free number: it is out of the way of the tabs people
 * open by hand, so a checkout can have eighty-nine shells before this collides
 * — and the server's clamp is 99, so it is a real number and not a sentinel.
 * See BENCH_READER_SLOT on the server; the two must agree.
 */
export const READER_SLOT = 90;

export interface BenchTab {
  /** Stable for the life of the tab, and the React key. */
  id: string;
  kind: BenchTabKind;
  /**
   * Which tmux session on the engine this tab is, 1..99 — its own, never
   * shared. Only the kinds that run something have one: a note is a file on
   * disk and a web tab is a webview, and neither needs a shell.
   */
  slot: number;
  title: string;
  /** file: the path being edited or read, and where to land in it. */
  path?: string;
  line?: number;
  /** file: read-only, which is what a copy of a ref always is. */
  readonly?: boolean;
  /** file: shown in the tab so a copy of a branch cannot be mistaken for the
   *  working tree. */
  ref?: string;
  /** web: the address. */
  url?: string;
  /** agent: which CLI — the label the server's ticket was minted for. */
  agent?: string;
  /** term: text put at the prompt when the session is first created, with the
   *  Enter left to the person reading it. A recipe arrives this way. */
  type?: string;
}

export interface BenchGeom { x: number; y: number; w: number; h: number }

export interface BenchState {
  /** Is the window on screen? Closed means the button is, which is not the same
   *  as nothing running: the tabs are tmux sessions and outlive both. */
  open: boolean;
  /** Bigger, for when the tab is a file rather than a glance at a shell. */
  grown: boolean;
  /**
   * The bench's OWN zoom, 0.6–2.
   *
   * Not the app's. The app's scale is about the whole cockpit — the board, the
   * diff, the rail — and this window is a terminal-sized thing you may want
   * bigger while everything else stays where it is. It is the same reason the
   * image viewer takes the zoom while it is open: when something on screen is a
   * better answer to "zoom", the app stands down (see zoomOwner).
   */
  zoom: number;
  /** Percentages of the viewport, so a window remembered on one screen opens
   *  in the same PLACE on another rather than the same pixel. */
  geom: BenchGeom;
  fab: { x: number; y: number };
  /** Which checkout the bench is pointed at. */
  root: string;
  byRoot: Record<string, { tabs: BenchTab[]; active: string }>;
}

const KEY = "agentglass.bench.v1";

const DEFAULT_GEOM: BenchGeom = { x: 18, y: 14, w: 64, h: 68 };
/** Bottom right, out of the way of the rail on the left and the top bar. */
const DEFAULT_FAB = { x: 96, y: 88 };

const EMPTY: BenchState = {
  open: false, grown: false, zoom: 1, geom: DEFAULT_GEOM, fab: DEFAULT_FAB, root: "", byRoot: {},
};

const listeners = new Set<() => void>();

function read(): BenchState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null") as Partial<BenchState> | null;
    if (!raw || typeof raw !== "object") return EMPTY;
    return {
      ...EMPTY,
      ...raw,
      zoom: clampZoom(raw.zoom ?? 1),
      geom: clampGeom({ ...DEFAULT_GEOM, ...(raw.geom ?? {}) }),
      fab: clampFab({ ...DEFAULT_FAB, ...(raw.fab ?? {}) }),
      byRoot: sane(raw.byRoot),
      /* Never restored as open. The bench is a thing you reach for, and an app
         that starts with a window over the view you asked for is an app that
         decided for you. The tabs are still there the moment you press the
         chord. */
      open: false,
    };
  } catch { return EMPTY; }
}

/** Drop anything that is not a tab we could render. Stored state is data from
 *  a previous version of this file, not a promise. */
function sane(byRoot: unknown): BenchState["byRoot"] {
  const out: BenchState["byRoot"] = {};
  if (!byRoot || typeof byRoot !== "object") return out;
  for (const [root, held] of Object.entries(byRoot as Record<string, unknown>)) {
    const h = held as Record<string, unknown>;
    const kept = Array.isArray(h?.tabs) ? h.tabs.filter(isTab) : [];
    if (!kept.length) continue;
    const chosen = typeof h?.active === "string" && kept.some((t) => t.id === h.active) ? h.active : kept[0]!.id;
    out[root] = { tabs: kept, active: chosen };
  }
  return out;
}

const KINDS: BenchTabKind[] = ["term", "file", "note", "web", "agent"];
function isTab(x: unknown): x is BenchTab {
  const t = x as BenchTab;
  return !!t && typeof t.id === "string" && typeof t.title === "string"
    && KINDS.includes(t.kind) && typeof t.slot === "number";
}

/** Kept inside the window, with enough of it left to grab. A geometry that
 *  came back off-screen would be unreachable — there is no window manager here
 *  to drag it into view. */
export function clampGeom(g: BenchGeom): BenchGeom {
  const w = Math.min(Math.max(g.w, 22), 100);
  const h = Math.min(Math.max(g.h, 18), 100);
  return {
    w, h,
    x: Math.min(Math.max(g.x, 0), 100 - w),
    y: Math.min(Math.max(g.y, 0), 100 - h),
  };
}

/** Small enough that a terminal still has rows, big enough to read across the
 *  room. A stored value from another version is data, not a promise: it is
 *  clamped on the way in as well as on the way out. */
export const clampZoom = (z: number): number =>
  Math.min(Math.max(Number.isFinite(z) ? z : 1, 0.6), 2);

/** The button, likewise — and this one is measured from its own centre, so the
 *  edges keep it fully on screen. */
export function clampFab(f: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.min(Math.max(f.x, 2), 98), y: Math.min(Math.max(f.y, 4), 96) };
}

/*
 * Read LAST, not at the top of the file.
 *
 * `read()` reaches for `KINDS` and the clamps, which are `const` — so calling
 * it above them is a temporal dead zone, and the throw lands in read()'s own
 * catch. Everything then looks fine and behaves as if storage were empty: the
 * bench comes back with no tabs, every time, and nothing anywhere says why.
 * This app has paid for that exact shape once already (see hook-tdz.test.ts);
 * the fix both times is ordering, not a try/catch.
 */
let state: BenchState = read();

function commit(next: BenchState): void {
  state = next;
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* non-fatal */ }
  for (const fn of listeners) fn();
}

export const benchState = (): BenchState => state;
export function subscribeBench(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/* ----------------------------------------------------------------- window */

export const openBench = () => commit({ ...state, open: true });
export const closeBench = () => commit({ ...state, open: false });
export const toggleBench = () => commit({ ...state, open: !state.open });
export const setBenchGrown = (grown: boolean) => commit({ ...state, grown });
export const setBenchZoom = (zoom: number) => commit({ ...state, zoom: clampZoom(zoom) });
/** One rung, in the direction asked for: 0 resets. Steps are multiplicative so
 *  a rung feels the same size at 60% as at 200%. */
export const zoomBench = (dir: -1 | 0 | 1) =>
  setBenchZoom(dir === 0 ? 1 : state.zoom * (dir > 0 ? 1.1 : 1 / 1.1));
export const setBenchGeom = (geom: BenchGeom) => commit({ ...state, geom: clampGeom(geom) });
export const setBenchFab = (fab: { x: number; y: number }) => commit({ ...state, fab: clampFab(fab) });

/** Point the bench at a checkout. The tabs of the one you left are untouched —
 *  they are sessions on the engine, and you will find them there. */
export function setBenchRoot(root: string): void {
  if (!root || root === state.root) return;
  commit({ ...state, root });
}

/* ------------------------------------------------------------------- tabs */

export const tabsFor = (root: string): BenchTab[] => state.byRoot[root]?.tabs ?? [];
export const activeTabId = (root: string): string => state.byRoot[root]?.active ?? "";
export const activeTab = (root: string): BenchTab | null =>
  tabsFor(root).find((t) => t.id === activeTabId(root)) ?? null;

/** Which checkouts have tabs — the menu of what is still running elsewhere. */
export const benchRoots = (): string[] => Object.keys(state.byRoot);

let seq = 0;
const nextId = (): string => `b${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * The smallest session number this checkout is not already using.
 *
 * Smallest rather than next, so closing tab 2 and opening another one reuses 2
 * instead of walking to 99 over a week — and 99 is where the server clamps, so
 * walking there is not free.
 */
export function freeSlot(root: string): number {
  const used = new Set(tabsFor(root).filter((t) => t.slot > 0).map((t) => t.slot));
  // Never the reader's: a shell handed that number would attach to the session
  // holding somebody's editor, and tmux would mirror the two.
  used.add(READER_SLOT);
  for (let n = 1; n <= 99; n++) if (!used.has(n)) return n;
  return 99;
}

export function addTab(root: string, tab: Omit<BenchTab, "id" | "slot"> & { slot?: number }): BenchTab {
  const full: BenchTab = { ...tab, id: nextId(), slot: tab.slot ?? freeSlot(root) };
  const held = state.byRoot[root] ?? { tabs: [], active: "" };
  commit({
    ...state,
    root,
    open: true,
    byRoot: { ...state.byRoot, [root]: { tabs: [...held.tabs, full], active: full.id } },
  });
  return full;
}

export function activateTab(root: string, id: string): void {
  const held = state.byRoot[root];
  if (!held || !held.tabs.some((t) => t.id === id)) return;
  commit({ ...state, byRoot: { ...state.byRoot, [root]: { ...held, active: id } } });
}

/**
 * Forget a tab.
 *
 * FORGET, not kill: what is running lives in tmux, and closing a tab here only
 * stops it being on screen. That is deliberate — the alternative is a × that
 * can end somebody's test run by accident — and the menu of live sessions is
 * how you get back to one you closed.
 */
export function closeTab(root: string, id: string): void {
  const held = state.byRoot[root];
  if (!held) return;
  const tabs = held.tabs.filter((t) => t.id !== id);
  const byRoot = { ...state.byRoot };
  if (tabs.length) {
    const at = held.tabs.findIndex((t) => t.id === id);
    const active = held.active === id ? (tabs[Math.min(at, tabs.length - 1)]!.id) : held.active;
    byRoot[root] = { tabs, active };
  } else {
    delete byRoot[root];
  }
  commit({ ...state, byRoot });
}

/** Where a web tab is pointed. In the store because minimising unmounts the
 *  window, and a URL kept in the component goes with it. */
export function setTabUrl(root: string, id: string, url: string): void {
  const held = state.byRoot[root];
  if (!held) return;
  const tabs = held.tabs.map((t) => (t.id === id ? { ...t, url } : t));
  commit({ ...state, byRoot: { ...state.byRoot, [root]: { ...held, tabs } } });
}

export function renameTab(root: string, id: string, title: string): void {
  const held = state.byRoot[root];
  if (!held) return;
  const tabs = held.tabs.map((t) => (t.id === id ? { ...t, title } : t));
  commit({ ...state, byRoot: { ...state.byRoot, [root]: { ...held, tabs } } });
}

/**
 * Show this file in the bench.
 *
 * The one entry point for every surface that used to open its own editor — the
 * viewer's edit toggle, a pull request's Open, the file tree. Same path twice
 * is the SAME tab: opening `services.py` from the diff and then from the
 * palette should land you where you already were, at the new line, rather than
 * leaving two tabs with one name.
 */
export function showFile(root: string, path: string, o: { line?: number; readonly?: boolean; ref?: string; title?: string } = {}): BenchTab {
  const held = state.byRoot[root];
  const same = held?.tabs.find((t) => t.kind === "file" && t.path === path && t.ref === o.ref);
  if (same) {
    const tabs = held!.tabs.map((t) => (t.id === same.id ? { ...t, line: o.line ?? t.line } : t));
    commit({ ...state, root, open: true, byRoot: { ...state.byRoot, [root]: { tabs, active: same.id } } });
    return { ...same, line: o.line ?? same.line };
  }
  return addTab(root, {
    kind: "file",
    slot: READER_SLOT,
    title: o.title ?? path.split("/").pop() ?? "file",
    path, line: o.line, readonly: o.readonly, ref: o.ref,
  });
}

/** Test seam: forget everything, including what is in localStorage. */
export function __resetBench(): void {
  try { localStorage.removeItem(KEY); } catch { /* non-fatal */ }
  state = EMPTY;
  for (const fn of listeners) fn();
}

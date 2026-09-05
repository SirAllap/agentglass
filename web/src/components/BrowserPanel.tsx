// Pages, inside the app.
//
// These are Electron `<webview>`s rather than the newer `WebContentsView`, and
// the reason is this app's layout rather than a preference. A WebContentsView is
// a main-process rectangle positioned in *window* coordinates: it floats over
// the DOM. The workspace is a rounded overlay whose views all stay mounted and
// merely flip visibility, so a WebContentsView would sit on top of the frame,
// cover every menu and dialog the app opens, and need its bounds recomputed by
// hand on every resize and every view switch. A `<webview>` is a DOM element —
// it lays out, clips and hides like anything else, and the existing model just
// works.
//
// The guests are given nothing: no preload, no Node, their own session. That is
// enforced in the main process (`guardWebviews`), not here — attributes in this
// markup are a request, and `will-attach-webview` is the answer.
//
// EVERY tab stays mounted and only the active one is visible. Same rule as the
// workspace's views and for the same reason: a page unmounted when you look
// away is a page that reloads when you come back, losing its scroll, its form,
// and whatever an agent was doing on it. `visibility`, never `display:none` —
// a display:none ancestor measures 0x0, and a guest resized to nothing comes
// back reflowed to a single column.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CloseButton } from "./CloseButton.tsx";
import { Portal } from "./Portal.tsx";
import { ContextMenu, MenuItem } from "./ContextMenu.tsx";
import { BROWSER_PARTITION, HAS_BROWSER, IS_DESKTOP, browserDevtools, browserDevtoolsClose, browserDevtoolsRect, browserDevtoolsZoom, browserCdp, browserZoom, browserShelfRead, captureFullPage, cookieSources, onDevtoolsZoom, onBrowserZoom, onBrowserOpenTab, onBrowserKey, onBrowserSearch, onBrowserInspect, setActiveBrowserGuest } from "../lib/desktop.ts";
import { buildSearchUrl, displayUrl, normalizeNavigationUrl } from "../lib/browserUrl.ts";
import { BLANK, homePage, searchEngine, zoomLevel, setZoomLevel as saveZoom, zoomPercent, stepZoom, ZOOM_MIN, ZOOM_MAX, devtoolsSide, setDevtoolsSide, devtoolsSize, setDevtoolsSize, devtoolsZoom, setDevtoolsZoom, sidebarOpen, setSidebarOpen, sidebarWidth, setSidebarWidth, type DevtoolsSide } from "../lib/browserPrefs.ts";
import { addTab, closeTab, listable, newTab, patchTab, pruneBlank, sleepingTab, stepTab, tabLabel, wake, type BrowserTab } from "../lib/browserTabs.ts";
import { dropsBefore, isDrag, parseDrop, type DropAt } from "../lib/browserDrag.ts";
import {
  MAX_ESSENTIALS, allItems, emptyShelf, findByUrl, folderCount, insertFolder, place, readShelves, removeItem, saveShelves,
  shelfFor, shelfItem, shelfFolder, toggleFolder, addFolder, removeFolder, renameFolder, sameUrl, withShelf, allFolders, canNest,
  boundItem, looseTabs as looseOf, tabForItem, retarget,
  mergeImported, type ImportedShelf,
  type Shelf, type ShelfFolder, type ShelfItem, type ShelfSpot,
} from "../lib/browserShelf.ts";
import { forgetProfileTabs, readSession, saveSession, setFor } from "../lib/browserSession.ts";
import {
  addProfile, loadProfiles, partitionFor, profileHue, profileName, removeProfile, saveProfiles,
  type BrowserProfile,
} from "../lib/browserProfiles.ts";
import { VIEWPORTS, type Viewport } from "../lib/browserViewport.ts";
import { browserNav, clearBrowserNav, subscribeBrowserNav } from "../lib/browserNav.ts";
import { clientId, serveBrowserAsk, setBrowserAskHandler } from "../lib/browserBus.ts";
import { api } from "../lib/api.ts";
import { forgetAgentZoom, reapplyZoom, applyGuestZoom, setPageZoomer, crossContainerRefusal, mintTakesThePane, type GuestZoom, type DrivableWebview } from "../lib/browserDrive.ts";
import { onBrowserTabs } from "../lib/browserBus.ts";
import { COLLECTOR } from "../lib/browserObserve.ts";
import { PagePicker } from "./browser/PagePicker.tsx";
import { Shooter } from "./browser/Shooter.tsx";
import { MarkupLayer } from "./browser/MarkupLayer.tsx";
import { DemoPage } from "./browser/DemoPage.tsx";
import { IS_DEMO } from "../lib/demo.ts";
import { DEMO_BROWSER_TABS } from "../lib/demoBrowser.ts";
import { ICON } from "../lib/iconSize.ts";
import { openSettings } from "../lib/openSettings.ts";
import { registerClaim } from "../lib/findScope.ts";
import { anyOverlayOpen, subscribeOverlays } from "../lib/overlays.ts";
import { suggest, type Suggestion } from "../lib/suggest.ts";
import {
  BackIcon, BlankPageIcon, CloseIcon, CodeIcon, ExternalIcon, ForwardIcon, GlobeIcon,
  HomeIcon, LockIcon, MoreIcon, NoteIcon, PenIcon, ReloadIcon, SearchIcon,
  SpinnerIcon, StopIcon, TargetIcon, FolderIcon, ContainerIcon, SpaceIcon, CameraIcon, PanelIcon, UpIcon, DownIcon, SplitIcon,
} from "./browser/icons.tsx";

/** Electron's `<webview>` is not in React's JSX catalogue, and its methods are
 *  not on HTMLElement. Narrowed to the handful actually called here rather than
 *  cast to `any`, so a typo is still a type error. */
export type WebviewEl = HTMLElement & {
  src: string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  reloadIgnoringCache(): void;
  stop(): void;
  getURL(): string;
  setZoomLevel(level: number): void;
  getZoomLevel(): number;
  loadURL(url: string): Promise<void>;
  getTitle(): string;
  executeJavaScript(code: string): Promise<unknown>;
  capturePage(rect?: { x: number; y: number; width: number; height: number }): Promise<{ toDataURL(): string }>;
  openDevTools(): void;
  closeDevTools(): void;
  isDevToolsOpened(): boolean;
  getWebContentsId(): number;
  findInPage(text: string, opts?: { forward?: boolean; findNext?: boolean; matchCase?: boolean; wordStart?: boolean }): number;
  stopFindInPage(action: "clearSelection" | "keepSelection" | "activateSelection"): void;
};

/* -------------------------------------------------------------- small parts */

/** A toolbar control. Square, quiet, and the same size as its neighbours — the
 *  old bar mixed glyph widths and read as a row of unrelated marks rather than
 *  as a toolbar. */
/** The same control at the width a 228px column can afford. `Tool` is 30px and
 *  eight of those do not fit; the target stays square and stays above the icon
 *  floor. */
function SideTool({ on, label, onClick, disabled, children }: {
  label: string; onClick: () => void; disabled?: boolean; on?: boolean; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} disabled={disabled} title={label} aria-label={label}
      className="agx-btn shrink-0 rounded-md flex items-center justify-center disabled:opacity-25"
      style={{
        width: 24, height: 24,
        color: on ? "var(--primary-hover)" : "var(--text2)",
        background: on ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent",
      }}>{children}</button>
  );
}

export function Tool({ on, label, onClick, disabled, tint, children }: {
  label: string; onClick: () => void; disabled?: boolean; on?: boolean; tint?: string;
  children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} disabled={disabled} title={label} aria-label={label}
      className="agx-btn shrink-0 rounded-md flex items-center justify-center disabled:opacity-25"
      style={{
        width: 30, height: 30,
        color: tint ?? (on ? "var(--primary-hover)" : "var(--text2)"),
        background: on ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent",
      }}>{children}</button>
  );
}

/** The site's own icon, or a mark in its place. Falls back on error rather than
 *  leaving a broken-image glyph in the strip. */
function Favicon({ src }: { src: string | null }) {
  const [bad, setBad] = useState(false);
  useEffect(() => { setBad(false); }, [src]);
  if (!src || bad) return <span className="shrink-0 opacity-40 flex items-center"><GlobeIcon size={13} /></span>;
  return <img src={src} alt="" onError={() => setBad(true)}
    className="shrink-0 rounded-[2px]" style={{ width: 14, height: 14, objectFit: "contain" }} />;
}

/* -------------------------------------------------------------------- view */

/**
 * The workspace hands every view an `active`, and this one uses it for exactly
 * one thing: taking the shell's find chord while it is the view on screen.
 *
 * Nothing else here needs it — there is nothing to poll, and a page must keep
 * running while you are looking at something else, which is the point of the
 * views staying mounted.
 */
/**
 * Test seam: pretend the shell has a browser.
 *
 * `HAS_BROWSER` is read once, at import, from the bridge the preload injects —
 * which is right in the app and untestable outside it, because by the time a
 * test can set a fake bridge the module has usually been imported by something
 * else in the same process and the constant is already false. Same shape as
 * `__setShotDir` and `__resetTabIds` elsewhere: a door only the suite opens.
 */
let forced = false;
export function __forceBrowser(on: boolean): void { forced = on; }

/**
 * Test seam: render the first tab of a fresh session awake.
 *
 * The suite renders to a string, so the effect that wakes the front tab on
 * first look (`viewOn && activeId` below) never fires — there is no other way
 * to get an awake `<webview>` on a first paint to check what it renders.
 */
let wakeFirst = false;
export function __wakeFirstTab(on: boolean): void { wakeFirst = on; }

/**
 * The width of the close cell in a container row — the button, and the empty
 * cell that holds its place when a container cannot be closed.
 *
 * ONE number for both on purpose. They have to be the same width or the chips
 * do not line up, and the placeholder is the one that is always drawn: a test
 * of the first paint can only measure that one, so tying the button to it is
 * what puts the button's size under the same lock. Twenty is the house minimum
 * for an icon-only control — "the icons come out ridiculously small for me".
 */
const CLOSE_CELL = 20;

export function BrowserView({ active: viewOn, scope }: {
  active: boolean;
  /**
   * Which copy of the browser this is.
   *
   * Empty (the default) is THE browser view. The floating bench mounts a second
   * one, and the two are different sets of pages: closing a tab in one must not
   * close it in the other, and the strips are saved under their own keys
   * (browserSession.keyFor). Everything else — the profiles, the cookies, the
   * history, the bookmarks — is deliberately shared, because it is the same
   * browser and the same person.
   */
  scope?: string;
}) {
  // Only the *first* page is read at mount. Everything else asks
  // `browserPrefs` at the moment it needs an answer, because this view is
  // mounted once for the life of the app: a home page cached here would ignore
  // every change made in settings until a restart.
  /*
   * Last session's tabs, or the home page.
   *
   * Restored ASLEEP except the one you were looking at: an asleep tab is a
   * name, an icon and an address in the strip and nothing else until it is
   * selected. Twelve live Chromium guests at launch is the cost MAX_TABS
   * exists to bound, and paying it for pages nobody has asked for yet is the
   * version of this feature that makes the app slow to start.
   */
  /*
   * Which profile's tabs are on screen.
   *
   * A profile is a set of pages, not a badge on one: switching swaps the whole
   * strip. Seeded from the session so the app opens where it was left, and
   * validated on the way in — this string decides which cookie jar every page
   * in the strip loads with.
   */
  const [profile, setProfile] = useState<string>(() => readSession(scope)?.current ?? "");
  const [tabs, setTabs] = useState<BrowserTab[]>(() => {
    // The demo opens with its own strip rather than whatever a previous visit
    // left in localStorage: a saved single blank tab would show the empty-state
    // card, which is exactly the dead panel this exists to stop being.
    if (IS_DEMO) return DEMO_BROWSER_TABS.map((t, i) => {
      const tab = sleepingTab(t.url, t.title, null, "");
      return i === 0 ? { ...tab, asleep: false } : tab;
    });
    const saved = readSession(scope);
    const set = setFor(saved, saved?.current ?? "");
    /*
     * No session yet — a fresh install, or a profile that has never opened this
     * browser. Asleep like every other restored tab (see below): a real
     * renderer profile with the debug port found a `<webview>` at about:blank
     * on every idle desktop session, and this was why — a live Chromium guest
     * mounted at launch and pointed at the home page, whether or not anybody
     * had looked at the browser view yet. The home page itself normally loads
     * fine; it read as about:blank because the guest that measured it had no
     * network route out.
     */
    if (!set) {
      const t = sleepingTab(homePage(), "", null, saved?.current ?? "");
      return [wakeFirst ? { ...t, asleep: false } : t];
    }
    // The one in front keeps its remembered name too, and only its `asleep`
    // differs. Built with `newTab` it came back nameless and the strip read
    // "New tab" until the page loaded, which is a flicker on every launch.
    /*
     * Everything asleep, even the one that was in front.
     *
     * This panel is now mounted from launch whether or not anybody goes to it
     * (see KEEP_RUNNING), and waking a tab here would put a Chromium guest in
     * every session that never opens the browser. The one in front wakes the
     * moment the view is looked at — or the moment an agent asks for it, which
     * is the other way this panel comes to life.
     */
    /*
     * EVERY PROFILE'S PAGES COME BACK, not only the one on screen.
     *
     * Restoring the current profile alone was right while a profile was a
     * place a person works in and only one of them existed at a time. It is
     * wrong now that agents each have one: an agent's tabs simply vanished at
     * launch, so "I restart the application and they lose all their work" was
     * literally true, and the agent's next call found nothing to address and
     * fell through to whatever was in front.
     *
     * It costs nothing. A restored tab is a name, an icon and an address with
     * no guest behind it — that is what `sleepingTab` is — so bringing back
     * forty of them is forty rows in an array. The strip shows the profile you
     * are in; the rest are addressable and invisible, which is exactly what an
     * agent's tab should be.
     */
    const here = saved?.current ?? "";
    const mine = set.tabs.map((t) => sleepingTab(t.url, t.title, t.icon, here));
    /*
     * A CONTAINER THAT NO LONGER EXISTS BRINGS NOTHING BACK.
     *
     * Dropping a container forgets its pages, and closing its last page takes
     * its entry out — but a file written before either of those existed still
     * holds them, and every launch restored the lot. Measured on the real app:
     * fifty containers that had been dropped hours earlier, sixty-four pages,
     * and `newtab` refusing with "64 pages is the limit" on a browser whose
     * owner had fourteen pages open.
     *
     * The names are the authority, not the tab file: an id that is not in the
     * container list is an identity nothing can reach — no menu, no strip, no
     * `--as`. Restoring pages into it is restoring them nowhere.
     */
    const known = new Set(loadProfiles(globalThis.localStorage ?? null).map((p) => p.id));
    const theirs = Object.entries(saved?.byProfile ?? {})
      .filter(([id]) => id !== here && (!id || known.has(id)))
      .flatMap(([id, s]) => s.tabs.map((t) => sleepingTab(t.url, t.title, t.icon, id)));
    /* And the file is told, once, rather than left to be re-read every launch. */
    for (const id of Object.keys(saved?.byProfile ?? {})) {
      if (id && id !== here && !known.has(id)) forgetProfileTabs(id);
    }
    return [...mine, ...theirs];
  });
  const [activeId, setActiveId] = useState("");

  /*
   * THE TABS, made addressable by an agent.
   *
   * "Tabs belong to the browser's UI; the CLI I drive has no verb for
   * switching tab, and `open` replaces the current view — so I move the
   * agent's side outside the browser." The tabs were here the whole time and
   * nothing could reach them; an agent comparing two pages had to choose
   * between losing the first and leaving the browser.
   *
   * Registered rather than imported by the bus, so the bus never depends on
   * the panel. Refs rather than the state values, because this closure is
   * installed once and the ops must see the CURRENT tabs, not the ones that
   * existed when it was registered — the mistake that would make `tabs`
   * answer with a list from ten minutes ago.
   */

  const els = useRef(new Map<string, WebviewEl>());
  const [menuOpen, setMenuOpen] = useState(false);
  /* Browsing identities. Held here rather than in a store: the list is a few
     names, it is read by one view, and it is written by one menu. */
  const [profiles, setProfiles] = useState<BrowserProfile[]>(() => loadProfiles(globalThis.localStorage ?? null));
  /*
   * Which spaces are folded shut.
   *
   * Ten agents is ten folders and forty pages, which is longer than the bar —
   * so a space folds, and stays folded across restarts, because the one you
   * are not watching is the one you want out of the way tomorrow too.
   */
  const [folded, setFolded] = useState<Set<string>>(() => {
    try {
      const raw = globalThis.localStorage?.getItem("agx_browser_folded_spaces");
      const doc: unknown = raw ? JSON.parse(raw) : null;
      return new Set(Array.isArray(doc) ? doc.filter((x): x is string => typeof x === "string") : []);
    } catch { return new Set(); }
  });
  const foldSpace = useCallback((id: string) => {
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { globalThis.localStorage?.setItem("agx_browser_folded_spaces", JSON.stringify([...next])); } catch { /* private mode */ }
      return next;
    });
  }, []);
  const [naming, setNaming] = useState<string | null>(null);
  const [find, setFind] = useState<string | null>(null);
  /** How the search is run, and what it found. `found` comes from the guest's
   *  own `found-in-page`, which is the only thing that knows. */
  const [findOpts, setFindOpts] = useState({ matchCase: false, wholeWords: false });
  const [found, setFound] = useState<{ at: number; of: number } | null>(null);
  const findRef = useRef<HTMLInputElement | null>(null);
  const [viewport, setViewport] = useState<Viewport>(VIEWPORTS[0]!);
  /*
   * Everywhere your own browser has been.
   *
   * Loaded once and held: this is fifteen thousand rows on a real machine, and
   * the ranking runs on every keystroke. A fetch per keystroke would be a
   * network round trip in the path of typing, and a SQLite query per keystroke
   * would be a synchronous read in the same place.
   */
  const [places, setPlaces] = useState<Suggestion[] | null>(null);
  const [hint, setHint] = useState(-1);
  useEffect(() => {
    api.browserPlaces().then((r) => setPlaces((r.places ?? []) as unknown as Suggestion[])).catch(() => setPlaces([]));
  }, []);
  /** Which agent-facing mode is up, if any. They are exclusive: pointing at an
   *  element and drawing over the page both want the same clicks. */
  const [mode, setMode] = useState<"none" | "pick" | "feedback" | "draw" | "shoot">("none");
  /** What mode is on, for the window-wide Escape — that listener is registered
   *  once per view switch and would otherwise hold the first render's answer. */
  const modeRef = useRef<"none" | "pick" | "feedback" | "draw" | "shoot">("none");

  // The first tab's id is minted inside the state initialiser, so it is adopted
  // here rather than minted twice. With a restored session the one to adopt is
  // the one that was in front, which is the only tab that came back awake.
  /*
   * THE STRIP IS A VIEW OF THE TABS, NOT ALL OF THEM.
   *
   * Every open page lives in one list whatever profile it belongs to, and the
   * strip shows the profile you are in. That is what lets an agent's tab be
   * addressable — `--page t7-…` finds it, wakes it and drives it — while
   * staying out of the way of whoever is looking at the window. The old shape
   * swapped the whole list on a profile switch, which meant another agent's
   * pages stopped existing the moment a person changed identity.
   */
  /** The tabs of the profile on screen — for deciding which one to land on,
   *  not for deciding which ones exist. See the guest list further down. */
  const strip = useMemo(() => tabs.filter((t) => (t.profile || "") === profile), [tabs, profile]);

  useEffect(() => {
    if (activeId) return;
    const first = strip.find((t) => !t.asleep) ?? strip[0];
    if (first) setActiveId(first.id);
  }, [activeId, strip]);

  /*
   * Write the strip down whenever it changes.
   *
   * Debounced, because `tabs` also changes on every title, favicon and loading
   * flag a guest reports — a page that streams updates would otherwise write
   * to localStorage a hundred times while it loads. Half a second is far below
   * the time it takes to close a window and far above the noise.
   */
  useEffect(() => {
    const t = setTimeout(() => saveSession(profile, tabs, activeId, scope), 500);
    return () => clearTimeout(t);
  }, [profile, tabs, activeId]);

  /* And once more on the way out, because the debounce above may never fire:
     closing the window is exactly the moment nothing gets half a second. */
  useEffect(() => {
    const flush = () => saveSession(profile, tabs, activeId, scope);
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, [profile, tabs, activeId]);

  /** Selecting a tab is what opens it: everything that changes the selection
   *  goes through here so a sleeping tab cannot be shown without a guest. */
  const show = useCallback((id: string) => {
    setTabs((ts) => wake(ts, id));
    setActiveId(id);
    /*
     * THE SPACE FOLLOWS THE PAGE.
     *
     * With the strip of spaces gone from the foot of the bar, the only way to
     * say "I am in this one" is to be on one of its pages — so landing on a
     * page moves you into its space, and the next Ctrl+T opens there.
     *
     * NOT `switchTo`: that one lets go of the guests of the space it leaves and
     * rebuilds the list from disk, which mints new ids. Agents address tabs by
     * id, so a click of ours must not renumber their work. This changes which
     * space is current and nothing else.
     */
    const landed = tabsRef.current.find((t) => t.id === id);
    if (landed) setProfile(landed.profile || "");
  }, []);

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const el = useCallback(() => (active ? els.current.get(active.id) ?? null : null), [active]);

  // What the page is at, and what is in the bar, are two different facts: while
  // you are typing, the page has not moved. `typed` being null means "not
  // editing", so navigation is free to update the display.
  const [typed, setTyped] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** Where the link under the pointer goes. Empty whenever nothing is under it
   *  — the bubble is not drawn at all then, the way a browser's is not. */
  const [hover, setHover] = useState("");
  /*
   * The inspector, as a pane of this window.
   *
   * A `<webview>` guest has no window of its own, so Electron's docking modes
   * all collapse to "detached" and DevTools came up floating over the app —
   * with its content not filling its own frame on a fractionally scaled
   * display. So the guest is pointed at a SECOND guest, and that one is laid
   * out here like any other pane. `at` carries where "Inspect" was clicked.
   */
  /*
   * The shelf: what this space keeps between sessions.
   *
   * Read once and written on every change rather than kept in sync with disk on
   * a timer — it is small, it changes when a hand moves it, and a drag that is
   * lost because the app closed a second later is the kind of thing nobody ever
   * reports and everybody notices.
   */
  const [shelves, setShelves] = useState(() => readShelves());
  const shelf = shelfFor(shelves, profile);
  const editShelf = useCallback((fn: (s: Shelf) => Shelf) => {
    setShelves((all) => {
      const next = withShelf(all, profile, fn(shelfFor(all, profile)));
      saveShelves(next);
      return next;
    });
  }, [profile]);

  /** The address box, when it is open: over the page for a new tab, anchored to
   *  the bar when it is this page's address being edited. */
  const [omni, setOmni] = useState<null | "new" | "edit">(null);
  /** The address as it is RIGHT NOW, for the shell's Ctrl+L — that subscription
   *  is registered once, and a closure over `active` would open the box on
   *  whatever page was up when the panel mounted. */
  const urlNow = useRef("");
  /** The bar itself, and how wide. Hidden, it leaves a hot edge that brings it
   *  back floating — see the sidebar's markup. */
  const [sideOpen, setSideOpen] = useState(() => sidebarOpen());
  const [sideW, setSideW] = useState(() => sidebarWidth());
  const [peek, setPeek] = useState(false);
  /** Which folder is being renamed, and what it says so far. */
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  /** What is being dragged, and what is under it. A shelf item by id, or a tab
   *  by id — a tab dropped on the shelf is a tab being kept. */
  /** The right-click menu: where, on what. Dragging is the fast way to arrange
   *  the shelf and it is also the undiscoverable one — every move it can make is
   *  in here as a sentence. */
  const [menuAt, setMenuAt] = useState<{ x: number; y: number; kind: "tab" | "item" | "folder" | "bar" | "space"; id: string } | null>(null);
  /**
   * The page in hand, while it is in hand.
   *
   * Pointer events rather than the HTML5 drag API. The first version used
   * `draggable` + `dragstart`: the attribute rendered, every handler was wired,
   * and in the running app nothing happened at all — twice. Every other handle
   * in this app is pointer-driven; this one is now too, and the part that
   * decides what a position MEANS lives in lib/browserDrag.ts, where it can be
   * tested without a window.
   */
  const [carry, setCarry] = useState<
    { kind: "item" | "tab"; id: string; label: string; x: number; y: number; at: DropAt | null } | null
  >(null);
  /** A drag just ended, so the click that follows it is not a click. */
  const dragged = useRef(false);
  /**
   * What you have closed, newest first.
   *
   * Ctrl+Shift+T walks it, the way every browser does — one press per tab, back
   * through the session. In memory rather than on disk: this is an undo for the
   * last few minutes, and a list of pages somebody closed is not something to
   * write down and keep.
   */
  const closed = useRef<{ url: string; title: string; icon: string | null; profile: string }[]>([]);
  /** The tabs as they are right now, for callbacks that must not be rebuilt
   *  every time the list changes — `close` is passed to a dozen rows. Assigned
   *  during render rather than in an effect: a callback that fires before the
   *  effect has run would read the list from the render before last. */
  const tabsRef = useRef<BrowserTab[]>([]);
  tabsRef.current = tabs;
  /** §9: the same trick for the profile list, which the tab verbs read to
   *  answer `profiles` and to refuse a `newtab` into one that does not exist. */
  const profilesRef = useRef<BrowserProfile[]>([]);
  profilesRef.current = profiles;
  /** §12: did the ask now being served say `--show`? Written by the ask handler
   *  one statement before `TabOps.open` reads it — see the note there for why a
   *  ref is safe here and an argument was not available. */
  const mintShow = useRef(false);
  /** The same trick for the two other things a keyboard callback has to read
   *  fresh: which tab is in front, and what is on the shelf. */
  const activeIdRef = useRef("");
  const shelfRef = useRef(emptyShelf());
  /** …and the two keyboard actions themselves, because the window listener is
   *  registered once per view switch and would otherwise be holding the first
   *  render's copy of them for the rest of the session. */
  const reopenRef = useRef<() => void>(() => {});
  const closeHereRef = useRef<() => void>(() => {});
  const stepTabRef = useRef<(forward: boolean) => void>(() => {});
  const elRef = useRef<() => WebviewEl | null>(() => null);
  /** Another browser's sidebar, read and waiting to be taken. Shown before it
   *  lands, because an import that just happens is an import nobody can check. */
  const [bringing, setBringing] = useState<{ label: string; shelf: ImportedShelf; space: string } | null>(null);
    /** A folded folder showing its contents under the pointer, and where to draw
   *  them — the one thing in the mockup that the first pass left out. */
  const [peep, setPeep] = useState<{ id: string; top: number; right: number } | null>(null);

  /* `tabsRef` and `activeIdRef` are declared further down for the keyboard
     callbacks and kept fresh during render, which is exactly what these ops
     need: installed once, they must read the CURRENT tabs rather than the
     ones that existed when they were registered. */
  useEffect(() => onBrowserTabs({
    list: () => tabsRef.current.map((t) => ({
      id: t.id, title: tabLabel(t), url: t.url, active: t.id === activeIdRef.current,
      /* §9: which isolated context this tab is in. Two tabs in different
         profiles are two different people — the thing tabs alone cannot be,
         because tabs share a session. */
      /* The NAME, and `default` said out loud. An empty string reads as "not
         set" when it means "the shared space every other agent is also in" —
         the single most consequential value in this answer and the least
         visible one. */
      profile: t.profile ? profileName(profilesRef.current, t.profile) : "default",
    })),
    profiles: () => profilesRef.current.map((p) => p.name),
    /* An agent makes its OWN container and drops it when the work is done.
       Never one a person is using, never one another agent made: two agents
       sharing a container share a login, and the second to act changes what
       the first is looking at. */
    makeProfile: (name) => {
      const r = addProfile(profilesRef.current, name);
      if ("error" in r) return { error: r.error };
      /*
       * THE REF MOVES NOW, not at the next render.
       *
       * `profilesRef.current = profiles` runs while rendering, and two agents
       * — or one agent making two containers in a row — arrive faster than
       * React re-renders. So the second call read the list from before the
       * first one existed and WROTE it back plus its own: the first container
       * was gone, from the list and from disk. Measured with three in a row:
       * localStorage held the second and the third, never the first.
       */
      profilesRef.current = r.profiles;
      setProfiles(r.profiles);
      saveProfiles(globalThis.localStorage ?? null, r.profiles);
      return { id: r.profile.id, name: r.profile.name };
    },
    dropProfile: (name) => {
      const found = profilesRef.current.find((p) => p.name === name || p.id === name);
      /* The default one is the person's. An agent may not throw it away, and
         asking to is a mistake worth naming rather than a no-op. */
      if (!found || !found.id) return false;
      forgetProfile(found.id);
      return true;
    },
    select: ({ index, id }) => {
      const t = id ? tabsRef.current.find((x) => x.id === id) : tabsRef.current[index ?? -1];
      if (!t) return false;
      setActiveId(t.id);
      /* A tab that was put to sleep has no live view behind it, so selecting
         one has to wake it or the next verb talks to nothing. */
      setTabs((cur) => wake(cur, t.id));
      return true;
    },
    open: (url, wanted) => {
      /* A profile named for the first time is MINTED, not refused — an agent
         saying `--as agent` should not have to stop and ask a human to click
         "add profile" first, and that ask was the 40-minute cost spec §7
         measured. `addProfile` still enforces its own limit and name
         collisions, so a wanted name that cannot be minted (menu full, name
         taken by something case-different) still fails rather than silently
         swapping in the current profile — "it opened, in the wrong identity"
         is the failure that costs an afternoon precisely because nothing
         about the answer says so. */
      let known = profilesRef.current;
      /*
       * THE TAB CARRIES THE ID, NOT THE NAME IT WAS ASKED FOR BY.
       *
       * It carried the name, and a name is not an id — ids are slugged,
       * names keep their dashes. `partitionFor` did not recognise it and
       * handed back the base partition, which is the person's own cookies. So
       * `newtab --profile review-pr-540` opened a tab LABELLED
       * review-pr-540 whose requests carried the default session. Nothing
       * failed; `tabs` reported the isolated identity it had been asked for.
       */
      let id = wanted ? known.find((p) => p.name === wanted || p.id === wanted)?.id : undefined;
      if (wanted && !id) {
        const r = addProfile(known, wanted);
        if ("error" in r) return { error: `${r.error} — pick another name for the container, or use one from \`profiles\`` };
        known = r.profiles;
        profilesRef.current = known;
        setProfiles(known);
        saveProfiles(globalThis.localStorage ?? null, known);
        id = r.profile.id;
      }
      const made = addTab(tabsRef.current, url, activeIdRef.current, id ?? profile, undefined);
      /* The reason travels. It used to be dropped here and the caller was told
         "could not open a tab" — with the panel holding a sentence that says
         exactly what to do about it. */
      if ("error" in made) return { error: made.error };
      setTabs(made.tabs);
      /*
       * §12: THIS USED TO BE AN UNCONDITIONAL `setActiveId(made.tab.id)`.
       *
       * Every `newtab`, and every `open` that minted, became the globally
       * active tab — so an agent's routine work moved what the person was
       * looking at, and re-aimed every other agent's un-addressed verb at it.
       * "You have to work in the background, inside your container."
       *
       * The tab is still born AWAKE (see `addTab`: `newTab` sets no `asleep`),
       * and the render below draws every non-sleeping tab as a real `<webview>`
       * hidden with `visibility`, never `display:none` — so a background mint
       * has a live guest immediately and its first `read` or `shot` costs no
       * wake-up. Background is not asleep, and that distinction is the reason
       * this could be done at all.
       */
      if (mintTakesThePane({ existing: tabsRef.current.length, show: mintShow.current })) {
        setActiveId(made.tab.id);
      }
      return { id: made.tab.id };
    },
    close: ({ index, id }) => {
      const t = id ? tabsRef.current.find((x) => x.id === id) : tabsRef.current[index ?? -1];
      if (!t) return false;
      const next = closeTab(tabsRef.current, t.id);
      els.current.delete(t.id);
      /* The same rule as the × on a row — see `close`. An agent closing its
         last page is the COMMON case for this one, and without it that
         container's set sat in the file and came back at the next launch. The
         two paths are one line apart and drifted; measured, it was this one
         that kept 47 pages alive across four restarts. */
      const gone = t.profile || "";
      if (gone && !next.tabs.some((x) => (x.profile || "") === gone)) forgetProfileTabs(gone);
      setTabs(next.tabs);
      setActiveId(next.activeId);
      return true;
    },
  }), [profile]);

  /**
   * A second page beside the first.
   *
   * Zen's "New Split", and the one entry of its menu this app did not have. Two
   * guests, side by side, sharing the width — a diff and its ticket, a doc and
   * the thing it documents. The BAR belongs to the primary one: an address box
   * that changes which page it means depending on where you last clicked is a
   * box you cannot trust. Swapping is a button, and it is one press.
   */
  const [splitId, setSplitId] = useState<string | null>(null);
  /** How the width is shared. Not persisted: which pair is up decides what the
   *  right split is, and yesterday's number is not it. */
  const [splitAt, setSplitAt] = useState(0.5);

  const [dt, setDt] = useState<{ tab: string; at?: { x: number; y: number } } | null>(null);
  /** The guest whose inspector is open, by WebContents id — what the shell
   *  needs to name it, and what has to survive the pane being resized. */
  const [dtGuest, setDtGuest] = useState(0);
  /** The hole the inspector floats over. It is a plain div: the DevTools are a
   *  view the shell owns (see browserDevtools), and all this side does is leave
   *  room and say where the room is. */
  const dtBox = useRef<HTMLDivElement | null>(null);
  /** The inspector's own zoom, on the same ladder as the page's. Its own, and
   *  that is the point: DevTools at a readable size does not mean the site at a
   *  readable size, and it certainly does not mean the app. */
  const [dtZoom, setDtZoom] = useState(() => devtoolsZoom());
  const [dtSide, setDtSide] = useState<DevtoolsSide>(() => devtoolsSide());
  const [dtSize, setDtSize] = useState(() => devtoolsSize(devtoolsSide()));
  /** Electron's logarithmic zoom level, mirrored here only so the chip can show
   *  it. The guest is the one that actually holds it. */
  const [zoom, setZoom] = useState(zoomLevel);
  /* Read by the registered zoomer, which is created once: a closure over
     `zoom` would step from whatever the level was when the panel mounted. */
  const zoomRef = useRef(zoom);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);

  const say = useCallback((msg: string) => {
    setNote(msg);
    setTimeout(() => setNote((n) => (n === msg ? null : n)), 3600);
  }, []);

  const patch = useCallback((id: string, p: Partial<BrowserTab>) => {
    setTabs((prev) => patchTab(prev, id, p));
  }, []);

  /*
   * Zoom, kept in three places that must not drift.
   *
   * The GUEST holds it (Chromium's own zoom, so text reflows the way it does in
   * a browser rather than being scaled like an image). The SHELL applies the
   * Ctrl+wheel gesture, because that gesture happens inside the guest's own
   * process and never reaches this panel. And this remembers it, because a
   * level that resets on every launch is no use to the person who needed it.
   */

  /*
   * Tell the shell which guest is on screen.
   *
   * The main process holds one `browserGuest` — what the Ctrl+wheel zoom lands
   * on, and what an agent's screenshot captures. With one page that was
   * whichever guest attached last, which was always right. With tabs it is
   * whichever you are looking at, and only this side knows which.
   */
  useEffect(() => {
    const w = el();
    if (!w) return;
    // A beat late on purpose: a guest that has only just been created has no
    // WebContents to name yet, and the call throws.
    const t = setTimeout(() => { try { setActiveBrowserGuest(w.getWebContentsId()); } catch { /* attaching */ } }, 60);
    return () => clearTimeout(t);
  }, [activeId, tabs.length, el]);

  /*
   * Answer the agents.
   *
   * This panel is the only thing that can reach a guest, so while it is mounted
   * it is the one that serves what the server relays — against the tab you are
   * looking at, which is what an agent means by "the browser".
   *
   * Deliberately not gated on `active`. The workspace keeps this view mounted
   * when you look at something else, and an agent driving a page while you read
   * a diff is the normal case, not an edge one.
   */
  /* Looked at for the first time: the tab that was in front comes back. Until
     then this panel is mounted and asleep — a name and an address, no guest. */
  useEffect(() => {
    if (!viewOn || !activeId) return;
    setTabs((prev) => (prev.find((t) => t.id === activeId)?.asleep ? wake(prev, activeId) : prev));
  }, [viewOn, activeId]);

  useEffect(() => {
    /*
     * A COPY DOES NOT TAKE THE AGENTS' BROWSER.
     *
     * `setBrowserAskHandler` is one slot for the whole window, and this
     * component is mounted twice now — the view, and the tab in the floating
     * bench. Two registrations meant the last one mounted won it and, worse,
     * either one unmounting set the slot to null: the bench's browser tab was
     * opened once and from then on `agentglass-browser` timed out with the
     * view sitting there perfectly able to answer. The window still counted as
     * ready, so the failure arrived as "the browser did not answer in time"
     * rather than as anything a person could act on.
     *
     * An agent drives ONE browser and it is this view — the one the CLI knows
     * how to open, the one a person can watch. The bench's copy is a human
     * surface and stays out of it.
     */
    if (scope) return;
    setBrowserAskHandler((ask) => {
      /*
       * WHETHER A MINT MAY TAKE THE PANE, handed to `open` above.
       *
       * `TabOps.open(url, profile)` takes no third argument and the interface
       * lives in browserBus.ts, so the flag travels through a ref instead.
       * Safe, and the reason is worth writing down rather than trusting: every
       * call site below reaches `serveTabs` -> `tabs.open()` SYNCHRONOUSLY —
       * `serveBrowserAsk` answers the tab verbs before its first `await` — so
       * nothing can interleave between this line and the read. The delayed
       * call site sets it again inside its own timeout, from the same frame.
       */
      mintShow.current = ask.args.show === true;
      /* §9: if a page is addressed explicitly, route to that tab's webview.
         Otherwise use the active one. */
      let targetId = activeIdRef.current;
      if (typeof ask.args.page === "string") {
        targetId = ask.args.page;
        /*
         * A NAMED TAB THAT IS NOT HERE FAILS, AND SAYS SO.
         *
         * It used to wait a beat for a guest to attach and then answer "the
         * browser view is not open in this window" — which is a sentence about
         * the window, for a caller whose actual problem is that the tab it has
         * been addressing is gone. An agent reading that opens the view and
         * carries on, in whatever tab happens to be in front. Naming the tab
         * is how an agent stays out of everybody else's work; the one thing
         * this must never do is quietly answer from a different one.
         */
        if (!tabsRef.current.some((t) => t.id === targetId)) {
          void api.browserResult({
            id: ask.id, ok: false,
            /* Three causes, and the third is the one that bit a peer session
             twice: tab ids are minted fresh on every launch, so an id written
             down before a restart names nothing afterwards — with the page
             sitting there open. The old wording claimed two causes that were
             both wrong in that case and sent them looking for who had closed
             what. */
          error: `no tab called ${targetId} — it was closed, it belongs to a window that is gone, `
              + `or the app has restarted since you read that id (ids are not stable across restarts). `
              + `Call \`tabs\` to re-read them, or open your own with \`open --as <your name> <url>\`.`,
          }).catch(() => { /* already timed out */ });
          return;
        }
      }
      /*
       * §3: AND IT MUST BE YOUR TAB, OR YOU MUST HAVE SAID YOU MEANT SOMEBODY
       * ELSE'S.
       *
       * This is the check the whole incident was missing. The existence check
       * above answers "is that tab here"; nobody was answering "is that tab
       * YOURS". Both agents were behaving correctly — the loser's tab was
       * simply the one in front, and a bare verb means "the tab in front".
       *
       * The owner is already on the tab object and already the name `tabs`
       * reports, so this compares what a caller can read back rather than an
       * internal partition id. Three ways past it, all deliberate:
       *
       *   - no `as` on the wire  → unverifiable, allowed. The MCP surface and
       *     `--shared` both arrive this way and both must keep working.
       *   - `pageExplicit`       → the operator typed `--page`, or named this
       *     exact tab with `tab <id>` (the server remembers that; see
       *     `rememberNamedTab`, which is what keeps `tab A; shot` working).
       *   - not page-bound       → `tabs`, `newtab`, `profiles` and friends
       *     are about the list, not about the tab in front.
       *
       * The refusal needs no audit line of its own: every reply passes through
       * the one seam in server/src/browserdrive.ts that calls `recordAudit`
       * with `ask.args`, and `as` and `page` are now in there.
       */
      const owner = ask.args.pageBound === false
        ? undefined
        : tabsRef.current.find((t) => t.id === targetId);
      if (owner) {
        const refusal = crossContainerRefusal({
          tab: targetId,
          container: owner.profile ? profileName(profilesRef.current, owner.profile) : "default",
          as: typeof ask.args.as === "string" ? ask.args.as : "",
          pageExplicit: ask.args.pageExplicit === true,
          acts: ask.args.acts !== false,
        });
        if (refusal) {
          void api.browserResult({ id: ask.id, ok: false, error: refusal })
            .catch(() => { /* already timed out */ });
          return;
        }
      }
      /* §8: the answer says which tab it came from and whose container that is.
         Resolved HERE and nowhere else — `runBrowserAsk` is handed one webview
         and cannot name it — so it rides down on the frame and is stamped onto
         every reply on the way back. A navigating `open` describes the page
         AFTER it moved, which is why it could never contradict a caller who had
         aimed at the wrong tab. */
      if (owner) {
        ask.args.atTab = owner.id;
        ask.args.atProfile = owner.profile ? profileName(profilesRef.current, owner.profile) : "default";
      }
      if (!targetId) { void serveBrowserAsk(null, ask); return; }
      const target = els.current.get(targetId);
      /* An agent asking IS a reason to wake up. Without this the first ask of a
         session is answered "there is no browser view in this window" while the
         panel sits there mounted and asleep — and the CLI then opens the view,
         which is the app taking the screen off whoever was typing. */
      if (target) { void serveBrowserAsk(target as unknown as DrivableWebview, ask); return; }
      setTabs((prev) => (prev.find((t) => t.id === targetId)?.asleep ? wake(prev, targetId) : prev));
      // A beat for the guest to attach. Long enough on this machine, and the
      // ask is answered either way rather than left hanging.
      setTimeout(() => {
        /* Re-armed from THIS frame: 1.2 s is long enough for another agent's
           ask to have run and left its own answer in the ref. */
        mintShow.current = ask.args.show === true;
        void serveBrowserAsk(els.current.get(targetId) as unknown as DrivableWebview | null, ask);
      }, 1200);
    });
    return () => setBrowserAskHandler(null);
    // Re-registered when the active tab changes, so the closure serves the tab
    // that is up rather than the one that was up when this mounted.
  }, [activeId, el, scope]);

  /*
   * "This window can drive a browser" — said ONCE, and it matters that it is
   * once.
   *
   * This used to live in the effect above, so every tab switch ran its cleanup:
   * `browserReady(false)`, then true again a beat later. In that gap the server
   * believes no window can answer, and an agent whose call lands there is told
   * "the browser view is not open in this window" — which the CLI fixes by
   * OPENING the browser view. That is the app yanking somebody out of the
   * terminal mid-sentence because an agent took a screenshot, and it is
   * exactly what he described.
   *
   * Mount and unmount, nothing else. The handler above can be re-registered as
   * often as it likes; the registration is not the handler.
   */
  useEffect(() => {
    // Only the desktop shell can actually drive a page: `<webview>` is an
    // Electron tag, and in a plain browser tab this panel renders an element
    // with none of the methods on it. Registering from there would have this
    // window volunteering for work it cannot do.
    if (!IS_DESKTOP) return;
    /* And a copy does not volunteer for the work either — see the ask handler
       above. Counting twice would make "is a browser open?" true because of a
       window nobody can drive. */
    if (scope) return;
    const id = clientId();
    const beat = () => { void api.browserReady(id, true).catch(() => {}); };
    beat();
    // Well inside the server's ninety-second expiry, so a missed one costs
    // nothing and a dead window stops counting on its own.
    const timer = setInterval(beat, 30_000);
    return () => {
      clearInterval(timer);
      void api.browserReady(id, false).catch(() => {});
    };
  }, [scope]);

  /*
   * The person's zoom, through the only call that takes effect.
   *
   * This used to be `el()?.setZoomLevel(next)`, which is documented twice in
   * browserDrive.ts as measured to do nothing to a guest — so the chip moved,
   * the level was remembered across launches, and the page never changed. The
   * agent's `zoom` verb had the working mechanism all along; now there is one
   * of it, and this calls it.
   *
   * The CDP call is named with the guest's own id. Without it the relay talks
   * to whichever tab is in front, which is right here and wrong the moment
   * anything else calls this — the same defect that had captures photographing
   * the wrong page.
   */
  const applyZoom = useCallback(async (level: number): Promise<GuestZoom | null> => {
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
    const w = el();
    if (!w) return null;
    /* And the tab is the person's again. An agent's zoom is remembered so a
       navigation does not undo it (see `agentZoom`); a person reaching for
       Ctrl+ on that same tab is not a navigation, it is the person taking it
       back, and their level has to be the one that survives from here on. */
    forgetAgentZoom(w);
    let gid: number | undefined;
    try { gid = w.getWebContentsId(); } catch { return null; }
    /*
     * THE PERSON'S ZOOM IS ELECTRON'S, NOT THE AGENT'S VIEWPORT.
     *
     * Reported with three screenshots — 110%, 140%, 240% — in which the page
     * kept its size and the RECTANGLE it was drawn in shrank, leaving a small
     * page in a large empty area: "it doesn't zoom, it does something odd".
     *
     * `applyGuestZoom` is a device metrics override, and an override narrows
     * the layout VIEWPORT while the `<webview>` element keeps the box it
     * always had. That is the right answer to an agent asking "show me this
     * page as a phone sees it" and the wrong one for a person leaning in.
     * `webContents.setZoomFactor` scales the page inside the box, and it is
     * only reachable from the main process — hence a door of its own.
     *
     * The override stays as the fallback for a build whose shell does not have
     * that door yet: a zoom that does something odd still beats a dead key.
     */
    const viaShell = await browserZoom(Math.pow(1.2, next), gid);
    if (viaShell.ok) {
      const shownByShell = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.log(viaShell.factor) / Math.log(1.2)));
      setZoom(shownByShell);
      saveZoom(shownByShell);
      /* The pane is unchanged by this kind of zoom — that is the whole
         difference from the override — so it is measured, not invented. */
      let pane = { width: 0, height: 0 };
      try {
        const box = (w as unknown as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect?.();
        if (box) pane = { width: Math.round(box.width), height: Math.round(box.height) };
      } catch { /* the element went away mid-zoom */ }
      return { factor: viaShell.factor, percent: viaShell.percent, pane };
    }
    const r = await applyGuestZoom(
      w as unknown as { executeJavaScript(code: string): Promise<unknown> },
      Math.pow(1.2, next),
      (method, params) => browserCdp(method, params, gid),
    );
    if (!r.ok) return null;
    /* The level comes from what the PAGE ended up at, not from what was asked
       for. Driven by `next` this chip read 120% while the page was at 96% —
       the same defect the verb documents having had twice, reproduced one
       layer up the moment the chip stopped being decorative. */
    /*
     * CLAMPED BEFORE IT IS SHOWN, not only before it is stored.
     *
     * `saveZoom` has always clamped on write and `setZoom` never did, so an
     * impossible reading reached the chip and the toast and stayed there until
     * a restart re-read the clamped value from disk. That is exactly what he
     * saw: `Page 524%` on a scale whose ceiling is 358% (`1.2 ** ZOOM_MAX`),
     * gone after closing and opening the app.
     *
     * The clamp is not the fix — the reading should not be impossible in the
     * first place, and `applyGuestZoom` now waits for the layout and refuses a
     * pane with no page in it. This is the guard that makes a future bad
     * measurement wrong by 20% instead of by a factor of five.
     */
    const shown = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.log(r.value.factor) / Math.log(1.2)));
    setZoom(shown);
    saveZoom(shown);
    return r.value;
  }, [el]);

  /*
   * Ctrl+ and Ctrl- over a web page, which is not this component's event.
   *
   * The keys belong to the window (electron/main.js says so and explains why),
   * and `zoomTarget` decides what they mean from where the pointer is. It
   * cannot resolve a guest and must not learn how, so the panel hands it a
   * function while it is mounted and takes it back on teardown.
   */
  useEffect(() => {
    setPageZoomer(async (dir) => applyZoom(dir === 0 ? 0 : stepZoom(zoomRef.current, dir)));
    return () => setPageZoomer(null);
  }, [applyZoom]);

  /*
   * Ctrl+wheel INSIDE the page, which never reaches this window.
   *
   * The wheel lands in the guest's own process, so the renderer's listener
   * cannot see it; Chromium reports it to the shell as `zoom-changed` and the
   * shell relays the level here. This used to only remember the number, while
   * the shell called `guest.setZoomLevel` — the call measured to do nothing.
   * So the chip climbed and the page sat still. Applying it here puts that
   * gesture on the same one path as the keys and as the agent's verb.
   */
  useEffect(() => onBrowserZoom((level) => { void applyZoom(level); }), [applyZoom]);

  const open = useCallback((url: string, from?: string, profile?: string, shelfId?: string) => {
    setTabs((prev) => {
      const r = addTab(prev, url, from, profile, shelfId);
      if ("error" in r) { say(r.error); return prev; }
      setActiveId(r.tab.id);
      return r.tabs;
    });
  }, [say]);

  const close = useCallback((id: string) => {
    const going = tabsRef.current.find((t) => t.id === id);
    if (going && going.url && going.url !== BLANK) {
      closed.current = [
        { url: going.url, title: going.title, icon: going.icon, profile: going.profile },
        ...closed.current.filter((c) => c.url !== going.url),
      ].slice(0, 25);
    }
    els.current.delete(id);
    setTabs((prev) => {
      const r = closeTab(prev, id);
      setActiveId(r.activeId);
      /*
       * THE LAST PAGE OF A CONTAINER TAKES ITS ENTRY WITH IT.
       *
       * `saveSession` writes one set per profile that still has a tab, and a
       * profile with none is not in that list at all — so its old set stayed
       * in the file untouched and the next launch restored it. Measured across
       * four reinstalls: 47 pages of containers that had been dropped hours
       * earlier came back every single time, and each launch they filled the
       * twelve-awake budget again.
       *
       * Only when it is the LAST one. A profile that still has pages gets
       * rewritten by the save that follows this, correctly and in one place.
       */
      const gone = going?.profile ?? "";
      if (gone && !r.tabs.some((t) => (t.profile || "") === gone)) forgetProfileTabs(gone);
      return r.tabs;
    });
  }, []);

  /**
   * Go and work as somebody else.
   *
   * The whole strip changes, because a profile IS the strip: the set you leave
   * is written down first — it is the only copy, nothing else in the app holds
   * those addresses — and the set you arrive at comes back asleep, so switching
   * costs one guest however many pages the other profile was holding.
   *
   * The guests of the profile you left are unmounted with their tabs. That is
   * not a compromise: a partition is fixed when a guest attaches, so pages from
   * two profiles cannot share a strip without each keeping its own processes
   * alive, and keeping twelve of them warm for a profile you are not looking at
   * is the cost this design exists to avoid.
   */
  const switchTo = useCallback((profileId: string) => {
    setNaming(null);
    if (profileId === profile) return;
    saveSession(profile, tabs, activeId, scope);
    /*
     * ONLY OUR OWN GUESTS ARE LET GO.
     *
     * This cleared every guest and rebuilt the whole list, which ended any tab
     * an agent had open in another identity — its id was gone, so its next
     * call could not address it and fell through to whatever was in front.
     * Switching identity is a thing a person does to their own strip; it is
     * not a reason to end somebody else's work.
     */
    const kept = tabs.filter((t) => (t.profile || "") !== profile);
    for (const t of tabs) if ((t.profile || "") === profile) els.current.delete(t.id);
    /* Already open in the one being entered — an agent got there first. Those
       ARE the profile's tabs; restoring the saved set on top would show every
       page twice. */
    const already = kept.filter((t) => (t.profile || "") === profileId);
    const set = already.length ? null : setFor(readSession(scope), profileId);
    const restored = already.length
      ? []
      : set
        ? set.tabs.map((t, i) => {
            const tab = sleepingTab(t.url, t.title, t.icon, profileId);
            return i === set.active ? { ...tab, asleep: false } : tab;
          })
        : [newTab(homePage(), profileId)];
    setProfile(profileId);
    setTabs([...kept, ...restored]);
    setActiveId(already[0]?.id ?? restored[set?.active ?? 0]?.id ?? restored[0]?.id ?? "");
    setTyped(null);
  }, [profile, tabs, activeId]);

  const makeProfile = useCallback((name: string) => {
    const r = addProfile(profiles, name);
    if ("error" in r) { say(r.error); return; }
    setProfiles(r.profiles);
    saveProfiles(globalThis.localStorage ?? null, r.profiles);
    // Straight into it. Naming a profile and then having to pick it from the
    // menu you just used is a step that exists only because it was easier to
    // write.
    switchTo(r.profile.id);
  }, [profiles, say, switchTo]);

  /** Forget the name. Chromium keeps the partition and its cookies — see
   *  browserProfiles.ts; erasing them is a different question with a different
   *  dialog, and doing it quietly here would be the worst way to answer it. */
  const forgetProfile = useCallback((id: string) => {
    /*
     * THE LIST AS IT IS NOW, not as it was when this closure was made.
     *
     * It read the render's copy, and two containers made in quick succession
     * — which is what an agent does — left this holding the list from before
     * the second one existed. Dropping the first then WROTE that old list back
     * minus one, and the second container disappeared with it. Measured:
     * `--make alpha`, `--make beta`, `--drop alpha`, and `profiles` answered
     * an empty list.
     */
    const next = removeProfile(profilesRef.current, id);
    setProfiles(next);
    saveProfiles(globalThis.localStorage ?? null, next);
    // Its strip goes with the name, or the file keeps a set of tabs filed under
    // a profile nothing can reach. And if it was the one on screen, there has
    // to be somewhere to stand: the default profile is always there.
    profilesRef.current = next;
    forgetProfileTabs(id);
    /*
     * AND THE PAGES GO WITH IT.
     *
     * "Throw one away with everything in it" is what the verb's own help
     * promises, and it was throwing away the NAME: the saved strip was
     * forgotten and the open tabs stayed in the list, in a container that no
     * longer existed. Measured after dropping four: seventeen of their pages
     * still listed, still holding the twelve-awake budget.
     */
    setTabs((prev) => {
      for (const t of prev) if ((t.profile || "") === id) els.current.delete(t.id);
      const kept = prev.filter((t) => (t.profile || "") !== id);
      if (kept.length !== prev.length && !kept.some((t) => t.id === activeIdRef.current)) {
        setActiveId(kept[0]?.id ?? "");
      }
      return kept;
    });
    if (id === profile) switchTo("");
  }, [profile, switchTo]);

  /* A page that opened a window used to be handed to the OS browser, because a
     single-page view had nowhere to put it. Now it goes beside the tab it came
     from — which is what makes an OAuth popup finish inside the app. */
  useEffect(() => onBrowserOpenTab((url) => open(url, activeId)), [open, activeId]);

  /*
   * The chords, arriving from the shell because the page had the focus.
   *
   * Same three actions as the panel's own key handler below — which only ever
   * fires when the focus is in OUR chrome, and after one click on a page it
   * never is again. That is why Ctrl+T did nothing for the whole time you were
   * actually browsing.
   */
  useEffect(() => { setHover(""); }, [activeId]);

  /* The inspector belongs to the tab it was opened on. Switching tabs closes
     it rather than quietly re-pointing it: DevTools showing another page's DOM
     under this page's toolbar is worse than no DevTools. */
  useEffect(() => { setDt(null); }, [activeId]);

  /* "Inspect" from the page's own context menu. Same pane, and it opens on the
     element that was right-clicked rather than at the top of the document. */
  useEffect(() => onBrowserInspect((at) => { if (activeId) setDt({ tab: activeId, at }); }), [activeId]);

  /*
   * Point one guest's DevTools at the other, once both exist.
   *
   * A beat late on purpose: a `<webview>` that has only just been created has
   * no WebContents to name yet and `getWebContentsId()` throws — the same
   * reason the active-guest effect above waits.
   */
  useEffect(() => {
    if (!dt) { setDtGuest(0); return; }
    const guest = els.current.get(dt.tab);
    if (!guest) return;
    let live = true;
    let opened = 0;
    const t = setTimeout(() => {
      try { opened = guest.getWebContentsId(); } catch { return; }
      const box = dtBox.current?.getBoundingClientRect();
      void browserDevtools({
        guest: opened,
        rect: { x: box?.left ?? 0, y: box?.top ?? 0, width: box?.width ?? 0, height: box?.height ?? 0 },
        zoom: dtZoom,
        ...(dt.at ?? {}),
      }).then((r) => {
        if (!live) return;
        if (!r.ok) { say(r.error || "The inspector could not be opened"); setDt(null); return; }
        setDtGuest(opened);
      });
    }, 80);
    return () => {
      live = false;
      clearTimeout(t);
      if (opened) void browserDevtoolsClose(opened);
    };
    // `dtZoom` is read at open and deliberately not a dependency: re-running
    // this would close and reopen the inspector on every zoom step. Later
    // changes go through browserDevtoolsZoom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dt, say]);

  /* Ctrl+wheel and Ctrl+plus inside the inspector. They land in that view and
     never reach this document, so the shell handles them and says what it did —
     otherwise the percentage on the strip would be a number nobody updated. */
  useEffect(() => onDevtoolsZoom(({ level }) => { setDtZoom(level); setDevtoolsZoom(level); }), []);

  /*
   * Keep the hole and the view on top of each other.
   *
   * The inspector is not in this document's layout — it is a view of the
   * shell's, floating over the window — so every reason the hole moves has to
   * be reported: the drag handle, the window resizing, the app's own zoom
   * (which changes what a CSS pixel is worth), and the tab strip growing a row.
   * A ResizeObserver on the hole itself catches all of them, because all of
   * them end with the hole a different size or in a different place.
   *
   * `on` is the other half: a floating view knows nothing about which workspace
   * view is on screen, and left visible while you read a diff it would sit over
   * the diff.
   */
  /* Anything drawn over the app — Settings, for one — hides the inspector while
     it is up. A floating view has no z-order in this document, so "in front of"
     is a thing only this side can know. */
  const covered = useSyncExternalStore(subscribeOverlays, anyOverlayOpen, () => false);
  /*
   * …and this panel's own popovers, which are in front of it too.
   *
   * Settings was the first case and the registry above covers it. The rest are
   * this panel's own — and only the ones that TAKE the screen are here.
   *
   * The menu behind ⋯ was in this list for one build and it was worse than the
   * problem: opening a menu made the whole inspector blink out. It is kept in
   * the bar's own column instead (see where it is positioned), where it has
   * nothing to overlap. A hover popover is left alone for the same reason —
   * blanking a DevTools pane because a pointer crossed a folder is not a fix.
   */
  const ownOverlay = !!menuAt || !!omni || !!bringing || mode !== "none";

  useLayoutEffect(() => {
    const box = dtBox.current;
    if (!dtGuest || !box) return;
    const send = () => {
      const r = box.getBoundingClientRect();
      browserDevtoolsRect(dtGuest, { x: r.left, y: r.top, width: r.width, height: r.height, on: viewOn && !covered && !ownOverlay });
    };
    send();
    const ro = new ResizeObserver(send);
    ro.observe(box);
    window.addEventListener("resize", send);
    return () => { ro.disconnect(); window.removeEventListener("resize", send); };
  }, [dtGuest, viewOn, covered, ownOverlay, dtSide, dtSize]);

  useEffect(() => onBrowserKey((k) => {
    if (k === "T") { reopenRef.current(); return; }
    if (k === "w") { closeHereRef.current(); return; }
    if (k === "t") { setOmni("new"); return; }
    if (k === "f") { setFind((f) => f ?? ""); setTimeout(() => findRef.current?.focus(), 0); return; }
    if (k === "l") { setOmni("edit"); return; }
    if (k === "S") { setMode((m) => (m === "shoot" ? "none" : "shoot")); return; }
    if (k === "s") { setSideOpen((v) => { setSidebarOpen(!v); return !v; }); setPeek(false); }
  }), []);

  /* "Search the web for…", from the page's context menu. In a tab of its own,
     beside the page the selection came from: a search that replaces what you
     were reading loses the thing you selected it from. */
  useEffect(() => onBrowserSearch((text) => {
    const q = text.trim();
    if (q) open(buildSearchUrl(q, searchEngine()), activeId);
  }), [open, activeId]);

  const go = useCallback((raw: string) => {
    // `about:blank` is not a URL the address-bar parser will hand back — it is
    // not http(s) — but it is exactly where Home goes when the home page has
    // been left empty, so it is passed straight through.
    const next = raw === BLANK ? BLANK : normalizeNavigationUrl(raw, searchEngine());
    const w = el();
    if (!next || !w || !active) return;
    setTyped(null);
    patch(active.id, { failed: null });
    w.src = next;
  }, [active, patch, el]);

  /*
   * Somebody elsewhere asked for an address — the ports panel, usually.
   *
   * `useSyncExternalStore` rather than an effect with a subscription: the
   * request carries a counter, and the counter is what makes "open :5173 again"
   * a second request rather than a no-op. Cleared on send so a request made
   * while this view was still mounting is not dropped.
   */
  const want = useSyncExternalStore(subscribeBrowserNav, browserNav, browserNav);
  useEffect(() => {
    if (!want) return;
    // Into a tab, rather than over whatever you were reading — unless the tab
    // you are on is blank, in which case opening a second empty one beside it
    // would be silly.
    if (active && (!active.url || active.url === BLANK)) go(want.url);
    else open(want.url, active?.id);
    clearBrowserNav();
  }, [want, go, open, active]);

  /* --------------------------------------------------------- guest wiring */

  /**
   * Attach the listeners for one tab.
   *
   * A callback ref rather than an effect: an element appears and disappears
   * with its tab, and an effect keyed on the list would tear down and re-bind
   * every tab whenever any one of them changed.
   */
  const bind = useCallback((id: string) => (node: HTMLElement | null) => {
    const w = node as WebviewEl | null;
    if (!w) { els.current.delete(id); return; }
    if (els.current.get(id) === w) return;
    els.current.set(id, w);

    const sync = () => {
      try { patch(id, { url: w.getURL(), canBack: w.canGoBack(), canForward: w.canGoForward() }); }
      catch { /* the guest is not attached yet */ }
    };
    const onStart = () => patch(id, { loading: true, failed: null });
    const onStop = () => {
      patch(id, { loading: false });
      sync();
      // The browser now remembers where you went: once the page has settled,
      // record the visit so the address bar can suggest your OWN history back —
      // not only what was imported from another browser.
      try {
        const url = w.getURL();
        const title = w.getTitle();
        if (/^https?:\/\//i.test(url)) {
          void api.recordVisit(url, title);
          // Reflect it locally too, so a page you just visited completes on the
          // very next keystroke without waiting for a reload. `places` is typed
          // Suggestion[] but is fed to suggest() as Place[]; build a Place-shaped
          // row and cast, prepending it (or bumping an existing one) by url.
          const at = Math.floor(Date.now() / 1000);
          setPlaces((prev) => {
            const rows = prev ?? [];
            const had = rows.find((p) => p.url === url);
            const row = {
              url,
              title: title || had?.title || "",
              visits: (had?.visits ?? 0) + 1,
              lastAt: at,
              bookmarked: had?.bookmarked ?? false,
            } as unknown as Suggestion;
            return [row, ...rows.filter((p) => p.url !== url)];
          });
        }
      } catch { /* the guest is not attached yet */ }
    };
    /* Where that link goes, while you are pointing at it — the bubble every
       browser puts in the bottom corner. It is the guest that knows: hovering
       happens inside the page, where nothing of ours is listening.
       Unconditional rather than gated on the active tab, because a tab you are
       not looking at is a tab nobody is pointing at; what it does need is
       clearing when the tab changes, or the last hover of the tab you left sits
       under the new one. */
    const onTarget = (e: Event) => setHover((e as Event & { url?: string }).url ?? "");
    const onTitle = (e: Event) => patch(id, { title: (e as Event & { title?: string }).title ?? "" });
    const onIcon = (e: Event) => {
      const icons = (e as Event & { favicons?: string[] }).favicons;
      const url = icons?.[0];
      if (!url) return;
      /*
       * RESOLVED HERE, ONCE, RATHER THAN AT EVERY PLACE THAT DRAWS IT.
       *
       * A remote favicon URL in an `<img>` is a CSP violation on every launch:
       * `img-src` allows self, data:, blob:, loopback and two named hosts, so
       * an icon from anywhere else is blocked ALWAYS — not only while the
       * sidecar is booting. It never appeared; the strip has been drawing the
       * globe fallback and the console has been paying six errors for it.
       *
       * The shell fetches it on this tab's own session and hands back a
       * `data:`, which the policy already allows. Doing it on arrival means
       * the three places that render an icon need no change and no guest id
       * threaded through them, and the work happens once per icon instead of
       * once per paint.
       *
       * The URL is set first and replaced after. A tab is named by its icon in
       * the strip, and waiting for a round trip before showing anything would
       * trade six console errors for a strip that flickers — outside the
       * desktop shell there is nothing to ask and the URL is all there is.
       */
      patch(id, { icon: url });
      const bridge = (window as unknown as { agentglass?: {
        browserFavicon?: (u: string, g?: number) => Promise<{ ok: boolean; dataUrl?: string }>;
      } }).agentglass;
      if (!bridge?.browserFavicon) return;
      let gid: number | undefined;
      try { gid = (w as unknown as { getWebContentsId?: () => number }).getWebContentsId?.(); } catch { /* not attached */ }
      void bridge.browserFavicon(url, gid).then((r) => {
        if (!r?.ok || !r.dataUrl) return;
        /* Only if the tab is still on the icon this was fetched FOR. A page
           that navigated while the round trip was in flight would otherwise be
           marked with the previous one — the shape of bug this panel has had
           twice, where an answer arrives for a tab that has moved on. */
        setTabs((prev) => prev.some((t) => t.id === id && t.icon === url)
          ? patchTab(prev, id, { icon: r.dataUrl! })
          : prev);
      }).catch(() => { /* the strip keeps the URL and the globe fallback */ });
    };
    // Only the main frame's failure is the page's failure: a blocked tracker in
    // a subframe is not a broken page, and reporting it as one would put an
    // error over a page that rendered perfectly well.
    const onFail = (e: Event) => {
      const d = e as Event & { errorDescription?: string; isMainFrame?: boolean; errorCode?: number };
      if (d.isMainFrame === false) return;
      // -3 is ABORTED, which is what a navigation you interrupted looks like.
      if (d.errorCode === -3) return;
      patch(id, { loading: false, failed: d.errorDescription || "The page could not be loaded" });
    };
    // The guest is a fresh Chromium every attach and knows nothing about the
    // level this panel remembers, so it is handed it back the moment it can
    // take it. `dom-ready` and not `did-navigate`: before that the guest has no
    // WebContents to set anything on and the call throws.
    /* THE WINDOW LEVEL, unless an agent has claimed this tab. Handing every
       fresh guest the person's level put an agent's `zoom 2` back to 158% on
       the next `open` — right for the tabs a person is looking at, wrong for a
       tab an agent set a size on and is now photographing. Which of the two it
       is, is `reapplyZoom`'s to know. */
    const onReady = () => {
      try { reapplyZoom(w, zoomLevel()); } catch { /* gone */ }
      /* AND THE LOG COLLECTOR, on every navigation.
       *
       * A console that starts recording when somebody asks for it has already
       * missed the error they are asking about — which is exactly the report:
       * "the SPA came up blank under HMR and I was blind; without console or
       * network there is no diagnosis, only trying things at random. The most
       * expensive thing of the day." So it is installed as the page becomes
       * able to run anything, and `observe` reads what it has collected.
       *
       * Failure is silent on purpose: a page that refuses this (a PDF viewer,
       * a page still swapping documents) must still browse normally. */
      /* Same shape as the load above: the promise carries the failure, so the
         catch belongs on the promise. A page that refuses this must not become
         an unhandled rejection in somebody's console. */
      void w.executeJavaScript(COLLECTOR).catch(() => { /* not scriptable */ });
    };

    w.addEventListener("dom-ready", onReady);
    w.addEventListener("did-start-loading", onStart);
    w.addEventListener("did-stop-loading", onStop);
    w.addEventListener("did-navigate", sync);
    w.addEventListener("did-navigate-in-page", sync);
    w.addEventListener("did-fail-load", onFail);
    w.addEventListener("page-title-updated", onTitle);
    w.addEventListener("page-favicon-updated", onIcon);
    w.addEventListener("update-target-url", onTarget);
    /* How many, and which one you are on. Only the guest knows — it does the
       searching — and without it the strip is a box that gives no sign of
       whether the word is on the page at all. */
    const onFound = (e: Event) => {
      const r = (e as Event & { result?: { activeMatchOrdinal?: number; matches?: number } }).result;
      if (r) setFound({ at: r.activeMatchOrdinal ?? 0, of: r.matches ?? 0 });
    };
    w.addEventListener("found-in-page", onFound);
  }, [patch]);

  /* ------------------------------------------------------------- keyboard */

  /*
   * The shell's Ctrl+F, when this view is the one on screen.
   *
   * The panel already handles the key itself, but only when the focus is
   * inside it — and after a click on the page, the focus is inside the
   * `<webview>`, where Chromium's own find takes over. This claim covers the
   * gap in between: the view is up, the focus is nowhere in particular, and
   * "find" should mean the page you are looking at rather than the app's
   * chrome around it.
   */
  useEffect(() => {
    if (!viewOn) return;
    return registerClaim(() => {
      setFind((f) => f ?? "");
      setTimeout(() => findRef.current?.focus(), 0);
      return true;
    });
  }, [viewOn]);

  useEffect(() => { urlNow.current = active?.url ?? ""; }, [active?.url]);

  /* A blank tab you have walked away from has no row and no page: it would sit
     there for ever with no way back to it. It is dropped as soon as it stops
     being the one you are on — nothing is lost, there was nothing in it. */
  useEffect(() => {
    setTabs((prev) => {
      const next = pruneBlank(prev, activeId);
      return next.length === prev.length ? prev : next;
    });
  }, [activeId]);

  const moreBtn = useRef<HTMLButtonElement | null>(null);
  const [menuAtXY, setMenuAtXY] = useState<{ top: number; right: number } | null>(null);

  /*
   * The box opens with something in it.
   *
   * Four doors lead here — the chord, the shell's copy of the chord, the
   * address chip, the menu — and seeding the field at each of them means three
   * of them are one edit away from opening it empty. Measured, twice, by
   * somebody who then had to type an address he was already looking at.
   */
  useEffect(() => {
    if (!omni) return;
    setHint(-1);
    setTyped(omni === "edit" ? (active?.url && active.url !== BLANK ? active.url : "") : "");
  }, [omni]);

  /*
   * The chords, from wherever the focus happens to be.
   *
   * There were two halves and a hole between them: the panel's own handler,
   * which only fires while the focus is inside its markup, and the shell's,
   * which only fires while the focus is inside the PAGE. Click the bar's
   * background and the focus is on neither — which is why Ctrl+T "worked
   * sometimes" and Ctrl+L looked dead.
   *
   * A window listener closes it. Only while this view is the one on screen, and
   * on capture, so it beats anything a page's own chrome does with the key.
   */
  useEffect(() => {
    if (!viewOn) return;
    const onKeyAnywhere = (e: KeyboardEvent) => {
      /*
       * Escape gets you out of the three things that take over the page.
       *
       * The picker handles Escape itself — inside the page, where it only
       * fires if the page has the focus. Point at an element, look at the bar,
       * press Escape, and nothing happens; the only way out was the menu. This
       * is the other half, and it costs nothing when no mode is on.
       */
      if (e.key === "Escape" && modeRef.current !== "none") {
        e.preventDefault();
        e.stopPropagation();
        setMode("none");
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      // Inside the box itself: it has its own handling, and Ctrl+L while typing
      // an address should not re-open the thing you are typing in.
      const inBox = (e.target as HTMLElement | null)?.dataset?.agxOmni === "1";
      if (k === "t") {
        e.preventDefault();
        // Shift is "bring back the last one I closed", and it walks the list.
        if (e.shiftKey) reopenRef.current(); else setOmni("new");
        return;
      }
      if (k === "w" && !inBox) { e.preventDefault(); closeHereRef.current(); return; }
      if (e.key === "Tab") { e.preventDefault(); stepTabRef.current(!e.shiftKey); return; }
      if (k === "r") {
        e.preventDefault();
        try { if (e.shiftKey) elRef.current()?.reloadIgnoringCache(); else elRef.current()?.reload(); }
        catch { /* no guest yet */ }
        return;
      }
      if (k === "l") { if (!inBox) { e.preventDefault(); setOmni("edit"); } return; }
      if (e.altKey && k === "u") { e.preventDefault(); setSplitId(null); return; }
      if (k === "s" && e.shiftKey) {
        // The chord his hands already know, from Firefox and from Zen.
        e.preventDefault();
        setMode((m) => (m === "shoot" ? "none" : "shoot"));
        return;
      }
      if (k === "s") {
        // His, not Zen's. Ctrl+S in this app saves nothing — there is no
        // document — so the chord is free and it is the one his hands know.
        e.preventDefault();
        setSideOpen((v) => { setSidebarOpen(!v); return !v; });
        setPeek(false);
        return;
      }
      if (k === "c" && e.shiftKey && !inBox) {
        /* The address, on the clipboard.
           Chromium spends this chord on "inspect element", which this app puts
           on the inspector button and on the page's own menu; copying where you
           are is the thing people do twenty times a day. Not without Shift —
           that is Copy, and the page's own selection owns it. */
        e.preventDefault();
        const url = elRef.current()?.getURL?.() || urlNow.current || "";
        if (!url || url === BLANK) { say("Nothing to copy — this tab has no page yet"); return; }
        void navigator.clipboard.writeText(url).then(() => say("Address copied")).catch(() => say("The clipboard refused that"));
        return;
      }
      if (k === "f" && !inBox) {
        e.preventDefault();
        setFind((f) => (f === null ? "" : f));
        setTimeout(() => findRef.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKeyAnywhere, true);
    return () => window.removeEventListener("keydown", onKeyAnywhere, true);
  }, [viewOn]);

  // The demo has no guest to attach and still draws the panel: its pages are
  // written into the build, and the chrome around them is this component.
  //
  // EVERY HOOK GOES ABOVE THIS LINE. A `useState` or a `useCallback` below a
  // conditional return runs on some renders and not others, React loses its
  // place in the hook list, and the window goes black — this app has had that
  // bug once already (web/test/hook-tdz.test.ts is the other half of it).
  if (!HAS_BROWSER && !IS_DEMO && !forced) return null;

  const blank = !active?.url || active.url === BLANK;
  // Only while typing: `typed` is null the moment the bar is not being edited,
  // and a completion list over a page you are reading is a list in the way.
  const tips = typed !== null && typed.trim() ? suggest(places ?? [], typed) : [];
  // A new tab shows the PLACEHOLDER, not the word "blank". `about:blank` is
  // where a new tab genuinely is, and displayUrl trims it to "blank", which
  // read as the name of a page nobody asked for.
  /* ------------------------------------------------------------ the shelf */

  /** The live tab showing this address, if there is one. A kept page and an open
   *  page are the same page — the shelf entry is where it is DRAWN, and the dot
   *  on it says whether anything is loaded behind it. */
  /** The live tab for a kept page — by identity first, so a kept page that has
   *  followed a link is still the same tab. See boundItem. */
  const liveFor = (item: ShelfItem): BrowserTab | undefined => tabForItem(tabs, item, shelf);

  /**
   * Open a kept page.
   *
   * Already open: show it, wherever it has wandered to. Open and pressed AGAIN
   * while it is the one on screen: take it back to the address it was kept at —
   * which is the only way back once you have followed three links, and is what
   * a pinned tab does everywhere else.
   */
  const openShelf = (item: ShelfItem) => {
    const live = liveFor(item);
    if (live) {
      if (live.id === activeId && !sameUrl(live.url, item.url)) {
        const el = els.current.get(live.id);
        /*
         * `.catch`, NOT try/catch. `loadURL` returns a promise and a
         * synchronous try cannot catch its rejection — so every interrupted
         * navigation escaped as an unhandled rejection. Seen in his own
         * DevTools: seventy-nine of "Uncaught (in promise) …
         * GUEST_VIEW_MANAGER_CALL … ERR_ABORTED (-3)", next to a browser view
         * that had come up blank.
         *
         * ERR_ABORTED is the ordinary case, not a fault: it is what Chromium
         * calls the navigation this one just replaced. The driver documents
         * that two files over; this call site never got the memo.
         */
        void el?.loadURL(item.url).catch(() => { /* replaced, or the guest went away */ });
        patch(live.id, { url: item.url, loading: true, failed: null });
        return;
      }
      // Adopt it, so following a link from here keeps it in its folder rather
      // than dropping it into the loose list.
      if (!live.shelfId) patch(live.id, { shelfId: item.id });
      show(live.id);
      return;
    }
    open(item.url, activeId, profile, item.id);
  };

  /** Keep a page: from a tab, or from a shelf item being moved. Everything the
   *  shelf shows before anything is loaded — the name and the icon — is taken
   *  now, because a kept page has to read while it is asleep. */
  const keep = (what: { kind: "item" | "tab"; id: string }, spot: ShelfSpot, index?: number) => {
    editShelf((sh) => {
      if (what.kind === "item") {
        const item = allItems(sh).find((i) => i.id === what.id);
        return item ? place(sh, item, spot, index) : sh;
      }
      const tab = tabs.find((t) => t.id === what.id);
      if (!tab || !tab.url || tab.url === BLANK) return sh;
      const already = findByUrl(sh, tab.url);
      return place(sh, already ?? shelfItem(tab.url, tabLabel(tab), tab.icon), spot, index);
    });
  };

  /** The tabs the session list should draw: the ones that are not a kept page.
   *  By identity, not by address — see looseTabs in browserShelf.ts, and the
   *  bug it fixes. */
  /* Blank tabs are not pages — see isBlank. The middle of the screen already
     says "Ctrl+T, or the address on the right"; a row saying "New tab" under a
     list of real ones is that sentence again, in the wrong place. */
  const loose = listable(looseOf(tabs, shelf));

  /*
   * THE SPACES, AS FOLDERS.
   *
   * One folder per identity with that identity's pages inside it, because with
   * ten agents working at once "whose is this page" is the only question the
   * bar is asked. Grouping happens HERE and not in `loose`: every pair keeps
   * the index the tab really has in `loose`, which is what every drop target is
   * measured in — reordering the array itself would have moved a hand-dragged
   * tab somewhere else.
   */
  const spaces = (() => {
    const by = new Map<string, { t: (typeof loose)[number]; n: number }[]>();
    loose.forEach((t, n) => {
      const k = t.profile || "";
      const got = by.get(k);
      if (got) got.push({ t, n });
      else by.set(k, [{ t, n }]);
    });
    /* The space you are in is drawn even when it holds nothing yet. Otherwise
       a fresh window is an empty bar that cannot answer the one question it
       exists to answer — where the next page will open. */
    if (!by.has(profile)) by.set(profile, []);
    return [...by.entries()]
      .map(([id, rows]) => ({ id, rows, name: profileName(profiles, id) }))
      /* Default first — it is the one that is always there — and the rest by
         name, in an order that does not move under the pointer when the space
         you are in changes. */
      .sort((a, b) => (a.id ? 1 : 0) - (b.id ? 1 : 0) || a.name.localeCompare(b.name));
  })();

  /* The refs the keyboard reads, kept current on every render. Assigned rather
     than set in an effect: a chord pressed between a render and its effects
     would otherwise act on the state before last. */
  modeRef.current = mode;
  activeIdRef.current = activeId;
  shelfRef.current = shelf;

  /* ------------------------------------------------------------ the box */

  /*
   * What the address box offers, in the order it offers it.
   *
   * The tabs you already have OPEN come first, and choosing one jumps to it
   * rather than loading a second copy — the single most useful thing a box like
   * this does, and the thing a plain history list cannot do. Then what is on
   * the shelf, then history and past searches, which is what `suggest` already
   * knew how to rank.
   */
  const omniQuery = (typed ?? "").trim().toLowerCase();
  const omniHits = (): { key: string; kind: "tab" | "kept" | "tip"; label: string; sub: string; run: () => void }[] => {
    if (!omniQuery) return [];
    const hit = (hay: string) => hay.toLowerCase().includes(omniQuery);
    const out: { key: string; kind: "tab" | "kept" | "tip"; label: string; sub: string; run: () => void }[] = [];
    for (const t of tabs) {
      if (!hit(`${t.url} ${tabLabel(t)}`)) continue;
      out.push({ key: `t:${t.id}`, kind: "tab", label: tabLabel(t), sub: displayUrl(t.url), run: () => show(t.id) });
      if (out.length >= 3) break;
    }
    for (const i of allItems(shelf)) {
      if (out.length >= 6 || !hit(`${i.url} ${i.title}`)) continue;
      if (out.some((r) => r.sub === displayUrl(i.url))) continue;
      out.push({ key: `k:${i.id}`, kind: "kept", label: i.title || displayUrl(i.url), sub: displayUrl(i.url), run: () => openShelf(i) });
    }
    for (const t of tips) {
      if (out.length >= 9) break;
      if (out.some((r) => r.sub === displayUrl(t.url))) continue;
      out.push({
        key: `h:${t.url}`, kind: "tip",
        label: t.why === "search" ? (t.query ?? t.url) : (t.title || displayUrl(t.url)),
        sub: t.why === "search" ? "search" : displayUrl(t.url),
        run: () => runOmni(t.url),
      });
    }
    return out;
  };

  /** Where a chosen address goes: this tab when the box was opened on the
   *  address, a new one when it was opened as a new tab. */
  const runOmni = (raw: string) => {
    const next = raw === BLANK ? BLANK : normalizeNavigationUrl(raw, searchEngine());
    if (!next) return;
    if (omni === "new") open(next, activeId, profile);
    else go(next);
    setOmni(null); setTyped(null); setHint(-1);
  };

  /* --------------------------------------------------------- drag and drop */

  /*
   * Arranging the shelf is dragging, and only dragging.
   *
   * No "move to…" menus: the place you drop a page IS the instruction, which is
   * the one part of this the mockup was explicit about. HTML5 drag rather than
   * pointer maths because the rows are ordinary elements in a scroller, and a
   * hand-rolled drag inside a scroller is how you end up reimplementing
   * auto-scroll badly.
   */
  /**
   * Press, move, drop.
   *
   * The pointer is captured on the row, so the events keep coming even when the
   * pointer crosses the page — a `<webview>` is another process and anything
   * that leaves this document's hands over one never comes back. What is under
   * the pointer is asked of the DOM on every move (`elementFromPoint`) rather
   * than remembered, because the shelf redraws itself as it goes.
   */
  const pressProps = (kind: "item" | "tab", id: string, label: string) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      /*
       * A press that starts on a button belongs to the button.
       *
       * This row takes POINTER CAPTURE to drag, and capture retargets the click
       * that follows: it is dispatched at the capturing element rather than at
       * the thing under the finger, so pressing the × inside a row ran the
       * row's own onClick and never the button's. That is what "the X still
       * does not close it" was — the close was fine, the click never reached it.
       */
      if ((e.target as HTMLElement | null)?.closest?.("button")) return;
      const from = { x: e.clientX, y: e.clientY };
      const node = e.currentTarget as HTMLElement;
      try { node.setPointerCapture(e.pointerId); } catch { /* the pointer is gone already */ }
      let started = false;
      const under = (x: number, y: number): DropAt | null => {
        const hit = document.elementFromPoint(x, y)?.closest("[data-drop-to]") ?? null;
        const at = hit ? parseDrop((n) => hit.getAttribute(n)) : null;
        if (!at || at.index == null) return at;
        /* Which HALF of the row. Dropping on the top half lands above it and on
           the bottom half below — without that, every drop onto a row means
           "before this one" and a list can never be added to at the end. */
        const r = (hit as HTMLElement).getBoundingClientRect();
        /* Rows split top/bottom; the shortcuts grid splits left/right, because
           in a grid "before" is to the left and a vertical midpoint would put
           the tile in the row above. The element says which it is. */
        const across = hit!.getAttribute("data-drop-axis") === "x";
        const before = across
          ? dropsBefore({ top: r.left, height: r.width }, x)
          : dropsBefore(r, y);
        return before ? at : { ...at, index: at.index + 1 };
      };
      const move = (ev: PointerEvent) => {
        const at = { x: ev.clientX, y: ev.clientY };
        if (!started && !isDrag(from, at)) return;
        if (!started) {
          /* A drag is not a selection. Without this the pointer sweeping across
             a row highlights its title in blue and you finish the drag holding a
             selection instead of a page. `pointerdown` cannot be prevented for
             this — that would swallow the click the same row needs. */
          document.body.style.userSelect = "none";
          window.getSelection()?.removeAllRanges();
        }
        started = true;
        dragged.current = true;
        setCarry({ kind, id, label, x: at.x, y: at.y, at: under(at.x, at.y) });
      };
      const up = (ev: PointerEvent) => {
        document.body.style.userSelect = "";
        // Let go of the pointer before the click is dispatched, or the click
        // keeps being retargeted at this row — see the note above.
        try { node.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
        node.removeEventListener("pointermove", move);
        node.removeEventListener("pointerup", up);
        node.removeEventListener("pointercancel", up);
        setCarry(null);
        if (!started) return;
        const at = under(ev.clientX, ev.clientY);
        if (at) drop({ kind, id }, at);
        // The click that follows a drag is not a click. Cleared a tick later,
        // once that click has been and gone.
        setTimeout(() => { dragged.current = false; }, 0);
      };
      node.addEventListener("pointermove", move);
      node.addEventListener("pointerup", up);
      node.addEventListener("pointercancel", up);
    },
  });

  /**
   * Close the page in front of you.
   *
   * A kept page keeps its entry: the point of closing it is the guest and its
   * processes, not the address — and without a word on screen, "the tab is
   * still in the folder" reads as the close having failed. Which is exactly
   * what it read as.
   */
  const closeHere = () => {
    const t = tabsRef.current.find((x) => x.id === activeIdRef.current);
    if (!t) return;
    const kept = findByUrl(shelfRef.current, t.url);
    close(t.id);
    if (kept) say("Page closed — it stays on the shelf");
  };

  /** The last one back, and the one before that, and so on. */
  const reopen = () => {
    const last = closed.current[0];
    if (!last) { say("Nothing closed to bring back"); return; }
    closed.current = closed.current.slice(1);
    open(last.url, activeId, last.profile);
  };

  /**
   * Find the other browser and read its sidebar.
   *
   * Zen only, and not for want of ambition: it is the one that keeps spaces,
   * folders and pins in a file of its own. Chrome's "pinned tabs" are a window
   * state with no names and no groups, and Firefox proper has no sidebar to
   * take.
   */
  const bringSidebar = async () => {
    const found = await cookieSources();
    const zen = (found.sources ?? []).filter((x) => x.id.startsWith("zen:"));
    if (!zen.length) { say(found.error || "No Zen profile on this machine"); return; }
    const src = zen[0]!;
    const got = await browserShelfRead(src.id);
    if (!got.ok || !got.shelf) { say(got.error || "That sidebar could not be read"); return; }
    const sh = got.shelf;
    if (!sh.items.length) { say(`${src.label} has nothing pinned to import`); return; }
    setBringing({ label: src.label, shelf: sh, space: sh.spaces[0]?.id ?? "" });
  };

  reopenRef.current = reopen;
  closeHereRef.current = closeHere;
  stepTabRef.current = (forward) => show(stepTab(tabs, activeId, forward ? 1 : -1));
  elRef.current = el;

  /* ------------------------------------------------------------ find */

  /** Run the search as it stands. Every path goes through here so the options
   *  and the text can never disagree with what the page is highlighting. */
  const runFind = (text: string, opts: { matchCase: boolean; wholeWords: boolean }) => {
    const w = el();
    if (!w) return;
    try {
      if (!text) { w.stopFindInPage("clearSelection"); setFound(null); return; }
      w.findInPage(text, { matchCase: opts.matchCase, wordStart: opts.wholeWords });
    } catch { /* no guest yet */ }
  };

  const step = (forward: boolean) => {
    const w = el();
    if (!w || !find) return;
    try { w.findInPage(find, { findNext: true, forward, matchCase: findOpts.matchCase, wordStart: findOpts.wholeWords }); }
    catch { /* gone */ }
  };

  const closeFind = () => {
    try { el()?.stopFindInPage("clearSelection"); } catch { /* gone */ }
    setFind(null);
    setFound(null);
  };

  /** Whether a split is actually on screen: both halves have to exist, and the
   *  second one must not be the first. A tab that was closed leaves the state
   *  behind, and a pane pointing at nothing is a black rectangle. */
  const split = !!splitId && splitId !== activeId && tabs.some((t) => t.id === splitId && !t.asleep);

  /** Put a page beside this one. */
  const splitWith = (id: string) => { if (id !== activeId) setSplitId(id); };

  /** …and a NEW page beside it. Not `open`, which makes what it opens active:
   *  the new half of a split goes beside the one you are on, and the one you
   *  are on is the one the bar is talking to. */
  const openBeside = (url: string) => {
    const r = addTab(tabs, url, activeId, profile);
    if ("error" in r) { say(r.error); return; }
    setTabs(r.tabs);
    setSplitId(r.tab.id);
  };

  /** The whole page, scroll and all, onto the clipboard. */
  const shootFullPage = async (how: "copy" | "save") => {
    say("Capturing the whole page…");
    const r = await captureFullPage(how);
    if (!r.ok) { say(r.error || "That page could not be captured"); return; }
    const size = `${r.width}×${r.height}`;
    const cut = r.cut ? ", cut at Chromium's limit" : "";
    say(how === "save" ? `Whole page saved to ${r.path}${cut}` : `Whole page copied — ${size}${cut}`);
  };

  /** A new folder, opened straight into its name. Minted here rather than
   *  inside the shelf update so the id is known before the tree is rebuilt —
   *  you cannot select what you cannot name. */
  const newFolder = (parentId?: string) => {
    const f = shelfFolder("New folder");
    editShelf((sh) => insertFolder(sh, f, parentId));
    setRenaming({ id: f.id, name: f.name });
  };

  /** What a landing means. The shelf's places are a `keep`; the tab list is the
   *  way back off the shelf, and reordering the tabs themselves. */
  const drop = (what: { kind: "item" | "tab"; id: string }, at: DropAt) => {
    if (at.spot.to !== "tabs") { keep(what, at.spot, at.index); return; }
    if (what.kind === "item") {
      const item = allItems(shelf).find((i) => i.id === what.id);
      if (!item) return;
      // Off the shelf and into the session: if it is loaded, that tab is now
      // just a tab; if it is not, it opens as one. Either way the entry goes,
      // because leaving it would be a page in two lists again.
      const live = liveFor(item);
      editShelf((sh) => removeItem(sh, item.id));
      if (!live) open(item.url, activeId, profile);
      return;
    }
    setTabs((prev) => {
      const from = prev.findIndex((t) => t.id === what.id);
      if (from < 0) return prev;
      const rest = prev.filter((t) => t.id !== what.id);
      const to = at.index == null ? rest.length : Math.max(0, Math.min(rest.length, at.index - (at.index > from ? 1 : 0)));
      return [...rest.slice(0, to), prev[from]!, ...rest.slice(to)];
    });
  };

  /** What the row under the pointer would do, for the highlight. */
  const overKey = carry?.at
    ? (carry.at.spot.to === "folder" ? `f:${carry.at.spot.id}` : carry.at.spot.to)
    : null;

  /**
   * The line where it would land.
   *
   * The ghost says WHICH list; this says WHERE in it. Both, because a ghost
   * following the pointer cannot tell you the difference between third and
   * fourth, and a list of nine kept pages is mostly made of that difference.
   */
  const marks = (to: string, id: string | null, n: number): boolean => {
    const at = carry?.at;
    if (!at || at.index !== n) return false;
    if (at.spot.to !== to) return false;
    return at.spot.to !== "folder" || at.spot.id === id;
  };

  const line = (to: string, id: string | null, n: number) => (marks(to, id, n)
    ? <div key={`line-${to}-${id}-${n}`} className="rounded-full" style={{ height: 2, margin: "1px 4px", background: "var(--primary-hover)" }} />
    : null);

  const lit = (key: string) => (overKey === key
    ? { background: "color-mix(in srgb, var(--primary) 14%, transparent)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--primary) 55%, transparent)" }
    : undefined);

  /* ------------------------------------------------------------- the shelf */

  const shelfRow = (item: ShelfItem, depth: number, where?: { to: "loose" | "folder" | "essentials"; id?: string; index: number }) => {
    const live = liveFor(item);
    const on = !!live && live.id === activeId;
    return (
      <div key={item.id} {...pressProps("item", item.id, item.title || displayUrl(item.url))}
        {...(where ? { "data-drop-to": where.to, "data-drop-id": where.id ?? undefined, "data-drop-index": String(where.index) } : null)}
        onContextMenu={(e) => { e.preventDefault(); setMenuAt({ x: e.clientX, y: e.clientY, kind: "item", id: item.id }); }}
        onClick={() => { if (!dragged.current) openShelf(item); }}
        onMouseDown={(e) => { if (e.button === 1 && live) { e.preventDefault(); close(live.id); } }}
        title={item.url}
        className="group flex items-center gap-2 rounded-md px-1.5 py-1 cursor-default min-w-0"
        style={{
          marginLeft: depth * 9,
          background: on ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent",
          boxShadow: on ? "inset 2px 0 0 var(--primary-hover)" : undefined,
          color: on ? "var(--text)" : "var(--text3)",
          opacity: live ? 1 : 0.78,
        }}>
        <Favicon src={item.icon} />
        <span className="min-w-0 flex-1 truncate text-[11px]">{item.title || displayUrl(item.url)}</span>
        {/* Loaded right now. A kept page with nothing behind it costs nothing —
            it is an address until you press it — and this is the only thing on
            the row that says which of the two it is. */}
        {live && <span aria-hidden title="loaded" className="shrink-0 rounded-full" style={{ width: 5, height: 5, background: "var(--success)" }} />}
        {/* Off the shelf, and DOWN — not gone.
            His words: the × should move it to the ordinary tabs below. A page
            you un-keep is a page you are still reading; closing it would be a
            different button, and that one is middle-click. The tab is marked
            deliberately un-kept so no other entry with the same address adopts
            it back the moment it is drawn. */}
        <button onClick={(e) => {
          e.stopPropagation();
          editShelf((sh) => removeItem(sh, item.id));
          if (live) patch(live.id, { shelfId: "" });
        }}
          aria-label={`Take ${item.title || item.url} off the shelf`}
          title={live ? "Take it off the shelf — the page stays open below" : "Take it off the shelf"}
          /* Bigger, and in a box: at 20px with a 12px glyph it read as a speck
             on a row of text, and this is the control that changes what the
             sidebar holds. */
          className="agx-x shrink-0 grid place-items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 rounded-md"
          style={{ width: 24, height: 24 }}><CloseIcon size={ICON.md} /></button>
      </div>
    );
  };

  const shelfTree = (folders: ShelfFolder[], depth: number): React.ReactNode => folders.map((f) => (
    <div key={f.id} className="min-w-0">
      <div data-drop-to="folder" data-drop-id={f.id}
        onContextMenu={(e) => { e.preventDefault(); setMenuAt({ x: e.clientX, y: e.clientY, kind: "folder", id: f.id }); }}
        /* A folded folder shows what is in it under the pointer, the way the
           mockup drew it: for looking, or for jumping to one, without having to
           unfold and fold again. */
        onMouseEnter={(e) => {
          if (f.open || carry) return;
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setPeep({ id: f.id, top: r.top, right: window.innerWidth - r.left + 6 });
        }}
        onMouseLeave={() => setPeep((v) => (v?.id === f.id ? null : v))}
        className="group flex items-center gap-1.5 rounded-md px-1.5 py-1 min-w-0"
        style={{ marginLeft: depth * 9, ...lit(`f:${f.id}`) }}>
        <button onClick={() => editShelf((sh) => toggleFolder(sh, f.id))}
          aria-label={f.open ? `Fold ${f.name}` : `Unfold ${f.name}`}
          className="shrink-0 grid place-items-center rounded"
          style={{ width: 18, height: 18, color: f.open ? "var(--text3)" : "var(--text4)" }}>
          <FolderIcon open={f.open} />
        </button>
        {renaming?.id === f.id ? (
          <input autoFocus value={renaming.name}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setRenaming({ id: f.id, name: e.target.value })}
            onBlur={() => { editShelf((sh) => renameFolder(sh, f.id, renaming.name)); setRenaming(null); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.currentTarget.blur(); }
              if (e.key === "Escape") { e.stopPropagation(); setRenaming(null); }
            }}
            className="flex-1 min-w-0 text-[10.5px] outline-none bg-transparent"
            style={{ color: "var(--text)" }} />
        ) : (
          <button onDoubleClick={() => setRenaming({ id: f.id, name: f.name })}
            onClick={() => editShelf((sh) => toggleFolder(sh, f.id))}
            title={`${f.name} — double-click to rename`}
            className="flex-1 min-w-0 truncate text-left text-[10px] uppercase tracking-[0.1em]"
            style={{ color: "var(--text3)" }}>{f.name}</button>
        )}
        <span className="shrink-0 text-[9.5px] tabular-nums" style={{ color: "var(--text4)" }}>{folderCount(f)}</span>
        <button onClick={() => editShelf((sh) => removeFolder(sh, f.id))}
          aria-label={`Delete the folder ${f.name}`} title="Delete the folder. What is in it goes back to the pins below."
          className="shrink-0 grid place-items-center opacity-0 group-hover:opacity-100 rounded"
          style={{ color: "var(--text3)", width: 20, height: 20 }}><CloseIcon size={ICON.xs} /></button>
      </div>
      {/*
        * Folded, but not blind.
        *
        * A page that is LOADED inside a folded folder was invisible: it is not
        * in the session list either — one page, one row — so opening it looked
        * like the tab had gone nowhere. Zen keeps the active one visible for
        * the same reason; this keeps every loaded one, which is at most a
        * handful and is the set you are actually working in.
        */}
      {!f.open && f.items.filter((i) => liveFor(i)).map((i) => shelfRow(i, depth + 1))}
      {f.open && (
        <div style={{ marginLeft: depth * 9 + 8, borderLeft: "1px solid color-mix(in srgb, var(--border) 35%, transparent)", paddingLeft: 4 }}>
          {f.items.map((i, n) => (
            <div key={i.id}>{line("folder", f.id, n)}{shelfRow(i, 0, { to: "folder", id: f.id, index: n })}</div>
          ))}
          {line("folder", f.id, f.items.length)}
          {shelfTree(f.folders, 0)}
        </div>
      )}
    </div>
  ));

  /*
   * The tools, drawn in the window's own strip.
   *
   * They were a second row inside a 228px column while the top of the window
   * was empty across the whole middle of the screen. A portal rather than
   * plumbing them up through the workspace: they belong to this panel — they
   * act on the page it is showing — and only their PIXELS live up there.
   */
  /* The menu, drawn in a portal and positioned from the button. `absolute`
     under it was the bug: the bar is a column with its own stacking context and
     the menu was clipped away entirely, so pressing ⋯ did nothing at all. */
  /**
   * The menu behind ⋯, and everything that was a row of icons.
   *
   * Seven tools were a second row inside a 228px column, then a second row in
   * the window's own strip where they sat over every other view's title bar.
   * They are entries here now: one press away, named rather than guessed at,
   * and out of the way of the thing you came to look at.
   *
   * Portalled and positioned from the button. `absolute` under it was the bug
   * that made ⋯ do nothing at all — the bar is a column with its own stacking
   * context, and the menu was clipped away inside it.
   */
  const menuRow = (icon: React.ReactNode, label: string, on?: boolean) => (
    <span className="flex items-center gap-2.5">
      <span className="shrink-0 grid place-items-center" style={{ width: 15, height: 15, color: on ? "var(--primary-hover)" : "var(--text3)" }}>{icon}</span>
      <span className="flex-1" style={on ? { color: "var(--text)" } : undefined}>{label}</span>
    </span>
  );

  const barMenu = menuOpen && menuAtXY ? (
    <Portal>
      <div className="fixed inset-0" style={{ zIndex: 40 }} onClick={() => setMenuOpen(false)} />
      <div className="fixed rounded-lg text-[11px] py-1 shadow-2xl"
        style={{ top: menuAtXY.top, right: menuAtXY.right, zIndex: 41, width: Math.max(230, Math.min(320, sideW - 8)), background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)" }}>
        {[
          { key: "home", node: menuRow(<HomeIcon size={14} />, "Home"), hint: "", run: () => go(homePage()) },
          { key: "new", node: menuRow(<span style={{ fontSize: 13, lineHeight: 1 }}>+</span>, "New tab"), hint: "Ctrl+T", run: () => setOmni("new") },
          { key: "keep", node: menuRow(<FolderIcon size={13} />, "Keep this page"), hint: "", run: () => { if (activeId) keep({ kind: "tab", id: activeId }, { to: "loose" }); } },
          { key: "folder", node: menuRow(<FolderIcon size={13} />, "New folder"), hint: "", run: () => newFolder() },
          { key: "space", node: menuRow(<SpaceIcon size={13} />, "New space"), hint: "", run: () => setNaming("") },
          { key: "split", node: menuRow(<SplitIcon size={13} />, split ? "Close the split" : "Split with a new tab"), hint: "Ctrl+Alt+U", run: () => {
            if (split) { setSplitId(null); return; }
            /* A split needs a second page, and the second page of a new split
               is a new one — the same thing Zen's own entry does. */
            openBeside(homePage());
          } },
          { key: "sep1", sep: true },
          { key: "shot", node: menuRow(<CameraIcon size={14} />, "Take a screenshot", mode === "shoot"), hint: "Ctrl+Shift+S", run: () => setMode((m) => (m === "shoot" ? "none" : "shoot")) },
          { key: "find", node: menuRow(<SearchIcon size={14} />, "Find on this page", find !== null), hint: "Ctrl+F", run: () => { setFind((f) => (f === null ? "" : null)); setTimeout(() => findRef.current?.focus(), 0); } },
          { key: "pick", node: menuRow(<TargetIcon size={14} />, "Point at an element", mode === "pick"), hint: "", run: () => setMode((m) => (m === "pick" ? "none" : "pick")) },
          { key: "note", node: menuRow(<NoteIcon size={14} />, "Tell an agent about an element", mode === "feedback"), hint: "", run: () => setMode((m) => (m === "feedback" ? "none" : "feedback")) },
          { key: "draw", node: menuRow(<PenIcon size={14} />, "Draw on the page", mode === "draw"), hint: "", run: () => setMode((m) => (m === "draw" ? "none" : "draw")) },
          { key: "dev", node: menuRow(<CodeIcon size={14} />, "Developer tools", !!dt), hint: "", run: () => { if (dt) { setDt(null); return; } if (activeId) setDt({ tab: activeId }); } },
          { key: "sep2", sep: true },
          { key: "dup", node: menuRow(null, "Duplicate this tab"), hint: "", run: () => active && open(active.url, active.id) },
          { key: "hard", node: menuRow(null, "Reload, ignoring the cache"), hint: "", run: () => { try { el()?.reloadIgnoringCache(); } catch { el()?.reload(); } } },
          { key: "copy", node: menuRow(null, "Copy the address"), hint: "", run: () => { void navigator.clipboard.writeText(active?.url ?? ""); say("Address copied"); } },
          { key: "ext", node: menuRow(<ExternalIcon size={14} />, "Open in your own browser"), hint: "", run: () => {
            const u = active?.url;
            if (!u || u === BLANK) { say("There is no page to open"); return; }
            window.open(u, "_blank");
            say("Opened in your browser");
          } },
          { key: "zoom", node: menuRow(null, "Zoom back to 100%"), hint: "Ctrl+0", run: () => applyZoom(0) },
          { key: "hide", node: menuRow(<PanelIcon size={14} />, "Hide this bar"), hint: "Ctrl+S", run: () => { setSideOpen(false); setSidebarOpen(false); } },
        ].map((it) => (it.sep ? (
          <div key={it.key} className="my-1" style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }} />
        ) : (
          <button key={it.key} onClick={() => { setMenuOpen(false); it.run?.(); }}
            className="w-full text-left px-3 py-1.5 flex items-center gap-3" style={{ color: "var(--text2)" }}>
            <span className="flex-1">{it.node}</span>
            {it.hint && <span className="text-[9.5px] shrink-0" style={{ color: "var(--text4)" }}>{it.hint}</span>}
          </button>
        )))}
        <div className="my-1" style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }} />
        <div className="px-3 pt-1 pb-0.5 text-[9px] tracking-wider uppercase" style={{ color: "var(--text4)" }}>Viewport</div>
        {VIEWPORTS.map((v) => (
          <button key={v.name} onClick={() => { setMenuOpen(false); setViewport(v); }}
            className="w-full text-left px-3 py-1.5 flex items-center gap-3"
            style={{ color: v.name === viewport.name ? "var(--text)" : "var(--text2)" }}>
            <span className="w-3 shrink-0">{v.name === viewport.name ? "✓" : ""}</span>
            <span className="flex-1">{v.name}</span>
            {v.width ? <span className="text-[9.5px] tabular-nums" style={{ color: "var(--text4)" }}>{v.width}px</span> : null}
          </button>
        ))}
        <div className="my-1" style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }} />
        {[
          { label: "Import a sidebar from Zen…", run: () => { void bringSidebar(); } },
          { label: "Import logins from a browser…", run: () => openSettings("browser") },
          { label: "Home page and search engine…", run: () => openSettings("browser") },
        ].map((it) => (
          <button key={it.label} onClick={() => { setMenuOpen(false); it.run(); }}
            className="w-full text-left px-3 py-1.5" style={{ color: "var(--text2)" }}>{it.label}</button>
        ))}
      </div>
    </Portal>
  ) : null;

  const sideBody = (
    <div className="flex flex-col h-full min-h-0"
      style={{ background: "color-mix(in srgb, var(--bg2) 65%, var(--bg))", borderLeft: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }}>
      {/*
        * The head of the bar, laid out the way Zen lays its own out: the menu
        * and the collapse on the left, the three navigation controls on the
        * right, and the address on a line of its own underneath where it has the
        * whole width to be read in.
        *
        * The tools used to be a row of seven here, and then a row of seven in
        * the window's strip, where they sat over every other view's title bar.
        * They are in the menu now — one press away, and out of the way.
        */}
      <div className="flex items-center gap-0.5 px-1.5 pt-1.5 shrink-0">
        <div className="shrink-0">
          <button ref={moreBtn} title="Menu" aria-label="Menu"
            onClick={() => {
              const r = moreBtn.current?.getBoundingClientRect();
              /* Pinned to the bar's own column: wide enough for the labels,
                 never wider than the bar, so it never lands on the inspector —
                 which is a view floating above this document and cannot be
                 covered by anything in it. */
              setMenuAtXY(r ? { top: r.bottom + 6, right: 6 } : null);
              setMenuOpen((v) => !v);
            }}
            className="agx-btn shrink-0 rounded-md flex items-center justify-center"
            style={{
              width: 24, height: 24,
              color: menuOpen ? "var(--primary-hover)" : "var(--text3)",
              background: menuOpen ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent",
            }}><MoreIcon /></button>
        </div>
        <SideTool label="Hide this bar (Ctrl+S)"
          onClick={() => { setSideOpen(false); setSidebarOpen(false); }}><PanelIcon /></SideTool>
        <span className="flex-1" />
        <SideTool label="Back" onClick={() => el()?.goBack()} disabled={!active?.canBack}><BackIcon /></SideTool>
        <SideTool label="Forward" onClick={() => el()?.goForward()} disabled={!active?.canForward}><ForwardIcon /></SideTool>
        <SideTool label={active?.loading ? "Stop" : "Reload"}
          onClick={() => (active?.loading ? el()?.stop() : el()?.reload())}>{active?.loading ? <StopIcon /> : <ReloadIcon />}</SideTool>
      </div>
      {barMenu}
      <div className="px-1.5 pt-1 pb-1.5 shrink-0 flex items-center gap-1">
        <button onClick={() => setOmni("edit")}
          title={active?.url || "Type an address"}
          className="min-w-0 flex-1 flex items-center gap-1.5 px-2 rounded-lg text-left"
          style={{
            height: 26, background: "color-mix(in srgb, var(--bg3) 45%, transparent)",
            border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)",
          }}>
          <span className="shrink-0 flex items-center" style={{ color: active?.url.startsWith("https://") ? "var(--success)" : "var(--text3)" }}>
            {active?.url.startsWith("https://") ? <LockIcon /> : <GlobeIcon />}
          </span>
          <span className="flex-1 min-w-0 truncate text-[11px]" style={{ color: blank ? "var(--text4)" : "var(--text2)" }}>
            {blank ? "Type an address" : displayUrl(active!.url)}
          </span>
        </button>
        {/*
          THE WAY BACK FROM A ZOOM YOU CANNOT UNDO.
          This was a <span> inside the address button — a number with no way to
          act on it. Reported at 358%, which is the CEILING (`1.2 ** ZOOM_MAX`):
          "I cannot adjust the browser's zoom". Ctrl+0 does not help there,
          because once the pointer and the focus are inside the <webview> the
          keys never reach this window at all — the same measured fact that made
          `cdp Input.*` refuse. So the number is the control: one click and the
          page is back at 100%. Its own button and a sibling of the address bar,
          because a button inside a button is not a thing the DOM will honour.
        */}
        {zoom !== 0 && (
          <button onClick={() => applyZoom(0)}
            title={`The page is at ${zoomPercent(zoom)}% — click to put it back to 100%`}
            aria-label={`Page zoom ${zoomPercent(zoom)} per cent. Back to 100%`}
            className="shrink-0 grid place-items-center text-[9px] tabular-nums rounded"
            style={{
              minWidth: 34, height: 20, color: "var(--text2)",
              background: "color-mix(in srgb, var(--text) 10%, transparent)",
            }}>{zoomPercent(zoom)}%</button>
        )}
      </div>

      <div className="agx-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-1.5 pb-1 flex flex-col gap-0.5"
        onContextMenu={(e) => { e.preventDefault(); setMenuAt({ x: e.clientX, y: e.clientY, kind: "bar", id: "" }); }}>
        {/* The grid at the top: the same in every space, and capped at twelve —
            past that it stops being something you read at a glance. Drawn
            whenever there is one OR something is being dragged, so there is
            always somewhere to drop the first one. */}
        {/* No heading over it. A grid of favicons is its own label, and the
            count and the + beside it were two things to read for something the
            drag says better — "6/12" is a number nobody was waiting for. */}
        {/* Drawn when it HOLDS something, or while something is being dragged.
            An empty grid with "drag a page here" under it was 40px of the bar
            spent, every session, on a sentence about a gesture — and the bar is
            for the pages that are open. The drop target still appears the
            moment a drag starts, so the gesture is still discoverable. */}
        {(shelf.essentials.length > 0 || carry) && (
          <>
            <div data-drop-to="essentials"
              className="grid gap-1 rounded-md p-1"
              style={{ gridTemplateColumns: "repeat(4, minmax(0,1fr))", ...lit("ess") }}>
              {shelf.essentials.map((i, n) => {
                const live = liveFor(i);
                const on = !!live && live.id === activeId;
                return (
                  <button key={i.id} {...pressProps("item", i.id, i.title || displayUrl(i.url))}
                    data-drop-to="essentials" data-drop-index={String(n)} data-drop-axis="x"
                    onClick={() => { if (!dragged.current) openShelf(i); }}
                    onMouseDown={(e) => { if (e.button === 1 && live) { e.preventDefault(); close(live.id); } }}
                    onContextMenu={(e) => { e.preventDefault(); editShelf((sh) => removeItem(sh, i.id)); }}
                    title={`${i.title || i.url}\n${i.url}\nRight-click to take it off`}
                    className="grid place-items-center rounded-lg"
                    style={{
                      aspectRatio: "1", minWidth: 0,
                      background: on ? "color-mix(in srgb, var(--primary) 22%, transparent)" : "color-mix(in srgb, var(--text) 6%, transparent)",
                      border: `1px solid ${on ? "color-mix(in srgb, var(--primary) 50%, transparent)" : "color-mix(in srgb, var(--border) 30%, transparent)"}`,
                      boxShadow: marks("essentials", null, n)
                        ? "inset 3px 0 0 var(--primary-hover)"
                        : live ? "inset 0 -2px 0 var(--success)" : undefined,
                    }}><Favicon src={i.icon} /></button>
                );
              })}
              {!shelf.essentials.length && (
                <div className="col-span-4 text-[9.5px] px-1 py-2 text-center" style={{ color: "var(--text4)" }}>
                  drop it here to keep it in every space
                </div>
              )}
            </div>
          </>
        )}

        {/* The folders of THIS space, and the pins that are not in one. */}
        {true && (
          <div className="mt-1.5" style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 25%, transparent)", paddingTop: 4 }}>
            {shelfTree(shelf.folders, 0)}
            <div data-drop-to="loose" className="rounded-md" style={{ minHeight: carry ? 26 : 0, ...lit("loose") }}>
              {shelf.loose.map((i, n) => (
                <div key={i.id}>{line("loose", null, n)}{shelfRow(i, 0, { to: "loose", index: n })}</div>
              ))}
              {line("loose", null, shelf.loose.length)}
              {carry && !shelf.loose.length && (
                <div className="text-[9.5px] px-2 py-1.5" style={{ color: "var(--text4)" }}>drop to keep it here</div>
              )}
            </div>

          </div>
        )}

        <div className="mt-1" style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 25%, transparent)" }} />

        {/* What is open and not kept. Everything on the shelf above is drawn
            there instead — one page, one row. */}
        {/* The list takes a drop too, not only its rows: below the last tab is
            where a hand aims for "put it at the end". */}
        <div data-drop-to="tabs" className="flex flex-col gap-0.5 rounded-md"
          style={{ minHeight: carry ? 30 : 0, ...lit("tabs") }}>
        {/* Sorted so each container's tabs sit together, carrying the ORIGINAL
            index with them: `n` below is where the tab really is in `loose`,
            which is what the drop targets are measured in. Sorting the array
            itself would have made a hand-dragged tab land somewhere else. */}
        {spaces.map(({ id: pid, rows, name }) => {
          /* The default container is not given a hashed hue. `profileHue("")`
             is 0 — a red heading at the top of the bar, which reads as an
             error in a theme where red is the close button and the failed
             build. It gets the app's own violet instead, which is also the
             honest thing to say about it: it is the one that was always
             there. */
          const hue = pid ? profileHue(pid) : 258;
          const shut = folded.has(pid);
          const here = pid === profile;
          /* THE COLOUR IS THE POINT. The dot beside a name was six pixels of
             it; with ten containers open, six pixels is not a thing you read.
             So the identity colours the box, the name, the count, the rail its
             pages hang from and the page you are on inside it — five places
             that agree, and none of them a legend to learn. */
          return (
            <div key={pid || "default"} className="flex flex-col">
              {/* The row is a group so the × can hide until you are on it, and
                  it carries its own context menu: right-clicking a container
                  used to open the BAR's menu — "create space", "create folder",
                  "import a sidebar from Zen" — none of which is about the
                  container under the pointer, and none of which could close it.
                  An agent makes its own container and is supposed to drop it
                  when the work is done; when it does not, the only way to be
                  rid of the leftover was the CLI. */}
              {/* ONE ROW, AND THE × IS PART OF IT.
                  It used to be `absolute right-0.5` over the heading: on hover
                  it landed on top of the page count, which is the shape he has
                  rejected twice now — "that button there, all ugly, all overlapped". So the
                  row is a flex with a slot at its end, the same 20px whether or
                  not a container can be closed, and the heading is laid out
                  inside what is left. Nothing ever moves and nothing overlaps;
                  the only thing hover changes is whether the glyph is drawn. */}
              <div className="group flex items-stretch gap-0.5"
                style={{ height: 24, marginTop: 4 }}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenuAt({ x: e.clientX, y: e.clientY, kind: "space", id: pid }); }}>
              <button onClick={() => foldSpace(pid)}
                title={`${name} — a container: its own tabs, logins and cache. Click to ${shut ? "show" : "fold"} its pages.`}
                className="min-w-0 flex-1 flex items-center gap-1.5 rounded-md px-1.5 select-none"
                style={{
                  /* The space you are in is filled, not outlined: "new tabs
                     open here" is worth a whole row of colour. */
                  background: here ? `hsl(${hue} 62% 50% / 0.18)` : "transparent",
                  boxShadow: here ? `inset 2px 0 0 hsl(${hue} 72% 64%)` : undefined,
                }}>
                {/* The caret says open or shut; the box says what it is. A
                    folder was the wrong glyph for this — a folder is where you
                    filed a page, and this is an identity with walls. */}
                {/* 9px beside the 13px container mark four pixels away — a 1.44×
                    jump inside one control, and 25% under the floor the scale calls
                    the point where a stroked glyph stops resolving. */}
                <span className="shrink-0 grid place-items-center"
                  style={{ width: 12, height: 12, color: `hsl(${hue} 60% 62%)`, transform: shut ? "rotate(-90deg)" : "none" }}>
                  <DownIcon size={ICON.xs} />
                </span>
                <span className="shrink-0 grid place-items-center" style={{ width: 14, height: 14, color: `hsl(${hue} 72% 64%)` }}>
                  <ContainerIcon size={13} />
                </span>
                <span className="min-w-0 flex-1 truncate text-left text-[11px]"
                  style={{ color: `hsl(${hue} 72% 76%)`, fontWeight: 600, letterSpacing: "0.01em" }}>{name}</span>
                <span className="shrink-0 tabular-nums text-[9.5px] rounded px-1"
                  style={{ color: `hsl(${hue} 60% 74%)`, background: `hsl(${hue} 62% 50% / 0.20)` }}>{rows.length}</span>
              </button>
              {/* The slot. Not offered for the default container — it is the
                  ground everything else stands on and there is nowhere to put
                  you if it goes — but the width is held anyway, so every
                  heading in the bar ends at the same x. */}
              {pid ? (
                <button onClick={(e) => { e.stopPropagation(); forgetProfile(pid); }}
                  aria-label={`Close the container ${name}`}
                  title={rows.length
                    ? `Close ${name} — its ${rows.length} page${rows.length === 1 ? "" : "s"} close with it`
                    : `Close ${name} — it has no pages open`}
                  className="agx-x shrink-0 self-center grid place-items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 rounded-md"
                  style={{ width: CLOSE_CELL, height: CLOSE_CELL }}><CloseIcon size={ICON.md} /></button>
              ) : <span className="shrink-0" style={{ width: CLOSE_CELL }} aria-hidden="true" />}
              </div>
              {!shut && (
                /* The pages hang from a rail in their container's colour. The
                   indent is what puts them INSIDE it — the flat list before
                   this had the heading and its pages at the same x, so the
                   grouping was a change of tint and nothing else. */
                <div style={{ marginLeft: 12, paddingLeft: 8, borderLeft: `2px solid hsl(${hue} 58% 56% / 0.32)` }}>
                  {rows.map(({ t, n }) => (
                    <div key={t.id}>
                      {line("tabs", null, n)}
                      <div {...pressProps("tab", t.id, tabLabel(t))}
                        data-drop-to="tabs" data-drop-index={String(n)}
                        onContextMenu={(e) => { e.preventDefault(); setMenuAt({ x: e.clientX, y: e.clientY, kind: "tab", id: t.id }); }}
                        onClick={() => { if (!dragged.current) show(t.id); }}
                        onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); close(t.id); } }}
                        title={t.url || "New tab"}
                        className="group flex items-center gap-2 rounded-md px-1.5 py-1 cursor-default min-w-0"
                        style={{
                          /* Its own space's colour, not the theme's accent: on
                             a bar showing four identities, "which one is this"
                             and "which one am I on" are the same question. */
                          background: t.id === activeId ? `hsl(${hue} 62% 50% / 0.26)` : "transparent",
                          boxShadow: t.id === activeId ? `inset 2px 0 0 hsl(${hue} 75% 66%)` : undefined,
                          color: t.id === activeId ? "var(--text)" : "var(--text3)",
                          opacity: t.asleep ? 0.6 : 1,
                        }}>
                        {/* No dot on the row any more: the rail it hangs from
                            is the same colour and runs the height of the
                            folder, which says it for every page at once. */}
                        {t.loading
                          ? <span className="shrink-0" style={{ color: "var(--text3)" }}><SpinnerIcon /></span>
                          : <Favicon src={t.icon} />}
                        <span className="min-w-0 flex-1 truncate text-[11px]">{tabLabel(t)}</span>
                        {/* Which one is the other half. Without it a split reads as one tab
                            being active and another one being, somehow, also on screen. */}
                        {split && t.id === splitId && (
                          <span className="shrink-0" title="beside the one you are on" style={{ color: "var(--primary-hover)" }}><SplitIcon size={ICON.xs} /></span>
                        )}
                        {/* Same size and the same reddish box as the shelf's ×: one glyph,
                            one meaning, one target big enough to aim at. */}
                        <button onClick={(e) => { e.stopPropagation(); close(t.id); }} aria-label={`Close ${tabLabel(t)}`}
                          title="Close this page"
                          className="agx-x shrink-0 grid place-items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 rounded-md"
                          style={{ width: 24, height: 24 }}><CloseIcon size={ICON.md} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {line("tabs", null, loose.length)}
        {carry && !loose.length && (
          <div className="text-[9.5px] px-2 py-1.5" style={{ color: "var(--text4)" }}>drop to stop keeping it</div>
        )}
        </div>
      </div>

      {/* Adding things lives at the FOOT of the bar, not in the middle of the
          list it adds to. Between the pages and the spaces, which is where a
          hand goes looking for "and one more". */}
      <div className="shrink-0 flex items-center gap-1 px-1.5 pt-1"
        style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 25%, transparent)" }}>
        <button onClick={() => setOmni("new")} title="New tab (Ctrl+T)"
          className="flex-1 min-w-0 flex items-center gap-1.5 px-1.5 py-1 rounded-md text-[10.5px]"
          style={{ color: "var(--text3)" }}>
          <span style={{ fontSize: 12, lineHeight: 1 }}>+</span> New tab
        </button>
        <button onClick={() => newFolder()} title="New folder" aria-label="New folder"
          className="shrink-0 grid place-items-center rounded-md"
          style={{ width: 22, height: 22, color: "var(--text3)" }}><FolderIcon size={13} /></button>
      </div>

      {/* THE STRIP OF SPACES ALONG THE FOOT IS GONE.
          It was a second place saying the same thing as the list above it —
          the same names, the same colours — and the list is where the pages
          are. What it uniquely did, switching space, the list does better: you
          are in the space of the page you are on (see `show`). Naming a new
          one still needs a box, and it appears only while you are naming. */}
      {naming !== null && (
        <div className="shrink-0 px-1.5 py-1.5"
          style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>
          <input autoFocus value={naming} placeholder="Name the space, then Enter"
            onChange={(e) => setNaming(e.target.value)}
            onBlur={() => setNaming(null)}
            onKeyDown={(e) => {
              if (e.key === "Enter") makeProfile(naming);
              if (e.key === "Escape") { e.stopPropagation(); setNaming(null); }
            }}
            className="w-full text-[10.5px] px-2 py-1 rounded-md outline-none"
            style={{ background: "var(--bg2)", color: "var(--text)" }} />
        </div>
      )}
    </div>
  );

  return (
    /*
     * A ROW now, and that is the shape of the whole redesign: the page on the
     * left, and everything that used to be a bar across the top in a column on
     * the right.
     *
     * `relative`, because the address box floats over the page instead of
     * living in a row of its own — a bar that is empty most of the time was
     * 34px of chrome before the page got a pixel.
     */
    <div className="flex h-full min-h-0 outline-none relative" tabIndex={-1}>
      <div className="flex-1 min-w-0 flex flex-col">
      {/*
       * No view header here, and this is the only view without one.
       *
       * Every other panel spends those 48px on controls. This one had nothing
       * to put in them: the page's own title, which the tab strip two rows
       * below was already showing, and a message that appears for three
       * seconds a few times a day. A browser is the one view whose content is
       * a whole other application's chrome — an address bar, a tab strip and
       * a title above them is a third bar of ours before the page gets a
       * pixel, and the page is what you came for.
       *
       * The heading stays for screen readers, which have no rail to read the
       * view's name from (see ViewHeader).
       */}
      <h2 className="sr-only">Browser</h2>

      {/*
        * Find, floating over the page.
        *
        * It used to be a row in the column, so opening it shortened the page and
        * everything jumped — on a long document that is the paragraph you were
        * reading moving out from under you. Over the page, at the bottom, the
        * way every browser does it.
        */}
      {find !== null && (
        <div className="absolute left-1/2 -translate-x-1/2 rounded-xl shadow-2xl px-2.5 py-2 flex flex-col gap-1.5"
          style={{
            bottom: 14, zIndex: 34, minWidth: 460, maxWidth: "min(680px, 92%)",
            background: "color-mix(in srgb, var(--bg2) 96%, black)",
            border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
          }}>
          <div className="flex items-center gap-2">
            <input ref={findRef} value={find}
              onChange={(e) => { setFind(e.target.value); runFind(e.target.value, findOpts); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); step(!e.shiftKey); return; }
                if (e.key === "Escape") { e.preventDefault(); closeFind(); }
              }}
              placeholder="Find in page" spellCheck={false}
              className="flex-1 min-w-0 text-[12px] px-2.5 py-1.5 rounded-lg outline-none bg-transparent"
              style={{ color: "var(--text)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }} />
            {/* The tally, where the eye already is. "0 of 0" is the answer to
                "is this word here at all", and it is the thing the old strip
                could not say. */}
            <span className="shrink-0 text-[10.5px] tabular-nums" style={{ color: found?.of ? "var(--text3)" : "var(--text4)" }}>
              {find.trim() ? `${found?.at ?? 0}/${found?.of ?? 0}` : ""}
            </span>
            <button onClick={() => step(false)} title="Previous match (Shift+Enter)" aria-label="Previous match"
              className="shrink-0 grid place-items-center rounded" style={{ width: 24, height: 24, color: "var(--text3)" }}><UpIcon /></button>
            <button onClick={() => step(true)} title="Next match (Enter)" aria-label="Next match"
              className="shrink-0 grid place-items-center rounded" style={{ width: 24, height: 24, color: "var(--text3)" }}><DownIcon /></button>
            <CloseButton onClick={closeFind} title="Close the search" />
          </div>
          <div className="flex items-center gap-4 px-0.5">
            {([["matchCase", "Match Case"], ["wholeWords", "Whole Words"]] as const).map(([key, label]) => (
              <label key={key} className="flex items-center gap-1.5 text-[10.5px] cursor-default" style={{ color: "var(--text3)" }}>
                <input type="checkbox" checked={findOpts[key]}
                  onChange={(e) => {
                    const next = { ...findOpts, [key]: e.target.checked };
                    setFindOpts(next);
                    runFind(find, next);
                  }} />
                {label}
              </label>
            ))}
            {/* Highlight All and Match Diacritics are Firefox's, and Chromium's
                find has neither: every match is highlighted always, and accents
                are never ignored. Naming options that do nothing would be worse
                than leaving them out. */}
          </div>
        </div>
      )}

      {active?.failed && (
        <div className="px-3 py-2 text-[11px] shrink-0" style={{ color: "var(--warning)" }}>{active.failed}</div>
      )}

      {/* The page and the inspector share what is left of the window: a row when
          the inspector is on the right, a column when it is underneath. The
          inspector is NOT a layer over the page — it takes room, and the page
          reflows into what is left, which is the whole point of docking it. */}
      <div className="flex-1 min-h-0 flex" style={{ flexDirection: dt && dtSide === "right" ? "row" : "column" }}>
      <div className="flex-1 min-h-0 relative" style={{ background: "var(--bg2)" }}>
        {/*
         * What just happened, over the page rather than above it.
         *
         * This lived in the header, which is why the header lived: three
         * seconds of "told the agent about it" was holding a permanent row
         * open. Floating it costs the page nothing when there is nothing to
         * say, and a guest page cannot be drawn over by a sibling, so it sits
         * on the container rather than inside the tab that owns the webview.
         */}
        {/*
          * The address under the pointer, bottom left, exactly where every
          * browser puts it — it is how you find out where a link goes BEFORE
          * you commit to it, which on a page full of trackers and redirects is
          * not a nicety.
          *
          * Over the page rather than in a bar of its own: a permanent row for
          * something that is empty most of the time is the mistake the header
          * above this view was deleted for. `pointer-events: none` so it never
          * swallows a click on whatever it is covering, and no wrapping — a
          * long url is truncated, because two lines of address bouncing the
          * page's bottom corner is worse than the half you cannot read.
          */}
        {hover && (
          <div className="absolute bottom-0 left-0 max-w-[70%] truncate text-[10.5px] px-2 py-1 rounded-tr-md pointer-events-none"
            style={{ zIndex: 20, color: "var(--text2)", background: "var(--bg2)",
              borderTop: "1px solid color-mix(in srgb, var(--text) 12%, transparent)",
              borderRight: "1px solid color-mix(in srgb, var(--text) 12%, transparent)" }}
            title={hover}>{displayUrl(hover)}</div>
        )}
        {note && (
          <div className="agx-zoom-in absolute bottom-3 right-3 text-[10px] px-2.5 py-1.5 rounded-md shadow-lg pointer-events-none"
            style={{ zIndex: 20, color: "var(--warning)", background: "var(--bg2)",
              border: "1px solid color-mix(in srgb, var(--warning) 35%, transparent)" }}>{note}</div>
        )}
        {tabs.map((t) => (
          /*
           * EVERY awake tab mounts a guest, whatever profile it is in.
           *
           * Filtering this list by the profile on screen looks harmless and is
           * not: a tab with no webview has nothing to drive, so an agent's tab
           * in another identity answered "the browser view is not open in this
           * window" for as long as a person was looking somewhere else. The
           * sidebar is where profiles are told apart; this is where pages
           * live. A sleeping tab still renders nothing, which is the saving.
           */
          /*
           * The inactive tabs are hidden; the active one says NOTHING.
           *
           * `visibility` is inherited, and a descendant setting `visible`
           * overrides a hidden ancestor — which is how the first version of
           * this left the page painted on top of the terminal after you
           * switched views. The workspace hides this whole view with
           * `visibility: hidden`, and the active tab has to be free to inherit
           * that. Only the ones this component is hiding get a value.
           */
          /* A sleeping tab renders nothing at all — not a hidden guest, not an
             empty one. The whole saving is that no <webview> exists, so there
             is no element here to hide. */
          t.asleep ? null : (
          <div key={t.id} className="absolute inset-y-0 flex justify-center"
            /* Two panes when split, one otherwise. `visibility` rather than
               unmounting, for the reason above: a guest that is torn down
               loses the page and everything an agent was doing on it. */
            style={split && t.id === activeId
              ? { left: 0, width: `${splitAt * 100}%` }
              : split && t.id === splitId
                ? { left: `${splitAt * 100}%`, right: 0 }
                : { left: 0, right: 0, ...(t.id === activeId ? null : { visibility: "hidden" }) }}>
            <div style={{ width: viewport.width ? `${viewport.width}px` : "100%", height: "100%", maxWidth: "100%" }}>
              {IS_DEMO ? (
                <DemoPage url={t.url || BLANK} />
              ) : (
                <webview
                  ref={bind(t.id) as unknown as React.Ref<HTMLElement>}
                  src={t.url || BLANK}
                  partition={partitionFor(BROWSER_PARTITION, t.profile)}
                  /* A page may ask for a window. What happens to the request is
                     decided in the shell — a sign-in popup gets a real window, a
                     link becomes a tab — but without this attribute the guest
                     cannot ask at all, and `window.open` hands the page a null
                     before anybody gets to choose. */
                  /* A STRING, cast past React's own types, and both halves are
                     measured. `allowpopups={true}` produces "Received `true` for
                     a non-boolean attribute" and renders NO attribute at all —
                     which is why the sign-in stayed blocked after the shell had
                     been taught to allow it. Electron reads the attribute's
                     presence, so "" is what it wants and what React keeps;
                     @types/react says boolean, and it is wrong for this
                     renderer. */
                  {...({ allowpopups: "" } as unknown as { allowpopups?: boolean })}
                  style={{ width: "100%", height: "100%", background: "var(--bg)" }}
                />
              )}
            </div>
          </div>
          )
        ))}

        {/* The seam, and the two things you do to a split: swap which side the
            bar is talking to, or close it. Over the split pane's top corner,
            where they cannot be mistaken for the page's own chrome. */}
        {split && (
          <>
            <div role="separator" aria-orientation="vertical" tabIndex={0}
              aria-label="Drag to share the width"
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") { e.preventDefault(); setSplitAt((v) => Math.max(0.2, v - 0.05)); }
                if (e.key === "ArrowRight") { e.preventDefault(); setSplitAt((v) => Math.min(0.8, v + 0.05)); }
              }}
              onPointerDown={(e) => {
                e.preventDefault();
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                const host = (e.currentTarget as HTMLElement).parentElement?.getBoundingClientRect();
                if (!host) return;
                const move = (ev: PointerEvent) => setSplitAt(Math.max(0.2, Math.min(0.8, (ev.clientX - host.left) / host.width)));
                const up = () => {
                  window.removeEventListener("pointermove", move);
                  window.removeEventListener("pointerup", up);
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", up);
              }}
              className="absolute inset-y-0"
              style={{ left: `calc(${splitAt * 100}% - 3px)`, width: 6, cursor: "col-resize", zIndex: 12, background: "color-mix(in srgb, var(--border) 45%, transparent)" }} />
            <div className="absolute flex items-center gap-1" style={{ left: `calc(${splitAt * 100}% + 8px)`, top: 8, zIndex: 13 }}>
              <button onClick={() => { const other = splitId!; setSplitId(activeId); show(other); }}
                title="Put the bar on this side" aria-label="Swap the sides"
                className="grid place-items-center rounded-md"
                style={{ width: 24, height: 24, background: "var(--bg2)", color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)" }}>⇄</button>
              <CloseButton onClick={() => setSplitId(null)} title="Close the split" hit={24}
                style={{ background: "var(--bg2)", color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)" }} />
            </div>
          </>
        )}

        {/* Somewhere to start. A blank guest paints a black rectangle the size
            of the window, which is what made this view read as broken rather
            than as empty. */}
        {blank && !active?.failed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 pointer-events-none"
            style={{ background: "var(--bg)" }}>
            <span style={{ color: "var(--text3)", opacity: 0.3 }}><BlankPageIcon size={40} /></span>
            <span className="text-[11.5px]" style={{ color: "var(--text3)" }}>Ctrl+T, or the address on the right, to start browsing.</span>
            <span className="text-[10px] text-center leading-relaxed" style={{ color: "var(--text3)", opacity: 0.65 }}>
              Ctrl+L for this page's address · Ctrl+T for a new one · Ctrl+F to find · Ctrl+Alt+S hides the bar<br />
              The three on the right point at an element, tell an agent about it, and draw on the page
            </span>
          </div>
        )}

        {(mode === "pick" || mode === "feedback") && (
          <PagePicker
            view={el()}
            url={active?.url ?? ""}
            title={active ? tabLabel(active) : ""}
            mode={mode}
            onNote={say}
            onDone={() => setMode("none")}
          />
        )}
        {mode === "shoot" && (
          <Shooter
            view={el()}
            onNote={say}
            onDone={() => setMode("none")}
          />
        )}
        {mode === "draw" && (
          <MarkupLayer view={el()} url={active?.url ?? ""} onNote={say} onDone={() => setMode("none")} />
        )}
      </div>

      {/*
        * The inspector's hole.
        *
        * Nothing is drawn in here. The DevTools are a `WebContentsView` the
        * shell owns and floats over this rectangle — the first version pointed
        * the page's DevTools at a second `<webview>`, which is what the API
        * reads like it wants, and it came up with a working toolbar and an
        * empty Elements tree (electron/electron#15874, open since 2018).
        *
        * So this side leaves room and says where the room is. Everything that
        * moves the hole is reported by the observer above.
        */}
      {dt && !IS_DEMO && (
        <>
          <div role="separator" aria-orientation={dtSide === "right" ? "vertical" : "horizontal"} tabIndex={0}
            aria-label="Drag to resize the inspector"
            title="Drag to resize"
            onKeyDown={(e) => {
              const step = e.shiftKey ? 60 : 20;
              const grow = dtSide === "right" ? "ArrowLeft" : "ArrowUp";
              const shrink = dtSide === "right" ? "ArrowRight" : "ArrowDown";
              if (e.key === grow) { e.preventDefault(); setDtSize((v) => { const n = Math.min(1600, v + step); setDevtoolsSize(dtSide, n); return n; }); }
              else if (e.key === shrink) { e.preventDefault(); setDtSize((v) => { const n = Math.max(120, v - step); setDevtoolsSize(dtSide, n); return n; }); }
            }}
            onPointerDown={(e) => {
              e.preventDefault();
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              /* Measured against the window's own edge rather than by adding up
                 deltas: a drag that accumulates drifts away from the pointer the
                 moment one move is dropped. */
              const edge = dtSide === "right" ? window.innerWidth : window.innerHeight;
              const move = (ev: PointerEvent) => {
                const px = Math.max(120, Math.min(1600, edge - (dtSide === "right" ? ev.clientX : ev.clientY)));
                setDtSize(px);
              };
              const up = () => {
                setDtSize((v) => { setDevtoolsSize(dtSide, v); return v; });
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
              };
              window.addEventListener("pointermove", move);
              window.addEventListener("pointerup", up);
            }}
            className="shrink-0"
            style={dtSide === "right"
              ? { width: 5, marginRight: -2, cursor: "col-resize", borderLeft: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }
              : { height: 5, marginBottom: -2, cursor: "row-resize", borderTop: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }} />
          <div className="shrink-0 flex flex-col min-w-0"
            style={dtSide === "right" ? { width: dtSize } : { height: dtSize }}>
            {/* Ours, not Chrome's. DevTools' own dock buttons move a window it
                does not have here, so the two that mean anything are drawn
                where they work. */}
            <div className="flex items-center gap-1 px-1.5 shrink-0"
              style={{ height: 24, background: "var(--bg2)", borderBottom: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>
              <span className="text-[9.5px] tracking-[0.12em] uppercase mr-auto" style={{ color: "var(--text4)" }}>Inspector</span>
              {/* Its own zoom, and only its own. The gesture works inside the
                  pane too (Ctrl+wheel, Ctrl+plus) — these are here because a
                  gesture you have to know about is not a control. */}
              {([["−", -1], ["+", 1]] as const).map(([glyph, dir]) => (
                <button key={glyph}
                  onClick={() => {
                    /* The same ten-point ladder the page's own zoom uses — see
                     `stepZoom`. Two zooms in one window that step differently
                     is the inconsistency this was asked to remove. */
                  const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, stepZoom(dtZoom, dir > 0 ? 1 : -1)));
                    setDtZoom(next); setDevtoolsZoom(next);
                    if (dtGuest) browserDevtoolsZoom(dtGuest, next);
                  }}
                  disabled={dir < 0 ? dtZoom <= ZOOM_MIN : dtZoom >= ZOOM_MAX}
                  title={dir < 0 ? "Make the inspector smaller" : "Make the inspector bigger"}
                  className="inline-flex items-center justify-center rounded hover:bg-white/10 disabled:opacity-30 text-[13px] leading-none"
                  style={{ width: 20, height: 20, color: "var(--text3)" }}>{glyph}</button>
              ))}
              <button
                onClick={() => { setDtZoom(0); setDevtoolsZoom(0); if (dtGuest) browserDevtoolsZoom(dtGuest, 0); }}
                title="Back to 100%"
                className="rounded px-1 tabular-nums text-[9.5px] hover:bg-white/10"
                style={{ color: dtZoom ? "var(--text2)" : "var(--text4)", minWidth: 30 }}>{zoomPercent(dtZoom)}%</button>
              <span aria-hidden className="mx-0.5" style={{ width: 1, height: 13, background: "color-mix(in srgb, var(--border) 40%, transparent)" }} />
              {(["bottom", "right"] as const).map((sd) => (
                <button key={sd} onClick={() => { setDtSide(sd); setDevtoolsSide(sd); setDtSize(devtoolsSize(sd)); }}
                  aria-pressed={dtSide === sd}
                  title={sd === "bottom" ? "Dock underneath the page" : "Dock to the right of the page"}
                  className="inline-flex items-center justify-center rounded hover:bg-white/10"
                  style={{ width: 20, height: 18, color: dtSide === sd ? "var(--primary)" : "var(--text4)" }}>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" />
                    {sd === "bottom"
                      ? <path d="M1.5 9.5h13" stroke="currentColor" />
                      : <path d="M10 2.5v11" stroke="currentColor" />}
                  </svg>
                </button>
              ))}
              <CloseButton onClick={() => setDt(null)} title="Close the inspector"
                style={{ color: "var(--text3)" }} className="rounded hover:bg-white/10" />
            </div>
            <div ref={dtBox} className="flex-1 min-h-0" style={{ background: "var(--bg)" }} />
          </div>
        </>
      )}
      </div>
      </div>
      {/* The grip. In the gap, wide enough for a pointer even though the line
          it draws is one pixel — the same handle the card pane has. */}
      {sideOpen && (
        <div role="separator" aria-orientation="vertical" tabIndex={0}
          aria-label="Drag to resize the bar"
          title="Drag to resize · double-click for the usual width"
          onDoubleClick={() => { setSideW(228); setSidebarWidth(228); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") { e.preventDefault(); setSideW((w) => { const n = Math.min(460, w + 12); setSidebarWidth(n); return n; }); }
            else if (e.key === "ArrowRight") { e.preventDefault(); setSideW((w) => { const n = Math.max(170, w - 12); setSidebarWidth(n); return n; }); }
          }}
          onPointerDown={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            const right = window.innerWidth;
            const move = (ev: PointerEvent) => setSideW(Math.max(170, Math.min(460, right - ev.clientX)));
            const up = () => {
              setSideW((w) => { setSidebarWidth(w); return w; });
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
          className="shrink-0 self-stretch"
          style={{ width: 5, marginLeft: -3, cursor: "col-resize", zIndex: 5 }} />
      )}
      {sideOpen ? (
        <aside className="shrink-0 min-h-0" style={{ width: sideW }}>{sideBody}</aside>
      ) : (
        <>
          {/* Hidden, it leaves a hot edge. The bar comes back OVER the page
              rather than pushing it, so a page you hid the bar to read does not
              reflow every time the pointer strays right. */}
          <div onMouseEnter={() => setPeek(true)} title="The bar (Ctrl+Alt+S)"
            className="shrink-0 self-stretch"
            style={{ width: 6, background: "linear-gradient(90deg, transparent, color-mix(in srgb, var(--primary) 22%, transparent))" }} />
          {peek && (
            <aside onMouseLeave={() => setPeek(false)}
              className="absolute top-0 right-0 bottom-0 shadow-2xl"
              style={{ width: sideW, zIndex: 30 }}>{sideBody}</aside>
          )}
        </>
      )}
      {/* What the other browser has, before any of it lands here.
          An import that simply happens is one nobody can check — and this one
          adds fourteen folders and seventy-odd pages to something arranged by
          hand, with no undo behind it. */}
      {bringing && (() => {
        const sh = bringing.shelf;
        const inSpace = (x: { space: string }) => !bringing.space || !x.space || x.space === bringing.space;
        const folders = sh.folders.filter(inSpace).length;
        const pages = sh.items.filter((i) => inSpace(i) || i.essential).length;
        const ess = sh.items.filter((i) => i.essential).length;
        return (
          <>
            <div className="absolute inset-0" style={{ zIndex: 48, background: "rgba(6, 4, 12, 0.5)" }} onClick={() => setBringing(null)} />
            <div className="absolute rounded-xl shadow-2xl p-3 flex flex-col gap-2"
              style={{
                zIndex: 49, left: "50%", top: 90, transform: "translateX(-50%)", width: 420,
                background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)",
              }}>
              <div className="text-[12px]" style={{ color: "var(--text)" }}>Import from {bringing.label}</div>
              {sh.spaces.length > 1 && (
                <div className="flex items-center gap-1 flex-wrap">
                  {sh.spaces.map((sp) => (
                    <button key={sp.id} onClick={() => setBringing({ ...bringing, space: sp.id })}
                      className="px-2 py-1 rounded-md text-[10.5px]"
                      style={{
                        color: sp.id === bringing.space ? "var(--text)" : "var(--text3)",
                        background: sp.id === bringing.space ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "color-mix(in srgb, var(--text) 6%, transparent)",
                      }}>{sp.name}</button>
                  ))}
                </div>
              )}
              <div className="text-[11px] leading-relaxed" style={{ color: "var(--text2)" }}>
                {folders} folder{folders === 1 ? "" : "s"}, {pages} kept page{pages === 1 ? "" : "s"}
                {ess ? `, ${ess} of them shortcuts` : ""}.
                <br />
                <span style={{ color: "var(--text3)" }}>
                  Nothing of yours is replaced. A page you already keep stays in YOUR folder and does
                  not join the imported one — so a folder here can come up shorter than it is over
                  there, and that is the reason.
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button onClick={() => {
                  let said = "";
                  editShelf((cur) => {
                    const r = mergeImported(cur, sh, bringing.space);
                    said = r.already
                      ? `Brought in ${r.added} page${r.added === 1 ? "" : "s"} — ${r.already} you already kept stayed where they were`
                      : `Brought in ${r.added} page${r.added === 1 ? "" : "s"} from ${bringing.label}`;
                    return r.shelf;
                  });
                  setBringing(null);
                  if (said) say(said);
                }}
                  className="px-2.5 py-1 rounded-md text-[11px]"
                  style={{ color: "var(--text)", background: "color-mix(in srgb, var(--primary) 26%, transparent)" }}>Import</button>
                <button onClick={() => setBringing(null)}
                  className="px-2.5 py-1 rounded-md text-[11px]" style={{ color: "var(--text3)" }}>Cancel</button>
              </div>
            </div>
          </>
        );
      })()}

      {/* What is in hand, following the pointer. `pointer-events: none` or it
          would be the thing under the pointer, and every drop would land on the
          page being dragged. */}
      {carry && (
        <div className="fixed rounded-md px-2 py-1 text-[10.5px] shadow-2xl pointer-events-none truncate"
          style={{
            left: carry.x + 12, top: carry.y + 12, zIndex: 60, maxWidth: 220,
            background: "var(--bg2)", color: "var(--text)",
            border: `1px solid color-mix(in srgb, var(--primary) ${carry.at ? 70 : 30}%, transparent)`,
          }}>
          {carry.label}
          {carry.at && (
            <span className="ml-1.5" style={{ color: "var(--primary-hover)" }}>
              → {carry.at.spot.to === "essentials" ? "shortcuts"
                : carry.at.spot.to === "tabs" ? "just a tab"
                : carry.at.spot.to === "folder"
                  ? (allFolders(shelf).find((f) => f.id === (carry.at!.spot as { id: string }).id)?.name ?? "folder")
                  : "kept"}
            </span>
          )}
        </div>
      )}

      {/* A folded folder, under the pointer. For looking, or for jumping to one
          of them — and it stays folded, which is the whole point of the count
          beside its name. */}
      {peep && (() => {
        const f = allFolders(shelf).find((x) => x.id === peep.id);
        if (!f || f.open) return null;
        return (
          <div className="fixed rounded-lg shadow-2xl p-1 flex flex-col gap-0.5"
            onMouseEnter={() => setPeep(peep)} onMouseLeave={() => setPeep(null)}
            style={{
              top: peep.top, right: peep.right, width: 200, maxHeight: 320, overflowY: "auto", zIndex: 45,
              background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)",
            }}>
            <div className="px-1.5 pt-0.5 pb-1 text-[9px] uppercase tracking-[0.12em] flex items-center gap-1.5" style={{ color: "var(--text4)" }}>
              <FolderIcon size={ICON.xs} /> {f.name} <span className="ml-auto tabular-nums">{folderCount(f)}</span>
            </div>
            {f.items.map((i) => shelfRow(i, 0))}
            {f.folders.map((k) => (
              <div key={k.id} className="flex items-center gap-1.5 px-1.5 py-1 text-[10px]" style={{ color: "var(--text4)" }}>
                <FolderIcon size={ICON.xs} /> <span className="truncate">{k.name}</span>
                <span className="ml-auto tabular-nums">{folderCount(k)}</span>
              </div>
            ))}
            {!f.items.length && !f.folders.length && (
              <div className="px-1.5 py-1.5 text-[10px]" style={{ color: "var(--text4)" }}>Nothing in it yet.</div>
            )}
          </div>
        );
      })()}

      {/*
        * Every move the drag can make, as a sentence.
        *
        * Dragging is the fast way to arrange this and it is also the one nobody
        * discovers — the first pass shipped with dragging as the ONLY way, and
        * the answer to "how do I make a folder" was nowhere on screen.
        */}
      {menuAt && (
        <ContextMenu x={menuAt.x} y={menuAt.y} onClose={() => setMenuAt(null)}>
          {(() => {
            const shut = (fn: () => void) => () => { fn(); setMenuAt(null); };
            const folders = allFolders(shelf);
            if (menuAt.kind === "tab") {
              const t = tabs.find((x) => x.id === menuAt.id);
              if (!t) return null;
              const kind = { kind: "tab" as const, id: t.id };
              return (
                <>
                  <div className="px-2 pt-1 pb-1.5 text-[10px] truncate" style={{ color: "var(--text4)" }}>{tabLabel(t)}</div>
                  {/* This tab IS a kept page and has wandered off it: offer to
                      move the entry rather than to keep a second copy. Same
                      thing the entry's own menu offers, from the row somebody
                      happens to have right-clicked. */}
                  {(() => {
                    const bound = boundItem(t, shelf);
                    if (!bound || sameUrl(bound.url, t.url) || !t.url || t.url === BLANK) return null;
                    return (
                      <MenuItem onClick={shut(() => {
                        editShelf((sh) => retarget(sh, bound.id, t.url, tabLabel(t), t.icon));
                        say(`“${bound.title || bound.url}” now points here`);
                      })}>Point “{(bound.title || bound.url).slice(0, 28)}” at this page</MenuItem>
                    );
                  })()}
                  <MenuItem onClick={shut(() => keep(kind, { to: "essentials" }))}>Add to the shortcuts</MenuItem>
                  <MenuItem onClick={shut(() => keep(kind, { to: "loose" }))}>Keep it</MenuItem>
                  {folders.map((f) => (
                    <MenuItem key={f.id} onClick={shut(() => keep(kind, { to: "folder", id: f.id }))}>Keep it in {f.name}</MenuItem>
                  ))}
                  <MenuItem onClick={shut(() => {
                    /* The folder and the page in one press: "new folder" and
                       then finding the page again is two thoughts for one
                       intention. */
                    editShelf((sh) => {
                      const withNew = addFolder(sh, tabLabel(t).slice(0, 24) || "Folder");
                      const made = withNew.folders[withNew.folders.length - 1]!;
                      const already = findByUrl(withNew, t.url);
                      return place(withNew, already ?? shelfItem(t.url, tabLabel(t), t.icon), { to: "folder", id: made.id });
                    });
                  })}>New folder with this page</MenuItem>
                  {t.id !== activeId && <MenuItem onClick={shut(() => splitWith(t.id))}>Open beside the one you are on</MenuItem>}
                  <MenuItem onClick={shut(() => open(t.url, t.id))}>Duplicate</MenuItem>
                  <MenuItem danger onClick={shut(() => close(t.id))}>Close</MenuItem>
                </>
              );
            }
            if (menuAt.kind === "item") {
              const item = allItems(shelf).find((i) => i.id === menuAt.id);
              if (!item) return null;
              const kind = { kind: "item" as const, id: item.id };
              const live = liveFor(item);
              return (
                <>
                  <div className="px-2 pt-1 pb-1.5 text-[10px] truncate" style={{ color: "var(--text4)" }}>{item.title || item.url}</div>
                  <MenuItem onClick={shut(() => openShelf(item))}>Open</MenuItem>
                  {!shelf.essentials.some((i) => i.id === item.id) && (
                    <MenuItem onClick={shut(() => keep(kind, { to: "essentials" }))}>Move to the shortcuts</MenuItem>
                  )}
                  {!shelf.loose.some((i) => i.id === item.id) && (
                    <MenuItem onClick={shut(() => keep(kind, { to: "loose" }))}>Move out of its folder</MenuItem>
                  )}
                  {folders.map((f) => (
                    <MenuItem key={f.id} onClick={shut(() => keep(kind, { to: "folder", id: f.id }))}>Move to {f.name}</MenuItem>
                  ))}
                  {/* The way a shortcut stops being one: the site moves the
                      page, and re-keeping it means dragging a new entry back
                      into the right folder in the right place. This changes the
                      address and leaves everything else — where it sits, its
                      order, a name somebody gave it. */}
                  {active?.url && active.url !== BLANK && !sameUrl(active.url, item.url) && (
                    <MenuItem onClick={shut(() => {
                      editShelf((sh) => retarget(sh, item.id, active.url, tabLabel(active), active.icon));
                      say("Kept page now points at this one");
                    })}>Point it at the page you are on</MenuItem>
                  )}
                  {live && <MenuItem onClick={shut(() => close(live.id))}>Close the page, keep the entry</MenuItem>}
                  <MenuItem danger onClick={shut(() => editShelf((sh) => removeItem(sh, item.id)))}>Take it off the shelf</MenuItem>
                </>
              );
            }
            if (menuAt.kind === "space") {
              const space = spaces.find((x) => x.id === menuAt.id);
              if (!space) return null;
              const pages = space.rows.length;
              return (
                <>
                  <div className="px-2 pt-1 pb-1.5 text-[10px] truncate" style={{ color: "var(--text4)" }}>
                    {space.name} — {pages} page{pages === 1 ? "" : "s"}
                  </div>
                  {space.id !== profile && (
                    <MenuItem onClick={shut(() => switchTo(space.id))}>Work in this container</MenuItem>
                  )}
                  <MenuItem onClick={shut(() => { switchTo(space.id); setOmni("new"); })}>Open a page here</MenuItem>
                  <MenuItem onClick={shut(() => foldSpace(space.id))}>{folded.has(space.id) ? "Show its pages" : "Fold it"}</MenuItem>
                  {/* The default container cannot be closed: it is where you
                      land when any other one goes. */}
                  {space.id && (
                    <MenuItem danger onClick={shut(() => forgetProfile(space.id))}>
                      {pages ? `Close it — its ${pages} page${pages === 1 ? "" : "s"} go with it` : "Close it"}
                    </MenuItem>
                  )}
                </>
              );
            }
            if (menuAt.kind === "folder") {
              const f = folders.find((x) => x.id === menuAt.id);
              if (!f) return null;
              return (
                <>
                  <div className="px-2 pt-1 pb-1.5 text-[10px] truncate" style={{ color: "var(--text4)" }}>{f.name}</div>
                  <MenuItem onClick={shut(() => setRenaming({ id: f.id, name: f.name }))}>Rename…</MenuItem>
                  {canNest(shelf, f.id) && (
                    <MenuItem onClick={shut(() => newFolder(f.id))}>New folder inside</MenuItem>
                  )}
                  <MenuItem onClick={shut(() => editShelf((sh) => toggleFolder(sh, f.id)))}>{f.open ? "Fold it" : "Unfold it"}</MenuItem>
                  <MenuItem danger onClick={shut(() => editShelf((sh) => removeFolder(sh, f.id)))}>
                    Delete the folder — its pages stay
                  </MenuItem>
                </>
              );
            }
            /* The order and the wording are Zen's, from his own screenshot:
               make a space, make a folder, open a tab. Ours adds the two that
               are about the page in front of you, under a rule. */
            const row = (icon: React.ReactNode, label: string) => (
              <span className="flex items-center gap-2">
                <span className="shrink-0 grid place-items-center" style={{ width: 14, height: 14, color: "var(--text4)" }}>{icon}</span>
                {label}
              </span>
            );
            return (
              <>
                <MenuItem onClick={shut(() => setNaming(""))}>{row(<SpaceIcon />, "Create space")}</MenuItem>
                <MenuItem onClick={shut(() => newFolder())}>{row(<FolderIcon size={13} />, "Create folder")}</MenuItem>
                <MenuItem onClick={shut(() => setOmni("new"))}>{row(<span style={{ fontSize: 13, lineHeight: 1 }}>+</span>, "New tab")}</MenuItem>
                {!blank && activeId && (
                  <>
                    <div className="my-1" style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }} />
                    <MenuItem onClick={shut(() => keep({ kind: "tab", id: activeId }, { to: "loose" }))}>Keep the page you are on</MenuItem>
                    <MenuItem onClick={shut(() => keep({ kind: "tab", id: activeId }, { to: "essentials" }))}>…and in the shortcuts</MenuItem>
                  </>
                )}
                <div className="my-1" style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }} />
                <MenuItem onClick={shut(() => { void bringSidebar(); })}>Import a sidebar from Zen…</MenuItem>
                <MenuItem onClick={shut(() => { setSideOpen(false); setSidebarOpen(false); })}>Hide this bar — Ctrl+S</MenuItem>
              </>
            );
          })()}
        </ContextMenu>
      )}

      {/* The address box.
          Over the page, and in one of two places: in the middle when it is a new
          tab — nothing is being replaced, so it is not attached to anything —
          and against the bar when it is THIS page's address, because that is
          where the thing you clicked was. */}
      {omni && (
        <>
          <div className="absolute inset-0" style={{ zIndex: 38, background: omni === "new" ? "rgba(6, 4, 12, 0.5)" : "rgba(6, 4, 12, 0.25)" }}
            onClick={() => { setOmni(null); setTyped(null); setHint(-1); }} />
          <div className="absolute rounded-xl shadow-2xl p-1.5 flex flex-col gap-0.5"
            style={{
              zIndex: 39, background: "var(--bg2)",
              border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)",
              ...(omni === "new"
                ? { left: "14%", right: (sideOpen ? sideW : 0) + 40, top: 120 }
                : { right: (sideOpen ? 6 : 6), top: 6, width: Math.max(380, Math.min(620, sideW * 2.4)) }),
            }}>
            <input autoFocus
              data-agx-omni="1"
              value={typed ?? ""}
              onChange={(e) => { setTyped(e.target.value); setHint(-1); }}
              onFocus={(e) => { if (omni === "edit") e.currentTarget.select(); }}
              onKeyDown={(e) => {
                const rows = omniHits();
                if (e.key === "ArrowDown" && rows.length) { e.preventDefault(); setHint((i) => Math.min(rows.length - 1, i + 1)); return; }
                if (e.key === "ArrowUp" && rows.length) { e.preventDefault(); setHint((i) => Math.max(-1, i - 1)); return; }
                if (e.key === "Enter") {
                  e.preventDefault();
                  const row = hint >= 0 ? rows[hint] : null;
                  if (row) { row.run(); setOmni(null); setTyped(null); setHint(-1); }
                  else runOmni(typed ?? "");
                  return;
                }
                /* Escape and nothing has happened — no empty tab to close after,
                   which is the whole reason the box exists instead of a blank
                   page. */
                if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOmni(null); setTyped(null); setHint(-1); }
              }}
              spellCheck={false}
              placeholder={omni === "new" ? "Type an address, or something to search for" : "This page's address"}
              className="w-full text-[13px] px-2.5 py-2 outline-none bg-transparent"
              style={{ color: "var(--text)" }} />
            {omniHits().map((r, i) => (
              <button key={r.key}
                onMouseDown={(e) => { e.preventDefault(); r.run(); setOmni(null); setTyped(null); setHint(-1); }}
                onMouseEnter={() => setHint(i)}
                className="w-full text-left px-2.5 py-1.5 rounded-lg flex items-center gap-2 text-[11px]"
                style={{ background: i === hint ? "color-mix(in srgb, var(--primary) 14%, transparent)" : "transparent" }}>
                <span className="truncate" style={{ color: "var(--text)", maxWidth: "46%" }}>{r.label}</span>
                <span className="truncate font-mono text-[10px]" style={{ color: "var(--text3)" }}>{r.sub}</span>
                {/* Why it is on the list. "open" is the one that changes what
                    pressing it does — it jumps rather than loading a copy. */}
                <span className="ml-auto shrink-0 text-[9px] uppercase tracking-[0.08em]"
                  style={{ color: r.kind === "tab" ? "var(--success)" : "var(--text4)" }}>
                  {r.kind === "tab" ? "open" : r.kind === "kept" ? "kept" : ""}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

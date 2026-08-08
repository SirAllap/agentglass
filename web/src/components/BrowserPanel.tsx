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
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Portal } from "./Portal.tsx";
import { BROWSER_PARTITION, HAS_BROWSER, IS_DESKTOP, onBrowserZoom, onBrowserOpenTab, setActiveBrowserGuest } from "../lib/desktop.ts";
import { displayUrl, normalizeNavigationUrl } from "../lib/browserUrl.ts";
import { BLANK, homePage, searchEngine, zoomLevel, setZoomLevel as saveZoom, zoomPercent, ZOOM_MIN, ZOOM_MAX } from "../lib/browserPrefs.ts";
import { addTab, closeTab, newTab, patchTab, sleepingTab, stepTab, tabLabel, wake, type BrowserTab } from "../lib/browserTabs.ts";
import { countFor, forgetProfileTabs, readSession, saveSession, setFor } from "../lib/browserSession.ts";
import {
  addProfile, DEFAULT_PROFILE, loadProfiles, partitionFor, profileHue, profileName, removeProfile, saveProfiles,
  type BrowserProfile,
} from "../lib/browserProfiles.ts";
import { VIEWPORTS, type Viewport } from "../lib/browserViewport.ts";
import { browserNav, clearBrowserNav, subscribeBrowserNav } from "../lib/browserNav.ts";
import { clientId, serveBrowserAsk, setBrowserAskHandler } from "../lib/browserBus.ts";
import { api } from "../lib/api.ts";
import { type DrivableWebview } from "../lib/browserDrive.ts";
import { viewHeaderClass, viewHeaderStyle, viewTitleClass } from "./workspace/ViewHeader.tsx";
import { PagePicker } from "./browser/PagePicker.tsx";
import { MarkupLayer } from "./browser/MarkupLayer.tsx";
import { DemoPage } from "./browser/DemoPage.tsx";
import { IS_DEMO } from "../lib/demo.ts";
import { DEMO_BROWSER_TABS } from "../lib/demoBrowser.ts";
import { ICON } from "../lib/iconSize.ts";
import { openSettings } from "../lib/openSettings.ts";
import { suggest, type Suggestion } from "../lib/suggest.ts";
import {
  BackIcon, BlankPageIcon, CloseIcon, CodeIcon, ExternalIcon, ForwardIcon, GlobeIcon,
  HomeIcon, LockIcon, MoreIcon, NoteIcon, PenIcon, PlusIcon, ReloadIcon, SearchIcon,
  SpinnerIcon, StopIcon, TargetIcon,
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
  sendInputEvent(event: { type: string; keyCode: string }): void;
  openDevTools(): void;
  closeDevTools(): void;
  isDevToolsOpened(): boolean;
  getWebContentsId(): number;
  findInPage(text: string, opts?: { forward?: boolean; findNext?: boolean }): number;
  stopFindInPage(action: "clearSelection" | "keepSelection" | "activateSelection"): void;
};

/* -------------------------------------------------------------- small parts */

/** A toolbar control. Square, quiet, and the same size as its neighbours — the
 *  old bar mixed glyph widths and read as a row of unrelated marks rather than
 *  as a toolbar. */
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

/** The workspace hands every view an `active`, and this one has no use for it:
 *  there is nothing to poll, and a page must keep running while you are looking
 *  at something else — that is the point of the views staying mounted. */
export function BrowserView(_props: { active: boolean }) {
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
  const [profile, setProfile] = useState<string>(() => readSession()?.current ?? "");
  const [tabs, setTabs] = useState<BrowserTab[]>(() => {
    // The demo opens with its own strip rather than whatever a previous visit
    // left in localStorage: a saved single blank tab would show the empty-state
    // card, which is exactly the dead panel this exists to stop being.
    if (IS_DEMO) return DEMO_BROWSER_TABS.map((t, i) => {
      const tab = sleepingTab(t.url, t.title, null, "");
      return i === 0 ? { ...tab, asleep: false } : tab;
    });
    const saved = readSession();
    const set = setFor(saved, saved?.current ?? "");
    if (!set) return [newTab(homePage(), saved?.current ?? "")];
    // The one in front keeps its remembered name too, and only its `asleep`
    // differs. Built with `newTab` it came back nameless and the strip read
    // "New tab" until the page loaded, which is a flicker on every launch.
    return set.tabs.map((t, i) => {
      const tab = sleepingTab(t.url, t.title, t.icon, saved?.current ?? "");
      return i === set.active ? { ...tab, asleep: false } : tab;
    });
  });
  const [activeId, setActiveId] = useState("");
  const els = useRef(new Map<string, WebviewEl>());
  const [menuOpen, setMenuOpen] = useState(false);
  /* Browsing identities. Held here rather than in a store: the list is a few
     names, it is read by one view, and it is written by one menu. */
  const [profiles, setProfiles] = useState<BrowserProfile[]>(() => loadProfiles(globalThis.localStorage ?? null));
  const [profileMenu, setProfileMenu] = useState(false);
  /*
   * Where to draw the profile menu, in viewport coordinates.
   *
   * It has to leave its own container to be seen at all. The tab strip scrolls
   * sideways — `overflow-x: auto`, which makes the browser clip on BOTH axes —
   * and it is 36px tall. Measured, the menu opened correctly at y=116 inside a
   * box that ends at y=114, so every pixel of it was clipped away and clicking
   * the button looked like it did nothing.
   *
   * Select.tsx solved this months ago and says so in its own comment: anything
   * that pops out of a panel in this app goes through the Portal. This is the
   * same fix, measured from the button.
   */
  const profileBtn = useRef<HTMLButtonElement | null>(null);
  const [profilePos, setProfilePos] = useState({ top: 0, right: 0 });
  useLayoutEffect(() => {
    if (!profileMenu || !profileBtn.current) return;
    const place = () => {
      const r = profileBtn.current?.getBoundingClientRect();
      if (r) setProfilePos({ top: r.bottom + 6, right: window.innerWidth - r.right });
    };
    place();
    // The strip scrolls and the window resizes; a menu pinned to where the
    // button WAS is worse than one that is clipped, because it looks placed.
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [profileMenu]);
  const [naming, setNaming] = useState<string | null>(null);
  const [find, setFind] = useState<string | null>(null);
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
  const [mode, setMode] = useState<"none" | "pick" | "feedback" | "draw">("none");

  // The first tab's id is minted inside the state initialiser, so it is adopted
  // here rather than minted twice. With a restored session the one to adopt is
  // the one that was in front, which is the only tab that came back awake.
  useEffect(() => {
    if (activeId) return;
    const first = tabs.find((t) => !t.asleep) ?? tabs[0];
    if (first) setActiveId(first.id);
  }, [activeId, tabs]);

  /*
   * Write the strip down whenever it changes.
   *
   * Debounced, because `tabs` also changes on every title, favicon and loading
   * flag a guest reports — a page that streams updates would otherwise write
   * to localStorage a hundred times while it loads. Half a second is far below
   * the time it takes to close a window and far above the noise.
   */
  useEffect(() => {
    const t = setTimeout(() => saveSession(profile, tabs, activeId), 500);
    return () => clearTimeout(t);
  }, [profile, tabs, activeId]);

  /* And once more on the way out, because the debounce above may never fire:
     closing the window is exactly the moment nothing gets half a second. */
  useEffect(() => {
    const flush = () => saveSession(profile, tabs, activeId);
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, [profile, tabs, activeId]);

  /** Selecting a tab is what opens it: everything that changes the selection
   *  goes through here so a sleeping tab cannot be shown without a guest. */
  const show = useCallback((id: string) => {
    setTabs((ts) => wake(ts, id));
    setActiveId(id);
  }, []);

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const el = useCallback(() => (active ? els.current.get(active.id) ?? null : null), [active]);

  // What the page is at, and what is in the bar, are two different facts: while
  // you are typing, the page has not moved. `typed` being null means "not
  // editing", so navigation is free to update the display.
  const [typed, setTyped] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** Electron's logarithmic zoom level, mirrored here only so the chip can show
   *  it. The guest is the one that actually holds it. */
  const [zoom, setZoom] = useState(zoomLevel);

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
  useEffect(() => onBrowserZoom((level) => { setZoom(level); saveZoom(level); }), []);

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
  useEffect(() => {
    setBrowserAskHandler((ask) => { void serveBrowserAsk(el() as unknown as DrivableWebview | null, ask); });
    // Only the desktop shell can actually drive a page: `<webview>` is an
    // Electron tag, and in a plain browser tab this panel renders an element
    // with none of the methods on it. Registering from there would have this
    // window volunteering for work it cannot do.
    if (!IS_DESKTOP) return () => setBrowserAskHandler(null);
    const id = clientId();
    const beat = () => { void api.browserReady(id, true).catch(() => {}); };
    beat();
    // Well inside the server's ninety-second expiry, so a missed one costs
    // nothing and a dead window stops counting on its own.
    const timer = setInterval(beat, 30_000);
    return () => {
      clearInterval(timer);
      void api.browserReady(id, false).catch(() => {});
      setBrowserAskHandler(null);
    };
    // Re-registered when the active tab changes, so the closure serves the tab
    // that is up rather than the one that was up when this mounted.
  }, [activeId, el]);

  const applyZoom = (level: number) => {
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
    try { el()?.setZoomLevel(next); } catch { /* guest not attached yet */ }
    setZoom(next);
    saveZoom(next);
  };

  /** The identity the tab in front of you was loaded with. */
  /* Every tab in the strip belongs to the profile the strip is showing; the
     per-tab field is what a guest attaches on, and they cannot disagree. */
  const activeProfile = profile;

  const open = useCallback((url: string, from?: string, profile?: string) => {
    setTabs((prev) => {
      const r = addTab(prev, url, from, profile);
      if ("error" in r) { say(r.error); return prev; }
      setActiveId(r.tab.id);
      return r.tabs;
    });
  }, [say]);

  /* A tab the user asked for — the + button, Ctrl+T, or the menu. It goes to the
     END of the strip, not beside the current one: `open(url, from)` inserts
     BESIDE `from`, which is right for a link a page opened (it belongs next to
     its parent) but wrong here, because a new tab is opened FROM nothing and
     every browser puts it last. `from` is left out so `addTab` appends; the
     profile is passed explicitly, since without a `from` there is nothing to
     inherit the current identity from. */
  const newBlankTab = useCallback(() => {
    open(BLANK, undefined, active?.profile);
    // Straight into the address bar, so the next keystroke is the address. The
    // input is always mounted, so it just needs focusing once React has swapped
    // the new tab in — the same setTimeout(…, 0) the find and rename inputs use.
    setTimeout(() => (document.getElementById("agx-browser-url") as HTMLInputElement | null)?.focus(), 0);
  }, [open, active?.profile]);

  const close = useCallback((id: string) => {
    els.current.delete(id);
    setTabs((prev) => {
      const r = closeTab(prev, id);
      setActiveId(r.activeId);
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
    setProfileMenu(false);
    setNaming(null);
    if (profileId === profile) return;
    saveSession(profile, tabs, activeId);
    els.current.clear();
    const set = setFor(readSession(), profileId);
    const next = set
      ? set.tabs.map((t, i) => {
          const tab = sleepingTab(t.url, t.title, t.icon, profileId);
          return i === set.active ? { ...tab, asleep: false } : tab;
        })
      : [newTab(homePage(), profileId)];
    setProfile(profileId);
    setTabs(next);
    setActiveId(next[set?.active ?? 0]?.id ?? next[0]!.id);
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
    const next = removeProfile(profiles, id);
    setProfiles(next);
    saveProfiles(globalThis.localStorage ?? null, next);
    // Its strip goes with the name, or the file keeps a set of tabs filed under
    // a profile nothing can reach. And if it was the one on screen, there has
    // to be somewhere to stand: the default profile is always there.
    forgetProfileTabs(id);
    if (id === profile) switchTo("");
  }, [profiles, profile, switchTo]);

  /* A page that opened a window used to be handed to the OS browser, because a
     single-page view had nowhere to put it. Now it goes beside the tab it came
     from — which is what makes an OAuth popup finish inside the app. */
  useEffect(() => onBrowserOpenTab((url) => open(url, activeId)), [open, activeId]);

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
    const onTitle = (e: Event) => patch(id, { title: (e as Event & { title?: string }).title ?? "" });
    const onIcon = (e: Event) => {
      const icons = (e as Event & { favicons?: string[] }).favicons;
      if (icons?.length) patch(id, { icon: icons[0]! });
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
    const onReady = () => { try { w.setZoomLevel(zoomLevel()); } catch { /* gone */ } };

    w.addEventListener("dom-ready", onReady);
    w.addEventListener("did-start-loading", onStart);
    w.addEventListener("did-stop-loading", onStop);
    w.addEventListener("did-navigate", sync);
    w.addEventListener("did-navigate-in-page", sync);
    w.addEventListener("did-fail-load", onFail);
    w.addEventListener("page-title-updated", onTitle);
    w.addEventListener("page-favicon-updated", onIcon);
  }, [patch]);

  /* ------------------------------------------------------------- keyboard */

  const onKey = (e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === "t") { e.preventDefault(); newBlankTab(); return; }
    if (k === "w") { e.preventDefault(); if (active) close(active.id); return; }
    if (k === "f") { e.preventDefault(); setFind(""); setTimeout(() => findRef.current?.focus(), 0); return; }
    if (e.key === "Tab") { e.preventDefault(); show(stepTab(tabs, activeId, e.shiftKey ? -1 : 1)); return; }
    if (k === "l") { e.preventDefault(); (document.getElementById("agx-browser-url") as HTMLInputElement | null)?.focus(); }
  };

  // The demo has no guest to attach and still draws the panel: its pages are
  // written into the build, and the chrome around them is this component.
  if (!HAS_BROWSER && !IS_DEMO) return null;

  const blank = !active?.url || active.url === BLANK;
  // Only while typing: `typed` is null the moment the bar is not being edited,
  // and a completion list over a page you are reading is a list in the way.
  const tips = typed !== null && typed.trim() ? suggest(places ?? [], typed) : [];
  // A new tab shows the PLACEHOLDER, not the word "blank". `about:blank` is
  // where a new tab genuinely is, and displayUrl trims it to "blank", which
  // read as the name of a page nobody asked for.
  const shown = typed ?? (blank ? "" : displayUrl(active!.url));
  const tabStyle = (on: boolean, asleep?: boolean) => ({
    height: 30, maxWidth: 210,
    background: on ? "var(--bg)" : "transparent",
    border: `1px solid ${on ? "color-mix(in srgb, var(--border) 45%, transparent)" : "transparent"}`,
    borderBottom: "none",
    /* Restored but not opened yet. Dimmed rather than marked, because it is not
       a state you need to do anything about — it says "this one has not cost
       you anything yet", and it stops being true the moment you click it. */
    opacity: asleep ? 0.55 : 1,
  });

  return (
    <div className="flex flex-col h-full min-h-0 outline-none" tabIndex={-1} onKeyDown={onKey}>
      <div className={viewHeaderClass} style={viewHeaderStyle}>
        <span className={viewTitleClass} style={{ color: "var(--text)" }}>Browser</span>
        <span className="text-[10px] truncate min-w-0" style={{ color: "var(--text3)" }}>{active ? tabLabel(active) : ""}</span>
        {note && (
          <span className="ml-auto text-[10px] px-2 py-0.5 rounded shrink-0"
            style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 35%, transparent)" }}>{note}</span>
        )}
      </div>

      {/* The strip is always there, even with one page: a tab bar that appears
          on the second tab shoves everything below it down, and the `+` is how
          the second tab gets opened in the first place. */}
      <div className="flex items-stretch gap-px px-1.5 pt-1.5 shrink-0 overflow-x-auto agw-noscrollbar"
        style={{ background: "color-mix(in srgb, var(--bg2) 55%, transparent)" }}>
        {tabs.map((t) => (
          <div key={t.id}
            onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); close(t.id); } else show(t.id); }}
            title={t.url || "New tab"}
            className="group flex items-center gap-1.5 px-2.5 rounded-t-md cursor-default min-w-0 shrink-0"
            style={tabStyle(t.id === activeId, t.asleep)}>
            {/* Whose tab this is. The strip mixes profiles — a link opened from
                a page stays in that page's identity — so without a mark the
                only way to tell is to click it and look at who you are signed
                in as. The default profile gets nothing: it is the absence of a
                mark, which is what "no profile chosen" should look like. */}
            {t.profile && (
              <span className="shrink-0 rounded-full" title={`${profileName(profiles, t.profile)} profile`}
                style={{ width: 6, height: 6, background: `hsl(${profileHue(t.profile)} 65% 55%)` }} />
            )}
            {t.loading
              ? <span className="shrink-0" style={{ color: "var(--text3)" }}><SpinnerIcon /></span>
              : <Favicon src={t.icon} />}
            <span className="min-w-0 flex-1 truncate text-[11.5px]"
              style={{ color: t.id === activeId ? "var(--text)" : "var(--text3)" }}>{tabLabel(t)}</span>
            {/* 20 rather than the 26 the rest of the app uses (lib/iconSize.ts):
                a tab strip has no room for the standard target, and 16 — the
                glyph with nothing around it — was the smallest control the icon
                audit found anywhere. */}
            <button onClick={(e) => { e.stopPropagation(); close(t.id); }} aria-label={`Close ${tabLabel(t)}`}
              className="shrink-0 grid place-items-center opacity-0 group-hover:opacity-100 rounded"
              style={{ color: "var(--text3)", width: 20, height: 20 }}><CloseIcon size={ICON.xs} /></button>
          </div>
        ))}
        <button onClick={newBlankTab} title="New tab (Ctrl+T)" aria-label="New tab"
          className="agx-btn shrink-0 rounded-md self-center ml-1 flex items-center justify-center"
          style={{ width: 26, height: 26, color: "var(--text3)" }}><PlusIcon /></button>

        {/* Who you are browsing as.
            At the end of the strip rather than in the toolbar below, because it
            belongs to the tabs: the toolbar acts on the page in front of you,
            and this says which of several signed-in identities that page was
            loaded with. It names the ACTIVE tab's profile, which is the only one
            the address bar and the buttons beside it are talking about. */}
        <div className="relative shrink-0 self-center ml-auto pl-2">
          <button ref={profileBtn} onClick={() => { setProfileMenu((v) => !v); setNaming(null); }}
            title={`${profileName(profiles, activeProfile)} — its own tabs and its own logins. Click to switch.`}
            /* A border, because this is a control and not a caption.
               Without one it was 11px of var(--text3) in the emptiest corner of
               the window — the thing that decides which signed-in identity a
               page loads with, drawn fainter than the tab title beside it, and
               with one profile it read as a label nobody could click. */
            className="agx-btn rounded-md flex items-center gap-1.5 px-2"
            style={{
              height: 26, color: "var(--text2)",
              border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)",
            }}>
            {/* The default profile's dot was var(--text4) on var(--bg2): a grey
                circle on grey, invisible at 7px. It is the same neutral the
                rest of the chrome uses for "nothing special here", but it has
                to be visible to say that. */}
            <span className="rounded-full" style={{
              width: 7, height: 7,
              background: activeProfile ? `hsl(${profileHue(activeProfile)} 65% 55%)` : "var(--text3)",
            }} />
            <span className="text-[11px] max-w-[90px] truncate">{profileName(profiles, activeProfile)}</span>
          </button>
          {profileMenu && (
            <Portal>
              <div className="fixed inset-0" onClick={() => { setProfileMenu(false); setNaming(null); }} />
              <div className="fixed rounded-lg overflow-hidden agx-menu"
                /* Capped, or the explanatory first line makes the menu as wide
                   as the sentence — measured at 730px, half the window, for a
                   list of one profile. */
                style={{ top: profilePos.top, right: profilePos.right, minWidth: 210, maxWidth: 290 }}>
                {/*
                  * Two different facts, told apart.
                  *
                  * The list is a list of ACTIONS — each row opens a tab — and it
                  * was headed by one small line saying so, with the current
                  * profile marked "here". "Here" reads as a position, so the
                  * row you are already in looked like the one that was selected,
                  * and clicking it produced a tab nobody asked for.
                  *
                  * So the state is stated once, at the top, in the past tense of
                  * a thing that cannot change: a tab's profile is fixed when its
                  * guest attaches. And every row below carries a ＋, because
                  * every row does the same thing.
                  */}
                {/* A profile is a set of tabs with its own logins. Switching
                    swaps the strip, so the menu says what you would be leaving
                    and what you would find. */}
                <div className="px-2.5 pt-2 pb-1.5 text-[11px] leading-snug" style={{ color: "var(--text3)" }}>
                  A profile keeps its own tabs and its own logins. Switching puts this
                  set away and brings that one back.
                </div>
                <div className="px-2.5 pt-1 pb-1 text-[10px] uppercase tracking-wider"
                  style={{ color: "var(--text4)", borderTop: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
                  switch to
                </div>
                {[DEFAULT_PROFILE, ...profiles].map((pr) => (
                  <div key={pr.id || "default"} className="group flex items-center">
                    <button onClick={() => switchTo(pr.id)}
                      className="flex-1 min-w-0 flex items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px]"
                      style={{ color: pr.id === activeProfile ? "var(--text)" : "var(--text2)" }}>
                      <span className="shrink-0 rounded-full" style={{
                        width: 7, height: 7,
                        background: pr.id ? `hsl(${profileHue(pr.id)} 65% 55%)` : "var(--text4)",
                      }} />
                      <span className="truncate">{pr.name}</span>
                      {/* What you would find there. The one you are in says so
                          instead, because switching to it does nothing and a
                          row that looks identical to the others would be
                          promising otherwise. */}
                      <span className="ml-auto text-[10px] shrink-0 tabular-nums" style={{ color: "var(--text4)" }}>
                        {pr.id === activeProfile
                          ? "here"
                          : (() => {
                              const n = pr.id === profile ? tabs.length : countFor(readSession(), pr.id);
                              return n ? `${n} tab${n === 1 ? "" : "s"}` : "empty";
                            })()}
                      </span>
                    </button>
                    {/* Forgetting a profile is a menu-hover action rather than a
                        row of its own: it is rare, and it must not sit under the
                        finger that is aiming at the name beside it. */}
                    {pr.id && (
                      <button onClick={() => forgetProfile(pr.id)} title={`Forget ${pr.name}. Its cookies stay on disk — this only removes the name.`}
                        aria-label={`Forget ${pr.name}`}
                        className="shrink-0 grid place-items-center opacity-0 group-hover:opacity-100 rounded mr-1.5"
                        style={{ color: "var(--text4)", width: 20, height: 20 }}><CloseIcon size={ICON.xs} /></button>
                    )}
                  </div>
                ))}
                <div style={{ borderTop: "1px solid var(--border)" }} />
                {naming === null ? (
                  <button onClick={() => setNaming("")}
                    className="w-full text-left px-2.5 py-1.5 text-[11.5px]" style={{ color: "var(--text2)" }}>
                    New profile…
                  </button>
                ) : (
                  <input autoFocus value={naming} placeholder="Name it, then Enter"
                    onChange={(e) => setNaming(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") makeProfile(naming);
                      if (e.key === "Escape") { e.stopPropagation(); setNaming(null); }
                    }}
                    className="w-full px-2.5 py-1.5 text-[11.5px] outline-none"
                    style={{ background: "transparent", color: "var(--text)" }} />
                )}
                {/* Said once, here, because the alternative is a person
                    discovering it by being signed out of something. */}
                <div className="px-2.5 pb-2 pt-1 text-[10px]" style={{ color: "var(--text4)" }}>
                  Each profile keeps its own logins and cookies.
                </div>
              </div>
            </Portal>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 px-2 py-1.5 border-b shrink-0"
        style={{ borderColor: "color-mix(in srgb, var(--border) 25%, transparent)" }}>
        <Tool label="Back" onClick={() => el()?.goBack()} disabled={!active?.canBack}><BackIcon /></Tool>
        <Tool label="Forward" onClick={() => el()?.goForward()} disabled={!active?.canForward}><ForwardIcon /></Tool>
        <Tool label={active?.loading ? "Stop" : "Reload"}
          onClick={() => (active?.loading ? el()?.stop() : el()?.reload())}>{active?.loading ? <StopIcon /> : <ReloadIcon />}</Tool>
        <Tool label="Home" onClick={() => go(homePage())}><HomeIcon /></Tool>

        {/* An address bar that looks like one. The old one was a thin outlined
            box the same height as the buttons beside it, which is most of why
            the whole thing read as a row of marks rather than as a browser. */}
        <div className="flex-1 min-w-0 flex items-center gap-1.5 px-2 rounded-lg mx-1"
          style={{
            height: 30,
            background: "color-mix(in srgb, var(--bg3) 45%, transparent)",
            border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)",
          }}>
          <span className="shrink-0 flex items-center" style={{ color: active?.url.startsWith("https://") ? "var(--success)" : "var(--text3)" }}>
            {active?.url.startsWith("https://") ? <LockIcon /> : <GlobeIcon />}
          </span>
          <input
            id="agx-browser-url"
            value={shown}
            onChange={(e) => { setTyped(e.target.value); setHint(-1); }}
            onFocus={(e) => { setTyped(blank ? "" : (active?.url ?? "")); e.currentTarget.select(); }}
            onBlur={() => setTyped(null)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && tips.length) { e.preventDefault(); setHint((i) => Math.min(tips.length - 1, i + 1)); return; }
              if (e.key === "ArrowUp" && tips.length) { e.preventDefault(); setHint((i) => Math.max(-1, i - 1)); return; }
              if (e.key === "Enter") {
                e.preventDefault();
                // A highlighted suggestion is what Enter means; otherwise it is
                // whatever was typed, which may be a search.
                go(hint >= 0 && tips[hint] ? tips[hint]!.url : (typed ?? ""));
                setHint(-1);
                e.currentTarget.blur();
              }
              // Escape puts back what the page actually is, rather than leaving
              // a half-typed address sitting over a page you never left.
              if (e.key === "Escape") { e.preventDefault(); setTyped(null); setHint(-1); e.currentTarget.blur(); }
            }}
            spellCheck={false}
            placeholder="Address, or something to search for"
            className="flex-1 min-w-0 text-[12px] outline-none bg-transparent"
            style={{ color: "var(--text)" }}
          />
          {/* Only when it is not 100%: a control that says "100%" on every page
              for everybody is a permanent explanation of a feature nobody used.
              When it IS zoomed, this is both the readout and the way back. */}
          {zoom !== 0 && (
            <button onClick={() => applyZoom(0)} title="Back to 100% (Ctrl+0)"
              className="agx-btn shrink-0 text-[9.5px] px-1 rounded tabular-nums" style={{ color: "var(--text3)" }}>
              {zoomPercent(zoom)}%
            </button>
          )}
          {viewport.width && (
            <button onClick={() => setViewport(VIEWPORTS[0]!)} title="Back to the full width"
              className="agx-btn shrink-0 text-[9.5px] px-1 rounded tabular-nums" style={{ color: "var(--warning)" }}>
              {viewport.width}px
            </button>
          )}
        </div>

        {/* The agent-facing three, together and in the order you would use
            them: point at something, say what is wrong with it, or draw. */}
        <Tool label="Point at an element — then C to copy it, S to shoot it" on={mode === "pick"}
          onClick={() => setMode((m) => (m === "pick" ? "none" : "pick"))}><TargetIcon /></Tool>
        <Tool label="Point at an element and tell an agent what to change" on={mode === "feedback"}
          onClick={() => setMode((m) => (m === "feedback" ? "none" : "feedback"))}><NoteIcon /></Tool>
        <Tool label="Draw on the page, then hand the markup over" on={mode === "draw"}
          onClick={() => setMode((m) => (m === "draw" ? "none" : "draw"))}><PenIcon /></Tool>

        <span className="shrink-0 mx-0.5" style={{ width: 1, height: 16, background: "color-mix(in srgb, var(--border) 40%, transparent)" }} />

        <Tool label="Find on this page (Ctrl+F)" on={find !== null}
          onClick={() => { setFind((f) => (f === null ? "" : null)); setTimeout(() => findRef.current?.focus(), 0); }}><SearchIcon /></Tool>
        {/* Real Chrome DevTools, on the guest. One line of code, and the single
            biggest difference between a viewer and a browser. */}
        <Tool label="Developer tools" onClick={() => {
          const w = el(); if (!w) return;
          try { w.isDevToolsOpened() ? w.closeDevTools() : w.openDevTools(); }
          catch { say("Developer tools are not available for this page"); }
        }}><CodeIcon /></Tool>
        <Tool label="Open in your own browser" onClick={() => {
          const u = active?.url;
          if (!u || u === BLANK) return say("There is no page to open");
          // Through the shell's own guarded opener, which refuses anything that
          // is not http(s) — the whole reason it exists.
          window.open(u, "_blank");
          say("Opened in your browser");
        }}><ExternalIcon /></Tool>

        <div className="relative shrink-0">
          <Tool label="More" on={menuOpen} onClick={() => setMenuOpen((v) => !v)}><MoreIcon /></Tool>
          {menuOpen && (
            <>
              <div className="fixed inset-0" style={{ zIndex: 40 }} onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 mt-1 rounded-lg text-[11px] py-1 shadow-2xl"
                style={{ zIndex: 41, minWidth: 230, background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)" }}>
                {[
                  { label: "New tab", hint: "Ctrl+T", run: newBlankTab },
                  { label: "Duplicate this tab", hint: "", run: () => active && open(active.url, active.id) },
                  { label: "Reload, ignoring the cache", hint: "", run: () => { try { el()?.reloadIgnoringCache(); } catch { el()?.reload(); } } },
                  { label: "Copy the address", hint: "", run: () => { void navigator.clipboard.writeText(active?.url ?? ""); say("Address copied"); } },
                  { label: "Zoom back to 100%", hint: "Ctrl+0", run: () => applyZoom(0) },
                ].map((it) => (
                  <button key={it.label} onClick={() => { setMenuOpen(false); it.run(); }}
                    className="w-full text-left px-3 py-1.5 flex items-center gap-3" style={{ color: "var(--text2)" }}>
                    <span className="flex-1">{it.label}</span>
                    {it.hint && <span className="text-[9.5px]" style={{ color: "var(--text3)" }}>{it.hint}</span>}
                  </button>
                ))}
                <div className="my-1" style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }} />
                <div className="px-3 pt-1 pb-0.5 text-[9px] tracking-wider uppercase" style={{ color: "var(--text3)" }}>Viewport</div>
                {VIEWPORTS.map((v) => (
                  <button key={v.name} onClick={() => { setMenuOpen(false); setViewport(v); }}
                    className="w-full text-left px-3 py-1.5 flex items-center gap-3"
                    style={{ color: v.name === viewport.name ? "var(--text)" : "var(--text2)" }}>
                    <span className="w-3 shrink-0">{v.name === viewport.name ? "✓" : ""}</span>
                    <span className="flex-1">{v.name}</span>
                    {v.width ? <span className="text-[9.5px] tabular-nums" style={{ color: "var(--text3)" }}>{v.width}px</span> : null}
                  </button>
                ))}
                <div className="my-1" style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }} />
                {/* The importer has been in Settings all along, which is three
                    clicks from the page that made you want it. Signing in to a
                    site is the moment you need your logins, not later. */}
                {[
                  { label: "Import logins from a browser…", run: () => openSettings("browser") },
                  { label: "Home page and search engine…", run: () => openSettings("browser") },
                ].map((it) => (
                  <button key={it.label} onClick={() => { setMenuOpen(false); it.run(); }}
                    className="w-full text-left px-3 py-1.5" style={{ color: "var(--text2)" }}>{it.label}</button>
                ))}
                <div className="px-3 pt-1 pb-0.5 text-[9.5px] leading-snug" style={{ color: "var(--text3)" }}>
                  Chrome, Firefox, Zen, Brave, LibreWolf and Chromium, if they
                  are on this machine.
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* The completion list. Anchored under the bar rather than floating in the
          middle, and only ever eight rows — see suggest(). */}
      {!!tips.length && (
        <div className="relative">
          <div className="absolute left-[132px] right-[220px] rounded-lg overflow-hidden shadow-2xl"
            style={{ zIndex: 35, background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)" }}>
            {tips.map((t, i) => (
              <button key={t.url}
                onMouseDown={(e) => { e.preventDefault(); go(t.url); setHint(-1); }}
                onMouseEnter={() => setHint(i)}
                className="w-full text-left px-2.5 py-1.5 flex items-center gap-2 text-[11px]"
                style={{ background: i === hint ? "color-mix(in srgb, var(--primary) 14%, transparent)" : "transparent" }}>
                <span className="shrink-0" style={{ color: t.why === "search" ? "var(--primary-hover)" : t.bookmarked ? "var(--warning)" : "var(--text3)", fontSize: 10 }}>
                  {t.why === "search" ? "\u2315" : t.bookmarked ? "\u2605" : "\u21bb"}
                </span>
                {t.why === "search" ? (
                  // A past search offers the term back, not the results URL it is
                  // stored as \u2014 clicking still reopens that URL (go(t.url)).
                  <>
                    <span className="truncate" style={{ color: "var(--text)" }}>{t.query}</span>
                    <span className="shrink-0 text-[10px]" style={{ color: "var(--text3)" }}>\u2014 search</span>
                  </>
                ) : (
                  <>
                    <span className="truncate" style={{ color: "var(--text)", maxWidth: "45%" }}>{t.title || t.url}</span>
                    <span className="truncate font-mono text-[10px]" style={{ color: "var(--text3)" }}>{t.url}</span>
                  </>
                )}
                {t.visits > 1 && <span className="ml-auto shrink-0 tabular-nums text-[9.5px]" style={{ color: "var(--text3)" }}>{t.visits}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {find !== null && (
        <div className="flex items-center gap-1.5 px-2 py-1 border-b shrink-0"
          style={{ borderColor: "color-mix(in srgb, var(--border) 25%, transparent)" }}>
          <input ref={findRef} value={find}
            onChange={(e) => {
              setFind(e.target.value);
              const w = el(); if (!w) return;
              try { e.target.value ? w.findInPage(e.target.value) : w.stopFindInPage("clearSelection"); } catch { /* gone */ }
            }}
            onKeyDown={(e) => {
              const w = el();
              if (e.key === "Enter" && w && find) { e.preventDefault(); try { w.findInPage(find, { findNext: true, forward: !e.shiftKey }); } catch { /* gone */ } }
              if (e.key === "Escape") { e.preventDefault(); try { w?.stopFindInPage("clearSelection"); } catch { /* gone */ } setFind(null); }
            }}
            placeholder="Find on this page — Enter for the next, Shift+Enter for the one before" spellCheck={false}
            className="flex-1 min-w-0 text-[11px] px-2 py-1 rounded outline-none bg-transparent"
            style={{ color: "var(--text)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }} />
          <Tool label="Close find" onClick={() => { try { el()?.stopFindInPage("clearSelection"); } catch { /* gone */ } setFind(null); }}><StopIcon /></Tool>
        </div>
      )}

      {active?.failed && (
        <div className="px-3 py-2 text-[11px] shrink-0" style={{ color: "var(--warning)" }}>{active.failed}</div>
      )}

      <div className="flex-1 min-h-0 relative" style={{ background: "var(--bg2)" }}>
        {tabs.map((t) => (
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
          <div key={t.id} className="absolute inset-0 flex justify-center"
            style={t.id === activeId ? undefined : { visibility: "hidden" }}>
            <div style={{ width: viewport.width ? `${viewport.width}px` : "100%", height: "100%", maxWidth: "100%" }}>
              {IS_DEMO ? (
                <DemoPage url={t.url || BLANK} />
              ) : (
                <webview
                  ref={bind(t.id) as unknown as React.Ref<HTMLElement>}
                  src={t.url || BLANK}
                  partition={partitionFor(BROWSER_PARTITION, t.profile)}
                  allowpopups={undefined}
                  style={{ width: "100%", height: "100%", background: "var(--bg)" }}
                />
              )}
            </div>
          </div>
          )
        ))}

        {/* Somewhere to start. A blank guest paints a black rectangle the size
            of the window, which is what made this view read as broken rather
            than as empty. */}
        {blank && !active?.failed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 pointer-events-none"
            style={{ background: "var(--bg)" }}>
            <span style={{ color: "var(--text3)", opacity: 0.3 }}><BlankPageIcon size={40} /></span>
            <span className="text-[11.5px]" style={{ color: "var(--text3)" }}>Type an address above to start browsing.</span>
            <span className="text-[10px] text-center leading-relaxed" style={{ color: "var(--text3)", opacity: 0.65 }}>
              Ctrl+L for the address bar · Ctrl+T for a tab · Ctrl+F to find<br />
              The three on the right point at an element, tell an agent about it, and draw on the page
            </span>
          </div>
        )}

        {(mode === "pick" || mode === "feedback") && (
          <PagePicker
            view={el()}
            url={active?.url ?? ""}
            title={active ? tabLabel(active) : ""}
            feedback={mode === "feedback"}
            onNote={say}
            onDone={() => setMode("none")}
          />
        )}
        {mode === "draw" && (
          <MarkupLayer view={el()} url={active?.url ?? ""} onNote={say} onDone={() => setMode("none")} />
        )}
      </div>
    </div>
  );
}

import { adoptServer } from "./api.ts";
import { partitionsFor } from "./browserProfiles.ts";

// Desktop-only capabilities.
//
// The same bundle runs in a browser tab and inside the Electron window, so
// anything that needs the native shell is optional: detected at runtime through
// the `window.agentglass` bridge the preload exposes, with a browser fallback
// where one exists (fullscreen) and a null "not applicable" where none does.

type DesktopBridge = {
  desktop: true;
  platform: string;
  /** Absent on shells built before the browser view existed. */
  browser?: boolean;
  browserPartition?: string;
  setFullscreen: (on: boolean) => Promise<boolean>;
  isFullscreen: () => Promise<boolean>;
  setZoom: (factor: number) => Promise<number>;
  autostartEnabled: () => Promise<boolean>;
  setAutostart: (on: boolean) => Promise<boolean>;
  revealPath?: (p: string) => Promise<{ ok: boolean; error?: string }>;
  remoteEnabled?: () => Promise<boolean>;
  setRemote?: (on: boolean) => Promise<boolean>;
  revokeRemote?: () => Promise<boolean>;
  onServerChanged?: (fn: (p: { origin?: string | null; token?: string | null }) => void) => () => void;
  /** The window's own controls. Optional because an older shell still has a
   *  system title bar and does not need them — and because a renderer that
   *  assumed they were there would draw three dead buttons in a browser tab. */
  winMinimize?: () => Promise<void>;
  winToggleMaximize?: () => Promise<boolean>;
  winClose?: () => Promise<void>;
  winIsMaximized?: () => Promise<boolean>;
  winState?: () => Promise<{ max: boolean; full: boolean }>;
  appMenu?: (x: number, y: number) => Promise<void>;
  onWinState?: (fn: (st: { max: boolean; full: boolean }) => void) => () => void;
  /** Absent on shells built before the project picker learned to browse. */
  chooseFolder?: (start?: string) => Promise<string | null>;
  /** Absent on shells built before the browser could zoom. */
  onBrowserZoom?: (fn: (level: number) => void) => () => void;
  onBrowserOpenTab?: (fn: (url: string) => void) => () => void;
  setActiveBrowserGuest?: (id: number) => Promise<boolean>;
  browserPlaces?: (req: { source: string }) => Promise<{ ok: boolean; places?: ImportedPlace[]; error?: string }>;
  /** Absent on shells built before agents could screenshot the browser. */
  captureBrowser?: () => Promise<string | null>;
  /** All absent on shells built before cookie import existed. */
  cookieSources?: () => Promise<CookieSourcesReply>;
  importCookies?: (req: { source: string; sites: string[] }) => Promise<CookieImportReply>;
  forgetCookies?: (req: { sites: string[]; partitions?: string[] }) => Promise<{ ok: boolean; removed?: number; profiles?: number; error?: string }>;
};

/** A page another browser knows about. History and bookmarks arrive as one
 *  shape, because the address bar treats them as one list. */
export interface ImportedPlace {
  url: string; title: string; visits: number; lastAt: number; bookmarked: boolean;
}

/** What the reader answers with. Sites and counts; never a name, never a value. */
export interface CookieSite { site: string; cookies: number }
export interface CookieSource {
  id: string; label: string; kind: "firefox" | "chromium";
  /** False when the values are encrypted with a key this cannot reach. */
  readable: boolean;
  rows: number;
  reason?: string;
  sites: CookieSite[];
}
export type CookieSourcesReply = { ok: boolean; sources?: CookieSource[]; error?: string };
export type CookieImportReply = {
  ok: boolean; set?: number; failed?: { name: string; url: string; error: string }[];
  skipped?: Record<string, number>; error?: string;
};

/** Whether this shell can bring existing logins in at all. */
export const CAN_IMPORT_COOKIES = typeof (typeof window !== "undefined"
  ? (window as unknown as { agentglass?: { cookieSources?: unknown } }).agentglass?.cookieSources
  : undefined) === "function";

export async function cookieSources(): Promise<CookieSourcesReply> {
  const b = bridge();
  if (!b?.cookieSources) return { ok: false, error: "this build cannot read other browsers" };
  try { return await b.cookieSources(); } catch (e) { return { ok: false, error: String(e) }; }
}

export async function importCookies(source: string, sites: string[]): Promise<CookieImportReply> {
  const b = bridge();
  if (!b?.importCookies) return { ok: false, error: "this build cannot import cookies" };
  try { return await b.importCookies({ source, sites }); } catch (e) { return { ok: false, error: String(e) }; }
}

/**
 * Forget these sites, everywhere this browser keeps them.
 *
 * The profile list is the renderer's, so the partitions have to be named from
 * here — and every one of them, or the button lies: it would report a number,
 * look finished, and leave the login it was asked to remove sitting in another
 * profile's jar. The main process validates each name and always sweeps the
 * default whether or not it was listed.
 */
export async function forgetCookies(sites: string[], profileIds: readonly string[] = []): Promise<{ ok: boolean; removed?: number; profiles?: number; error?: string }> {
  const b = bridge();
  if (!b?.forgetCookies) return { ok: false, error: "this build cannot remove them" };
  const partitions = partitionsFor(BROWSER_PARTITION, profileIds);
  try { return await b.forgetCookies({ sites, partitions }); } catch (e) { return { ok: false, error: String(e) }; }
}

function bridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  const b = (window as unknown as { agentglass?: DesktopBridge }).agentglass;
  return b && b.desktop ? b : null;
}

/** True when running inside the desktop app rather than a browser tab. */
export const IS_DESKTOP = bridge() !== null;

export const IS_MAC_DESKTOP = IS_DESKTOP && bridge()?.platform === "darwin";

/** Whether a page can be embedded — a `<webview>`, which exists in the shell
 *  and not in a phone's browser tab. Checked rather than assumed from
 *  IS_DESKTOP so that an older shell, which is still the desktop app, does not
 *  render a view it cannot fill. */
export const HAS_BROWSER = bridge()?.browser === true;

/** The session guests run in. The main process attaches a guest on this
 *  partition and refuses every other, so it is read from the shell rather than
 *  written down twice. */
export const BROWSER_PARTITION = bridge()?.browserPartition ?? "";

/** Whether this shell can open the system's folder chooser. False in a browser
 *  tab, and false on a shell built before it existed — the picker offers its
 *  path box instead of a button that would do nothing. */
export const CAN_BROWSE_FOLDER = typeof bridge()?.chooseFolder === "function";

/**
 * Ask the system for a folder. Null when the person cancelled, and null when
 * there is no chooser to ask — the caller treats both the same way, because
 * "no folder came back" is the only thing it can act on.
 */
export async function chooseFolder(start?: string): Promise<string | null> {
  const b = bridge();
  if (!b?.chooseFolder) return null;
  try {
    return await b.chooseFolder(start);
  } catch {
    return null;
  }
}

/**
 * Hear about a zoom the shell has just applied to the built-in browser.
 *
 * A no-op unsubscribe when the shell is older or this is a browser tab, so the
 * caller can wire it unconditionally in an effect.
 */
export function onBrowserZoom(fn: (level: number) => void): () => void {
  const b = bridge();
  return b?.onBrowserZoom ? b.onBrowserZoom(fn) : () => {};
}

/**
 * A page in the built-in browser asked for a window.
 *
 * A middle click, a `target="_blank"`, an OAuth popup. Every one of them used
 * to be handed to the OS browser, because a single-page view had nowhere else
 * to put it — which threw you out of the app to finish a login. Now it becomes
 * a tab. A no-op unsubscribe on an older shell, so the caller can wire it
 * unconditionally.
 */
export function onBrowserOpenTab(fn: (url: string) => void): () => void {
  const b = bridge();
  return b?.onBrowserOpenTab ? b.onBrowserOpenTab(fn) : () => {};
}

/**
 * Tell the shell which tab is on screen.
 *
 * The main process keeps one "current browser" — it is what the Ctrl+wheel
 * zoom lands on and what an agent's screenshot captures. With one page that was
 * always whichever guest attached last; with tabs it is whichever you are
 * looking at, and this side is the only one that knows.
 */
export function setActiveBrowserGuest(id: number): void {
  const b = bridge();
  try { void b?.setActiveBrowserGuest?.(id); } catch { /* older shell */ }
}

/**
 * The pages and bookmarks in another browser's profile.
 *
 * Read by the shell rather than the server for the same reason the cookies
 * are: this is somebody's browsing history, and a route would put it on the
 * API surface an agent can reach.
 */
export async function browserPlaces(source: string): Promise<ImportedPlace[]> {
  const b = bridge();
  if (!b?.browserPlaces) return [];
  try {
    const r = await b.browserPlaces({ source });
    return r.ok ? (r.places ?? []) : [];
  } catch { return []; }
}

/**
 * A screenshot of the built-in browser as a data URL, taken by the shell.
 *
 * Null when this is a browser tab, when the shell predates it, or when there is
 * no page to capture — the caller falls back to asking the element, which works
 * whenever the pane happens to be on screen.
 */
export async function captureBrowser(): Promise<string | null> {
  const b = bridge();
  if (!b?.captureBrowser) return null;
  try { return await b.captureBrowser(); } catch { return null; }
}

/** Whether the app is set to launch at login. Null when not applicable (a
 *  browser tab) or when the shell refuses to answer — the caller renders
 *  nothing rather than guessing a state it can't verify. */
export async function autostartEnabled(): Promise<boolean | null> {
  const b = bridge();
  if (!b) return null;
  try {
    return await b.autostartEnabled();
  } catch {
    return null;
  }
}

/** Turn launch-at-login on or off; resolves to the state actually in effect. */
export async function setAutostart(on: boolean): Promise<boolean | null> {
  const b = bridge();
  if (!b) return null;
  try {
    return await b.setAutostart(on);
  } catch {
    return null;
  }
}

/**
 * Fullscreen, the way every other app on the machine does it.
 *
 * Worth having because this is a cockpit you sit in front of for hours, and the
 * terminal and diff panels are already built to take the whole window — the OS
 * chrome around them is the only thing left to reclaim.
 *
 * Returns the state actually applied, or null in a browser tab. There the
 * element Fullscreen API is the right mechanism instead, which `toggleFullscreen`
 * falls back to, so F11 does the expected thing on both surfaces.
 */
export async function setFullscreen(on: boolean): Promise<boolean | null> {
  const b = bridge();
  if (!b) return null;
  try {
    return await b.setFullscreen(on);
  } catch {
    return null;
  }
}

export async function isFullscreen(): Promise<boolean> {
  const b = bridge();
  if (!b) return !!document.fullscreenElement;
  try {
    return await b.isFullscreen();
  } catch {
    return false;
  }
}

/** Flip it, on whichever surface this is running. */
export async function toggleFullscreen(): Promise<boolean> {
  const now = await isFullscreen();
  if (IS_DESKTOP) {
    await setFullscreen(!now);
    return !now;
  }
  try {
    // A browser tab: the native window belongs to the browser, so the page can
    // only ask for element-level fullscreen — which still gets rid of the tab
    // strip and the address bar, i.e. everything the user meant.
    if (now) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
    return !now;
  } catch {
    return now; // denied (needs a user gesture, or the browser said no)
  }
}

/** Scale the whole window the way a browser's own zoom does: the webview
 *  relays out at a smaller CSS viewport, so the UI reflows at the new size
 *  instead of just being drawn bigger. Resolves to the factor applied, or null
 *  in a browser tab — there the browser's zoom already covers this, and the
 *  shell has no say. See lib/uiScale.ts for why this beats a font-size knob. */
export async function setWindowZoom(factor: number): Promise<number | null> {
  const b = bridge();
  if (!b) return null;
  try {
    return await b.setZoom(factor);
  } catch {
    return null;
  }
}

/**
 * Whether the shell is holding the sidecar open to the network.
 *
 * Null when the question does not apply — a browser tab, or a shell built
 * before this existed. The panel renders the manual recipe in that case rather
 * than a toggle that would do nothing: only the process that spawns the server
 * can change what it is bound to.
 */
export async function remoteAccessEnabled(): Promise<boolean | null> {
  const b = bridge();
  if (!b?.remoteEnabled) return null;
  try {
    return await b.remoteEnabled();
  } catch {
    return null;
  }
}

/**
 * Open or close the door, and wait for it to actually be open or closed.
 *
 * This restarts the sidecar (a socket's bind cannot change under it) and then
 * reloads the window, so the promise resolving is the last thing this code sees
 * — treat it as fire-and-forget. Null when the shell cannot do it.
 */
export async function setRemoteAccess(on: boolean): Promise<boolean | null> {
  const b = bridge();
  if (!b?.setRemote) return null;
  try {
    return await b.setRemote(on);
  } catch {
    return null;
  }
}

/**
 * Invalidate every link handed out so far and mint a new one.
 *
 * The toggle cannot do this on its own: turning remote access off shuts the
 * port, but a phone that scanned the code still holds a working key for the
 * next time it goes on. Rotating the secret is the only revoke that reaches
 * devices you no longer have.
 *
 * False when the shell declines — a token pinned in the environment is not the
 * app's to rotate. Null when there is no shell to ask.
 */
export async function revokeRemoteAccess(): Promise<boolean | null> {
  const b = bridge();
  if (!b?.revokeRemote) return null;
  try {
    return await b.revokeRemote();
  } catch {
    return null;
  }
}

/**
 * Follow the sidecar when the shell restarts it.
 *
 * Toggling remote access and revoking a link both bring the server back with a
 * different token, and possibly on a different port. This is what lets that
 * happen under a running app: the shell hands over the new pair, the api module
 * adopts it, and a `agentglass:server-changed` event lets anything holding a
 * socket reconnect. No reload, so terminals, drafts and scroll positions
 * survive a setting change.
 */
export function followServerChanges(): () => void {
  const b = bridge();
  if (!b?.onServerChanged) return () => {};
  return b.onServerChanged((p) => {
    adoptServer(p);
    window.dispatchEvent(new CustomEvent("agentglass:server-changed"));
  });
}

/**
 * The window's minimise / maximise / close, when this shell draws its own.
 *
 * Null in a browser tab and on a shell old enough to still have a system title
 * bar, which is exactly when the buttons must not be drawn: three controls that
 * do nothing are worse than a title bar.
 */
export const WINDOW_CONTROLS = (() => {
  const b = bridge();
  if (!b?.winMinimize || !b.winToggleMaximize || !b.winClose) return null;
  return {
    minimize: () => { void b.winMinimize!().catch(() => {}); },
    toggleMaximize: () => { void b.winToggleMaximize!().catch(() => {}); },
    close: () => { void b.winClose!().catch(() => {}); },
    /** Maximised AND fullscreen, in one answer — they are different states and
     *  two different parts of the bar care about them. */
    state: () => b.winState?.() ?? Promise.resolve({ max: false, full: false }),
    /** The app menu, popped under a point in window coordinates. Null-safe:
     *  an older shell has a real menu bar and needs no button for it. */
    menu: b.appMenu ? (x: number, y: number) => { void b.appMenu!(x, y).catch(() => {}); } : null,
    /** Subscribe to changes the window manager made without asking us. */
    subscribe: (fn: (st: { max: boolean; full: boolean }) => void) => b.onWinState?.(fn) ?? (() => {}),
  };
})();

/**
 * Show a file where it lives, in the desktop's own file manager.
 *
 * Null when there is nothing to ask — a browser tab, or a shell built before
 * this existed — so a caller can leave the button out rather than draw one that
 * does nothing. `showItemInFolder` selects the item; it never runs it.
 */
export async function revealPath(p: string): Promise<{ ok: boolean; error?: string } | null> {
  const b = bridge();
  if (!b?.revealPath) return null;
  try { return await b.revealPath(p); }
  catch (e) { return { ok: false, error: String(e) }; }
}

/** Whether this shell can show a file in the file manager at all. Read at
 *  render time so a button is not offered where it would be dead. */
export const canReveal = (): boolean => !!bridge()?.revealPath;

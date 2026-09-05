import { adoptServer } from "./api.ts";
import { partitionsFor } from "./browserProfiles.ts";
import type { ImportedShelf } from "./browserShelf.ts";

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
  /** Absent on shells built before the machine could stay awake for an agent. */
  powerStatus?: () => Promise<PowerStatus>;
  setPowerMode?: (mode: PowerMode) => Promise<PowerStatus>;
  remoteEnabled?: () => Promise<boolean>;
  setRemote?: (on: boolean) => Promise<boolean>;
  revokeRemote?: () => Promise<boolean>;
  onServerChanged?: (fn: (p: { origin?: string | null; token?: string | null }) => void) => () => void;
  /** The window's own controls. Optional because an older shell still has a
   *  system title bar and does not need them — and because a renderer that
   *  assumed they were there would draw three dead buttons in a browser tab. */
  winMinimize?: () => Promise<void>;
  winToggleMaximize?: (why?: string) => Promise<boolean>;
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
  /** Absent on shells built before the browser had its own keyboard. */
  onBrowserKey?: (fn: (key: string) => void) => () => void;
  onBrowserSearch?: (fn: (text: string) => void) => () => void;
  /** All absent on shells built before the inspector was a pane. */
  browserDevtools?: (req: { guest: number; rect: DevtoolsRect; x?: number; y?: number; zoom?: number }) => Promise<{ ok: boolean; docked?: boolean; error?: string }>;
  browserDevtoolsClose?: (req: { guest: number }) => Promise<{ ok: boolean }>;
  browserDevtoolsRect?: (req: { guest: number; rect: DevtoolsRect }) => void;
  browserDevtoolsZoom?: (req: { guest: number; level: number }) => Promise<{ ok: boolean; level?: number }>;
  onDevtoolsZoom?: (fn: (at: { guest: number; level: number }) => void) => () => void;
  onBrowserInspect?: (fn: (at: { x: number; y: number }) => void) => () => void;
  setActiveBrowserGuest?: (id: number) => Promise<boolean>;
  browserPlaces?: (req: { source: string }) => Promise<{ ok: boolean; places?: ImportedPlace[]; error?: string }>;
  /** Absent on shells built before a sidebar could be imported. */
  browserShelfRead?: (source: string) => Promise<{ ok: boolean; shelf?: unknown; error?: string }>;
  captureFullPage?: (how?: "copy" | "save") => Promise<{ ok: boolean; width?: number; height?: number; cut?: boolean; path?: string; error?: string }>;
  /** Absent on shells built before agents could screenshot the browser. */
  /* §12 widened this: a crop and a full-page capture are the SHELL's job,
     because a webview cannot screenshot beyond its own viewport. */
  captureBrowser?: (opts?: { clip?: { x: number; y: number; width: number; height: number }; fullPage?: boolean; guestId?: number }) =>
    Promise<string | null | { png: string | null; why?: string; cut?: boolean }>;
  /** Absent on shells built before §4 — addInitScript/expose. */
  registerInitScript?: (name: string, source: string, guestId?: number) => Promise<{ ok: boolean; error?: string }>;
  /** Absent on shells built before §5 — the DevTools protocol, relayed whole. */
  cdp?: (method: string, params?: unknown, guestId?: number) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  /** The PERSON's zoom — `webContents.setZoomFactor` in the shell, which scales
   *  the page inside the box it has. Omit the factor to read. */
  zoom?: (factor?: number, guestId?: number) => Promise<{ ok: boolean; factor?: number; percent?: number; error?: string }>;
  cdpEvents?: () => Promise<{ ok: boolean; events?: Array<{ at: number; method: string; params: unknown }>; error?: string }>;
  /** All absent on shells built before session-level settings existed. */
  sessionSettings?: (req: Record<string, unknown>) => Promise<{ ok: boolean; applied?: string[]; error?: string }>;
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
 * A browser chord pressed while the PAGE had the focus.
 *
 * `t`, `l`, `f` — a new tab, the address bar, the find strip. The shell keeps
 * reload and back to itself: those are the page's own business and forwarding
 * them would take the focus off it for nothing.
 */
export function onBrowserKey(fn: (key: string) => void): () => void {
  const b = bridge();
  return b?.onBrowserKey ? b.onBrowserKey(fn) : () => {};
}

/** "Search the web for…", from the page's own context menu. Text, not a url:
 *  the engine is a setting, and it lives on this side. */
export function onBrowserSearch(fn: (text: string) => void): () => void {
  const b = bridge();
  return b?.onBrowserSearch ? b.onBrowserSearch(fn) : () => {};
}

/**
 * Put the inspector in a pane of this window instead of a floating one.
 *
 * A `<webview>` guest has no window of its own, so every docking mode Electron
 * offers collapses to "detached" — which on a fractionally scaled display came
 * up as a separate window whose content did not fill its frame. The shell hosts
 * the DevTools in a view of its own and floats it over the hole the panel
 * leaves for it; `rect` is that hole, in the renderer's own pixels.
 *
 * NOT a second `<webview>`, which is the obvious reading of the API and was the
 * first attempt: measured, it came up with a working toolbar and an empty
 * Elements tree — a webview-to-webview limitation open since 2018.
 */
export async function browserDevtools(req: { guest: number; rect: DevtoolsRect; x?: number; y?: number; zoom?: number }): Promise<{ ok: boolean; docked?: boolean; error?: string }> {
  const b = bridge();
  if (!b?.browserDevtools) return { ok: false, error: "this shell has no inspector" };
  try { return await b.browserDevtools(req); } catch { return { ok: false, error: "the inspector could not be opened" }; }
}

/** Where the inspector's hole is, in the renderer's own pixels. `on: false`
 *  hides it without closing it — a floating view knows nothing about which
 *  workspace view is on screen, and left visible it sits over the terminal. */
export interface DevtoolsRect { x: number; y: number; width: number; height: number; on?: boolean }

/**
 * The inspector's own zoom — not the app's, and not the page's.
 *
 * It is a WebContents of its own, so this is one call and it touches nothing
 * else. The gesture, though, is not free: Ctrl+plus and Ctrl+wheel land inside
 * that view and never reach this document, so the shell catches them there and
 * reports back through `onDevtoolsZoom`.
 */
export function browserDevtoolsZoom(guest: number, level: number): void {
  const b = bridge();
  try { void b?.browserDevtoolsZoom?.({ guest, level }); } catch { /* older shell */ }
}

export function onDevtoolsZoom(fn: (at: { guest: number; level: number }) => void): () => void {
  const b = bridge();
  return b?.onDevtoolsZoom ? b.onDevtoolsZoom(fn) : () => {};
}

export function browserDevtoolsRect(guest: number, rect: DevtoolsRect): void {
  const b = bridge();
  try { b?.browserDevtoolsRect?.({ guest, rect }); } catch { /* older shell */ }
}

export async function browserDevtoolsClose(guest: number): Promise<void> {
  const b = bridge();
  try { await b?.browserDevtoolsClose?.({ guest }); } catch { /* older shell */ }
}

/** "Inspect" from the page's own context menu, with where it was clicked. */
export function onBrowserInspect(fn: (at: { x: number; y: number }) => void): () => void {
  const b = bridge();
  return b?.onBrowserInspect ? b.onBrowserInspect(fn) : () => {};
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
/**
 * Another browser's sidebar: its spaces, its folders, its pinned pages.
 *
 * Read by the shell rather than the server, like the cookies and the history —
 * it is somebody's browsing, and a route would put it on the surface an agent
 * driving this browser can reach.
 */
/**
 * The whole page — scroll included — onto the desktop's clipboard.
 *
 * Done in the shell rather than here for two reasons: what is below the fold
 * was never painted, so only the debugger can render it; and a renderer's
 * clipboard write is refused while the guest holds the focus, which during a
 * screenshot it always does.
 */
export async function captureFullPage(how: "copy" | "save" = "copy"): Promise<{ ok: boolean; width?: number; height?: number; cut?: boolean; path?: string; error?: string }> {
  const b = bridge();
  if (!b?.captureFullPage) return { ok: false, error: "this shell cannot capture a whole page" };
  try { return await b.captureFullPage(how); } catch { return { ok: false, error: "the capture did not answer" }; }
}

export async function browserShelfRead(source: string): Promise<{ ok: boolean; shelf?: ImportedShelf; error?: string }> {
  const b = bridge();
  if (!b?.browserShelfRead) return { ok: false, error: "this shell cannot read another browser's sidebar" };
  try { return await b.browserShelfRead(source) as { ok: boolean; shelf?: ImportedShelf; error?: string }; }
  catch (e) { return { ok: false, error: String(e) }; }
}

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
/**
 * A frame of the browser pane, and the reason when there is none.
 *
 * The shell used to answer a bare `null` and every caller reported it as "the
 * pane is not on screen" — which is one of three reasons and was usually not
 * the right one. An older shell still answers a string, and that is handled
 * rather than assumed away.
 */
export async function captureBrowser(
  /** `shot --selector/--clip` (§12/§18): what the frame should contain,
   *  resolved before the shell ever asks Chromium for one. */
  opts?: { clip?: { x: number; y: number; width: number; height: number }; fullPage?: boolean },
  /** §9: WHICH tab. Without it the shell captures whichever guest is in front,
   *  so one agent's shot came back as a picture of another agent's page —
   *  right dimensions, plausible content, wrong page, and nothing saying so. */
  guestId?: number,
): Promise<{ png: string | null; why: string; cut?: boolean; url?: string }> {
  const b = bridge();
  if (!b?.captureBrowser) return { png: null, why: "this shell cannot capture the browser" };
  try {
    const r = await b.captureBrowser({ ...(opts ?? {}), ...(guestId ? { guestId } : {}) });
    if (typeof r === "string" || r === null) return { png: r, why: r ? "" : "the pane produced no frame" };
    return { png: r.png, why: r.why ?? "", cut: r.cut, url: (r as { url?: string }).url };
  } catch { return { png: null, why: "the capture did not answer" }; }
}

/** §4: register a named init script with the shell — see
 *  `registerInitScript` on `AgentglassBridge` and `browserDrive.ts`, which
 *  calls this. */
export async function registerBrowserInitScript(name: string, source: string, guestId?: number): Promise<{ ok: boolean; error?: string }> {
  const b = bridge();
  if (!b?.registerInitScript) return { ok: false, error: "this shell cannot register an init script" };
  try {
    return await b.registerInitScript(name, source, guestId);
  } catch { return { ok: false, error: "the shell did not answer" }; }
}

/**
 * §5: one CDP command, and the events that arrived since the last drain.
 *
 * Deliberately not one wrapper per DevTools feature. The spec names nine —
 * debugger, DOM breakpoints, listeners, coverage, profiler, heap, source maps,
 * layers, accessibility audit — and every one is a domain Chromium already
 * speaks. Nine wrappers would be nine ways to be missing the tenth.
 */
export async function browserCdp(
  method: string,
  params?: unknown,
  /** §9: WHICH tab. Without it the relay talks to whichever guest is in front,
   *  so every DevTools call — the screenshot route included — went to the tab
   *  the person was looking at rather than the one the caller named. */
  guestId?: number,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const b = bridge();
  if (!b?.cdp) return { ok: false, error: "this shell has no DevTools protocol relay" };
  try {
    return await b.cdp(method, params, guestId);
  } catch { return { ok: false, error: "the shell did not answer" }; }
}

/**
 * The person's zoom on the tab they are looking at.
 *
 * Separate from the `zoom` VERB, which is a device metrics override: an
 * override narrows the layout viewport while the `<webview>` keeps its box, so
 * the page comes out the same size in a smaller rectangle. Right for an agent
 * emulating a screen, wrong for a person leaning in — reported with three
 * screenshots of a page shrinking into the corner.
 *
 * Omitting the factor reads the current one, through the same door, so reading
 * and setting cannot disagree.
 */
export async function browserZoom(
  factor?: number, guestId?: number,
): Promise<{ ok: true; factor: number; percent: number } | { ok: false; error: string }> {
  const b = bridge();
  if (!b?.zoom) return { ok: false, error: "this shell cannot zoom a page" };
  try {
    const r = await b.zoom(factor, guestId);
    if (!r?.ok || typeof r.factor !== "number") return { ok: false, error: r?.error || "the shell did not answer" };
    return { ok: true, factor: r.factor, percent: r.percent ?? Math.round(r.factor * 100) };
  } catch { return { ok: false, error: "the shell did not answer" }; }
}

/** Whatever CDP sent while nobody was asking — a debugger pause, a DOM
 *  breakpoint firing, a console call. Draining empties the buffer, so two
 *  callers do not both get the same pause and both act on it. */
export async function browserCdpEvents(): Promise<Array<{ at: number; method: string; params: unknown }>> {
  const b = bridge();
  if (!b?.cdpEvents) return [];
  try {
    const r = await b.cdpEvents();
    return r.ok && Array.isArray(r.events) ? r.events : [];
  } catch { return []; }
}

/** Apply session-level settings: proxy, extensions, cookies, DNS.
 *  Session-level settings are applied through the Electron main process,
 *  not through the page's DevTools protocol. */
export async function applySessionSettings(req: Record<string, unknown>): Promise<{ ok: boolean; applied?: string[]; error?: string }> {
  const b = bridge();
  if (!b?.sessionSettings) return { ok: false, error: "this shell does not support session settings" };
  try {
    return await b.sessionSettings(req);
  } catch { return { ok: false, error: "the shell did not apply the settings" }; }
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

/** `on` stays awake continuously, `agent` only while something is working,
 *  `off` allows normal sleep. */
export type PowerMode = "on" | "agent" | "off";
export interface PowerStatus {
  mode: PowerMode;
  /** Whether the assertion is held right now. */
  awake: boolean;
  /** The last poll's answer to "is an agent working" — only meaningful in `agent` mode. */
  working: boolean;
}

/** Null in a browser tab, or on a shell built before this existed. */
export async function powerStatus(): Promise<PowerStatus | null> {
  const b = bridge();
  if (!b?.powerStatus) return null;
  try {
    return await b.powerStatus();
  } catch {
    return null;
  }
}

export async function setPowerMode(mode: PowerMode): Promise<PowerStatus | null> {
  const b = bridge();
  if (!b?.setPowerMode) return null;
  try {
    return await b.setPowerMode(mode);
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
    toggleMaximize: (why?: string) => { void b.winToggleMaximize!(why).catch(() => {}); },
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

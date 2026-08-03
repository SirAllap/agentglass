import { adoptServer } from "./api.ts";

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
  remoteEnabled?: () => Promise<boolean>;
  setRemote?: (on: boolean) => Promise<boolean>;
  revokeRemote?: () => Promise<boolean>;
  onServerChanged?: (fn: (p: { origin?: string | null; token?: string | null }) => void) => () => void;
};

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

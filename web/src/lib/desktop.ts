// Desktop-only capabilities.
//
// The same bundle runs in a browser tab and inside the Electron window, so
// anything that needs the native shell is optional: detected at runtime through
// the `window.agentglass` bridge the preload exposes, with a browser fallback
// where one exists (fullscreen) and a null "not applicable" where none does.

type DesktopBridge = {
  desktop: true;
  platform: string;
  setFullscreen: (on: boolean) => Promise<boolean>;
  isFullscreen: () => Promise<boolean>;
  setZoom: (factor: number) => Promise<number>;
  autostartEnabled: () => Promise<boolean>;
  setAutostart: (on: boolean) => Promise<boolean>;
};

function bridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  const b = (window as unknown as { agentglass?: DesktopBridge }).agentglass;
  return b && b.desktop ? b : null;
}

/** True when running inside the desktop app rather than a browser tab. */
export const IS_DESKTOP = bridge() !== null;

export const IS_MAC_DESKTOP = IS_DESKTOP && bridge()?.platform === "darwin";

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

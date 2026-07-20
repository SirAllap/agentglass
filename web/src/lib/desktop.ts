// Desktop-only capabilities.
//
// The same bundle runs in a browser tab and inside the Tauri window, so
// anything that needs the native shell has to be optional: detected at
// runtime, and imported only once we know the shell is there. The dynamic
// import keeps the plugin out of the browser's bundle entirely — Vite splits
// it into a chunk a plain tab never requests.

/** True when running inside the desktop app rather than a browser tab. */
export const IS_DESKTOP =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const IS_MAC_DESKTOP = IS_DESKTOP && /mac/i.test(navigator.platform ?? "");

type AutostartApi = {
  isEnabled: () => Promise<boolean>;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
};

let cached: Promise<AutostartApi> | null = null;
function autostart(): Promise<AutostartApi> {
  cached ??= import("@tauri-apps/plugin-autostart");
  return cached;
}

/** Whether the app is set to launch at login. Null when not applicable (a
 *  browser tab) or when the shell refuses to answer — the caller renders
 *  nothing rather than guessing a state it can't verify. */
export async function autostartEnabled(): Promise<boolean | null> {
  if (!IS_DESKTOP) return null;
  try {
    return await (await autostart()).isEnabled();
  } catch {
    return null;
  }
}

/** Turn launch-at-login on or off; resolves to the state actually in effect. */
export async function setAutostart(on: boolean): Promise<boolean | null> {
  if (!IS_DESKTOP) return null;
  try {
    const api = await autostart();
    if (on) await api.enable();
    else await api.disable();
    return await api.isEnabled();
  } catch {
    return null;
  }
}

let webviewApi: Promise<typeof import("@tauri-apps/api/webview")> | null = null;
function webview() {
  webviewApi ??= import("@tauri-apps/api/webview");
  return webviewApi;
}

let windowApi: Promise<typeof import("@tauri-apps/api/window")> | null = null;
function appWindow() {
  windowApi ??= import("@tauri-apps/api/window");
  return windowApi;
}

/**
 * Fullscreen, the way every other app on the machine does it.
 *
 * Worth having because this is a cockpit you sit in front of for hours, and
 * the terminal and diff panels are already built to take the whole window —
 * the OS chrome around them is the only thing left to reclaim.
 *
 * Returns the state actually applied, or null in a browser tab. There the
 * Fullscreen API is the right mechanism instead, which `toggleFullscreen`
 * below falls back to, so F11 does the expected thing on both surfaces.
 */
export async function setFullscreen(on: boolean): Promise<boolean | null> {
  if (!IS_DESKTOP) return null;
  try {
    const { getCurrentWindow } = await appWindow();
    await getCurrentWindow().setFullscreen(on);
    return on;
  } catch {
    return null;
  }
}

export async function isFullscreen(): Promise<boolean> {
  if (!IS_DESKTOP) return !!document.fullscreenElement;
  try {
    const { getCurrentWindow } = await appWindow();
    return await getCurrentWindow().isFullscreen();
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
    // only ask for the element-level fullscreen — which still gets rid of the
    // tab strip and the address bar, i.e. everything the user meant.
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
  if (!IS_DESKTOP) return null;
  try {
    const { getCurrentWebview } = await webview();
    await getCurrentWebview().setZoom(factor);
    return factor;
  } catch {
    return null;
  }
}

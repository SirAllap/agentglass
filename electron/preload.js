// Bridge between the web UI and the Electron shell. Exposes exactly the native
// capabilities the cockpit uses (fullscreen, window zoom, launch-at-login) on
// a single `window.agentglass` object, so web/src/lib/desktop.ts can detect the
// desktop and call them. Everything else stays browser-standard.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentglass", {
  desktop: true,
  platform: process.platform,
  // A <webview> exists here and does not in a phone's browser tab, so the
  // browser view asks before it draws itself. Announced as a capability rather
  // than inferred from `desktop`, because the two can come apart: an older
  // shell is still the desktop app and has no guest to give.
  browser: true,
  /** The default browsing session, and the stem every profile's partition is
   *  built from (`<this>-<slug>`). The renderer must not invent the stem: the
   *  main process refuses to attach a guest on anything outside that family,
   *  and the app's own session is deliberately not in it. */
  browserPartition: "persist:agentglass-browser",
  // Where the sidecar listens. The renderer is served from agentglass://app,
  // whose hostname says nothing about the API — without this the web app would
  // derive `http://app:4000` from location.hostname and reach nothing.
  //
  // Asked of the main process rather than assumed from the env: the port is not
  // knowable up front, since another app may already hold the preferred one and
  // the shell then moves aside (electron/main.js). Sync because api.ts reads
  // this during module evaluation.
  apiOrigin: (() => {
    try { return ipcRenderer.sendSync("ag:apiOrigin") || null; } catch { return null; }
  })() || `http://127.0.0.1:${Number(process.env.AGENTGLASS_PORT || 4000)}`,
  // The shared secret, when one is in force (remote access on, or a token set
  // in the environment). Sync for the same reason as apiOrigin: api.ts reads it
  // during module evaluation and there is no second chance to hand it over.
  // Null in the ordinary loopback-only case, where nothing requires a token.
  apiToken: (() => {
    try { return ipcRenderer.sendSync("ag:apiToken") || null; } catch { return null; }
  })(),
  remoteEnabled: () => ipcRenderer.invoke("ag:remoteEnabled"),
  setRemote: (on) => ipcRenderer.invoke("ag:setRemote", on),
  revokeRemote: () => ipcRenderer.invoke("ag:revokeRemote"),
  // The browser element-picker copies through the MAIN process clipboard, not
  // navigator.clipboard. When you press C/S the focus is on the <webview> guest,
  // so a renderer clipboard write is denied for a document that is not focused
  // and fails silently — which is exactly why the picker said "copied" and
  // copied nothing. The main process needs neither focus nor a user gesture.
  // Both resolve true on success, false on failure, so the caller can stop
  // claiming a copy that did not happen.
  copyText: (text) => ipcRenderer.invoke("ag:copyText", String(text ?? "")),
  copyImage: (dataUrl) => ipcRenderer.invoke("ag:copyImage", String(dataUrl ?? "")),
  // Fired when the sidecar has been restarted under the app: a new port, a new
  // token, or both. Carries them rather than asking the page to reload.
  onServerChanged: (fn) => {
    const h = (_e, payload) => { try { fn(payload); } catch { /* renderer's problem */ } };
    ipcRenderer.on("ag:server-changed", h);
    return () => ipcRenderer.removeListener("ag:server-changed", h);
  },
  // Why there is no server, when there is no server. Null while one is up.
  //
  // Read synchronously here for the same reason `apiOrigin` is: a window that
  // opens after the shell has already given up — a reload, a second window —
  // has missed the event below and would otherwise show a fully configured
  // origin with nothing behind it. The subscription carries everything that
  // happens after this page loaded, in both directions: a failure, and the
  // `null` that says a restart worked.
  sidecarFailure: (() => {
    try { return ipcRenderer.sendSync("ag:sidecarFailure") || null; } catch { return null; }
  })(),
  onServerFailed: (fn) => {
    const h = (_e, payload) => { try { fn(payload || null); } catch { /* renderer's problem */ } };
    ipcRenderer.on("ag:server-failed", h);
    return () => ipcRenderer.removeListener("ag:server-failed", h);
  },
  // The window's own controls, because the frame that used to carry them is
  // gone. See main.js for why.
  winMinimize: () => ipcRenderer.invoke("ag:winMinimize"),
  winToggleMaximize: () => ipcRenderer.invoke("ag:winToggleMaximize"),
  winClose: () => ipcRenderer.invoke("ag:winClose"),
  winIsMaximized: () => ipcRenderer.invoke("ag:winIsMaximized"),
  winState: () => ipcRenderer.invoke("ag:winState"),
  /** Pop the app menu under the "⋯" in our own bar. There is no menu bar —
   *  see main.js — so this is the only route to it. */
  appMenu: (x, y) => ipcRenderer.invoke("ag:appMenu", x, y),
  /** The built-in browser's zoom, after a Ctrl+wheel or Ctrl+plus inside the
   *  page. The shell applies it (a zoom a frame late feels like it is fighting
   *  the wheel); this is only so the panel can show and remember the level. */
  onBrowserZoom: (fn) => {
    const h = (_e, level) => fn(level);
    ipcRenderer.on("ag:browser-zoom", h);
    return () => ipcRenderer.removeListener("ag:browser-zoom", h);
  },
  /** A page in the built-in browser asked for a window — a middle click, a
   *  `target="_blank"`, an OAuth popup. It used to be handed to the OS
   *  browser because there was nowhere else to put it; now it becomes a tab. */
  onBrowserOpenTab: (fn) => {
    const h = (_e, url) => fn(String(url));
    ipcRenderer.on("ag:browser-open-tab", h);
    return () => ipcRenderer.removeListener("ag:browser-open-tab", h);
  },
  /** Which tab is on screen, by its guest's WebContents id. The shell holds
   *  one "current browser" for the Ctrl+wheel zoom and for the screenshots an
   *  agent asks for, and only this side knows which tab that is. */
  setActiveBrowserGuest: (id) => ipcRenderer.invoke("ag:browserActive", id),
  /** The pages and bookmarks in another browser's profile, so the address bar
   *  can complete against somewhere you have actually been. */
  browserPlaces: (req) => ipcRenderer.invoke("ag:browserPlaces", req),
  /** The browsers on this machine whose logins could be brought in, with a
   *  count per site and no names and no values. Reading happens in a separate
   *  one-shot process — see main.js — so cookie values never reach here. */
  cookieSources: () => ipcRenderer.invoke("ag:cookieSources"),
  /** Bring the logins for these sites in. Confirmed by a native dialog in the
   *  main process, which this side can neither fake nor suppress. */
  importCookies: (req) => ipcRenderer.invoke("ag:importCookies", req),
  /** And take them out again — these sites only, not the whole profile. */
  forgetCookies: (req) => ipcRenderer.invoke("ag:forgetCookies", req),
  /** A screenshot of the built-in browser, taken by the shell because a pane
   *  nobody is looking at produces no frames for the panel to capture. Null
   *  when there is no browser open. */
  captureBrowser: () => ipcRenderer.invoke("ag:captureBrowser"),
  /** The system folder chooser, for picking a project. Resolves to a path, or
   *  null if it was cancelled. A browser tab has no equivalent, which is why
   *  the picker keeps a path box beside it. */
  chooseFolder: (start) => ipcRenderer.invoke("ag:chooseFolder", start),
  /** Told, not polled: the window manager can maximise or fullscreen this
   *  window without asking us, and a glyph that guesses is a glyph that lies. */
  onWinState: (fn) => {
    const h = (_e, st) => fn({ max: !!st?.max, full: !!st?.full });
    ipcRenderer.on("ag:winState", h);
    return () => ipcRenderer.removeListener("ag:winState", h);
  },
  setFullscreen: (on) => ipcRenderer.invoke("ag:setFullscreen", on),
  isFullscreen: () => ipcRenderer.invoke("ag:isFullscreen"),
  setZoom: (factor) => ipcRenderer.invoke("ag:setZoom", factor),
  autostartEnabled: () => ipcRenderer.invoke("ag:autostartEnabled"),
  setAutostart: (on) => ipcRenderer.invoke("ag:setAutostart", on),
  /** Open the desktop's file manager with this file selected. Desktop only, so
   *  the caller checks for it rather than assuming — see desktop.ts. */
  revealPath: (p) => ipcRenderer.invoke("ag:revealPath", p),
});

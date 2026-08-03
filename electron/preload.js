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
  /** The session every guest shares. The renderer must not invent this string:
   *  the main process refuses to attach a guest on any other partition. */
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
  // Fired when the sidecar has been restarted under the app: a new port, a new
  // token, or both. Carries them rather than asking the page to reload.
  onServerChanged: (fn) => {
    const h = (_e, payload) => { try { fn(payload); } catch { /* renderer's problem */ } };
    ipcRenderer.on("ag:server-changed", h);
    return () => ipcRenderer.removeListener("ag:server-changed", h);
  },
  // The window's own controls, because the frame that used to carry them is
  // gone. See main.js for why.
  winMinimize: () => ipcRenderer.invoke("ag:winMinimize"),
  winToggleMaximize: () => ipcRenderer.invoke("ag:winToggleMaximize"),
  winClose: () => ipcRenderer.invoke("ag:winClose"),
  winIsMaximized: () => ipcRenderer.invoke("ag:winIsMaximized"),
  /** Told, not polled: the window manager can maximise this window without
   *  asking us, and a glyph that guesses is a glyph that lies. */
  onWinState: (fn) => {
    const h = (_e, max) => fn(!!max);
    ipcRenderer.on("ag:winState", h);
    return () => ipcRenderer.removeListener("ag:winState", h);
  },
  setFullscreen: (on) => ipcRenderer.invoke("ag:setFullscreen", on),
  isFullscreen: () => ipcRenderer.invoke("ag:isFullscreen"),
  setZoom: (factor) => ipcRenderer.invoke("ag:setZoom", factor),
  autostartEnabled: () => ipcRenderer.invoke("ag:autostartEnabled"),
  setAutostart: (on) => ipcRenderer.invoke("ag:setAutostart", on),
});

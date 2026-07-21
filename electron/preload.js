// Bridge between the web UI and the Electron shell. Exposes exactly the native
// capabilities the cockpit uses (fullscreen, window zoom, launch-at-login) on
// a single `window.agentglass` object, so web/src/lib/desktop.ts can detect the
// desktop and call them. Everything else stays browser-standard.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentglass", {
  desktop: true,
  platform: process.platform,
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
  setFullscreen: (on) => ipcRenderer.invoke("ag:setFullscreen", on),
  isFullscreen: () => ipcRenderer.invoke("ag:isFullscreen"),
  setZoom: (factor) => ipcRenderer.invoke("ag:setZoom", factor),
  autostartEnabled: () => ipcRenderer.invoke("ag:autostartEnabled"),
  setAutostart: (on) => ipcRenderer.invoke("ag:setAutostart", on),
});

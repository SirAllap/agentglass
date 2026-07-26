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
  setFullscreen: (on) => ipcRenderer.invoke("ag:setFullscreen", on),
  isFullscreen: () => ipcRenderer.invoke("ag:isFullscreen"),
  setZoom: (factor) => ipcRenderer.invoke("ag:setZoom", factor),
  autostartEnabled: () => ipcRenderer.invoke("ag:autostartEnabled"),
  setAutostart: (on) => ipcRenderer.invoke("ag:setAutostart", on),
});

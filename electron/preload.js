// Bridge between the web UI and the Electron shell. Exposes exactly the native
// capabilities the cockpit uses (fullscreen, window zoom, launch-at-login) on
// a single `window.agentglass` object, so web/src/lib/desktop.ts can detect the
// desktop and call them. Everything else stays browser-standard.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentglass", {
  desktop: true,
  platform: process.platform,
  setFullscreen: (on) => ipcRenderer.invoke("ag:setFullscreen", on),
  isFullscreen: () => ipcRenderer.invoke("ag:isFullscreen"),
  setZoom: (factor) => ipcRenderer.invoke("ag:setZoom", factor),
  autostartEnabled: () => ipcRenderer.invoke("ag:autostartEnabled"),
  setAutostart: (on) => ipcRenderer.invoke("ag:setAutostart", on),
});

// agentglass Electron shell.
//
// Runs the EXACT web UI (web/dist) in Chromium, which GPU-composites on Linux
// where the previous WebKitGTK-based shell fell back to software — the live
// radar and streaming dashboard paint on the GPU instead of pinning a CPU core.
// Same pixels as the web app.
//
// It serves web/dist from the app's own `agentglass://` scheme and brings the
// Bun server up with it unless one is already running.
//
// The scheme is not cosmetic. This used to be a loopback HTTP server on an
// EPHEMERAL port, which meant the renderer's origin changed on every launch --
// and localStorage is keyed by origin, so every restart handed the app an
// empty store: theme, display size, chats, drafts, the saved token and every
// preference, all silently reset. A fixed port would have fixed persistence
// but reintroduced the bug the ephemeral port was chosen to avoid (a second
// instance failing to bind). A custom scheme has neither problem: one stable
// origin, no port, and any number of instances share it.

const { app, BrowserWindow, ipcMain, protocol } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

// GPU compositing on Wayland.
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
app.commandLine.appendSwitch("enable-features", "UseOzonePlatform");

// Must run before `ready`. `standard` is what gives the scheme a real origin
// (and therefore its own persistent localStorage); `secure` keeps it a trusted
// context so the SPA behaves exactly as it does over https.
const APP_SCHEME = "agentglass";
const APP_ORIGIN = `${APP_SCHEME}://app`;
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

const SERVER_PORT = Number(process.env.AGENTGLASS_PORT || 4000);

// Paths differ between `electron .` (repo checkout) and a packaged app, where
// electron-builder copies web/dist and the compiled sidecar into resources/.
const PACKAGED = app.isPackaged;
const REPO = path.resolve(__dirname, "..");
const DIST = PACKAGED ? path.join(process.resourcesPath, "web") : path.join(REPO, "web", "dist");
const SIDECAR_NAME = process.platform === "win32" ? "agentglass-server.exe" : "agentglass-server";
const SIDECAR_BIN = PACKAGED ? path.join(process.resourcesPath, SIDECAR_NAME) : null;

let sidecar = null;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".json": "application/json",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".ico": "image/x-icon", ".map": "application/json",
};

/**
 * Serve web/dist under agentglass://app/.
 *
 * Same job the loopback server did — SPA fallback for extensionless paths, a
 * traversal guard, a MIME table — minus the port, which is the entire point.
 */
function serveApp() {
  protocol.handle(APP_SCHEME, async (request) => {
    let p = decodeURIComponent(new URL(request.url).pathname);
    if (p === "/" || !path.extname(p)) p = "/index.html"; // SPA fallback
    const file = path.join(DIST, p);
    // Still guard traversal: the path comes from the page, not from us.
    if (!file.startsWith(DIST)) return new Response("forbidden", { status: 403 });
    try {
      const data = await fs.promises.readFile(file);
      return new Response(data, {
        headers: { "content-type": MIME[path.extname(file)] || "application/octet-stream" },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

function health() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${SERVER_PORT}/health`, (r) => {
      resolve(r.statusCode === 200);
      r.resume();
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

async function ensureServer() {
  if (await health()) return; // a dev server or another instance is already up
  sidecar = PACKAGED
    ? spawn(SIDECAR_BIN, [], { stdio: "ignore" })
    : spawn("bun", ["run", path.join(REPO, "server", "src", "index.ts")], { stdio: "ignore" });
  for (let i = 0; i < 40; i++) {
    if (await health()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

// --- desktop capabilities the UI calls through the preload bridge ------------

function registerIpc(win) {
  ipcMain.handle("ag:setFullscreen", (_e, on) => { win.setFullScreen(!!on); return win.isFullScreen(); });
  ipcMain.handle("ag:isFullscreen", () => win.isFullScreen());
  ipcMain.handle("ag:setZoom", (_e, f) => { win.webContents.setZoomFactor(f); return f; });

  ipcMain.handle("ag:autostartEnabled", () => autostartEnabled());
  ipcMain.handle("ag:setAutostart", (_e, on) => setAutostart(!!on));
}

// Electron's setLoginItemSettings covers macOS/Windows. On Linux the convention
// is a .desktop file in ~/.config/autostart, which we manage directly.
const LINUX_AUTOSTART = path.join(os.homedir(), ".config", "autostart", "agentglass.desktop");

function autostartEnabled() {
  if (process.platform === "linux") return fs.existsSync(LINUX_AUTOSTART);
  return app.getLoginItemSettings().openAtLogin;
}

function setAutostart(on) {
  if (process.platform === "linux") {
    if (on) {
      fs.mkdirSync(path.dirname(LINUX_AUTOSTART), { recursive: true });
      const exec = app.isPackaged ? process.execPath : `${process.execPath} ${REPO}/electron`;
      fs.writeFileSync(
        LINUX_AUTOSTART,
        `[Desktop Entry]\nType=Application\nName=agentglass\nExec=${exec}\nX-GNOME-Autostart-enabled=true\n`
      );
    } else if (fs.existsSync(LINUX_AUTOSTART)) {
      fs.unlinkSync(LINUX_AUTOSTART);
    }
    return autostartEnabled();
  }
  app.setLoginItemSettings({ openAtLogin: on });
  return app.getLoginItemSettings().openAtLogin;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: "#0f0a1a",
    title: "agentglass",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "icons", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  registerIpc(win);
  win.loadURL(`${APP_ORIGIN}/`);
}

app.whenReady().then(() => {
  serveApp();
  // The window does not wait for the server.
  //
  // It used to: `await ensureServer()` sat between ready and createWindow, so
  // nothing appeared on screen until the sidecar answered /health — measured at
  // 376ms of a 588ms startup on a warm cache, and unbounded when the 103MB
  // binary has to come off disk cold. Up to twelve seconds of *nothing*, since
  // the poll runs 40 times at 300ms, and a launch that shows no window reads as
  // an app that failed to start.
  //
  // Nothing in the shell needs the server before the window exists, and the UI
  // already copes with it being briefly absent: the live socket reconnects with
  // backoff and every panel's fetch has a retry or an honest loading state. So
  // the window comes up first and the server arrives underneath it.
  createWindow();
  void ensureServer();
});

/**
 * Stop the sidecar, once, however we are going down.
 *
 * `window-all-closed` covers closing the window and nothing else. Kill the app
 * any other way — SIGTERM from a script, SIGINT from the terminal it was
 * launched in, a crash in the main process — and the server outlived it,
 * holding :4000. The next launch then found something already answering
 * /health, adopted it, and ran against a server from the *previous* build:
 * a UI talking to code that no longer matched it, with no sign anything was
 * wrong. That cost real debugging time.
 *
 * SIGKILL is the one case this cannot cover; nothing in-process can.
 */
let stopped = false;
function stopSidecar() {
  if (stopped) return;
  stopped = true;
  if (!sidecar) return;
  try { sidecar.kill(); } catch { /* already gone */ }
  // A server mid-request can ignore SIGTERM for a moment. Follow up, but only
  // if it is genuinely still there.
  const child = sidecar;
  setTimeout(() => { try { if (child.exitCode === null && !child.killed) child.kill("SIGKILL"); } catch { /* gone */ } }, 1500).unref?.();
  sidecar = null;
}

app.on("before-quit", stopSidecar);
app.on("will-quit", stopSidecar);
process.on("exit", stopSidecar);
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => { stopSidecar(); app.quit(); });
}

app.on("window-all-closed", () => {
  stopSidecar();
  app.quit();
});

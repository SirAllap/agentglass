// agentglass Electron shell.
//
// Runs the EXACT web UI (web/dist) in Chromium. GPU raster and WebGL keep the
// live radar and streaming dashboard off the CPU, where the previous
// WebKitGTK-based shell fell back to software. On Linux the *final* frame is
// CPU-composited (see disable-gpu-compositing below) to dodge a Wayland/GPU
// white-out, but the accelerated painting still runs on the GPU. Same pixels
// as the web app.
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
// origin and no port to contend for. Only one instance runs now (see the lock
// below), but the origin is what makes the store survive a restart.

const { app, BrowserWindow, Menu, ipcMain, protocol, shell } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

// GPU compositing on Wayland.
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
app.commandLine.appendSwitch("enable-features", "UseOzonePlatform");

// Software-composite the final frame on Linux.
//
// On some Linux GPU/compositor stacks Chromium's GPU compositor hands the
// window stale or empty tiles — the whole UI reads as solid white until a
// repaint (switching theme) forces the tiles to redraw. Compositing the final
// frame on the CPU sidesteps it; GPU raster and WebGL still run, so charts and
// the radar keep their acceleration and only the last composite is on the CPU.
// The window being unreadable beats a hair of compositor latency. Linux only,
// and AGENTGLASS_GPU=1 opts back into full GPU compositing for a machine whose
// stack is fine.
if (process.platform === "linux" && !process.env.AGENTGLASS_GPU) {
  app.commandLine.appendSwitch("disable-gpu-compositing");
}

// One instance, one window.
//
// Nothing used to stop a second launch, and the shell was built to survive one:
// it opened its own window, probed the port, found the first instance's sidecar
// and adopted it (see pickPort). Two windows then drove one server and neither
// looked wrong -- so double-clicking the launcher, or a script starting the app
// while it was already up, piled on whole extra copies of Chromium, each holding
// its own memory, with nothing on screen to say it had happened.
//
// Taken here rather than inside `whenReady` on purpose: before the scheme is
// registered and long before a window exists, so an instance that loses the race
// costs one process that exits immediately instead of one that briefly paints.
// The `return` is a genuine early exit -- this file is CommonJS, whose module
// top level is a function body.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

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

// Where the sidecar is asked to listen. Resolved at startup (see pickPort) --
// the preferred port is only the first candidate, not a promise.
const PREFERRED_PORT = Number(process.env.AGENTGLASS_PORT || 4000);
// How far to walk when the preferred port is taken by something that is not us.
const PORT_CANDIDATES = 8;
let SERVER_PORT = PREFERRED_PORT;
let apiOrigin = `http://127.0.0.1:${SERVER_PORT}`;

// Paths differ between `electron .` (repo checkout) and a packaged app, where
// electron-builder copies web/dist and the compiled sidecar into resources/.
const PACKAGED = app.isPackaged;
const REPO = path.resolve(__dirname, "..");
const DIST = PACKAGED ? path.join(process.resourcesPath, "web") : path.join(REPO, "web", "dist");
const SIDECAR_NAME = process.platform === "win32" ? "agentglass-server.exe" : "agentglass-server";
const SIDECAR_BIN = PACKAGED ? path.join(process.resourcesPath, SIDECAR_NAME) : null;

let sidecar = null;
// Kept so a second launch has something to raise instead of opening a window.
let mainWindow = null;

// --- remote access (open the dashboard on your phone) -----------------------
//
// Off by default and stored on disk rather than in memory, because the whole
// point is that it survives a restart: a URL you put on a phone once should
// keep working tomorrow.
//
// The config directory is the server's own, spelled the same way here on
// purpose (server/src/auth.ts) — the token file is shared, so the shell and the
// sidecar can never disagree about what the secret is.
const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agentglass");
const REMOTE_CFG = path.join(CONFIG_DIR, "remote.json");
const TOKEN_PATH = path.join(CONFIG_DIR, "token");

function remoteEnabled() {
  try {
    return JSON.parse(fs.readFileSync(REMOTE_CFG, "utf8")).enabled === true;
  } catch {
    return false;
  }
}

function setRemoteEnabled(on) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(REMOTE_CFG, JSON.stringify({ enabled: !!on }, null, 2) + "\n");
}

/**
 * The shared secret, minted on first use.
 *
 * Exposing the port without one would put a shell, git write access and docker
 * control on the wifi, so the toggle mints a token rather than offering the
 * choice. Written 0600 in the config dir, which is exactly what the server does
 * when it is exposed with no token set — same path, same permissions, so
 * whichever of the two gets there first, the other agrees.
 */
function ensureToken() {
  try {
    const existing = fs.readFileSync(TOKEN_PATH, "utf8").trim();
    if (existing) return existing;
  } catch { /* not minted yet */ }
  const t = require("crypto").randomBytes(24).toString("base64url");
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_PATH, t + "\n", { mode: 0o600 });
    fs.chmodSync(TOKEN_PATH, 0o600);
  } catch { /* best effort — it still works for this run */ }
  return t;
}

/** What the renderer must send on every call. Null when nothing requires one. */
function currentToken() {
  if (process.env.AGENTGLASS_TOKEN) return process.env.AGENTGLASS_TOKEN;
  return remoteEnabled() ? ensureToken() : null;
}

/**
 * The environment the sidecar is spawned with.
 *
 * AGENTGLASS_WEB_DIR is always set, remote access or not. Without it the
 * packaged sidecar serves no UI at all: it looks for web/dist relative to its
 * own source file, and inside a `bun build --compile` binary that resolves into
 * the virtual filesystem holding the bundle, where nothing else exists. The
 * build does ship the dashboard (electron-builder copies web/dist to
 * resources/web) and this is the only thing that knows where.
 */
function sidecarEnv(port) {
  const env = {
    ...process.env,
    AGENTGLASS_PORT: String(port),
    AGENTGLASS_DIE_WITH_PARENT: "1",
    AGENTGLASS_WEB_DIR: DIST,
  };
  if (remoteEnabled()) {
    // An explicit env var wins: someone who set the bind by hand meant it.
    env.AGENTGLASS_BIND = process.env.AGENTGLASS_BIND || "0.0.0.0";
    env.AGENTGLASS_TRUST_LAN = "1";
    env.AGENTGLASS_TOKEN = ensureToken();
  }
  return env;
}

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

/**
 * What is answering on a port: our server, someone else's, or nothing.
 *
 * "Answers 200" is NOT proof it is us, and treating it as proof is a bug with
 * teeth: a machine that autostarts any other local dev server on :4000 -- an
 * observability server, an API stub, anything -- handed agentglass a stranger,
 * which the shell then adopted. Every panel fetched from it, got whatever it
 * says, and the app came up empty ("no repos found") with no error anywhere.
 * That is why /health names itself and why this reads the body.
 */
function probe(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (r) => {
      if (r.statusCode !== 200) { r.resume(); return resolve("foreign"); }
      let body = "";
      r.setEncoding("utf8");
      // Bounded: a foreign server may stream something enormous at us.
      r.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
      r.on("end", () => {
        try {
          const j = JSON.parse(body);
          // `service` is the marker; the shape check keeps a sidecar built
          // before that field existed adoptable rather than orphaned.
          const ours = j.service === "agentglass" || (j.ok === true && typeof j.clients === "number");
          resolve(ours ? "ours" : "foreign");
        } catch { resolve("foreign"); }
      });
      r.on("error", () => resolve("foreign"));
    });
    req.on("error", () => resolve("free")); // refused == nothing listening
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve("foreign") });
  });
}

/**
 * Ask a server of ours on `port` whether it is exposed to the network.
 *
 * Null on anything unexpected — a build predating /remote/status, a token
 * mismatch, a timeout. Callers treat null as "cannot confirm", which is the
 * safe reading: it never claims reachability it has not seen.
 */
function probeRemote(port, token, timeoutMs = 700) {
  return new Promise((resolve) => {
    const req = http.get(
      `http://127.0.0.1:${port}/remote/status`,
      { headers: token ? { authorization: `Bearer ${token}` } : {} },
      (r) => {
        if (r.statusCode !== 200) { r.resume(); return resolve(null); }
        let body = "";
        r.setEncoding("utf8");
        r.on("data", (c) => { body += c; if (body.length > 65536) req.destroy(); });
        r.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
        r.on("error", () => resolve(null));
      }
    );
    req.on("error", () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

/**
 * Pick the port to talk to: ours if one is already up, else the first free one.
 *
 * Probed in parallel, so this costs one round trip on loopback rather than one
 * per candidate -- it runs before the window opens and must not be felt.
 */
async function pickPort() {
  const ports = Array.from({ length: PORT_CANDIDATES }, (_, i) => PREFERRED_PORT + i);
  const states = await Promise.all(ports.map((p) => probe(p, 400)));
  const ours = ports.find((_, i) => states[i] === "ours");
  const free = ports.find((_, i) => states[i] === "free");
  if (ours !== undefined) {
    // Adoption is normally free real estate: an instance is already up, use it.
    // With remote access on it is not, because a sidecar bound to loopback
    // cannot be talked into listening on the LAN — adopting one would leave the
    // toggle on and nothing reachable, which is the exact silent failure this
    // whole feature exists to end. Take a free port and run our own instead.
    if (!remoteEnabled()) return { port: ours, adopt: true };
    const st = await probeRemote(ours, currentToken());
    if (st && st.exposed) return { port: ours, adopt: true };
    if (free !== undefined) return { port: free, adopt: false };
    console.log(`[agentglass] :${ours} holds a loopback-only server and no candidate port is free; ` +
      `remote access will stay unreachable until it is stopped.`);
    return { port: ours, adopt: true };
  }
  // Everything taken by strangers is not a state worth guessing around: fall
  // back to the preferred port and let the sidecar report the bind failure.
  return { port: free ?? PREFERRED_PORT, adopt: false };
}

/** Settle the API origin. Must finish before the window opens -- the renderer
 *  reads it synchronously at module load and cannot be told again later. */
async function resolvePort() {
  const { port, adopt } = await pickPort();
  SERVER_PORT = port;
  apiOrigin = `http://127.0.0.1:${port}`;
  if (port !== PREFERRED_PORT) {
    console.log(`[agentglass] :${PREFERRED_PORT} is in use by another app; using :${port}. ` +
      `Hooks posting to :${PREFERRED_PORT} need AGENTGLASS_SERVER=${apiOrigin}.`);
  }
  return adopt;
}

async function ensureServer(adopt) {
  const port = SERVER_PORT;
  if (adopt) return; // a dev server or another instance is already up
  // AGENTGLASS_DIE_WITH_PARENT arms the server's own parent-death watchdog:
  // stopSidecar below cannot fire if this main process is SIGKILLed or crashes,
  // so the sidecar backs it up by exiting on its own once we are gone. Only
  // servers we spawn get the flag; adopted ones (returned above) keep whatever
  // lifecycle they were launched with.
  const env = sidecarEnv(port);
  sidecar = PACKAGED
    ? spawn(SIDECAR_BIN, [], { stdio: "ignore", env })
    : spawn("bun", ["run", path.join(REPO, "server", "src", "index.ts")], { stdio: "ignore", env });
  for (let i = 0; i < 40; i++) {
    if ((await probe(port)) === "ours") return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * Bring the sidecar back with a different environment — the one thing turning
 * remote access on and off requires, since a listening socket cannot be
 * rebound in place.
 *
 * The window is reloaded afterwards because the renderer reads both the API
 * origin and the token during module evaluation (web/src/lib/api.ts) and has no
 * way to be told either again. A reload is survivable: chats, drafts and
 * preferences live in localStorage under the app's own scheme and come back
 * with it, which the smoke test pins.
 */
async function restartSidecar() {
  killSidecar();
  // The port can move: an exposed instance wants the preferred port so the URL
  // on the phone stays true, and pickPort's adoption rule changes with it.
  const adopt = await resolvePort();
  await ensureServer(adopt);
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.reload(); } catch { /* window went away mid-toggle */ }
  }
}

// --- desktop capabilities the UI calls through the preload bridge ------------

function registerIpc(win) {
  ipcMain.handle("ag:setFullscreen", (_e, on) => { win.setFullScreen(!!on); return win.isFullScreen(); });
  ipcMain.handle("ag:isFullscreen", () => win.isFullScreen());
  ipcMain.handle("ag:setZoom", (_e, f) => { win.webContents.setZoomFactor(f); return f; });

  ipcMain.handle("ag:autostartEnabled", () => autostartEnabled());
  ipcMain.handle("ag:setAutostart", (_e, on) => setAutostart(!!on));

  ipcMain.handle("ag:remoteEnabled", () => remoteEnabled());
  /**
   * Turn LAN access on or off.
   *
   * Both directions restart the sidecar, because a bind is fixed for the life
   * of a listening socket. Turning it *off* matters as much as on: the promise
   * a toggle makes is that off means the port is shut, not merely that the UI
   * stopped mentioning it.
   */
  ipcMain.handle("ag:setRemote", async (_e, on) => {
    setRemoteEnabled(!!on);
    await restartSidecar();
    return remoteEnabled();
  });
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
  openLinksOutside(win);
  keepUsefulShortcuts(win);
  win.loadURL(`${APP_ORIGIN}/`);
  mainWindow = win;
  win.on("closed", () => { if (mainWindow === win) mainWindow = null; });
}

/**
 * A second launch raises the window that already exists.
 *
 * Without this the lock alone would make the app look broken in a new way:
 * clicking the launcher while agentglass was minimised, or on another
 * workspace, would do visibly nothing at all -- the second process would take
 * one look at the lock and exit in silence. `show` is what crosses workspaces;
 * `restore` alone leaves a minimised window minimised.
 */
app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

/**
 * A link to GitHub belongs in the user's browser, not in this window.
 *
 * Without both handlers, `target="_blank"` opens a second, chrome-less Electron
 * window with no way back, and an ordinary click navigates the app itself away
 * from the renderer -- there is no address bar to return from, so the only fix
 * is restarting the app.
 *
 * Only http(s) is ever handed to the OS. `shell.openExternal` will happily
 * launch a `file://` or a custom-scheme URL, and the strings reaching here come
 * out of pull request bodies and git remotes, which are written by other people.
 */
/**
 * Put back the few accelerators the menu was carrying.
 *
 * Removing the menu removes its shortcuts with it. Editing keys survive —
 * Chromium handles cut/copy/paste inside a field natively — but reload,
 * devtools, zoom and fullscreen were the menu's.
 *
 * What is deliberately NOT bound here is anything a shell owns. This app has a
 * real terminal in it: Ctrl+R is history search, Ctrl+C interrupts, Ctrl+L
 * clears. Rebinding those to browser actions would break the pane people spend
 * the most time in, so reload is Ctrl+Shift+R and the rest are function keys.
 */
function keepUsefulShortcuts(win) {
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    const ctrl = input.control || input.meta;
    const hit = () => e.preventDefault();

    if (input.key === "F12" || (ctrl && input.shift && input.key.toLowerCase() === "i")) {
      hit(); win.webContents.toggleDevTools(); return;
    }
    if (ctrl && input.shift && input.key.toLowerCase() === "r") {
      hit(); win.webContents.reloadIgnoringCache(); return;
    }
    if (input.key === "F11") {
      hit(); win.setFullScreen(!win.isFullScreen()); return;
    }
    if (ctrl && (input.key === "=" || input.key === "+")) {
      hit(); win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5); return;
    }
    if (ctrl && input.key === "-") {
      hit(); win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5); return;
    }
    if (ctrl && input.key === "0") {
      hit(); win.webContents.setZoomLevel(0);
    }
  });
}

function openLinksOutside(win) {
  const external = (url) => {
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      shell.openExternal(url);
      return true;
    } catch { return false; }
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith(APP_ORIGIN)) return; // the app navigating within itself
    e.preventDefault();
    external(url);
  });
}

app.whenReady().then(async () => {
  // No menu bar, at all.
  //
  // `autoHideMenuBar` only hides it until Alt is pressed — and this app embeds
  // a real terminal, where Alt is part of ordinary use (meta bindings, tmux,
  // readline). The bar kept dropping over the top of the UI mid-keystroke.
  // Removing the menu outright is the only thing that stops that; the handful
  // of accelerators it carried are rebound in keepUsefulShortcuts().
  Menu.setApplicationMenu(null);
  serveApp();
  // Synchronous on purpose: the preload publishes `apiOrigin` as a plain value
  // because web/src/lib/api.ts reads it while its module body runs, before any
  // promise could resolve. Safe because the port is settled just below, before
  // any window (and therefore any preload) exists.
  ipcMain.on("ag:apiOrigin", (e) => { e.returnValue = apiOrigin; });
  // Same reason as the origin above: api.ts reads the token while its module
  // body runs. Turning remote access on makes the token mandatory for *every*
  // caller, the local renderer included — without this the app would lock
  // itself out of its own sidecar the moment the toggle was flipped.
  ipcMain.on("ag:apiToken", (e) => { e.returnValue = currentToken(); });

  // Which port, decided before the window — the renderer bakes the origin in at
  // load and there is no second chance to correct it. This is a parallel round
  // trip on loopback (~ms), not the sidecar boot the comment below is about.
  const adopt = await resolvePort();

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
  void ensureServer(adopt);
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
  killSidecar();
}

/** Kill it without latching the shutdown flag — used by restartSidecar, which
 *  intends to bring one straight back up. */
function killSidecar() {
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

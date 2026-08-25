// agentglass Electron shell.
//
// Runs the EXACT web UI (web/dist) in Chromium, where GPU rasterisation keeps
// the dashboard off the CPU — the previous WebKitGTK-based shell fell back to
// software. On Linux the *final* frame is CPU-composited (see
// disable-gpu-compositing below) to dodge a Wayland/GPU white-out; raster still
// runs on the GPU, WebGL does not. Same pixels as the web app.
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

const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeImage, protocol, screen, session, shell } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
// The `<webview>` boundary, in its own file so it can be read and tested on its
// own. Shipped inside the asar with this one — see build.files in package.json.
const {
  BROWSER_PARTITION, isBrowserPartition, safeGuestUrl, applyGuestGuard,
} = require("./guest-guard.js");

/*
 * Which windowing backend this app is, on Linux. Pinned, on purpose.
 *
 * What used to be here was `ozone-platform-hint=auto` plus
 * `enable-features=UseOzonePlatform`. Both were deleted rather than kept "just
 * in case": Chromium removed `--ozone-platform-hint` in M140 (= Electron 38,
 * `ui/ozone/public/ozone_switches.cc` now defines only `ozone-platform`,
 * `ozone-dump-file` and `ozone-override-screen-size`), and the
 * `UseOzonePlatform` feature no longer exists either. They were not merely
 * doing nothing — they were two lines telling the next reader that this file
 * chooses a backend, when it had stopped choosing anything.
 *
 * So it chooses one now, and it chooses it FROM THE SESSION. Not a constant —
 * a constant is wrong in one direction or the other, and both directions were
 * measured.
 *
 * DO NOT PIN "x11". That was the first attempt, for the reason below, and it
 * failed in the worst shape there is: on GNOME 46 / Wayland with Chromium 150 the
 * packaged app started, brought the sidecar up, served :4000, answered /health —
 * and never mapped a window. Nothing on screen, no crash, no non-zero exit; the
 * main process had connected to no display server at all. The GPU process says
 * why, and still does today:
 *     ui/base/x/x11_software_bitmap_presenter.cc:147
 *       XGetWindowAttributes failed for window 1
 * With AGENTGLASS_GPU=1 (so this is not the white-out workaround below) it is the
 * same, plus three ContextResult::kTransientFailure out of CreateCommandBuffer.
 * The switch is not being ignored — it reaches the children, it is right there in
 * /proc/<gpu-pid>/cmdline — it just cannot present.
 *
 * DO NOT PIN "wayland" EITHER, however tempting after the above. Measured out of
 * a scratch copy of this directory, four pins x two sessions, reading the main
 * process's /memfd:wayland-* allocations and what the renderer can see over CDP:
 *
 *                            Wayland session            X11-only session
 *     pin "wayland"          window, dpr 1.5, 331KB     NO FRAME, dpr 1  <-- zombie
 *     pin "x11"              window, but the X11 GPU    window, dpr 1, 190KB
 *                            error above every launch
 *     no pin                 window, dpr 1.5, 331KB     window, dpr 1, 190KB
 *     from the session       window, dpr 1.5, 331KB     window, dpr 1, 190KB
 *
 * The top-right cell is the same silent zombie as the x11 one, aimed at everybody
 * who logs into X11: alive, serving, /health ok, no window, nothing in the log.
 * This repo publishes an AppImage and a .deb, so that is not a hypothetical
 * machine. "No pin" measures identically to choosing from the session; choosing
 * is kept because a file that says which backend it is beats one that leaves it
 * to a default that has already changed twice in this app's lifetime.
 *
 * On the machine this ships to the expression evaluates to "wayland", which is
 * exactly the one-word hand-patch that was confirmed working in the installed
 * asar. The source and the install now agree.
 *
 * The cost, which is real and is now paid: a Wayland client cannot position its
 * own window, the compositor does. Saved window POSITION is gone — see
 * APP_PLACES_ITS_WINDOW below, which stops pretending otherwise. Size, maximised
 * and fullscreen all still work. The argument that used to stand here was that
 * `xlsclients -l` listed agentglass before the upgrade, so it was already an X11
 * client under XWayland and pinning x11 changed nothing. That was true of
 * Electron 33 and did not survive Electron 43; it is written down so nobody
 * re-derives it and reverts.
 *
 * Wayland pays something back that was not expected: the primary monitor on the
 * machine this ships to is at fractional scale 1.5 (mutter's own DisplayConfig
 * says so), and a native Wayland client is told that where XWayland was not —
 * devicePixelRatio 1.5, a 2160x1350 buffer for a 1440x900 window. Under XWayland
 * it was dpr 1 and the compositor upscaled the result, which is where "small or
 * blurry" came from.
 */
if (process.platform === "linux") {
  app.commandLine.appendSwitch(
    "ozone-platform",
    process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland" ? "wayland" : "x11",
  );
}

/*
 * Software-composite the final frame on Linux.
 *
 * On some Linux GPU/compositor stacks Chromium's GPU compositor hands the window
 * stale or empty tiles — the whole UI reads as solid white until a repaint
 * (switching theme) forces them to redraw. Compositing the final frame on the
 * CPU sidesteps it. Linux only, and AGENTGLASS_GPU=1 opts back in.
 *
 * The price, MEASURED, because what used to be written here was wrong. This said
 * "GPU raster and WebGL still run… only the last composite is on the CPU". Half
 * of that is true. Read out of the running app through CDP SystemInfo.getInfo:
 *
 *                        default (this switch)   AGENTGLASS_GPU=1
 *     gpu_compositing    disabled_software       enabled
 *     rasterization      enabled                 enabled
 *     webgl              enabled_readback        enabled
 *     webgpu             enabled_readback        enabled
 *
 * So raster does survive, and WebGL does NOT: it drops to readback, where every
 * frame is copied off the GPU into system memory. And the thing that pays is not
 * what the old comment named — the radar and the dashboard charts are SVG, the
 * dashboard holds zero canvases — it is the TERMINAL, whose xterm WebGL renderer
 * (web/src/components/TerminalPanel.tsx) exists precisely to keep a fast-writing
 * shell off the CPU.
 *
 * Kept anyway, for now. Under native Wayland on this machine (AMD Radeon 890M,
 * Mesa 25.2.8, GNOME 46) the white-out did not appear in either mode across a
 * dark→light theme change, view switches, maximise, unmaximise, fullscreen,
 * windowed, minimise and restore — nine frames each way, every one with the
 * right mean colour and a clean log. That is an absence of evidence from one
 * session, not evidence of absence, and the bug it guards against is
 * intermittent and stack-dependent; it was also tuned on XWayland under Electron
 * 33, which is no longer the configuration that ships. Whoever removes it should
 * do it deliberately, run without it for a week, and get the terminal's
 * acceleration back as the reward.
 */
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
const WINDOW_CFG = path.join(CONFIG_DIR, "window.json");
const PICKER_CFG = path.join(CONFIG_DIR, "picker.json");

/**
 * Where the folder picker was last pointed.
 *
 * Kept by us because the OS stopped keeping it. Electron 43: `defaultPath`
 * "now defaults to the user's Downloads folder… and the OS will no longer track
 * and restore the last-used directory between dialog invocations". For a
 * PROJECT picker Downloads is not a neutral default, it is the wrong answer —
 * nobody's repositories are there — and losing the OS's memory means every
 * "Add project" starts from scratch again.
 *
 * Same shape as the window state above, and for the same reason: the point is
 * that it survives a restart, so it goes on disk rather than in a variable.
 */
function readLastFolder() {
  try {
    const p = JSON.parse(fs.readFileSync(PICKER_CFG, "utf8")).folder;
    // A remembered folder that has since been moved or deleted is worse than
    // none: the dialog opens somewhere that does not exist and the OS decides
    // where instead, which is the behaviour this exists to avoid.
    return typeof p === "string" && p && fs.existsSync(p) ? p : "";
  } catch {
    return "";
  }
}

function saveLastFolder(folder) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(PICKER_CFG, JSON.stringify({ folder }, null, 2) + "\n");
  } catch { /* remembering where you browsed is not worth failing the pick over */ }
}

/**
 * Whether an app on this platform may put its own window somewhere.
 *
 * On Linux it may not, and that is a consequence of the ozone pin at the top of
 * this file rather than a preference: the app is a native Wayland client there,
 * and a Wayland client is never told where it is and cannot ask to be moved —
 * the compositor decides both. `x`/`y` handed to BrowserWindow are accepted and
 * ignored, and `getNormalBounds()` answers with an origin the window does not
 * have.
 *
 * So SIZE and STATE are persisted everywhere and POSITION only where it can be
 * honoured. The alternative — carry on writing x/y on Linux — is worse than
 * dropping them: window.json would look like a working feature to the next
 * reader, and the off-screen guard below would be answering a real question
 * ("is this rectangle still on a monitor?") out of numbers that describe
 * nothing.
 */
const APP_PLACES_ITS_WINDOW = process.platform !== "linux";

/**
 * Where the window was, and how.
 *
 * Every launch used to open a fresh 1440x900 in the middle of the screen, so a
 * maximised window and a chosen size lasted exactly one session. The display
 * scale already survives a restart (localStorage, re-applied on boot) and the
 * terminal's font size survives on its own — the window itself was the one
 * thing that forgot.
 *
 * Bounds AND state, because they are different answers: unmaximising a restored
 * window has to put it somewhere, and "somewhere" should be the size it was
 * before it was maximised rather than a default. Where position is ours (see
 * APP_PLACES_ITS_WINDOW) that "somewhere" includes the corner it was in; on
 * Linux it is the size only, and the compositor picks the corner.
 */
function readWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(WINDOW_CFG, "utf8"));
    return {
      width: Number(s.width) || 1440,
      height: Number(s.height) || 900,
      // Read even on Linux only if we could act on it. An old window.json from
      // before the Wayland move still carries x/y, and honouring those would be
      // pretending the switch never happened.
      x: APP_PLACES_ITS_WINDOW && Number.isFinite(s.x) ? s.x : undefined,
      y: APP_PLACES_ITS_WINDOW && Number.isFinite(s.y) ? s.y : undefined,
      max: s.max === true,
      full: s.full === true,
    };
  } catch {
    return { width: 1440, height: 900, max: false, full: false };
  }
}

function saveWindowState(win) {
  try {
    if (win.isDestroyed()) return;
    const full = win.isFullScreen();
    const max = win.isMaximized();
    // `getNormalBounds` rather than `getBounds`: while maximised or fullscreen
    // the latter is the screen, and saving that would make "restore" a no-op
    // for ever after — the window would come back maximised-sized and then have
    // nowhere to unmaximise to.
    const b = win.getNormalBounds();
    const state = APP_PLACES_ITS_WINDOW
      ? { ...b, max, full }
      : { width: b.width, height: b.height, max, full };
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(WINDOW_CFG, JSON.stringify(state, null, 2) + "\n");
  } catch { /* a window state is not worth failing a close over */ }
}

/** Is this rectangle still on a screen that exists? A window saved on a second
 *  monitor and reopened without it would otherwise come back off-screen, with
 *  no way to drag it into view.
 *
 *  Dead code on Linux by construction rather than by an `if` here: readWindowState
 *  hands back undefined coordinates when the platform does not place its own
 *  windows, and undefined is already the "do not place it" answer below. */
function onSomeDisplay(b, screen) {
  if (b.x === undefined || b.y === undefined) return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
  });
}
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
 *
 * Minted for the loopback-only case too, which is the ordinary one — see
 * sidecarEnv for why the mode label stopped deciding this.
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

/**
 * The one secret both halves must agree on — what the renderer sends, and what
 * the sidecar is spawned with. Never null.
 *
 * A single decision point on purpose. When the sidecar minted from the file and
 * this preferred the environment, an operator who set AGENTGLASS_TOKEN by hand
 * got a shell talking past its own server: the two disagreed about the secret
 * and every route answered 401, with nothing on screen naming the reason.
 */
function currentToken() {
  return process.env.AGENTGLASS_TOKEN?.trim() || ensureToken();
}

/**
 * Throw away the shared secret and mint another.
 *
 * The toggle alone cannot do this. Turning remote access off shuts the port,
 * but every device that ever scanned the code still holds a working key for the
 * moment it comes back on — a phone lent to someone, a tablet left behind, a
 * link forwarded in a chat. Rotating is the only honest revoke: the old link
 * stops working everywhere, at once, and there is nothing to hunt down.
 *
 * Refuses when the token came from the environment, because rotating a file the
 * server will not read would report a revoke that did not happen.
 */
function rotateToken() {
  if (process.env.AGENTGLASS_TOKEN) return null;
  try { fs.rmSync(TOKEN_PATH, { force: true }); } catch { /* already gone */ }
  return ensureToken();
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
    /**
     * Always — remote access on or off.
     *
     * "Loopback means it is you" is true of processes and false of people.
     * 127.0.0.1 belongs to the machine, not to the account: every other Unix
     * user on the box can reach it, and so can any browser extension holding
     * `http://localhost/*`. Without a token each of them opened the port and
     * was handed the cockpit — the terminal, git write, docker — with nothing
     * to present. Someone installing a .deb does not read a security section
     * first, and the old default asked them to set this by hand.
     *
     * The token is read from a 0600 file, so reaching the port stops being the
     * same thing as being let through it, and the two callers that could reach
     * it but cannot read the file are exactly the two we wanted gone.
     *
     * This does NOT make the desktop shell the only way in, and is not meant
     * to: a browser still gets there with ?token=, which is the whole basis of
     * the phone and the QR flow. It closes reach-without-read, nothing more.
     *
     * Nothing here costs the hooks anything: /ingest and the OTLP receivers are
     * exempt (server/src/auth.ts), and the two that do authenticate read this
     * same file when the environment has not got it (hooks/statusline.sh,
     * hooks/gate_event.py).
     */
    AGENTGLASS_TOKEN: currentToken(),
  };
  if (remoteEnabled()) {
    // An explicit env var wins: someone who set the bind by hand meant it.
    env.AGENTGLASS_BIND = process.env.AGENTGLASS_BIND || "0.0.0.0";
    env.AGENTGLASS_TRUST_LAN = "1";
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
 * A Content-Security-Policy for the privileged agentglass://app origin — the one
 * that holds the API token (window.agentglass.apiToken) and the setRemote bridge.
 *
 * No live XSS exists — the renderers escape untrusted text first — but this
 * origin displays a great deal of attacker-influenceable text (agent tool output,
 * terminal streams, PR bodies), so a future injection or a compromised dependency
 * would otherwise run with no restriction at all: read the token and exfiltrate
 * it anywhere. The load-bearing directives are connect-src (an injected script
 * can reach only this app and its own loopback sidecar, never an outside host)
 * and script-src/object-src/base-uri (no injected <script>, plugin, or <base>).
 *
 * Shipped Report-Only deliberately: index.html carries one inline bootstrap
 * <script>, so an enforcing `script-src 'self'` would blank the window until that
 * inline moves to a hash or nonce. Report-Only reports every violation to the
 * renderer console with zero risk to a running app; flipping to enforcing is this
 * header's name plus the boot script's sha256 added to script-src.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "child-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

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
    // Still guard traversal: the path comes from the page, not from us. Anchor on
    // DIST + separator so a resolved sibling whose name merely starts with DIST's
    // (…/web-anything next to …/web) can't slip past a bare-prefix check.
    if (file !== DIST && !file.startsWith(DIST + path.sep)) return new Response("forbidden", { status: 403 });
    try {
      const data = await fs.promises.readFile(file);
      return new Response(data, {
        headers: {
          "content-type": MIME[path.extname(file)] || "application/octet-stream",
          "content-security-policy-report-only": CSP,
        },
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

/**
 * The last reason the sidecar is not there, or null while it is.
 *
 * Latched in the main process rather than only pushed at the window, because
 * the two are not in step: `ensureServer` gives up roughly twelve seconds after
 * `createWindow`, and a window opened (or reloaded) after that has missed the
 * event entirely. The renderer reads this synchronously through the preload the
 * same way it reads `apiOrigin`, and subscribes for anything that happens
 * after.
 */
let sidecarFailure = null;

/**
 * Say out loud that there is no server, and say WHY.
 *
 * THE HOLE THIS FILLS. `ensureServer` used to poll forty times and then simply
 * fall off the end of its loop, returning `undefined` — the same thing it
 * returns on success. Its only caller is `void ensureServer(adopt)`: no `then`,
 * no `catch`, no flag. `createWindow()` has already run, so the app is on
 * screen, the origin is configured and looks verified, and there is nothing
 * behind it. Every panel then fails the way a panel fails when there is
 * genuinely nothing to show, and the only thing anywhere on screen that
 * disagrees is a CLOSED pill in the header.
 *
 * The UI could not cover for it either, by construction: ServerBanner returns
 * early unless `SERVER_GUESSED`, and api.ts makes that false whenever
 * `DESKTOP_API` is set — which is always, in the packaged app. The banner that
 * says "No server" was unreachable from the desktop. It is reachable now, and
 * this is what reaches it.
 *
 * Also to the console, because a failure this thing describes badly is one
 * somebody will want the raw text of.
 */
function reportSidecar(failure) {
  sidecarFailure = failure;
  if (failure) console.error(`[agentglass] sidecar: ${failure.reason} — ${failure.detail || "(no detail)"}`);
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send("ag:server-failed", failure); } catch { /* window went away */ }
  }
}

/**
 * Keep the last of the sidecar's own words, for the message.
 *
 * `stdio: "ignore"` sent its stderr to /dev/null, which threw away the one
 * thing that explains a start failure in the user's terms — a bind error names
 * the port, a missing web directory names the path. Piped and DRAINED, never
 * buffered whole: a pipe nobody reads fills at 64KB and then blocks the writer,
 * so a server that logged enough would hang instead of running. Only the tail
 * is kept, which is where a fatal error is.
 */
function tailStderr(child) {
  const box = { text: "" };
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (c) => { box.text = (box.text + c).slice(-4096); });
  child.stderr?.on("error", () => { /* the process went away mid-write */ });
  return box;
}

async function ensureServer(adopt) {
  const port = SERVER_PORT;
  if (adopt) { reportSidecar(null); return true; } // a dev server or another instance is already up
  // AGENTGLASS_DIE_WITH_PARENT arms the server's own parent-death watchdog:
  // stopSidecar below cannot fire if this main process is SIGKILLed or crashes,
  // so the sidecar backs it up by exiting on its own once we are gone. Only
  // servers we spawn get the flag; adopted ones (returned above) keep whatever
  // lifecycle they were launched with.
  const env = sidecarEnv(port);
  const [cmd, argv] = PACKAGED
    ? [SIDECAR_BIN, []]
    : ["bun", ["run", path.join(REPO, "server", "src", "index.ts")]];
  const child = spawn(cmd, argv, { stdio: ["ignore", "ignore", "pipe"], env });
  sidecar = child;
  const err = tailStderr(child);

  /*
   * The `error` event, which is what a missing binary actually is.
   *
   * Measured on Node 24: `spawn("/nonexistent/agentglass-server")` does NOT
   * throw. It returns a ChildProcess with `pid === undefined` and emits
   * `error` on the next tick — and an unhandled `error` on an EventEmitter is
   * re-thrown, which in the main process takes the whole app down. So a
   * try/catch around the spawn is not the fix and never was; this listener is.
   * A packaged build whose sidecar failed to be copied in did not start with a
   * broken app, it did not start at all.
   */
  let spawnError = null;
  child.on("error", (e) => { spawnError = e; });
  /*
   * And `exit`, which is every other way it can fail: a port it cannot bind, a
   * config it cannot read, a crash on the first line. There was no listener for
   * this either, so a sidecar that died after two seconds was indistinguishable
   * from one still starting up — for twelve seconds, and then for ever.
   *
   * WHO SAYS SO IS SPLIT BY TIME, and measuring it is what showed why: with
   * both this and the loop below reporting, a sidecar that exited during
   * startup announced the same failure twice, to the console and down the IPC.
   * So the loop owns the verdict while it is still waiting — it breaks the
   * moment `exit` is set and describes what it found — and this owns everything
   * after a server that WAS up goes away, which is the case nothing covered at
   * all: a crash at three in the morning left a live window in front of a dead
   * port with a CLOSED pill as the only clue.
   */
  let exit = null;
  let started = false;
  child.on("exit", (code, signal) => {
    exit = { code, signal };
    // A kill we asked for is not a failure. `killSidecar` nulls `sidecar`
    // before this can fire, and `stopped` covers the app going down, so the
    // identity check is what tells "it died" from "we ended it".
    if (sidecar !== child || stopped) return;
    sidecar = null;
    if (started) reportSidecar(describeSidecarFailure(port, { code, signal }, spawnError, err.text, true));
  });

  for (let i = 0; i < 40; i++) {
    if ((await probe(port)) === "ours") { started = true; reportSidecar(null); return true; }
    // Do not spend twelve seconds waiting for a process that is already gone.
    // The old loop did, which is why "the binary is missing" and "the server is
    // slow to boot" felt the same from outside.
    if (spawnError || exit) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  reportSidecar(describeSidecarFailure(port, exit, spawnError, err.text, false));
  return false;
}

/**
 * Turn how it failed into something a person can act on.
 *
 * Four outcomes and four different fixes, which is the whole reason this is not
 * one "server unavailable" string: a missing binary is a broken install, a
 * taken port is another program, a crash on start is a bug or a bad config, and
 * a timeout is none of those and needs the log.
 */
function describeSidecarFailure(port, exit, spawnError, stderr, hadStarted) {
  const detail = (stderr || "").trim().split("\n").filter(Boolean).slice(-3).join(" · ").slice(0, 400);
  if (spawnError?.code === "ENOENT") {
    return {
      reason: "missing",
      what: "The server program is not where the app expects it.",
      where: spawnError.path || String(spawnError.syscall || ""),
      fix: PACKAGED
        ? "This install is incomplete — reinstall the app."
        : "Install bun, or run the server yourself with `bun run server/src/index.ts`.",
      detail, port,
    };
  }
  if (spawnError) {
    return { reason: "spawn", what: "The server program could not be started.", where: spawnError.path || "",
      fix: "Check that it is executable and not blocked by the system.", detail: detail || String(spawnError.message || spawnError), port };
  }
  if (exit) {
    const how = exit.signal ? `signal ${exit.signal}` : `exit ${exit.code}`;
    // Two very different events wearing the same `exit`, and telling a person
    // they may have a port clash when the server had already BOUND that port
    // and served requests on it is worse than saying nothing. `hadStarted` is
    // the only thing that separates them.
    return hadStarted
      ? {
        reason: "exited",
        what: `The server was running and stopped (${how}).`,
        where: "",
        fix: "Restart the app. If it keeps happening, the server's last words are below.",
        detail, port,
      }
      : {
        reason: "exited",
        what: `The server started and stopped again (${how}).`,
        where: "",
        // The most common cause by a distance, and the one the user can see for
        // themselves. `pickPort` already walks eight ports before this, so a
        // clash here means all of them were taken or the bind failed for another
        // reason — either way the port is the first thing to look at.
        fix: `Something else may be holding port ${port}, or the server hit an error on startup.`,
        detail, port,
      };
  }
  return {
    reason: "timeout",
    what: `The server did not answer on port ${port} within 12 seconds.`,
    where: "",
    fix: "It may still be starting. If this stays, restart the app.",
    detail, port,
  };
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

  // Wait for the socket to actually be gone before looking for a port.
  //
  // A server that has just been signalled goes on answering /health for a
  // moment, and pickPort reads that as "an instance of ours is already up" and
  // adopts it. It then returns without spawning anything, the old process
  // finishes dying, and the app is left with no server at all — no window, no
  // error, just every panel failing. Measured intermittent: the same click
  // worked and then did not.
  for (let i = 0; i < 50; i++) {
    if ((await probe(SERVER_PORT, 300)) !== "ours") break;
    await new Promise((r) => setTimeout(r, 100));
  }

  // The port can move: an exposed instance wants the preferred port so the URL
  // on the phone stays true, and pickPort's adoption rule changes with it.
  await resolvePort();
  // Never adopt here, whatever the probe says. We are the process that just
  // killed the server; anything still answering is either the corpse above or
  // something that is not ours to hand the app to.
  await ensureServer(false);
  // Tell the page where the server is now, rather than reloading it.
  //
  // A reload was the first version of this and it was awful: flipping a setting
  // threw away every terminal, every unsent chat draft and every scroll
  // position in the app. The renderer reads the origin and the token through
  // live bindings (web/src/lib/api.ts), so handing it the new pair is enough —
  // the next fetch and the next socket connect use them.
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send("ag:server-changed", { origin: apiOrigin, token: currentToken() }); } catch { /* window went away mid-toggle */ }
  }
}

// --- desktop capabilities the UI calls through the preload bridge ------------

function registerIpc(win) {
  // The window controls the app now draws for itself. Trivial, and they have to
  // exist: `frame: false` removed the only other way to do any of them.
  ipcMain.handle("ag:winMinimize", () => { win.minimize(); });
  ipcMain.handle("ag:winToggleMaximize", () => {
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle("ag:winClose", () => { win.close(); });
  ipcMain.handle("ag:winIsMaximized", () => win.isMaximized());

  /*
   * The system's own folder chooser, for picking a project.
   *
   * The web side can only offer a path box: a browser cannot open a file
   * dialog that returns a *directory*, and typing an absolute path from memory
   * is the least discoverable control in the app — someone who has never seen
   * it does not know it is a control at all. Inside the shell there is a real
   * one, so this hands it over and the picker keeps the path box as the
   * fallback for a browser tab.
   *
   * Modal to the window, so it cannot end up behind it. It returns a path and
   * nothing else — no read, no write, no recursion — and the caller still goes
   * through the same server checks any typed path does.
   */
  /*
   * Screenshot the built-in browser, for an agent that cannot see it.
   *
   * The panel has `capturePage()` on its own element and it is a trap: Chromium
   * produces no frames for content nobody is looking at, so the call simply
   * never resolves when the pane is behind another view or the window is not on
   * screen — which is exactly when an agent is driving it. Measured: `shot`
   * timed out at twenty seconds while `read` and `click` on the same page
   * answered instantly.
   *
   * From here the same capture takes `stayHidden`, which is the flag that says
   * "render this even though it is not visible". `stayAwake` keeps the frame
   * loop from being throttled while it happens.
   */
  /*
   * Bringing existing logins into the built-in browser.
   *
   * Extensions are a dead end in Electron, so a password manager cannot live in
   * this browser and the way somebody's sessions get here is their cookies. That
   * is not a small permission, so three things are true of this by design:
   *
   *   * the reading happens in a SEPARATE, one-shot process — so cookie values
   *     never touch the HTTP API, never reach the renderer, and are gone with
   *     the process that read them. This used to be written down as a
   *     limitation ("Electron 33 cannot read SQLite"), and that reason has
   *     expired: Electron 43 ships Node 24, whose `node:sqlite` is unflagged,
   *     so the shell COULD open the jar in-process now. It deliberately does
   *     not. Keeping the values out of this process is the point; being unable
   *     to read them here was only ever the accident that made it obvious. (The
   *     process is the sidecar BINARY when packaged rather than `bun run`,
   *     because an installed app has no bun on PATH.);
   *   * there is no HTTP route for any of it, so an agent driving this browser
   *     cannot ask for anybody's logins;
   *   * the confirmation is a native dialog from the main process, which is the
   *     one surface a compromised renderer can neither fake nor suppress, and it
   *     names the sites.
   */
  const runCookieReader = (args) => new Promise((resolve, reject) => {
    const [cmd, argv] = PACKAGED
      ? [SIDECAR_BIN, ["cookies", ...args]]
      : ["bun", ["run", path.join(__dirname, "..", "server", "src", "cookieread.ts"), ...args]];
    const child = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => reject(e));
    /*
     * `close`, not `exit`.
     *
     * `exit` fires when the process is gone; its pipes may still hold data
     * nobody has read yet. With two sites the answer always arrived first and
     * this worked for a year. With two hundred — about two thousand cookies
     * and their values, several hundred kilobytes — the tail was still in
     * flight, the JSON came back cut in half, and all anybody saw was "the
     * cookie reader did not answer". `close` is the event that means every
     * stream is drained.
     */
    child.on("close", () => {
      // The LAST line: something this imports may warn, and a warning must not
      // be parsed as the answer.
      const line = out.trim().split("\n").pop() || "";
      try { resolve(JSON.parse(line)); }
      catch {
        // A truncated answer and an empty one are different problems, and the
        // old message could not tell them apart.
        const why = !out.trim()
          ? (err.trim().split("\n").pop() || "it printed nothing")
          : `its answer was ${out.length} bytes and did not parse`;
        reject(new Error(`the cookie reader did not answer: ${why}`));
      }
    });
  });

  ipcMain.handle("ag:cookieSources", async () => {
    try { return await runCookieReader(["list"]); }
    catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  });

  ipcMain.handle("ag:importCookies", async (_e, req) => {
    const source = typeof req?.source === "string" ? req.source : "";
    // Two thousand, not two hundred. A real profile had two hundred and
    // one sites and the old cap dropped the last one without a word.
    const sites = Array.isArray(req?.sites) ? req.sites.filter((s) => typeof s === "string").slice(0, 2000) : [];
    // Re-checked here rather than trusted from the renderer: this is the side
    // that holds the values.
    if (!source || !sites.length) return { ok: false, error: "choose a browser and at least one site" };

    const answer = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["Import", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: `Bring your logins for ${sites.length} site${sites.length === 1 ? "" : "s"} into agentglass's browser?`,
      detail: `${sites.slice(0, 12).join(", ")}${sites.length > 12 ? `, and ${sites.length - 12} more` : ""}\n\n`
        + "Anyone who can use this window — including an agent you let drive it — will be signed in to these sites.",
    });
    if (answer.response !== 0) return { ok: false, error: "cancelled" };

    let read;
    try { read = await runCookieReader(["read", "--source", source, "--sites", sites.join(",")]); }
    catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
    if (!read || !read.ok) return { ok: false, error: (read && read.error) || "could not read those cookies" };

    const ses = session.fromPartition(BROWSER_PARTITION);
    let set = 0;
    const failed = [];
    for (const c of read.cookies) {
      try { await ses.cookies.set(c); set += 1; }
      catch (err) { failed.push({ name: c.name, url: c.url, error: String(err && err.message ? err.message : err) }); }
    }
    // Without this, a quit or a crash between here and the next checkpoint
    // loses the session somebody just handed over.
    try { await ses.cookies.flushStore(); } catch { /* best effort */ }
    return { ok: true, set, failed, skipped: read.skipped };
  });

  /**
   * Undo. Not "delete the partition" — the sites named, and nothing else.
   *
   * Across every browsing profile, which is the part that has to be got right.
   * This swept one partition when there was only one; profiles gave the user
   * several, and a "forget these sites" that quietly cleared one of them is the
   * worst kind of privacy control — it reports a number, it looks finished, and
   * the login it was supposed to remove is still sitting in another jar.
   *
   * The renderer says which partitions it knows about, because it owns the
   * profile list. Each is checked against the browser family before it becomes
   * a session: an unvalidated one here would let a renderer bug reach into the
   * app's own storage and start deleting from it.
   */
  ipcMain.handle("ag:forgetCookies", async (_e, req) => {
    // Two thousand, not two hundred. A real profile had two hundred and
    // one sites and the old cap dropped the last one without a word.
    const sites = Array.isArray(req?.sites) ? req.sites.filter((s) => typeof s === "string").slice(0, 2000) : [];
    if (!sites.length) return { ok: false, error: "choose at least one site" };
    // The default is always swept, named or not: a caller that forgets to list
    // it must not end up clearing only the profiles.
    const asked = Array.isArray(req?.partitions) ? req.partitions.filter(isBrowserPartition) : [];
    const partitions = [...new Set([BROWSER_PARTITION, ...asked])];
    let removed = 0;
    for (const partition of partitions) {
      const ses = session.fromPartition(partition);
      const all = await ses.cookies.get({});
      for (const c of all) {
        const host = (c.domain || "").replace(/^\./, "");
        if (!sites.some((s) => host === s || host.endsWith(`.${s}`))) continue;
        const url = `${c.secure ? "https" : "http"}://${host}${c.path || "/"}`;
        try { await ses.cookies.remove(url, c.name); removed += 1; } catch { /* already gone */ }
      }
      try { await ses.cookies.flushStore(); } catch { /* best effort */ }
    }
    return { ok: true, removed, profiles: partitions.length };
  });

  /*
   * "This tab is the one on screen."
   *
   * Said by the renderer whenever the active tab changes, and resolved to a
   * guest here. Only the renderer knows which tab you are looking at, and two
   * things in this process need to: the Ctrl+wheel zoom, and the screenshot an
   * agent asks for. An id that names nothing is ignored rather than clearing
   * the guest — a tab mid-attach would otherwise blank the browser for a frame
   * and take an agent's screenshot with it.
   */
  ipcMain.handle("ag:browserActive", (_e, id) => {
    const n = Number(id);
    if (!Number.isInteger(n)) return false;
    for (const g of browserGuests) {
      if (!g.isDestroyed() && g.id === n) { browserGuest = g; return true; }
    }
    return false;
  });

  /* History and bookmarks from a chosen profile. Same privileged reader as the
     cookies, for the same reason: this is browsing history, and a route would
     put it where an agent driving the browser could ask for it. */
  ipcMain.handle("ag:browserPlaces", async (_e, req) => {
    const source = typeof req?.source === "string" ? req.source : "";
    if (!source) return { ok: false, error: "no profile chosen" };
    try { return await runCookieReader(["places", "--source", source]); }
    catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  });

  ipcMain.handle("ag:captureBrowser", async () => {
    const guest = browserGuest;
    if (!guest || guest.isDestroyed()) return null;
    try {
      // Raced, because `stayHidden` does not always come back. It is the flag
      // for "render this even though nobody is looking", and when the compositor
      // has nothing to render from it simply never resolves — measured: every
      // other verb answered instantly and `shot` sat until the server's own
      // twenty-second timeout, which reads to an agent as a broken browser
      // rather than as a pane that is not showing. Four seconds is far longer
      // than a capture that is going to happen takes.
      const img = await Promise.race([
        guest.capturePage(undefined, { stayHidden: true, stayAwake: true }),
        new Promise((r) => setTimeout(() => r(null), 4000)),
      ]);
      return !img || img.isEmpty() ? null : img.toDataURL();
    } catch {
      return null;
    }
  });

  ipcMain.handle("ag:chooseFolder", async (_e, start) => {
    const r = await dialog.showOpenDialog(win, {
      title: "Choose a project folder",
      // Never `undefined`. At Electron 43 that means ~/Downloads (see
      // readLastFolder): what the caller asked for, else where you were last
      // time, else home — a chain that always names somewhere, so the dialog's
      // starting point is this app's decision and not the OS's default.
      defaultPath: (typeof start === "string" && start) || readLastFolder() || os.homedir(),
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Open",
    });
    if (r.canceled || !r.filePaths.length) return null;
    // The PARENT, not the pick: you add several projects out of one ~/code, and
    // reopening inside the repo you just added means climbing out of it every
    // time.
    saveLastFolder(path.dirname(r.filePaths[0]));
    return r.filePaths[0];
  });
  ipcMain.handle("ag:winState", () => ({ max: win.isMaximized(), full: win.isFullScreen() }));

  /*
   * The app menu, on demand.
   *
   * There is deliberately no menu BAR — see the note at setApplicationMenu(null):
   * this app embeds a real terminal where Alt is part of ordinary use, and an
   * auto-hiding bar kept dropping over the UI mid-keystroke. Removing it took
   * the accelerators with it, and `frame: false` then took the last visible
   * trace of a menu away entirely.
   *
   * So it is built here, popped from the "⋯" in our own top bar, and never
   * installed as the application menu. Alt still does nothing; the menu exists
   * only while you are pointing at it. Roles rather than hand-written handlers,
   * so copy/paste/zoom behave exactly as the platform's own would.
   */
  ipcMain.handle("ag:appMenu", (_e, x, y) => {
    const menu = Menu.buildFromTemplate([
      { label: "Edit", submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
      ] },
      { label: "View", submenu: [
        { role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" },
        { role: "togglefullscreen" },
      ] },
      { label: "Window", submenu: [
        { role: "minimize" },
        { label: win.isMaximized() ? "Restore" : "Maximise", click: () => (win.isMaximized() ? win.unmaximize() : win.maximize()) },
        { type: "separator" },
        { role: "close" },
      ] },
      { type: "separator" },
      { label: "Quit agentglass", role: "quit" },
    ]);
    // Anchored under the button that opened it, not at the pointer: a menu that
    // appears wherever the cursor happened to be does not read as belonging to
    // the control you pressed.
    menu.popup({ window: win, x: Math.round(x), y: Math.round(y) });
  });
  // Maximising by dragging to an edge, going fullscreen with F11, or anything
  // else the window manager owns does not go through us — so the renderer is
  // TOLD rather than left to infer, or the glyph says "maximise" on a maximised
  // window and the clock hides itself at the wrong moment.
  for (const ev of ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen", "restore"]) {
    win.on(ev, () => {
      try { win.webContents.send("ag:winState", { max: win.isMaximized(), full: win.isFullScreen() }); }
      catch { /* torn down */ }
    });
  }

  ipcMain.handle("ag:setFullscreen", (_e, on) => { win.setFullScreen(!!on); return win.isFullScreen(); });
  ipcMain.handle("ag:isFullscreen", () => win.isFullScreen());
  ipcMain.handle("ag:setZoom", (_e, f) => { win.webContents.setZoomFactor(f); return f; });

  ipcMain.handle("ag:autostartEnabled", () => autostartEnabled());
  ipcMain.handle("ag:setAutostart", (_e, on) => setAutostart(!!on));

  /*
   * Show a file where it lives, in the desktop's own file manager.
   *
   * `showItemInFolder` opens the manager and SELECTS the item; it does not
   * execute anything, which is why this is a reasonable thing to offer from a
   * renderer at all. The path is still checked before it is used: absolute, and
   * something that exists. A relative path would be resolved against whatever
   * the app's cwd happens to be, which is not a place anybody chose.
   */
  ipcMain.handle("ag:revealPath", (_e, p) => {
    if (typeof p !== "string" || !path.isAbsolute(p)) return { ok: false, error: "not an absolute path" };
    try { fs.statSync(p); } catch { return { ok: false, error: "no such file" }; }
    shell.showItemInFolder(p);
    return { ok: true };
  });

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
    const want = !!on;
    // Turning LAN access on exposes this machine's shell, git and browser to the
    // network, so it gets the same main-process confirmation importing cookies
    // does — a decision a compromised renderer can neither fake nor suppress,
    // rather than one living only in the React UI that renderer controls. Turning
    // it *off* needs no gate: it only ever removes reach.
    if (want && !remoteEnabled()) {
      const answer = await dialog.showMessageBox(win, {
        type: "warning",
        buttons: ["Expose to the network", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        message: "Let other devices on your network reach agentglass?",
        detail: "The server will listen on every network interface, not just this "
          + "machine. Anything that pairs — your phone, or anyone who can reach "
          + "this host and holds a link — can drive its terminal, git and browser. "
          + "Only do this on a network you trust.",
      });
      if (answer.response !== 0) return remoteEnabled();
    }
    setRemoteEnabled(want);
    await restartSidecar();
    return remoteEnabled();
  });
  /**
   * Revoke every link handed out so far.
   *
   * The restart is what enforces it — the running server holds the old secret
   * in memory and would go on accepting it — and it also drops the record of
   * which devices had connected, so the panel goes back to waiting for the
   * first one rather than claiming a phone that can no longer get in.
   */
  ipcMain.handle("ag:revokeRemote", async () => {
    const next = rotateToken();
    if (!next) return false; // AGENTGLASS_TOKEN is set in the environment; the file is not in charge
    await restartSidecar();
    return true;
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
      // The session that runs this file is the HOST's, so execPath is wrong
      // under Flatpak: /app/… exists only inside the sandbox, and the entry
      // would silently never start. `flatpak run` is the host-side name for the
      // same app. HOME is the real home either way, so the file itself lands in
      // the right place without help.
      const exec = process.env.FLATPAK_ID
        ? `flatpak run ${process.env.FLATPAK_ID}`
        : app.isPackaged ? process.execPath : `${process.execPath} ${REPO}/electron`;
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

/** Electron's zoom LEVEL is logarithmic: each step is a factor of 1.2, which is
 *  the size ladder Chrome walks with Ctrl+plus. ±7 is about 25%–500%. */
/** The guest currently showing a page, for the one thing the panel cannot do
 *  for itself — see ag:captureBrowser. Null whenever there is no browser pane
 *  mounted, which is most of the time. */
let browserGuest = null;
/** Every attached guest. `browserGuest` is whichever of them the renderer says
 *  is on screen; this is what lets a destroyed tab fall back to another. */
const browserGuests = new Set();

const ZOOM_STEP = 0.5;
const ZOOM_MIN = -7;
const ZOOM_MAX = 7;

function guardWebviews(win) {
  // The decision itself lives in guest-guard.js so a test can call it — see the
  // header there. This is only the wiring: the guard says yes or no, and no
  // means the guest never exists.
  win.webContents.on("will-attach-webview", (e, webPreferences, params) => {
    if (!applyGuestGuard(webPreferences, params)) e.preventDefault();
  });

  win.webContents.on("did-attach-webview", (_e, guest) => {
    // A guest is its own Chromium process and its key events never reach the
    // renderer, so with a page focused every app shortcut silently stops
    // working — the workspace cannot be switched or closed and the pane is a
    // trap. Only the chords that move you *out* are forwarded; everything else
    // belongs to the page, where Ctrl+L, Ctrl+F and the rest still mean what
    // they mean in a browser.
    guest.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const mod = process.platform === "darwin" ? input.meta : input.control;
      // The keyboard half of the same thing. Kept with the zoom rather than
      // with the chords below: these are not forwarded to the app, they are
      // handled here and swallowed, exactly as a browser does.
      if (mod && (input.key === "+" || input.key === "=" || input.key === "-" || input.key === "0")) {
        event.preventDefault();
        applyZoom(input.key === "0" ? 0 : guest.getZoomLevel() + (input.key === "-" ? -ZOOM_STEP : ZOOM_STEP));
        return;
      }
      const jumpsOut = (mod && /^[1-9]$/.test(input.key))
        || (mod && input.key.toLowerCase() === "w")
        || input.key === "Escape";
      if (!jumpsOut) return;
      event.preventDefault();
      win.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: input.key,
        modifiers: [
          input.control && "control", input.meta && "meta",
          input.shift && "shift", input.alt && "alt",
        ].filter(Boolean),
      });
      win.webContents.focus();
    });

    /*
     * Zoom, which a page cannot do for itself.
     *
     * Ctrl+wheel and Ctrl+plus are browser chrome, not page behaviour: Chrome
     * implements them above the renderer, so a bare guest has neither and the
     * text is whatever size the site decided. Electron reports the gesture as
     * `zoom-changed` and then does nothing about it, which is the half that has
     * to live here.
     *
     * Applied in the main process rather than forwarded to the panel and back:
     * a zoom that lands a frame late feels like it is fighting the wheel. The
     * panel is told afterwards, so it can show the level and remember it.
     *
     * Bounded either side. Chrome's own range is roughly 25%–500%, and past
     * that a page stops being usable in a way that is hard to undo when the
     * controls themselves are too small to hit.
     */
    const applyZoom = (level) => {
      const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
      guest.setZoomLevel(next);
      win.webContents.send("ag:browser-zoom", next);
      return next;
    };
    /*
     * Which guest is "the browser".
     *
     * There are several now — one per tab — and two things in this process
     * still mean exactly one: the Ctrl+wheel zoom, which must land on the page
     * you are looking at, and the screenshot an agent asks for, which must be
     * of that same page. Only the renderer knows which tab is on screen, so it
     * says (`ag:browser-active`) and this follows.
     *
     * The last one to attach is the fallback, which is what the single-guest
     * version always did and is right until the first tab switch.
     */
    browserGuests.add(guest);
    browserGuest = guest;
    guest.once("destroyed", () => {
      browserGuests.delete(guest);
      if (browserGuest === guest) browserGuest = [...browserGuests].pop() ?? null;
    });

    guest.on("zoom-changed", (_e, direction) => {
      applyZoom(guest.getZoomLevel() + (direction === "in" ? ZOOM_STEP : -ZOOM_STEP));
    });

    /*
     * A page opening a window now has somewhere to go: a tab.
     *
     * It used to hand every one of them to the OS browser, because there was
     * nowhere else — which meant a middle-click, a `target="_blank"` and every
     * OAuth popup threw you out of the app. The renderer opens it beside the
     * tab it came from. Still `deny`, so Electron never makes a real window of
     * its own; and still through safeGuestUrl, so only http(s) is passed on.
     */
    guest.setWindowOpenHandler(({ url }) => {
      const safe = safeGuestUrl(url);
      if (safe) win.webContents.send("ag:browser-open-tab", safe);
      return { action: "deny" };
    });
  });
}

function createWindow() {
  const st = readWindowState();
  const place = onSomeDisplay(st, screen) ? { x: st.x, y: st.y } : {};
  const win = new BrowserWindow({
    width: st.width,
    height: st.height,
    ...place,
    backgroundColor: "#0f0a1a",
    title: "agentglass",
    autoHideMenuBar: true,
    /*
     * No system title bar. The app draws its own.
     *
     * The strip at the top of this window already carries the project, the
     * fleet, the plan meters and the clock; a second bar above it holding
     * nothing but three buttons is 30px of chrome saying nothing. So the buttons
     * move in with everything else and the strip becomes the drag region.
     *
     * macOS keeps its traffic lights — they are a system affordance people
     * expect exactly where they are, and `hiddenInset` leaves them in place over
     * our own bar, which pads itself past them. Everywhere else the window is
     * frameless and the buttons below are the whole story, which is why they are
     * wired rather than decorative: with `frame: false` there is no other way to
     * minimise, maximise or close.
     *
     * `roundedCorners` is deliberately not set, and that is a decision rather
     * than an oversight. Electron 43 newly applies it on Linux — its own typedef
     * went from `@platform darwin` in 33 to "on Linux, rounded corners are only
     * drawn when the desktop environment supports client-side decorations", and
     * GNOME 46 does CSD — so the default `true` reaches this window for the first
     * time on this upgrade. Checked before leaving it: the app was put in
     * Porcelain (white) and all four corners read back at 8x. The nearest pixel
     * of anything the app draws is the logo, ~7 device px in from the top and ~18
     * from the left; the window buttons are further in still, and the outer 20px
     * of every corner is flat background. A corner radius has nothing to clip.
     *
     * Not verifiable here: GNOME 46 refuses every route to a photograph of a
     * Wayland surface (grim gets "compositor doesn't support
     * wlr-screencopy-unstable-v1", org.gnome.Shell.Screenshot answers
     * AccessDenied, the portal wants a click), so this was read off the browser's
     * own compositing surface. If the round is applied above that surface it
     * would not appear there — but it would land on those same flat corner
     * pixels, which is why the measurement still answers the question.
     */
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" }
      : { frame: false }),
    icon: path.join(__dirname, "icons", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // The browser view is a <webview>, which is off by default. See
      // guardWebviews for what enabling it costs and what pays it back; the
      // short version is that a guest is a DOM element here rather than a
      // main-process rectangle, which is the only way it can live inside a
      // workspace whose views stay mounted and merely toggle visibility.
      webviewTag: true,
    },
  });
  registerIpc(win);
  guardWebviews(win);
  openLinksOutside(win);
  keepUsefulShortcuts(win);
  // Restored before the page loads, so the window does not visibly snap into
  // place a beat after it appears.
  if (st.full) win.setFullScreen(true);
  else if (st.max) win.maximize();

  win.loadURL(`${APP_ORIGIN}/`);
  mainWindow = win;

  // Saved on every settle rather than only on close: a crash, a kill or a
  // reboot are exactly the times you would most like the window to come back
  // where it was. Debounced, because a drag or a resize fires continuously.
  let saveTimer = null;
  const remember = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(win), 400);
  };
  for (const ev of ["resize", "move", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) {
    win.on(ev, remember);
  }
  // And once more on the way out, unthrottled: the debounce would otherwise be
  // cancelled by the process ending.
  win.on("close", () => { clearTimeout(saveTimer); saveWindowState(win); });
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
    /*
     * The zoom keys are NOT handled here, and that is the point.
     *
     * They used to be: `preventDefault()` and `setZoomLevel` right in this
     * handler, which runs in the main process before the renderer sees the
     * keystroke at all. So the app's own rule — the pointer decides whether you
     * are sizing the terminal or the window — could never run, because the
     * keystroke never arrived. Everything zoomed together, always, and no
     * amount of work in the renderer was ever going to change that.
     *
     * The renderer owns them now (see lib/zoomTarget.ts) and asks this process
     * to scale the window through `ag:setZoom` when that is what was meant.
     * That also settles a second, quieter conflict: this used to move the zoom
     * LEVEL while the app's own setting moves the zoom FACTOR, so the two were
     * fighting over the same number in different units.
     *
     * There is no menu bar to supply a default accelerator (setApplicationMenu
     * is null), so nothing else claims them either.
     */
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
    // Parse rather than prefix-match: startsWith(APP_ORIGIN) also treats
    // agentglass://app-anything as "within the app". Only host "app" on our own
    // scheme is the app navigating within itself; everything else opens outside.
    let internal = false;
    try {
      const u = new URL(url);
      internal = u.protocol === `${APP_SCHEME}:` && u.host === "app";
    } catch { /* not a parseable URL — treat as external */ }
    if (internal) return;
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
  // Whether there is a server at all, for a window that opened AFTER the give-up
  // — a reload, or a second window. The push in `reportSidecar` only reaches
  // windows that already exist, and a page that reloads five minutes into a
  // dead sidecar would otherwise come up with no idea anything is wrong.
  ipcMain.on("ag:sidecarFailure", (e) => { e.returnValue = sidecarFailure; });
  // The browser element-picker's copy/screenshot, done on the main-process
  // clipboard so it works while the <webview> guest holds focus — the preload
  // explains why navigator.clipboard cannot. Each returns whether it stuck, so
  // the picker stops claiming a copy that silently failed.
  ipcMain.handle("ag:copyText", (_e, text) => {
    try { clipboard.writeText(String(text ?? "")); return true; } catch { return false; }
  });
  ipcMain.handle("ag:copyImage", (_e, dataUrl) => {
    try {
      const img = nativeImage.createFromDataURL(String(dataUrl ?? ""));
      if (img.isEmpty()) return false; // a bad data URL yields an empty image
      clipboard.writeImage(img);
      return true;
    } catch { return false; }
  });

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

// @ts-check
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

const { app, BrowserWindow, Menu, WebContentsView, clipboard, dialog, ipcMain, nativeImage, protocol, screen, session, shell } = require("electron");
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
const { browserMenuTemplate } = require("./browser-menu.js");
const power = require("./power.js");

/*
 * What `// @ts-check` at the top of this file buys, and why the JSDoc below it
 * exists at all.
 *
 * This is the file that mints the auth token, decides what a <webview> may be,
 * and registers every IPC channel the renderer can reach — and it is plain
 * JavaScript, which for years meant it was the one file here nothing checked a
 * line of. `make typecheck` and CI both read it now. The annotations are only where the checker cannot work
 * a type out for itself: a `let x = null` it would otherwise call `any`, a
 * function whose parameters have no call site to infer from, and the handful of
 * places where Electron's own types are stricter than this code was.
 */

/** @typedef {import("electron").WebContents} WebContents */
/** @typedef {import("electron").BrowserWindow} AppWindow */
/** @typedef {import("electron").WebContentsView} DevtoolsView */

/** Why there is no server, in a shape the renderer can draw. Four reasons and
 *  four different fixes — see describeSidecarFailure, which is the only thing
 *  that builds one.
 * @typedef {{ reason: string, what: string, where: string, fix: string, detail: string, port: number }} SidecarFailure */

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

/**
 * Expose Chromium's own debugging port — off by default, on request only.
 *
 * Every idle-CPU fix so far was reasoned about from outside this process:
 * headless Chrome standing in for the renderer, the sidecar's own request
 * count, everything but the renderer itself. `--remote-debugging-port` is
 * how that stops being a guess — it is Chromium's CDP port, a different
 * door from the one the fuses in electron/package.json shut (Node's
 * `--inspect`, `NODE_OPTIONS`, `ELECTRON_RUN_AS_NODE`; see
 * server/test/desktop-fuses.test.ts). Appended here as a switch this
 * process hands itself, never read off an argv an attacker could set, so it
 * exists exactly when AGENTGLASS_DEBUG_PORT is set and not otherwise.
 *
 * Chromium binds it to 127.0.0.1 only, same as the sidecar's own port — but
 * unlike the sidecar it takes no token. A CDP connection can read every DOM
 * node, every variable, and drive the page as the user, in the one window
 * that also holds the read token and every live terminal session. That is
 * worse than the token it has none of, so it stays off unless somebody who
 * can already set an environment variable on this machine asks for it by
 * name — the same bar AGENTGLASS_GPU above sets for the compositor switch.
 */
const DEBUG_PORT = Number(process.env.AGENTGLASS_DEBUG_PORT || 0);
if (DEBUG_PORT > 0) {
  app.commandLine.appendSwitch("remote-debugging-port", String(DEBUG_PORT));
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
  // TypeScript checks this file against a module top level, where a bare
  // `return` is a syntax error (TS1108). Node does not: it wraps a CommonJS
  // module in a function before running it, which is what the comment above is
  // about and why this has worked since it was written. The suppression is for
  // the checker's model, not for the language.
  // @ts-ignore -- CommonJS module top level IS a function body
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

/**
 * The PATH the sidecar — and through it every agent it seats — is started with.
 *
 * `bin/` ships inside every package as an extraResource (electron/package.json
 * "build.extraResources": `../bin` → `resources/bin`), so a .dmg carries
 * `agentglass-agent`, `agentglass-browser` and `agentglass-browser-mcp` at
 * `agentglass.app/Contents/Resources/bin/`. Nothing puts that directory on
 * anybody's PATH: the Linux installer symlinks the CLIs into `~/.local/bin`,
 * a .dmg has no installer, and an agent that types `agentglass-browser` on a
 * Mac got "command not found" from an app that had the file all along.
 *
 * Prepended, because a package's user has no other copy for it to shadow, and
 * the one that ships with this build is the one that matches this build's
 * server. Every packaged platform, not only the Mac: a .deb or AppImage user
 * who never ran the local installer has exactly the same gap, and on a
 * machine where the installer DID symlink the CLIs the prepended copy is the
 * same file at another path. A development run is left alone — bin/ is in
 * the checkout there, not under resources/.
 *
 * Pure, and its inputs are parameters, because the suite runs on Linux and
 * states a Mac instead (desktop-mac-bin-path.test.ts).
 *
 * @param {string | undefined} current  the PATH the shell was started with
 * @param {{ platform: string, packaged: boolean, resourcesPath: string, delimiter?: string }} where
 * @returns {string | undefined}
 */
function withBundledBin(current, where) {
  if (!where.packaged) return current;
  const bin = path.join(where.resourcesPath, "bin");
  const sep = where.delimiter ?? path.delimiter;
  const parts = (current ?? "").split(sep).filter(Boolean);
  if (parts.includes(bin)) return current;
  return [bin, ...parts].join(sep);
}

/** @type {import("child_process").ChildProcess | null} */
let sidecar = null;
// Kept so a second launch has something to raise instead of opening a window.
/** @type {AppWindow | null} */
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

/** @param {string} folder */
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

/*
 * Why the window stopped being maximised — written down, because nobody is
 * watching when it happens.
 *
 * Reported as "if I paste what I have in the clipboard it minimises and stays
 * that way": a maximised window that comes back at its normal size after a paste.
 * Nothing in this process asks for that — the only two callers of `unmaximize`
 * are the button and the context menu — so the answer is either the window
 * manager, an extension, or a relaunch that restored the wrong state, and none
 * of those can be told apart after the fact from the outside.
 *
 * So the moment is recorded when it happens: what the bounds became, whether
 * this process asked, and whether a keyboard CHORD had just been pressed.
 *
 * Chords only, and this is deliberate: a paste is Ctrl+V, and knowing whether
 * one arrived a few milliseconds before the window changed is the whole
 * question. Plain keys are never recorded — that would be a keylogger with a
 * diagnostic's name on it — and the chord is stored as its modifiers plus one
 * key name, never as text that reached a field.
 */
const WINDOW_LOG_MAX = 60_000;
/** @type {{at:number,key:string,ctrl:boolean,shift:boolean,alt:boolean}|null} */
let lastChord = null;
let askedAt = 0;            // when THIS process last asked for a window change
let lastAsk = "";           // and how that ask was made — see winToggleMaximize

/**
 * @param {string} what — the transition being recorded
 * @param {AppWindow} win
 */
function noteWindow(what, win) {
  try {
    const b = win.getBounds();
    const chord = lastChord && Date.now() - lastChord.at < 3000
      ? `${lastChord.ctrl ? "Ctrl+" : ""}${lastChord.alt ? "Alt+" : ""}${lastChord.shift ? "Shift+" : ""}${lastChord.key} ${Date.now() - lastChord.at}ms ago`
      : "none";
    const line = `${new Date().toISOString()} ${what} max=${win.isMaximized()} full=${win.isFullScreen()} `
      + `bounds=${b.width}x${b.height}+${b.x}+${b.y} focused=${win.isFocused()} `
      + `asked=${askedAt && Date.now() - askedAt < 3000 ? "yes" : "no"} why=${askedAt && Date.now() - askedAt < 3000 ? (lastAsk || "unsaid") : "-"} chord=${chord}\n`;
    const file = path.join(app.getPath("userData"), "window.log");
    if (fs.existsSync(file) && fs.statSync(file).size > WINDOW_LOG_MAX) fs.writeFileSync(file, "");
    fs.appendFileSync(file, line);
  } catch { /* a log nobody can write is not worth an exception */ }
}

/** @param {AppWindow} win */
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
 *  windows, and undefined is already the "do not place it" answer below.
 * @param {{ x?: number, y?: number, width: number, height: number }} b
 * @param {import("electron").Screen} screen */
function onSomeDisplay(b, screen) {
  if (b.x === undefined || b.y === undefined) return false;
  // Read into locals rather than used through `b` inside the callback: the
  // check above narrows the properties here, and that narrowing does not
  // survive into a closure, which the callback below is.
  const { x, y } = b;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return x < a.x + a.width && x + b.width > a.x && y < a.y + a.height && y + b.height > a.y;
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

/** @param {boolean} on */
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
 * @param {number} port
 */
function sidecarEnv(port) {
  /* Typed as the process environment it is about to become, not as the object
     literal it starts as: the two remote-access keys below are added
     conditionally, and an inferred literal type has no room for a key that is
     only sometimes set. */
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    // A .dmg's CLIs live inside the bundle and nowhere on PATH; see
    // withBundledBin. Linux and Windows get their PATH back unchanged.
    PATH: withBundledBin(process.env.PATH, { platform: process.platform, packaged: PACKAGED, resourcesPath: process.resourcesPath }),
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

/** Extension to content type. `Record<string, string>` rather than the literal
 *  type inferred from the entries, because it is looked up with whatever
 *  extension a file on disk happens to have — an unknown one is the
 *  octet-stream case below, not a type error.
 * @type {Record<string, string>} */
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
 * It shipped Report-Only while index.html's one inline bootstrap <script> was
 * unnamed, because an enforcing `script-src 'self'` blanks the window until it
 * is. It is named now — the sha256 below — so this is enforcing, and a real
 * build was loaded under exactly these directives in headless Chromium first:
 * one violation, `manifest-src`, which is why that directive is here.
 *
 * THIS LIST IS A COPY. The original is shared/csp.ts, which the sidecar imports
 * for the HTTP origin that serves the same web/dist to a phone. Two copies
 * because this file cannot import it: `build.files` in electron/package.json is
 * an allowlist of four files, so a `require("../shared/csp.js")` resolves to
 * nothing inside the packaged asar and the app dies on launch. What keeps the
 * copy honest is server/test/csp.test.ts, which parses this array out of this
 * file and fails on the first byte of drift. If those four files ever grow a
 * fifth, delete this array and require the shared one.
 */
const CSP = [
  "default-src 'none'",
  /* The splash in web/index.html, hashed. Its bytes and this string are locked
     together by the test named above — edit the splash without rehashing it and
     the window comes up blank, which is precisely the failure the test spends
     its time preventing. */
  "script-src 'self' 'sha256-avgYkkkdd6eLtDuXfkYt2w13v+s20IiZ9Mraf4FR2JY=' 'sha256-WoyIdsXRXsB6KXPWR0pkumt+r5WqeyVOTWuslDXPNb8='",
  "style-src 'self' 'unsafe-inline'",
  /* The two hosts this app really draws pictures from, named rather than left to
     the enforcing header below — which would otherwise blank every avatar in the
     pull request panel and every screenshot on a card.
     Images only: neither host can run a script under this policy. */
  /* And the sidecar itself, which is where every proxied picture actually
     comes from. The desktop renderer is served from `agentglass://app`, so
     `'self'` is that scheme and NOT the loopback the API lives on — and each
     avatar is `http://127.0.0.1:<port>/prs/asset?url=…`, the allowlisted proxy
     that fetches GitHub for us. Naming the two GitHub hosts above was
     therefore not enough: the request never goes there from the page.
     Measured, A/B, on the real proxy answering 200 image/jpeg: without this
     directive the <img> ends with naturalWidth 0 and an error event; with it,
     48. Reported as "we don't have the avatar images". */
  "img-src 'self' data: blob: http://127.0.0.1:* http://localhost:* https://*.clickup-attachments.com https://*.clickup.com https://*.githubusercontent.com https://avatars.githubusercontent.com",
  /* Falls back to default-src, and 'none' there blocks web.manifest — which is
     what "add to home screen" is made of on the HTTP twin of this policy. */
  "manifest-src 'self'",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "child-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  /* Nothing frames this app, here or on the HTTP origin. */
  "frame-ancestors 'none'",
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
          "content-security-policy": CSP,
          /* The MIME table above is the only thing saying what a file is, so
             nothing downstream is allowed to guess otherwise. */
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
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
 * @param {number} port @param {number} [timeoutMs]
 * @returns {Promise<"ours" | "foreign" | "free">}
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
 * @param {number} port @param {string | null} token @param {number} [timeoutMs]
 * @returns {Promise<{ exposed?: boolean } | null>}
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
 * @type {SidecarFailure | null}
 */
let sidecarFailure = null;

/** Whether a server has been CONFIRMED, which is not the same as nothing having
 *  failed yet. Set only from reportSidecar; see the comment there for why the
 *  distinction is worth a second variable. */
let sidecarUp = false;

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
 * `sidecarUp` is the other half, and the half that was missing: `sidecarFailure`
 * is null in two situations that could not be more different — the sidecar is
 * up, and nobody has decided yet. The renderer could not tell those apart, so
 * it asked the network instead: one /health per boot, refused in the cold case
 * and logged by Chromium as an error whatever the caller does with it, plus a
 * second from ServerBanner probing on its own. A null report only ever follows
 * a confirmed server — the adopt branch, where one was already up, or the poll
 * that saw /health say "ours" — so this is the fact the shell already had and
 * was never asked for.
 * @param {SidecarFailure | null} failure
 */
function reportSidecar(failure) {
  sidecarFailure = failure;
  sidecarUp = !failure;
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
 * @param {import("child_process").ChildProcess} child
 */
function tailStderr(child) {
  const box = { text: "" };
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (/** @type {Buffer | string} */ c) => { box.text = (box.text + c).slice(-4096); });
  child.stderr?.on("error", () => { /* the process went away mid-write */ });
  return box;
}

/** @param {boolean} adopt @returns {Promise<boolean>} */
async function ensureServer(adopt) {
  const port = SERVER_PORT;
  if (adopt) { reportSidecar(null); return true; } // a dev server or another instance is already up
  // AGENTGLASS_DIE_WITH_PARENT arms the server's own parent-death watchdog:
  // stopSidecar below cannot fire if this main process is SIGKILLed or crashes,
  // so the sidecar backs it up by exiting on its own once we are gone. Only
  // servers we spawn get the flag; adopted ones (returned above) keep whatever
  // lifecycle they were launched with.
  const env = sidecarEnv(port);
  /* The cast is the checker's blind spot, not a doubt about the value:
     SIDECAR_BIN is a path when PACKAGED and null when it is not, and nothing
     tells TypeScript that the two ternaries are asking the same question. */
  const [cmd, argv] = PACKAGED
    ? [/** @type {string} */ (SIDECAR_BIN), []]
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
  /** @type {NodeJS.ErrnoException | null} */
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
  /** @type {{ code: number | null, signal: NodeJS.Signals | null } | null} */
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

  /*
   * Tight at first, then the old cadence.
   *
   * This loop is now the renderer's ONLY way of learning that a server exists:
   * the page stopped asking the network and waits for the null report this
   * sends. So the gap between the sidecar being ready and this noticing became
   * a gap in front of every panel's first request — measured at 410ms of it,
   * first data at 1436ms before and 1846ms after, on the same rig and clock.
   *
   * The first second is checked every 60ms and the rest keeps the 300ms it had.
   * These probes are a Node http.get from the main process, so unlike the ones
   * the page used to make they cost nothing visible when they are refused —
   * which is exactly why it is cheap to ask more often while the answer is
   * still changing. The 12s ceiling is unchanged: 16 quick tries plus 36 slow
   * ones is the same wall-clock budget the 40-at-300ms loop had.
   */
  for (let i = 0; i < 52; i++) {
    if ((await probe(port)) === "ours") { started = true; reportSidecar(null); return true; }
    // Do not spend twelve seconds waiting for a process that is already gone.
    // The old loop did, which is why "the binary is missing" and "the server is
    // slow to boot" felt the same from outside.
    if (spawnError || exit) break;
    await new Promise((r) => setTimeout(r, i < 16 ? 60 : 300));
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
 * @param {number} port
 * @param {{ code: number | null, signal: NodeJS.Signals | null } | null} exit
 * @param {NodeJS.ErrnoException | null} spawnError
 * @param {string} stderr
 * @param {boolean} hadStarted
 * @returns {SidecarFailure}
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

/** @param {AppWindow} win */
function registerIpc(win) {
  // The window controls the app now draws for itself. Trivial, and they have to
  // exist: `frame: false` removed the only other way to do any of them.
  ipcMain.handle("ag:winMinimize", () => { win.minimize(); });
  ipcMain.handle("ag:winToggleMaximize", (_e, why) => {
    // Stamped so the log can tell "the user pressed the button" apart from
    // "something else did this to us" — see noteWindow. `why` carries how the
    // control was activated: a pointer click, a keyboard activation of a
    // button that still had focus, or a click nobody made.
    askedAt = Date.now();
    lastAsk = typeof why === "string" ? why.slice(0, 120) : "";
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
  /** @param {string[]} args @returns {Promise<any>} */
  const runCookieReader = (args) => new Promise((resolve, reject) => {
    // Same cast, same reason, as the sidecar spawn above: SIDECAR_BIN is a path
    // exactly when PACKAGED, and nothing tells the checker the two ternaries
    // ask one question.
    const [cmd, argv] = PACKAGED
      ? [/** @type {string} */ (SIDECAR_BIN), ["cookies", ...args]]
      : ["bun", ["run", path.join(__dirname, "..", "server", "src", "cookieread.ts"), ...args]];
    const child = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    // Optional access on streams that "pipe" above guarantees are there, for
    // the same reason tailStderr does it: the types describe every stdio shape
    // spawn can be given, not the one it was given here.
    child.stdout?.on("data", (/** @type {Buffer | string} */ d) => { out += d.toString(); });
    child.stderr?.on("data", (/** @type {Buffer | string} */ d) => { err += d.toString(); });
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
    catch (e) { return { ok: false, error: String(e instanceof Error ? e.message : e) }; }
  });

  ipcMain.handle("ag:importCookies", async (_e, req) => {
    const source = typeof req?.source === "string" ? req.source : "";
    // Two thousand, not two hundred. A real profile had two hundred and
    // one sites and the old cap dropped the last one without a word.
    const sites = Array.isArray(req?.sites) ? req.sites.filter((/** @type {unknown} */ s) => typeof s === "string").slice(0, 2000) : [];
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
    catch (e) { return { ok: false, error: String(e instanceof Error ? e.message : e) }; }
    if (!read || !read.ok) return { ok: false, error: (read && read.error) || "could not read those cookies" };

    const ses = session.fromPartition(BROWSER_PARTITION);
    let set = 0;
    const failed = [];
    for (const c of read.cookies) {
      try { await ses.cookies.set(c); set += 1; }
      catch (err) { failed.push({ name: c.name, url: c.url, error: String(err instanceof Error ? err.message : err) }); }
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
    const sites = Array.isArray(req?.sites) ? req.sites.filter((/** @type {unknown} */ s) => typeof s === "string").slice(0, 2000) : [];
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
        if (!sites.some((/** @type {unknown} */ s) => host === s || host.endsWith(`.${s}`))) continue;
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
    catch (e) { return { ok: false, error: String(e instanceof Error ? e.message : e) }; }
  });

  /*
   * A frame of the browser pane, even when nobody is looking at it.
   *
   * Chromium does not render what is not on screen, and the browser view is
   * hidden whenever somebody is reading a diff or working in the terminal —
   * which is exactly when an agent is driving it. `capturePage` came back empty
   * there, the verb reported "the pane is not on screen", and the CLI, which
   * treats that as fixable, pulled the whole window over to the browser on
   * every screenshot. That is the bug this exists to end.
   *
   * Two ways, in order, because the first one is cheap and correct WHEN IT
   * WORKS and neither is reliable on its own:
   *
   *   1. `capturePage` with `stayHidden: false` — the flag reads like "capture
   *      it discreetly" and means the opposite of what this needs: true keeps
   *      the page hidden, and a hidden page has no frame to give. False marks
   *      the guest visible for the length of the capture. Nothing appears on
   *      screen: the element embedding it is still hidden in a view nobody is
   *      looking at.
   *
   *   2. The debugger, and `Page.captureScreenshot` with
   *      `captureBeyondViewport`, which makes Chromium render the page into an
   *      off-screen surface rather than read the one it is already compositing.
   *      This is how a background tab is screenshotted; it costs an attach and
   *      a detach, so it is the fallback rather than the first move.
   *
   * MEASURED, both times, against the running app with the terminal in front —
   * `stayHidden: false` alone was not enough, which is why (2) is here.
   */
  /** One of THIS window's browser guests, by webContents id. Null for anything
   *  else: a capture must never fall back to the active tab, because that is
   *  how one agent's shot becomes a picture of another agent's page. */
  /** @param {number} id */
  const browserGuestById = (id) => {
    for (const g of browserGuests) if (!g.isDestroyed() && g.id === id) return g;
    return null;
  };

  ipcMain.handle("ag:captureBrowser", async (_e, opts) => {
    /* Answers `{ png, why }` rather than a string, because the interesting case
       is the failure: several things can stop a capture and the caller could not
       tell them apart — an agent got "the pane is not on screen" whatever the
       actual reason was. */
    /*
     * THE GUEST THE CALLER NAMED, not whichever tab is in front.
     *
     * This took `browserGuest` — the ACTIVE one. With one agent that is the
     * same thing; with two it is not. Agent A asking for a shot of its own tab
     * while agent B has a different one in front got back a picture of B's
     * page, and nothing anywhere said so: right dimensions, plausible
     * content, wrong page. Cross-contaminated evidence between two agents that
     * were supposed to be isolated, and the kind that survives review because
     * it looks fine.
     *
     * The panel knows which webview it is driving and passes its id. An id
     * that is not one of this window's browser guests is refused rather than
     * silently falling back to the active one — a fallback here is how the bug
     * comes back.
     */
    const wanted = Number(opts && opts.guestId);
    const guest = Number.isFinite(wanted) && wanted > 0
      ? browserGuestById(wanted)
      : browserGuest;
    if (!guest || guest.isDestroyed()) {
      return { png: null, why: wanted ? "that tab is not a browser pane in this window" : "no browser pane is mounted" };
    }

    /*
     * `shot --selector/--clip/--full-page` (§12/§18) — what the frame should
     * CONTAIN, resolved once here rather than left for a caller to crop out of
     * a whole-viewport PNG afterwards. `clip` is already a viewport-relative
     * rectangle by the time it reaches this handler — the renderer turned a
     * selector into one — so this only has to fill it in for `fullPage`,
     * which needs the page's actual content size and not the viewport's.
     */
    /* WHICH PAGE THIS PICTURE IS OF, said out loud.
       A capture that comes back from the wrong guest is indistinguishable from
       a right one — measured: two `shot --page` calls naming two different
       tabs produced byte-identical PNGs of a third page nobody asked for. The
       renderer compares this against the tab it addressed and refuses a
       mismatch, so a wrong page is an error rather than evidence. */
    const guestUrl = () => { try { return guest.getURL(); } catch { return ""; } };

    const wantClip = opts && opts.clip && typeof opts.clip === "object" ? opts.clip : null;
    const wantFullPage = !!(opts && opts.fullPage);

    /*
     * One clock for the whole verb, not one per attempt.
     *
     * There are five ways to a frame below and each of them can hang. Giving
     * every one its own generous timeout adds up to longer than the renderer
     * waits for an answer, and then a capture that was going to succeed is
     * reported as "the shell did not answer in time" — MEASURED, twice. So the
     * routes share a deadline and each takes what is left.
     *
     * Ten seconds, and the number is not free: the relay hangs up on a
     * screenshot at twenty and the renderer has its own last resort to try
     * afterwards. Everything below has to fit inside that with the answer still
     * arriving — MEASURED at six, where the first debugger route hung for three
     * and the other two never ran at all.
     */
    const deadline = Date.now() + 10_000;
    const left = () => Math.max(0, deadline - Date.now());
    const LATE = Symbol("late");
    /** @param {Promise<any>} p @param {number} ms */
    const inTime = (p, ms) => Promise.race([
      p,
      new Promise((r) => setTimeout(() => r(LATE), Math.min(ms, left()))),
    ]);
    /** @type {string[]} */
    const tried = [];
    /** @param {string} what */
    const note = (what) => { tried.push(what); return null; };

    /*
     * The compositor's own copy, twice.
     *
     * `stayHidden: false` marks the guest visible for the length of the capture
     * — the flag reads like "capture it discreetly" and means the opposite of
     * what this needs. Nothing appears on screen: the element embedding the
     * guest is still hidden in a view nobody is looking at.
     *
     * Twice because `UnknownVizError` is what Chromium answers when the frame
     * sink it would copy from is not there, and it is sometimes back a moment
     * later. MEASURED on a page with a voice SDK on it: the first shot failed
     * and every shot after it failed too, including back on a page that had
     * worked, which is what a frame sink that does NOT come back looks like
     * from here — hence everything below this loop.
     */
    // `fullPage` needs the page's real content size, which only the debugger
    // route below can ask for — the compositor copies the surface it already
    // has, which is the viewport and nothing past it.
    if (!wantFullPage) {
      for (let go = 0; go < 2 && left() > 500; go++) {
        try {
          const img = await inTime(guest.capturePage(wantClip || undefined, { stayHidden: false, stayAwake: true }), 1200);
          if (img === LATE) note("the compositor did not answer");
          else if (img && !img.isEmpty()) return { png: img.toDataURL(), why: "", url: guestUrl(), via: go === 0 ? "the compositor" : "the compositor, second try" };
          else note("the compositor produced an empty frame");
        } catch (e) {
          note(String(e instanceof Error ? e.message : e));
        }
        if (go === 0) await new Promise((r) => setTimeout(r, 250));
      }
    }

    /*
     * Then the debugger, which can render a page that the compositor cannot.
     *
     * The seat is single and the inspector sits in it, so say that plainly
     * rather than reporting the compositor's error for it — with DevTools open
     * on this page there is no second session to be had, and the answer is to
     * close it.
     */
    // Attached and OURS (§4's addInitScript/expose hold a session open on
    // this guest) is not the inspector — reuse it rather than refusing.
    const ownSession = guestOwnsDebugger.has(guest);
    if (guest.debugger.isAttached() && !ownSession) {
      return {
        png: null,
        why: "the inspector is attached to this page, so the screenshot cannot use the debugger — close the inspector and try again",
      };
    }
    let attached = false;
    let cut = false;
    try {
      if (!ownSession) { guest.debugger.attach("1.3"); attached = true; }
      /** @param {string} method @param {object} params @param {number} ms */
      const send = async (method, params, ms) => {
        const r = await inTime(guest.debugger.sendCommand(method, params), ms);
        return r === LATE ? note(`${method} did not answer`) : r;
      };

      /* `fullPage`'s clip is the page's own content size, not a rectangle the
         caller already knew — same source and the same 16384 Chromium cap as
         `ag:captureFullPage`'s manual "shoot the whole page" button, so an
         agent's `--full-page` and a person's own screenshot never disagree
         about how tall "the whole page" is. */
      let effectiveClip = wantClip;
      /* 1 unless a full-page capture measures the page's zoom below. */
      let fullPageScale = 1;
      if (wantFullPage) {
        const m = await send("Page.getLayoutMetrics", {}, 1500);
        const size = (m && (m.cssContentSize || m.contentSize)) || null;
        if (size && size.width && size.height) {
          const CAP = 16384;
          /* Never smaller than what is on screen — see the same guard in
             `ag:captureFullPage`. A page laid out narrower than the window
             produced a "whole page" shot with the right-hand side missing,
             smaller than the plain visible one, which is a bug whichever way
             round you read it. */
          /* The zoom, measured — see the note in `ag:captureFullPage`. A clip
             in CSS pixels captured at scale 1 comes back SMALLER than the
             visible shot on any zoomed page, by exactly the zoom factor. */
          const vp = (m && (m.cssVisualViewport || m.visualViewport)) || {};
          fullPageScale = Number(vp.zoom) || 1;
          const wide = Math.ceil(size.width);
          const tall = Math.max(Math.ceil(size.height), Math.ceil(vp.clientHeight || 0));
          /* Nothing below the fold means the whole page IS the visible one —
             see the long note in `ag:captureFullPage`. Leaving the clip unset
             takes the ordinary route, which lands right without arithmetic. */
          if (Math.ceil(size.height) <= Math.ceil(vp.clientHeight || 0) + 2) {
            fullPageScale = 1;
            effectiveClip = wantClip;
          } else {
            const width = Math.min(wide, CAP);
            const height = Math.min(tall, CAP);
            cut = tall > CAP || wide > CAP;
            effectiveClip = { x: 0, y: 0, width, height };
          }
        } else {
          note("the page reported no content size to capture full-page");
        }
      }
      const clipParams = effectiveClip
        ? { captureBeyondViewport: true, clip: { x: effectiveClip.x, y: effectiveClip.y, width: effectiveClip.width, height: effectiveClip.height, scale: fullPageScale } }
        : {};
      /*
       * `captureBeyondViewport` renders into an off-screen surface and
       * `fromSurface: false` asks the renderer for the frame instead of the
       * surface — the surface being precisely the broken part when the sink is
       * gone. If both come back empty, the page is being told its size by a
       * surface it no longer has: an explicit metrics override gives it one,
       * which is the same trick headless Chrome uses to capture a page nobody
       * is showing.
       */
      /* Spelled out rather than inferred: an array of [label, thunk] pairs
         widens to `(string | (() => …))[]` on its own, and destructuring that
         in the loop below gives a `way` the checker will not call. */
      /** @type {[string, () => Promise<any>][]} */
      const ways = [
        /* `fromSurface: false` first, and the order is the diagnosis: the two
           compositor attempts have already failed by the time this runs, and
           they failed on the surface. Asking the surface again with
           `captureBeyondViewport` hung for three seconds and left no time for
           the two routes that do not use it — measured. So the ones that render
           from the frame go first, and the surface gets whatever is left. */
        ["the debugger, from the frame", () => send("Page.captureScreenshot", { format: "png", fromSurface: false, ...clipParams }, 2200)],
        ["the debugger, with a viewport of its own", async () => {
          const m = await send("Page.getLayoutMetrics", {}, 1500);
          const box = (m && (m.cssLayoutViewport || m.layoutViewport)) || null;
          if (!box) return null;
          await send("Emulation.setDeviceMetricsOverride", {
            width: Math.max(1, Math.round(box.clientWidth)),
            height: Math.max(1, Math.round(box.clientHeight)),
            deviceScaleFactor: 1,
            mobile: false,
          }, 1500);
          try {
            return await send("Page.captureScreenshot", { format: "png", fromSurface: false, ...clipParams }, 2200);
          } finally {
            // Always, even on the way out of a failure: a page left with an
            // override lays itself out for a viewport nobody has.
            try { await guest.debugger.sendCommand("Emulation.clearDeviceMetricsOverride"); } catch { /* detaching clears it anyway */ }
          }
        }],
        ["the debugger, off-screen", () => send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, ...clipParams }, 2200)],
      ];
      for (const [via, way] of ways) {
        if (left() < 400) { note("there was no time left to try the rest"); break; }
        try {
          const shot = await way();
          if (shot && shot.data) return { png: `data:image/png;base64,${shot.data}`, why: "", url: guestUrl(), via, cut: cut || undefined };
          if (shot) note("the page produced no frame off-screen");
        } catch (e) {
          note(String(e instanceof Error ? e.message : e));
        }
      }
    } catch (e) {
      note(String(e instanceof Error ? e.message : e));
    } finally {
      // Only ours. A DevTools window somebody opened on this page owns the
      // debugger too, and detaching it from under them would close it.
      if (attached) { try { guest.debugger.detach(); } catch { /* already gone */ } }
    }
    return { png: null, why: `every way of capturing this page failed: ${[...new Set(tried)].join("; ")}` };
  });

  /**
   * §4: `addInitScript`/`expose`, both funnelled through one relay call —
   * `browserDrive.ts` only ever asks to register a NAMED script.
   *
   * `Page.addScriptToEvaluateOnNewDocument` is what makes this different from
   * `eval`: Chromium runs it in every new document on this guest, before that
   * document's own scripts, for as long as the debugger session lives — which
   * here is as long as the guest does, not one command's round trip. Re-
   * registering the same `name` REMOVES the old identifier before adding the
   * new one, so a caller changing its mind ends up with one script under that
   * name, not two both trying to run.
   */
  ipcMain.handle("ag:browserRegisterInitScript", async (_e, req) => {
    /* THE TAB THE CALLER NAMED. This read `browserGuest` — the front tab — so
       an init script asked for on a background tab was registered on whatever
       was in front, and answered ok. Same fault the capture and the DevTools
       relay each had; an id we do not recognise is refused rather than served
       from the front tab. */
    const wanted = Number(req && req.guestId);
    const guest = Number.isFinite(wanted) && wanted > 0 ? browserGuestById(wanted) : browserGuest;
    if (!guest || guest.isDestroyed()) {
      return { ok: false, error: wanted ? "that tab is not a browser pane in this window" : "no browser pane is mounted" };
    }
    const name = typeof req?.name === "string" ? req.name : "";
    const source = typeof req?.source === "string" ? req.source : "";
    if (!name || !source) return { ok: false, error: "name and source are required" };
    // A human's own DevTools owns the single debugger seat a page has —
    // refuse rather than steal it, the same call `ag:captureBrowser` makes.
    if (guest.debugger.isAttached() && !guestOwnsDebugger.has(guest)) {
      return { ok: false, error: "the inspector is attached to this page — close it and try again" };
    }
    try {
      if (!guestOwnsDebugger.has(guest)) {
        guest.debugger.attach("1.3");
        guestOwnsDebugger.add(guest);
      }
      let scripts = guestInitScripts.get(guest);
      if (!scripts) { scripts = new Map(); guestInitScripts.set(guest, scripts); }
      const old = scripts.get(name);
      if (old && old.identifier) {
        try { await guest.debugger.sendCommand("Page.removeScriptToEvaluateOnNewDocument", { identifier: old.identifier }); }
        catch { /* the guest may already have dropped it on navigation */ }
      }
      /* Chromium only injects these on a session whose Page domain is on.
         Idempotent, and cheap, so it is asked for every time rather than
         tracked — a session that was attached for a screenshot has not
         enabled it. */
      try { await guest.debugger.sendCommand("Page.enable"); } catch { /* already on */ }
      /*
       * `runImmediately`, BECAUSE "ON EVERY NEW DOCUMENT" IS NOT TRUE HERE.
       *
       * Measured with the raw protocol on a `<webview>` guest: a script
       * registered on this session runs when asked for `runImmediately` and is
       * GONE after one navigation — reload or Page.navigate alike, and
       * re-registering on `did-start-navigation` does not bring it back
       * either. The guest does not keep them.
       *
       * So the verb does the half that is real: it runs the script in the
       * document that is there now, and says so. A caller that navigates has
       * to ask again — which is a sentence it can act on, unlike
       * {"registered": ...} over a page that never saw it.
       */
      const { identifier } = await guest.debugger.sendCommand(
        "Page.addScriptToEvaluateOnNewDocument", { source, runImmediately: true },
      );
      scripts.set(name, { source, identifier });
      return { ok: true, ranNow: true };
    } catch (e) {
      return { ok: false, error: String(e instanceof Error ? e.message : e) };
    }
  });

  /*
   * §5: the DevTools protocol itself, one call wide.
   *
   * The spec asks for a debugger, DOM breakpoints, a listener inspector, JS and
   * CSS coverage, a profiler, heap snapshots, source maps and paint layers —
   * and every one of those is a CDP domain that Chromium already implements.
   * Wrapping each in its own IPC handler would be nine handlers that all do the
   * same thing, and would be missing the tenth on the day somebody needs it.
   * So the protocol is relayed whole, and the ergonomic verbs on top of it
   * (`listeners`, `coverage`) are built in the panel where they are cheap to
   * add rather than here where each one costs a round of shell plumbing.
   *
   * The seat, and why this can refuse: a page has ONE debugger session. If a
   * person has their own inspector open on this guest, it is theirs — this
   * refuses rather than steals it, exactly as `ag:captureBrowser` and §4's
   * init-script relay do. Stealing it would close their DevTools out from
   * under them mid-debug, which is the kind of thing that makes somebody stop
   * trusting a tool for good.
   *
   * The event buffer exists because CDP is a stream and this relay is a
   * request. `Debugger.paused`, `Runtime.consoleAPICalled`, a DOM breakpoint
   * firing — all of those arrive when they arrive, and an agent that has to
   * be holding a connection to see them is back to the polling §1 removed.
   * They queue here, newest last, and `cdp --events` drains them.
   */
  /** @type {Map<Electron.WebContents, Array<{at: number, method: string, params: unknown}>>} */
  const guestCdpEvents = new Map();
  const CDP_EVENT_CAP = 500;

  /*
   * WHERE A DOWNLOAD IS MEANT TO LAND, per guest.
   *
   * `download` arms `Browser.setDownloadBehavior` with a directory, clicks, and
   * then waits for `Page.downloadWillBegin` and `Page.downloadProgress` to come
   * back through the event buffer. Measured through the CLI: the click happens
   * — the test server logged three requests for the file — and neither event
   * ever arrives, so the verb waits out its whole timeout and nothing lands.
   *
   * The reason is that Electron takes a guest's download itself, on the
   * session's `will-download`, before the protocol is involved at all. Nothing
   * in this app listened for it (grep: zero handlers), so the item was left to
   * the default behaviour and CDP had nothing to report.
   *
   * So the path is remembered here when the verb asks for it, the session
   * handler below saves the file where it was asked to go, and it pushes the
   * two events the waiting loop is already listening for. Same shape as the
   * printToPDF branch further down and for the same reason: the answer stops
   * coming from the protocol without anything downstream needing to learn that.
   */
  /** @type {Map<Electron.WebContents, string>} */
  const guestDownloadDir = new Map();
  /** Sessions already wired, so a second download does not stack handlers. */
  const downloadWired = new WeakSet();

  /** @param {Electron.WebContents} guest */
  const wireDownloads = (guest) => {
    const ses = guest.session;
    if (downloadWired.has(ses)) return;
    downloadWired.add(ses);
    ses.on("will-download", (_ev, item, wc) => {
      const dir = guestDownloadDir.get(wc) ?? guestDownloadDir.get(guest);
      if (!dir) return; // nobody asked for this one; leave Electron's default alone
      const name = item.getFilename();
      item.setSavePath(path.join(dir, name));
      // Spelled out because this file is typechecked and an untyped parameter
      // here is two more tsc errors on a list that has to stay readable.
      /** @param {string} method @param {Record<string, unknown>} params */
      const push = (method, params) => {
        const buf = guestCdpEvents.get(wc) || guestCdpEvents.get(guest);
        if (!buf) return;
        buf.push({ at: Date.now(), method, params });
        if (buf.length > CDP_EVENT_CAP) buf.splice(0, buf.length - CDP_EVENT_CAP);
      };
      // The guid is the protocol's way of pairing the two events. Electron has
      // no equivalent, so one is minted and used for both — the waiting loop
      // only ever compares it with itself.
      const guid = `agx-dl-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
      push("Page.downloadWillBegin", { guid, suggestedFilename: name, url: item.getURL() });
      item.once("done", (_e2, state) => {
        push("Page.downloadProgress", {
          guid,
          // `completed` and `canceled` are the two the loop acts on; anything
          // else it keeps waiting through, which is right — an interrupted
          // download that resumes still finishes.
          state: state === "completed" ? "completed" : state === "cancelled" ? "canceled" : String(state),
        });
      });
    });
  };

  /*
   * A favicon as `data:`, so the tab strip stops asking the network.
   *
   * Same guest-resolution rule as the relay below, and the same refusal: an id
   * we do not recognise is turned down rather than quietly served from the tab
   * in front. That bug has appeared three times in this file — the capture, the
   * DevTools relay, addInitScript — and every time it looked like success.
   *
   * The URL is checked against what Chromium reported for THAT guest; see where
   * guestFavicons is filled. A caller cannot reach the network with an argument
   * of its own, which is the line prAsset draws and the reason this is not a
   * proxy.
   *
   * Fetched on the guest's OWN session, so it carries that tab's cookies,
   * partition and proxy: the same request the page made a moment ago, not a
   * privileged one from the shell.
   */
  ipcMain.handle("ag:browserFavicon", async (_e, req) => {
    const wanted = Number(req && req.guestId);
    const guest = Number.isFinite(wanted) && wanted > 0 ? browserGuestById(wanted) : null;
    if (!guest || guest.isDestroyed()) {
      return { ok: false, error: "that tab is not a browser pane in this window" };
    }
    const url = typeof (req && req.url) === "string" ? req.url : "";
    const known = guestFavicons.get(guest);
    if (!url || !known || !known.has(url)) {
      return { ok: false, error: "that is not an icon this tab reported" };
    }
    try {
      const res = await guest.session.fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return { ok: false, error: `upstream ${res.status}` };
      const type = res.headers.get("content-type") || "";
      // Images only: this must not become a way to read text off a host by
      // dressing it as an icon.
      if (!/^image\//i.test(type)) return { ok: false, error: "not an image" };
      const buf = Buffer.from(await res.arrayBuffer());
      // A favicon is a few kB. Past this it is not one, and every byte is paid
      // for again as base64 in the renderer.
      if (buf.length > 256 * 1024) return { ok: false, error: "too large for an icon" };
      return { ok: true, dataUrl: "data:" + type.split(";")[0] + ";base64," + buf.toString("base64") };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /*
   * THE PERSON'S ZOOM, WHICH IS NOT THE AGENT'S.
   *
   * Reported with three screenshots at 110%, 140% and 240%: the page kept its
   * size and the RECTANGLE IT WAS DRAWN IN shrank, leaving a small page in a
   * large empty area — "it doesn't zoom, it does something odd".
   *
   * That is exactly what `Emulation.setDeviceMetricsOverride` does. It narrows
   * the layout VIEWPORT, and the `<webview>` element keeps the box it always
   * had, so the page is laid out for a smaller window and drawn at the same
   * scale. It is the right primitive for an agent asking "show me this page as
   * a phone would see it"; it is the wrong one for a person leaning in.
   *
   * Electron already has the right one, and it scales the page inside the box
   * it has: `webContents.setZoomFactor`. It is only reachable from this
   * process, which is why it is a door of its own — the renderer's
   * `<webview>.setZoomFactor` was measured doing nothing at all.
   *
   * The guest is resolved the way `ag:browserCdp` resolves it, including the
   * refusal on an id we do not recognise: a silent fall back to the front tab
   * is how the wrong-tab bug keeps coming back.
   */
  ipcMain.handle("ag:browserZoom", async (_e, req) => {
    const wanted = Number(req && req.guestId);
    const guest = Number.isFinite(wanted) && wanted > 0 ? browserGuestById(wanted) : browserGuest;
    if (!guest || guest.isDestroyed()) {
      return { ok: false, error: wanted ? "that tab is not a browser pane in this window" : "no browser pane is mounted" };
    }
    try {
      const asked = req && req.factor;
      /* No factor is a READ. Setting and reading go through one door so they
         cannot disagree about what the page is at. */
      if (typeof asked === "number" && Number.isFinite(asked)) {
        if (!(asked > 0.1 && asked <= 5)) {
          return { ok: false, error: "zoom takes a factor between 0.1 and 5 — 1 is a page at its own size" };
        }
        guest.setZoomFactor(asked);
      }
      const factor = guest.getZoomFactor();
      return { ok: true, factor, percent: Math.round(factor * 100) };
    } catch (e) {
      return { ok: false, error: String((e && /** @type {Error} */ (e).message) || e) };
    }
  });

  ipcMain.handle("ag:browserCdp", async (_e, req) => {
    /*
     * THE TAB THE CALLER NAMED, not whichever one is in front.
     *
     * This said `browserGuest` — the front tab — so every DevTools call went
     * there whatever `--page` said, and the screenshot route is a DevTools
     * call. Measured on the running app: `read` answered from the agent's own
     * page while `shot`, one command later, returned a picture of a different
     * tab. Right dimensions, plausible content, wrong page, and nothing in the
     * answer saying so.
     *
     * An id we do not recognise is REFUSED rather than quietly served from the
     * front tab: a silent fallback here is how this bug comes back.
     */
    const wanted = Number(req && req.guestId);
    const guest = Number.isFinite(wanted) && wanted > 0 ? browserGuestById(wanted) : browserGuest;
    if (!guest || guest.isDestroyed()) {
      return { ok: false, error: wanted ? "that tab is not a browser pane in this window" : "no browser pane is mounted" };
    }

    // Draining the buffer needs no session and must work even when attaching
    // would fail — the events already happened.
    if (req?.drain === true) {
      const buf = guestCdpEvents.get(guest) || [];
      guestCdpEvents.set(guest, []);
      return { ok: true, events: buf };
    }

    const method = typeof req?.method === "string" ? req.method : "";
    if (!method || !method.includes(".")) {
      return { ok: false, error: 'method must be a CDP method, e.g. "Debugger.enable"' };
    }

    /*
     * INTERCEPT'S RULES, kept HERE because this is where the events arrive.
     *
     * `intercept` used to call `Fetch.enable` and write its rules into a
     * variable in the page. Fetch.enable pauses EVERY request until something
     * answers it, and nothing did: one call and the tab stopped loading
     * anything, for good, while the verb answered ok. Measured by a peer
     * session — a matching URL, a non-matching URL and `--clear` all hung, and
     * the tab only came back after `Fetch.disable` by hand.
     *
     * A rule has to live where `Fetch.requestPaused` is received, which is the
     * debugger session in this process. `Fetch.agxSetRules` is that door: it
     * takes the whole list at once (so clearing is passing a shorter list),
     * turns the domain on when there is something to match and off when there
     * is not.
     */
    if (method === "Fetch.agxSetRules") {
      const rules = Array.isArray(req?.params?.rules) ? req.params.rules : [];
      if (!rules.length) {
        guestIntercepts.delete(guest);
        if (guestOwnsDebugger.has(guest)) {
          try { await guest.debugger.sendCommand("Fetch.disable"); } catch { /* already gone */ }
        }
        return { ok: true, result: { rules: 0 } };
      }
      guestIntercepts.set(guest, rules);
      return { ok: true, result: { rules: rules.length } };
    }


    /*
     * Page.printToPDF, which a guest's debugger does not have.
     *
     * `pdf` called it over the protocol and got back `'Page.printToPDF' wasn't
     * found` — measured on a clean launch, before anything else had touched the
     * debugger, and `Page.enable` first changes nothing. The method is simply
     * not in the surface Chromium exposes to a <webview>'s debugger session.
     * Electron carries the same capability as a webContents call, so that is
     * what answers here.
     *
     * SERVED FROM THIS HANDLER RATHER THAN A CHANNEL OF ITS OWN, deliberately.
     * A second channel would have to repeat the twenty lines above that decide
     * WHICH guest this is and refuse an id they do not recognise — and a
     * second copy of that rule is exactly how "every DevTools call went to the
     * front tab" comes back. One resolution, one refusal, both shared.
     *
     * The reply keeps CDP's shape (`{ data: <base64> }`) because the contract
     * downstream is unchanged: the verb passes it through and the CLI decodes
     * the base64 and writes the file. Nothing above this line learns that the
     * answer stopped coming from the protocol.
     */
    /*
     * The directory a download is meant to land in, taken from the protocol
     * call the verb already makes rather than from a channel of its own.
     *
     * Passed through to the debugger as well, not swallowed: a guest that DOES
     * honour it should keep doing so, and this is only the safety net for the
     * far commoner case where Electron takes the item first.
     */
    if (method === "Browser.setDownloadBehavior") {
      const p = (req && req.params) || {};
      if (p.behavior === "allow" && typeof p.downloadPath === "string" && p.downloadPath) {
        guestDownloadDir.set(guest, p.downloadPath);
        wireDownloads(guest);
      } else {
        guestDownloadDir.delete(guest);
      }
    }

    if (method === "Page.printToPDF") {
      try {
        const p = (req && req.params) || {};
        const buf = await guest.printToPDF({
          printBackground: p.printBackground !== false,
          landscape: p.landscape === true,
        });
        return { ok: true, result: { data: buf.toString("base64") } };
      } catch (e) {
        // Narrowed rather than `e.message` on a bare catch: this file is
        // typechecked, and the untyped form is two more tsc errors on top of
        // the eight already here. Adding to that list is how it stops being
        // read at all.
        return { ok: false, error: `the page could not be printed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    if (guest.debugger.isAttached() && !guestOwnsDebugger.has(guest)) {
      return { ok: false, error: "the inspector is attached to this page — close it and try again" };
    }
    try {
      if (!guestOwnsDebugger.has(guest)) {
        guest.debugger.attach("1.3");
        guestOwnsDebugger.add(guest);
        guestCdpEvents.set(guest, []);
        /* Spelled out: `guest` is now a lookup that can miss, so the checker no
           longer infers these from a narrowed constant.
           @param {unknown} _ev @param {string} m @param {unknown} params */
        guest.debugger.on("message", (/** @type {unknown} */ _ev, /** @type {string} */ m, /** @type {unknown} */ params) => {
          /* A paused request is a request nobody has answered yet, and every
             one of them is a page that is not loading. Answered first, and
             before the buffer, because a rule that matches nothing still has
             to let the request through. */
          if (m === "Fetch.requestPaused") answerPaused(guest, params);
          const buf = guestCdpEvents.get(guest);
          if (!buf) return;
          buf.push({ at: Date.now(), method: m, params });
          // Oldest first out: a page that logs in a loop must not be able to
          // push a debugger pause out of the buffer before anyone reads it.
          if (buf.length > CDP_EVENT_CAP) buf.splice(0, buf.length - CDP_EVENT_CAP);
        });
        guest.debugger.on("detach", () => {
          guestOwnsDebugger.delete(guest);
          guestCdpEvents.delete(guest);
        });
      }
      /*
       * BOUNDED HERE, WHERE THE COMMAND IS ISSUED — not raced by the caller.
       *
       * `Page.captureScreenshot` does not fail on a guest that is not
       * compositing: it never answers. The first fix raced it in the renderer
       * and that made things WORSE, measured by somebody using it: a tab that
       * had been in the background once could not be captured again ever, not
       * after being brought to the front, not after a reload. Racing abandons
       * the promise and leaves the command outstanding in the debugger session,
       * and the next one queues behind a capture that is never coming.
       *
       * So the deadline lives with the command, and a command that misses it
       * takes the session down with it: detaching is what clears the pending
       * request, and the next call attaches a clean one. That is the difference
       * between a slow answer and a poisoned tab.
       */
      const late = Symbol("late");
      const result = await Promise.race([
        guest.debugger.sendCommand(method, req?.params || {}),
        new Promise((r) => setTimeout(() => r(late), CDP_DEADLINE_MS)),
      ]);
      if (result === late) {
        try { guest.debugger.detach(); } catch { /* already gone */ }
        guestOwnsDebugger.delete(guest);
        return { ok: false, error: `${method} did not answer in ${Math.round(CDP_DEADLINE_MS / 1000)}s — the session was reset` };
      }
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: String(e instanceof Error ? e.message : e) };
    }
  });

  ipcMain.handle("ag:browserSessionSettings", async (_e, req) => {
    /* §13: apply session-level settings — proxy, extensions, third-party cookies, DNS.
       These are process-level and go through the Electron session API, not through CDP.
       Everything here is optional: if a setting cannot be applied, we report plainly
       what happened rather than silently failing. */
    const ses = session.fromPartition(BROWSER_PARTITION);
    if (!ses) return { ok: false, error: "no browser session is available" };
    const applied = [];
    try {
      if (req?.proxy && typeof req.proxy === "object") {
        const px = req.proxy;
        const rules = String(px.rules ?? "");
        const bypass = String(px.bypass ?? "");
        await ses.setProxy({ proxyRules: rules, proxyBypassRules: bypass });
        applied.push("proxy");
      }
      if (req?.cookies && typeof req.cookies === "object") {
        /*
         * REFUSED, AND IT USED TO SAY "cookies" INSTEAD.
         *
         * These three branches called `ses.setVisitedLink({ options: { options:
         * { thirdPartyPolicy } } })` — a method `Session` does not have, with a
         * shape nothing in Electron takes — and then pushed "cookies" onto the
         * list of things applied. So the verb answered that it had set a cookie
         * policy while the call threw into the catch below, or did nothing at
         * all: the exact "answered success, changed nothing" this repository has
         * spent two sweeps removing. The typecheck named it the moment one was
         * run over `electron/`.
         *
         * There is no per-session third-party cookie policy to call instead:
         * Chromium decides that from the profile and its own flags, and Electron
         * exposes neither at runtime. So the honest answer is that this shell
         * cannot do it, said to the caller rather than swallowed.
         */
        const policy = String(req.cookies.thirdParty ?? "");
        if (policy) {
          return {
            ok: false,
            error: "cookies.thirdParty cannot be set from here — Electron exposes no per-session "
              + "third-party cookie policy, and the call that pretended to was a method Session does "
              + "not have. Use a separate container (a profile) for the pages that must not share cookies.",
          };
        }
      }
      if (req?.extensions && typeof req.extensions === "object") {
        const ext = req.extensions;
        const action = String(ext.action ?? "");
        if (action === "load") {
          const path = String(ext.path ?? "");
          if (path) {
            try {
              await ses.loadExtension(path);
              applied.push("extensions:load");
            } catch (e) {
              return { ok: false, error: `could not load extension: ${String(e instanceof Error ? e.message : e)}` };
            }
          }
        } else if (action === "remove") {
          const id = String(ext.id ?? "");
          if (id) {
            try {
              ses.removeExtension(id);
              applied.push("extensions:remove");
            } catch (e) {
              return { ok: false, error: `could not remove extension: ${String(e instanceof Error ? e.message : e)}` };
            }
          }
        } else if (action === "list") {
          try {
            const exts = await ses.getAllExtensions();
            applied.push("extensions:list");
            return { ok: true, applied, value: { extensions: exts } };
          } catch (e) {
            return { ok: false, error: `could not list extensions: ${String(e instanceof Error ? e.message : e)}` };
          }
        }
      }
      if (req?.dns && typeof req.dns === "object") {
        /* Electron does not expose a method to change DNS at runtime — it must
           be set at launch with --host-resolver-rules. We report this plainly
           rather than silently accepting a request we cannot fulfill. */
        return { ok: false, error: "DNS remapping must be set at launch with --host-resolver-rules, not at runtime" };
      }
      return { ok: true, applied };
    } catch (e) {
      return { ok: false, error: String(e instanceof Error ? e.message : e) };
    }
  });

  /*
   * The inspector, inside the app instead of floating over it.
   *
   * A `<webview>` guest has no window of its own, so every docking mode Electron
   * offers collapses to "detached": DevTools came up as a separate OS window,
   * over the app, with its content not filling its frame on a fractionally
   * scaled display. The fix is the documented one — give the guest a webContents
   * to draw its DevTools INTO, and let the panel lay that out like any other
   * pane.
   *
   * Both ids must be guests this window attached. `webContents.fromId` will hand
   * back anything in the process, the renderer is the one asking, and "point the
   * DevTools of X at Y" is not a sentence any other webContents should be able
   * to complete.
   */
  /** @param {number} id */
  const knownGuest = (id) => {
    for (const g of browserGuests) if (!g.isDestroyed() && g.id === id) return g;
    return null;
  };

  /*
   * The DevTools host: a WebContentsView the shell owns, not a second guest.
   *
   * The first version pointed the page's DevTools at another `<webview>`, which
   * is what `setDevToolsWebContents` is documented to accept — and MEASURED, it
   * came up with a working toolbar and an EMPTY Elements tree. It is a known
   * webview-to-webview limitation (electron/electron#15874, open since 2018).
   *
   * A `WebContentsView` is the other thing the docs name, it is created here
   * rather than by the guest view manager, and its Elements tree is populated.
   * The price is that it is not part of the page's layout: it floats over the
   * window at a rectangle somebody has to keep correct, which is what
   * `ag:browserDevtoolsRect` is for. The renderer measures the hole it left and
   * says where it is; this multiplies by the window's zoom, because the
   * renderer speaks CSS pixels and a view's bounds are device-independent ones.
   *
   * Hidden rather than removed when the browser is not the view on screen — a
   * floating child view knows nothing about our workspace, and left visible it
   * would sit over the terminal.
   */
  /** @type {Map<number, DevtoolsView>} */
  const devtoolsViews = new Map();

  /** `rect` is described as the complete rectangle it has to be for the branch
   *  below to use it, and the `!!rect` guard stays for the renderer that sends
   *  nothing at all — a shape and a presence check are different questions.
   * @param {DevtoolsView} view
   * @param {{ x: number, y: number, width: number, height: number, on?: boolean } | null | undefined} rect */
  const placeDevtools = (view, rect) => {
    const z = (() => { try { return win.webContents.getZoomFactor() || 1; } catch { return 1; } })();
    const on = !!rect && rect.width > 8 && rect.height > 8 && rect.on !== false;
    try {
      view.setVisible(on);
      if (on) {
        view.setBounds({
          x: Math.round(rect.x * z), y: Math.round(rect.y * z),
          width: Math.round(rect.width * z), height: Math.round(rect.height * z),
        });
      }
    } catch { /* the view is gone */ }
  };

  /*
   * The inspector's own zoom.
   *
   * Its own, and that is the entire requirement: not the app's, not the page's.
   * Every browser does this — Ctrl+plus inside DevTools makes DevTools bigger
   * and leaves the site alone — and here it comes free, because the host is a
   * WebContents of its own. What does NOT come free is the gesture: the keys and
   * the wheel land in that view, so they are caught there, exactly as the
   * guest's own zoom is caught in the guest.
   *
   * Bounds are unaffected. They are device-independent pixels multiplied by the
   * WINDOW's zoom; what this changes is how big the DevTools draw themselves
   * inside the rectangle they were given.
   */
  /** @param {DevtoolsView} view @param {number} guestId */
  const wireDevtoolsZoom = (view, guestId) => {
    const wc = view.webContents;
    /** @param {number} level */
    const apply = (level) => {
      const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
      try { wc.setZoomLevel(next); } catch { return; }
      // The panel draws the percentage, and a level it did not ask for is one it
      // would otherwise report wrongly for the rest of the session.
      try { win.webContents.send("ag:browser-devtools-zoom", { guest: guestId, level: next }); } catch { /* torn down */ }
    };
    wc.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const mod = process.platform === "darwin" ? input.meta : input.control;
      if (!mod) return;
      if (input.key === "+" || input.key === "=" || input.key === "-" || input.key === "0") {
        event.preventDefault();
        apply(input.key === "0" ? 0 : stepZoom(wc.getZoomLevel(), input.key === "-" ? -1 : 1));
      }
    });
    wc.on("zoom-changed", (_e, direction) => {
      apply(stepZoom(wc.getZoomLevel(), direction === "in" ? 1 : -1));
    });
    return apply;
  };

  /** @param {number} id */
  const dropDevtools = (id) => {
    const view = devtoolsViews.get(id);
    if (!view) return;
    devtoolsViews.delete(id);
    try { win.contentView.removeChildView(view); } catch { /* already detached */ }
    try { view.webContents.close(); } catch { /* already closed */ }
  };

  /*
   * Another browser's sidebar, for importing.
   *
   * Through the same one-shot as the cookies and the history, and for the same
   * reason: it is somebody's browsing, and there is no HTTP route for it, so an
   * agent driving this browser cannot ask. No confirmation dialog here — unlike
   * the cookies, nothing leaves this machine and nothing is written to another
   * profile; the panel shows what it found and the person presses Import.
   */
  ipcMain.handle("ag:browserShelfRead", async (_e, source) => {
    try { return await runCookieReader(["shelf", "--source", String(source ?? "")]); }
    catch (e) { return { ok: false, error: String(e instanceof Error ? e.message : e) }; }
  });

  ipcMain.handle("ag:browserDevtools", (_e, req) => {
    const guest = knownGuest(Number(req && req.guest));
    if (!guest) return { ok: false, error: "that page is gone" };
    try {
      let view = devtoolsViews.get(guest.id);
      if (!view || view.webContents.isDestroyed()) {
        view = new WebContentsView();
        devtoolsViews.set(guest.id, view);
        win.contentView.addChildView(view);
        guest.setDevToolsWebContents(view.webContents);
        guest.openDevTools();
        wireDevtoolsZoom(view, guest.id);
        /* The level the panel remembers, applied once the front-end is there to
           be scaled — before that the call lands on `about:blank` and is lost
           on the navigation to `devtools://`. */
        if (typeof req.zoom === "number") {
          const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, req.zoom));
          /*
           * On EVERY load, and once more a beat later.
           *
           * `once("dom-ready")` was not enough and he noticed: the DevTools
           * front-end is a page that reloads itself as panels come up, and each
           * load resets the zoom to 1 — so the level came back only if you were
           * quick. `on` rather than `once` covers the reloads; the delayed
           * repeat covers the one where the front-end sets its own zoom after
           * ours.
           */
          /* Held in a const for the closure. `view` is a `let`, and a closure
             reading a `let` is read as possibly seeing a later value — it
             cannot here, but only a const says so. */
          const pane = view;
          const apply = () => { try { pane.webContents.setZoomLevel(z); } catch { /* gone */ } };
          view.webContents.on("dom-ready", () => { apply(); setTimeout(apply, 400); });
        }
        // A tab that goes takes its inspector with it, or the view outlives the
        // page it was inspecting and floats over whatever is behind it.
        guest.once("destroyed", () => dropDevtools(guest.id));
      }
      placeDevtools(view, req && req.rect);
      if (req && typeof req.x === "number" && typeof req.y === "number") {
        guest.inspectElement(Math.round(req.x), Math.round(req.y));
      }
      return { ok: true, docked: true };
    } catch (e) {
      dropDevtools(guest.id);
      return { ok: false, error: String(e instanceof Error ? e.message : e) };
    }
  });

  // Fire and forget: this arrives on every drag frame and every resize, and an
  // invoke would make the renderer wait for a round trip to draw the next one.
  ipcMain.on("ag:browserDevtoolsRect", (_e, req) => {
    const guest = knownGuest(Number(req && req.guest));
    const view = guest && devtoolsViews.get(guest.id);
    if (view) placeDevtools(view, req && req.rect);
  });

  ipcMain.handle("ag:browserDevtoolsZoom", (_e, req) => {
    const guest = knownGuest(Number(req && req.guest));
    const view = guest && devtoolsViews.get(guest.id);
    if (!view || view.webContents.isDestroyed()) return { ok: false };
    const level = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(req && req.level) || 0));
    try { view.webContents.setZoomLevel(level); } catch { return { ok: false }; }
    return { ok: true, level };
  });

  ipcMain.handle("ag:browserDevtoolsClose", (_e, req) => {
    const guest = knownGuest(Number(req && req.guest));
    if (guest) {
      try { guest.closeDevTools(); } catch { /* already closed */ }
      dropDevtools(guest.id);
    }
    return { ok: true };
  });

  /*
   * The whole page, scroll and all.
   *
   * `capturePage` cannot do this and never will: it photographs what the
   * compositor has, and what is below the fold was never painted. The debugger
   * can — `captureBeyondViewport` renders the document into an off-screen
   * surface at whatever size `Page.getLayoutMetrics` says it is — which is the
   * same door the hidden-pane capture goes through, for the same reason.
   *
   * Copied here rather than handed back as a data URL to be copied in the
   * renderer: a full page is several megabytes of base64, and the clipboard
   * this app needs is the desktop's anyway (a renderer write is refused while
   * the guest holds the focus, which it does).
   */
  /*
   * A screenshot, saved.
   *
   * Into the downloads folder without asking, which is what a browser does with
   * this button — a save dialog for something you took by dragging a rectangle
   * is a second decision nobody wanted to make. The name is ours and the
   * extension is fixed: this only ever writes a PNG, and the only thing the
   * renderer chooses is the middle of the filename.
   */
  ipcMain.handle("ag:saveImage", async (_e, dataUrl, name) => {
    try {
      const head = "data:image/png;base64,";
      if (typeof dataUrl !== "string" || !dataUrl.startsWith(head)) return { ok: false, error: "that is not a PNG" };
      const img = nativeImage.createFromDataURL(dataUrl);
      if (img.isEmpty()) return { ok: false, error: "that image is empty" };
      // Only what a filename may be: this string came from the renderer, and a
      // path separator in it is the difference between a download and a write
      // anywhere on the disk.
      const slug = String(name || "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(0, 60) || "screenshot";
      const base = slug.toLowerCase().endsWith(".png") ? slug.slice(0, -4) : slug;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const file = path.join(app.getPath("downloads"), `${base}-${stamp}.png`);
      fs.writeFileSync(file, img.toPNG());
      return { ok: true, path: file };
    } catch (e) {
      return { ok: false, error: String(e instanceof Error ? e.message : e) };
    }
  });

  ipcMain.handle("ag:captureFullPage", async (_e, how) => {
    const guest = browserGuest;
    if (!guest || guest.isDestroyed()) return { ok: false, error: "there is no page to capture" };
    let attached = false;
    try {
      if (!guest.debugger.isAttached()) { guest.debugger.attach("1.3"); attached = true; }
      const m = await guest.debugger.sendCommand("Page.getLayoutMetrics");
      const size = m.cssContentSize || m.contentSize || { width: 0, height: 0 };
      /*
       * NEVER SMALLER THAN WHAT IS ON SCREEN.
       *
       * `cssContentSize` is the size of the CONTENT, and on a page whose layout
       * is narrower than the window — a centred app, a fixed-width dashboard —
       * that is less than the viewport. Capturing it produced a "whole page"
       * shot with the right-hand side cut off, while "Visible" got everything:
       * the whole page was SMALLER than the visible one, which reads as a bug
       * whichever way round you look at it.
       *
       * Reported with two screenshots side by side, and they are the clearest
       * possible statement of it. Whole page means "everything visible, plus
       * whatever is below the fold" — so each dimension is the larger of the
       * two.
       */
      const vp = (m.cssVisualViewport || m.visualViewport || {});
      /*
       * THE ZOOM, which is what was actually missing.
       *
       * MEASURED on the page this was reported against: a full-page capture
       * came back 2580x1606 while the plain visible one was 3375x1625 — the
       * WHOLE page narrower than the visible one by 795 pixels, which is
       * exactly the crop that was reported. The ratio between them is 1.308,
       * and `getLayoutMetrics` reported `zoom: 1.3145` on that page.
       *
       * `cssContentSize` is in CSS pixels and does NOT account for the
       * browser's zoom; `clip.scale` is the multiplier that does. Asked with
       * scale 1 the capture is 2580 wide; asked with scale 1.3145 it is 3391 —
       * the size of the visible shot. That is the whole bug, and two earlier
       * guesses (content width, then re-layout) were both wrong about it.
       */
      const zoom = Number(vp.zoom) || 1;
      const wide = Math.ceil(size.width);
      const tall = Math.max(Math.ceil(size.height), Math.ceil(vp.clientHeight || 0));
      /*
       * IF NOTHING IS BELOW THE FOLD, THE WHOLE PAGE IS WHAT YOU CAN SEE.
       *
       * This is the case that kept coming back wrong, and the answer turned
       * out to be that there was nothing to do. On a page that fits, the
       * content-size route re-renders through a clip and a scale and lands
       * shifted and cropped, while the ordinary visible capture is already
       * exactly right — same picture, no arithmetic. Three attempts went into
       * making the arithmetic produce what the simple route produces for free.
       *
       * A page that DOES scroll still needs the clip, so the branch stays.
       */
      const fits = Math.ceil(size.height) <= Math.ceil(vp.clientHeight || 0) + 2;
      if (fits) {
        const img0 = await guest.capturePage().catch(() => null);
        if (img0 && !img0.isEmpty()) {
          const sz = img0.getSize();
          if (how === "save") {
            const stamp0 = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            const file0 = path.join(app.getPath("downloads"), `agentglass-page-${sz.width}x${sz.height}-${stamp0}.png`);
            fs.writeFileSync(file0, img0.toPNG());
            return { ok: true, width: sz.width, height: sz.height, cut: false, path: file0 };
          }
          clipboard.writeImage(img0);
          return { ok: true, width: sz.width, height: sz.height, cut: false };
        }
      }
      // Chromium refuses a capture past this; a page taller than it comes back
      // cut rather than not at all, and saying so is better than a silent crop.
      const CAP = 16384;
      const width = Math.min(wide, CAP);
      const height = Math.min(tall, CAP);
      if (!width || !height) return { ok: false, error: "that page reports no size" };
      const shot = await guest.debugger.sendCommand("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        /* scale is the zoom, not 1 — see the note above. With 1 the capture
           comes back smaller than the visible one on any zoomed page. */
        clip: { x: 0, y: 0, width, height, scale: zoom },
      });
      if (!shot || !shot.data) return { ok: false, error: "the page produced no frame" };
      const img = nativeImage.createFromBuffer(Buffer.from(shot.data, "base64"));
      if (img.isEmpty()) return { ok: false, error: "the page produced an empty frame" };
      const cut = tall > CAP;
      // Copy or keep — the same two things the selection offers, because a
      // whole page is the one shot you are most likely to want as a file.
      if (how === "save") {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const file = path.join(app.getPath("downloads"), `agentglass-page-${width}x${height}-${stamp}.png`);
        fs.writeFileSync(file, img.toPNG());
        return { ok: true, width, height, cut, path: file };
      }
      clipboard.writeImage(img);
      return { ok: true, width, height, cut };
    } catch (e) {
      return { ok: false, error: String(e instanceof Error ? e.message : e) };
    } finally {
      if (attached) { try { guest.debugger.detach(); } catch { /* already gone */ } }
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
        { label: win.isMaximized() ? "Restore" : "Maximise", click: () => { askedAt = Date.now(); return win.isMaximized() ? win.unmaximize() : win.maximize(); } },
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
  /* One subscription per line rather than a loop over the names. `on` is typed
     one event at a time — each name has its own listener signature — so a loop
     hands it a union that matches none of them, and the only way to keep the
     loop is to lie about the name with a cast. */
  const tellWinState = () => {
    try { win.webContents.send("ag:winState", { max: win.isMaximized(), full: win.isFullScreen() }); }
    catch { /* torn down */ }
  };
  win.on("maximize", tellWinState);
  win.on("unmaximize", tellWinState);
  win.on("enter-full-screen", tellWinState);
  win.on("leave-full-screen", tellWinState);
  win.on("restore", tellWinState);

  ipcMain.handle("ag:setFullscreen", (_e, on) => { win.setFullScreen(!!on); return win.isFullScreen(); });
  ipcMain.handle("ag:isFullscreen", () => win.isFullScreen());
  ipcMain.handle("ag:setZoom", (_e, f) => { win.webContents.setZoomFactor(f); return f; });

  ipcMain.handle("ag:autostartEnabled", () => autostartEnabled());
  ipcMain.handle("ag:setAutostart", (_e, on) => setAutostart(!!on));

  ipcMain.handle("ag:powerStatus", () => power.status());
  ipcMain.handle("ag:setPowerMode", (_e, m) => power.setMode(String(m)));

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

/** @param {boolean} on */
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

/** Electron's zoom LEVEL is logarithmic: each step is a factor of 1.2, which is
 *  the size ladder Chrome walks with Ctrl+plus. ±7 is about 25%–500%. */
/** The guest currently showing a page, for the one thing the panel cannot do
 *  for itself — see ag:captureBrowser. Null whenever there is no browser pane
 *  mounted, which is most of the time.
 * @type {WebContents | null} */
let browserGuest = null;
/** Every attached guest. `browserGuest` is whichever of them the renderer says
 *  is on screen; this is what lets a destroyed tab fall back to another. */
const browserGuests = new Set();
/** Per guest, the favicon URLs Chromium has reported for it. The allowlist
 *  `ag:browserFavicon` checks against; see where it is filled for why. */
const guestFavicons = new WeakMap();
/** Enough for a tab that changes its icon a few times; not enough for a page
 *  that rewrites it in a loop to grow this without end. */
const FAVICON_URL_CAP = 16;

/** Windows opened as popups from a guest — a sign-in, in practice. The
 *  Cross-Origin-Opener-Policy header is dropped for these and only these; see
 *  where it is done for the measurement that justifies it. */
const popupIds = new Set();
/** Sessions whose header filter is already installed. One per partition, and
 *  installing it twice would run it twice for every response. */
const coopFreed = new WeakSet();

/**
 * §4's `addInitScript`/`expose`: which CDP script identifier belongs to which
 * NAME, per guest.
 *
 * `Page.addScriptToEvaluateOnNewDocument` is the one door that runs before a
 * page's own scripts — `executeJavaScript` only ever reaches a page already
 * running — and it needs a debugger session held open for the guest's whole
 * life, not attached and detached per call the way `ag:captureBrowser` does
 * it. A `WeakMap` rather than explicit teardown on tab close: the guest is
 * the key, so the entry is unreachable the moment nothing else in this
 * process holds the guest either, which is exactly when its scripts stop
 * mattering — there is no page left to run them on.
 * Holds the SOURCE beside the identifier: a guest drops its registered
 * scripts on every navigation, so they have to be added again, and the
 * identifier alone cannot do that.
 * @type {WeakMap<WebContents, Map<string, { source: string, identifier: string }>>} */
const guestInitScripts = new WeakMap();
/** Guests whose debugger session is OURS — held open for
 *  `Page.addScriptToEvaluateOnNewDocument`, not a screenshot's transient
 *  attach/detach. `ag:captureBrowser`'s "the inspector is attached" refusal
 *  means something different when the attacher is this map instead of a
 *  human's DevTools, so it checks here before believing that. */
const guestOwnsDebugger = new WeakSet();

/** What `intercept` is holding for each guest, newest set wins. Empty means the
 *  Fetch domain is off — see `Fetch.agxSetRules`.
 *  @type {WeakMap<WebContents, Array<Record<string, unknown>>>} */
const guestIntercepts = new WeakMap();

/**
 * Answer one paused request.
 *
 * EVERY path ends in a call, including the one where nothing matches: a
 * request that is paused and never answered is a page that stops loading, and
 * that is exactly what the first version of this feature did to a tab.
 *
 * @param {WebContents} guest
 * @param {unknown} params
 */
function answerPaused(guest, params) {
  const p = /** @type {{ requestId?: string; request?: { url?: string } }} */ (params || {});
  const id = typeof p.requestId === "string" ? p.requestId : "";
  if (!id) return;
  const url = String(p.request?.url || "");
  const send = (/** @type {string} */ method, /** @type {Record<string, unknown>} */ args) => {
    /* A request can be gone by the time we answer — the page navigated, the
       tab closed. That is not a failure worth reporting anywhere. */
    guest.debugger.sendCommand(method, { requestId: id, ...args }).catch(() => {});
  };
  const rules = guestIntercepts.get(guest) || [];
  const hit = rules.find((r) => typeof r.pattern === "string" && r.pattern && url.includes(String(r.pattern)));
  if (!hit) { send("Fetch.continueRequest", {}); return; }
  if (hit.abort === true) {
    const reason = typeof hit.reason === "string" && hit.reason ? hit.reason : "Failed";
    send("Fetch.failRequest", { errorReason: reason });
    return;
  }
  const status = Number(hit.status);
  send("Fetch.fulfillRequest", {
    responseCode: Number.isInteger(status) && status >= 100 && status <= 599 ? status : 200,
    body: Buffer.from(typeof hit.body === "string" ? hit.body : "").toString("base64"),
  });
}

/* How long one DevTools command may take before the session is reset out from
   under it. Generous — a real capture of a big page is under a second and a
   debugger evaluate can be slower — and short enough that a caller is not left
   holding a tab that will never answer. */
const CDP_DEADLINE_MS = 8_000;

const ZOOM_MIN = -7;
const ZOOM_MAX = 7;

/*
 * ZOOM MOVES IN TENS.
 *
 * Chromium's ladder is geometric — every step multiplies by 1.2^0.5 — so it
 * walks 100, 110, 120, 132, 145, 158, 173. Each step is the same PROPORTION
 * and no two are the same number, which is what makes it read as arbitrary
 * from outside: "sometimes it goes up by five, sometimes by three. That has to
 * be something consistent."
 *
 * Ten percentage points, up or down, always. A level that arrived from
 * somewhere else — an old stored value, a pinch, a site that set its own —
 * lands ON the grid with the first press instead of carrying its offset
 * forever: 107% goes to 110 pressing in and 100 pressing out.
 *
 * Mirrored in web/src/lib/browserPrefs.ts, which cannot be imported from this
 * process. Both are three lines of arithmetic; a shared module across the
 * process boundary would be more machinery than the rule is.
 */
const ZOOM_PCT_MIN = 30;
const ZOOM_PCT_MAX = 350;
const ZOOM_PCT_STEP = 10;

/** @param {number} level @param {number} dir +1 in, -1 out */
const stepZoom = (level, dir) => {
  const now = Math.pow(1.2, level) * 100;
  const grid = Math.round(now / ZOOM_PCT_STEP) * ZOOM_PCT_STEP;
  const off = Math.abs(grid - now) > 0.6;
  const next = off
    ? (dir > 0 ? Math.ceil(now / ZOOM_PCT_STEP) : Math.floor(now / ZOOM_PCT_STEP)) * ZOOM_PCT_STEP
    : grid + dir * ZOOM_PCT_STEP;
  const held = Math.max(ZOOM_PCT_MIN, Math.min(ZOOM_PCT_MAX, next));
  return Math.log(held / 100) / Math.log(1.2);
};

/**
 * Back and forward on a guest, across two Electron generations.
 *
 * `webContents.goBack()` moved to `webContents.navigationHistory` and the old
 * names are on their way out; the `<webview>` element in the renderer still has
 * both. Asked in that order rather than assumed, because a shortcut that throws
 * takes the keystroke with it and reads as a browser that ignores Alt+Left.
 */
/** @param {WebContents} guest @param {number} dir */
function guestNav(guest, dir) {
  const back = dir < 0;
  try {
    const h = guest.navigationHistory;
    if (h && typeof h.goBack === "function") {
      // Statements rather than a ternary used as one: a ternary evaluated for
      // its side effects reads as a value somebody forgot to use, which is what
      // the linter says about it too.
      if (back ? h.canGoBack() : h.canGoForward()) { if (back) h.goBack(); else h.goForward(); }
      return;
    }
    if (back ? guest.canGoBack() : guest.canGoForward()) { if (back) guest.goBack(); else guest.goForward(); }
  } catch { /* nothing to go back to */ }
}

/** @param {WebContents} guest @param {number} dir */
function canNav(guest, dir) {
  const back = dir < 0;
  try {
    const h = guest.navigationHistory;
    if (h && typeof h.canGoBack === "function") return back ? h.canGoBack() : h.canGoForward();
    return back ? guest.canGoBack() : guest.canGoForward();
  } catch { return false; }
}

/** @param {AppWindow} win */
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
        applyZoom(input.key === "0" ? 0 : stepZoom(guest.getZoomLevel(), input.key === "-" ? -1 : 1));
        return;
      }
      /*
       * The chords a browser owns, which a bare guest has none of.
       *
       * The note above this handler used to say Ctrl+L, Ctrl+F "and the rest
       * still mean what they mean in a browser" inside the page. They do not:
       * a guest is a page, not a browser — there is no chrome in there to
       * reload it, open a tab or focus an address bar, so every one of these
       * did nothing at all while a page had the focus, which is most of the
       * time somebody is using this view.
       *
       * Two kinds, and they are handled differently on purpose. Reloading and
       * going back are the GUEST's own business: done here, swallowed, and the
       * focus stays on the page — routing them through the renderer would cost
       * a round trip and take the caret off whatever you were doing. A new tab,
       * the address bar and the find strip are the APP's chrome: they go to the
       * renderer by name, and the window is focused first, because all three
       * end with a caret in a box that must be able to receive it.
       */
      const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
      if ((mod && key === "r") || key === "F5") {
        event.preventDefault();
        // Shift is the usual way to ask for it; Ctrl+F5 is the other one, and a
        // browser that only knows one of them is a browser somebody's hands get
        // wrong twice a day.
        if (input.shift || (key === "F5" && mod)) guest.reloadIgnoringCache();
        else guest.reload();
        return;
      }
      if (input.alt && (key === "ArrowLeft" || key === "ArrowRight")) {
        event.preventDefault();
        guestNav(guest, key === "ArrowLeft" ? -1 : 1);
        return;
      }
      // Ctrl+Shift+T: the last tab back, and the one before that. Its own line
      // because every other chord here is shift-less, and this one IS the shift.
      // Ctrl+Shift+S: the screenshot tool, which is a thing the panel draws over
      // the page rather than anything the page itself can do.
      if (mod && input.shift && key === "s") {
        event.preventDefault();
        win.webContents.send("ag:browser-key", "S");
        return;
      }
      if (mod && input.shift && key === "t") {
        event.preventDefault();
        win.webContents.send("ag:browser-key", "T");
        return;
      }
      // `s` and `w` as well. The bar is this app's chrome and Ctrl+S saves
      // nothing here — there is no document — so the chord is free; and closing
      // a tab is a thing the panel does, not the page.
      if (mod && !input.shift && (key === "t" || key === "l" || key === "f" || key === "s" || key === "w")) {
        event.preventDefault();
        // Hiding the bar and closing a tab leave the focus where it was: they
        // are the ones that do not end with a caret in a box of ours.
        if (key !== "s" && key !== "w") win.webContents.focus();
        win.webContents.send("ag:browser-key", key);
        return;
      }
      // `w` used to be here, forwarded as a synthetic key press and landing on
      // whatever happened to have the focus — which is why closing a tab from a
      // page worked or did not depending on where you had last clicked. It goes
      // through the named channel above now, like the rest.
      /* Ctrl+Alt+A is the app's floating bench, and a guest has to let it out.
         A page's keys never reach the renderer, so with a page focused the
         chord did nothing at all — which is the same trap the workspace chords
         were in, and the reason this list exists. Sent back the same way, so
         the renderer decides what it means. */
      const benchChord = mod && input.alt && (input.key || "").toLowerCase() === "a";
      const jumpsOut = (mod && /^[1-9]$/.test(input.key)) || input.key === "Escape" || benchChord;
      if (!jumpsOut) return;
      /*
       * A KEY NO HAND DELIVERED DOES NOT MOVE ANYBODY.
       *
       * `press Escape` is one of the commonest verbs an agent runs, and it
       * arrives here as a real Chromium input event — deliberately, because a
       * KeyboardEvent built in JavaScript is untrusted and pages ignore it. So
       * a synthetic Escape took this branch: it was swallowed by
       * `preventDefault` (the verb never reached the page, which is its whole
       * job), an Escape was injected into the app's own renderer, closing
       * whatever panel the person had open, and then `win.webContents.focus()`
       * raised the window over whatever they were doing.
       *
       * A real keystroke can only arrive at a guest that already has focus, so
       * this costs a person nothing. `sendInputEvent` reaches an unfocused
       * guest, and that is exactly the case that must not take the screen —
       * the browser panel is mounted from launch whether or not anybody has
       * gone to it, so there is always one there to receive it.
       */
      try { if (!guest.isFocused()) return; } catch { /* gone: nobody to move */ }
      event.preventDefault();
      win.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: input.key,
        /* `filter(Boolean)` drops the `false`s at run time; the checker does
           not read it as a narrowing, hence the cast on the result. */
        modifiers: /** @type {("control" | "meta" | "shift" | "alt")[]} */ ([
          input.control && "control", input.meta && "meta",
          input.shift && "shift", input.alt && "alt",
        ].filter(Boolean)),
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
    /** @param {number} level */
    const applyZoom = (level) => {
      const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
      /*
       * The panel applies it, not this process.
       *
       * `guest.setZoomLevel(next)` used to be the line above this one, and it
       * is measured — twice, in web/src/lib/browserDrive.ts — to do nothing to
       * a guest: the level goes in, comes back out, and the page keeps the
       * scale of the window embedding it. So this gesture moved a number and
       * left the page alone.
       *
       * The zoom that works is a device-metrics override on that guest's own
       * DevTools session, and the panel is where the guest is resolved. Send
       * the level and let it; a second resolver in this process is how the
       * capture ended up photographing the wrong tab.
       */
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
      guestFavicons.delete(guest);
      if (browserGuest === guest) browserGuest = [...browserGuests].pop() ?? null;
    });

    /*
     * THE FAVICON URLS CHROMIUM ITSELF DECLARED, and nothing else.
     *
     * A tab strip painting `<img src="https://some-site/favicon.ico">` is six
     * CSP violations a launch, because `img-src` allows self, data:, blob:,
     * loopback and two named hosts — so a favicon from anywhere else is blocked
     * ALWAYS, not just at boot. The icons never appeared; the strip has been
     * drawing the globe fallback and the console has been paying for it.
     *
     * The bytes are fetched in the shell instead and handed back as `data:`,
     * which the policy already allows. Widening `img-src` was the other option
     * and is worse: it would admit every image on the internet to this window
     * to save a fetch that happens once per tab.
     *
     * THE SET IS THE WHOLE SECURITY ARGUMENT. `ag:browserFavicon` will fetch a
     * URL only if it is in here — put there by Chromium reporting the icon of a
     * page the guest had already loaded, never by a caller. That is what keeps
     * this from being the general fetcher `prAsset` refuses to become: there is
     * no argument an agent can pass that reaches the network.
     */
    guest.on("page-favicon-updated", (_e, favicons) => {
      const set = guestFavicons.get(guest) ?? new Set();
      for (const u of favicons || []) {
        if (typeof u === "string" && /^https?:\/\//i.test(u)) set.add(u);
      }
      // Bounded: a page that rewrites its icon in a loop must not grow this
      // without end. Oldest out — the current icon is always the newest.
      while (set.size > FAVICON_URL_CAP) set.delete(set.values().next().value);
      guestFavicons.set(guest, set);
    });

    guest.on("zoom-changed", (_e, direction) => {
      applyZoom(stepZoom(guest.getZoomLevel(), direction === "in" ? 1 : -1));
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
    /*
     * A page asking for a window: sometimes a tab, sometimes a real one.
     *
     * Everything used to become a tab, and for a link that is right — a
     * middle-click or a `target="_blank"` belongs beside the page it came from.
     * For a SIGN-IN it is fatal. Google's, Microsoft's and every SSO flow open
     * a popup and then talk back to it: `window.opener`, `postMessage`, and a
     * handle they hold on to. Denying the open hands the page a null, and what
     * you get is exactly what he saw — six of "[GSI_LOGGER] Failed to open
     * popup window on url… Maybe blocked by the browser?" and two stray tabs
     * called "Login" that could never finish anything.
     *
     * Chromium already tells the two apart: a `window.open` with width and
     * height in its features is `new-popup`, and a link is `foreground-tab`. So
     * a popup gets a real window — same session, so it is signed in as this
     * profile — and everything else still becomes a tab.
     */
    guest.setWindowOpenHandler(({ url, disposition, features }) => {
      const safe = safeGuestUrl(url);
      if (!safe) return { action: "deny" };
      /*
       * READ THIS BEFORE TRUSTING THE PARAGRAPH ABOVE.
       *
       * Turning `// @ts-check` on found that `"new-popup"` is not a value this
       * app can ever be given: Electron 43 types `disposition` as
       * `"default" | "foreground-tab" | "background-tab" | "new-window" |
       * "other"`, and its own documentation lists the same five. Chromium's
       * NEW_POPUP is not passed through under that name. So the first half of
       * this test has never once been true, and every popup that has worked
       * here worked through the "belt and braces" half below.
       *
       * Left exactly as it was rather than quietly changed to `"new-window"`:
       * this decides whether a sign-in gets a real window or becomes a tab, and
       * which of the five dispositions is the right one is a question to answer
       * against a real OAuth flow, not against a type. The comparison is
       * written through `String()` so the checker stops calling it an
       * impossible one while it stands.
       */
      const wantsWindow = String(disposition) === "new-popup"
        // Belt and braces: some flows do not set a disposition Chromium reads
        // as a popup, and ask for a size instead. In practice this is the whole
        // test — see above.
        || /\b(width|height)=/.test(String(features || ""));
      if (!wantsWindow) {
        win.webContents.send("ag:browser-open-tab", safe);
        return { action: "deny" };
      }
      return {
        action: "allow",
        /*
         * SIZE AND NOTHING ELSE.
         *
         * The first version passed webPreferences as well — the same hardening
         * the guest already has, written out again to be explicit. Measured:
         * the popup opened, Google showed the account chooser, and picking one
         * ended in "Cross-Origin-Opener-Policy policy would block the
         * window.postMessage call". Preferences that differ from the opener's
         * put the child in another process, and a child in another process has
         * no opener to answer — which is the entire mechanism a sign-in uses to
         * hand the result back.
         *
         * Inheriting is both safer and correct: the guest was hardened by the
         * guard when it attached (no preload, sandboxed, isolated, its own
         * partition) and the child gets all of it, including the session — which
         * is what makes the login land in the profile it was started from.
         *
         * No `parent` either. A parented window is another difference from what
         * these flows are tested against, and being always-above ours is not
         * worth one more thing that behaves unlike every other browser.
         */
        /* TRUE. A sign-in window that dies because the page underneath it
           navigated is exactly the symptom he described — the verification-code
           page appearing for a moment and vanishing — and the page underneath a
           sign-in navigates as a matter of course, because that is what a
           sign-in does to it. */
        outlivesOpener: true,
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          autoHideMenuBar: true,
          backgroundColor: "#ffffff",
        },
      };
    });

    /*
     * What happened to the sign-in window, written down.
     *
     * A popup that opens, navigates twice and closes leaves nothing behind: the
     * console is the child's, the child is gone, and all anybody can report is
     * "it flashed". Three lines in a file turn that into a sequence — which
     * navigation, and what closed it.
     *
     * Append-only, truncated at a hundred kilobytes, and it only ever writes
     * while a popup exists. Nothing here is on a hot path.
     */
    /*
     * Let a sign-in window talk back to the page that opened it.
     *
     * MEASURED, from the log this same handler writes:
     *
     *   open  accounts.google.com/o/oauth2/v2/auth…
     *   nav   accounts.google.com/v3/signin/accountchooser…
     *   nav   accounts.google.com/signin/oauth/legacy/consent…
     *   nav   accounts.google.com/gsi/transform
     *   console  Cross-Origin-Opener-Policy policy would block the
     *            window.postMessage call.          (twice)
     *   destroyed
     *
     * `gsi/transform` is the last step of Google's flow: the page whose only
     * job is to postMessage the credential to its opener and close. Chromium
     * refused, because a Cross-Origin-Opener-Policy header on the way through
     * had severed the pair — and it severs here and not in Chrome because the
     * opener is a `<webview>` guest, which lives in a browsing context group of
     * its own. That is structural; no flag on our side changes it.
     *
     * So the header is dropped, and ONLY for windows this app opened as popups
     * from a guest. Not for tabs, not for anything else in the session: a page
     * you navigate to keeps every protection it asked for. What is given up is
     * an isolation guarantee for a window whose entire purpose is to talk to
     * its opener — and what is bought is that signing in works at all.
     */
    const session = guest.session;
    if (!coopFreed.has(session)) {
      coopFreed.add(session);
      session.webRequest.onHeadersReceived((details, callback) => {
        const id = details.webContentsId;
        if (id == null || !popupIds.has(id)) { callback({}); return; }
        const headers = details.responseHeaders || {};
        let touched = false;
        for (const name of Object.keys(headers)) {
          const key = name.toLowerCase();
          if (key === "cross-origin-opener-policy" || key === "cross-origin-opener-policy-report-only") {
            delete headers[name];
            touched = true;
          }
        }
        callback(touched ? { responseHeaders: headers } : {});
      });
    }

    guest.on("did-create-window", (child, details) => {
      // Which windows the rule above applies to: the ones this handler made.
      const id = child.webContents.id;
      popupIds.add(id);
      child.webContents.once("destroyed", () => popupIds.delete(id));

      /** @param {string} what @param {unknown} detail */
      const note = (what, detail) => {
        try {
          const line = `${new Date().toISOString()} ${what} ${String(detail || "").slice(0, 300)}\n`;
          const file = path.join(app.getPath("userData"), "browser-popups.log");
          if (fs.existsSync(file) && fs.statSync(file).size > 100_000) fs.writeFileSync(file, "");
          fs.appendFileSync(file, line);
        } catch { /* a log nobody can write is not worth an exception */ }
      };
      note("open", details.url);
      const wc = child.webContents;
      wc.on("did-navigate", (_e, url) => note("nav", url));
      wc.on("did-navigate-in-page", (_e, url) => note("nav-in-page", url));
      wc.on("did-fail-load", (_e, code, desc, url) => note("fail", `${code} ${desc} ${url}`));
      wc.on("console-message", (_e, _lvl, message) => note("console", message));
      wc.on("destroyed", () => note("destroyed", ""));
      child.on("closed", () => note("closed", ""));
    });

    /*
     * The right button did nothing at all.
     *
     * A `<webview>` has no context menu of its own — Chromium's belongs to the
     * browser around the page, and here that browser is us. So this is built
     * from what Chromium reports about the spot that was clicked: a link, an
     * image, a selection, an editable box, and the page itself under all of it.
     *
     * Only what this app can actually do. No "save link as" while there is
     * nowhere for a download to land, no bookmark item while there are no
     * bookmarks — a menu whose entries do nothing is worse than a short one.
     * The two that leave the app are named as leaving it, because opening a
     * page signed in HERE in another browser signed in as somebody else is a
     * surprise worth spelling out.
     */
    guest.on("context-menu", (_e, params) => {
      const items = browserMenuTemplate(params, {
        safeUrl: safeGuestUrl,
        pageUrl: guest.getURL() || "",
        canBack: canNav(guest, -1),
        canForward: canNav(guest, 1),
        on: {
          openTab: (/** @type {string} */ url) => win.webContents.send("ag:browser-open-tab", url),
          copyText: (/** @type {string} */ text) => clipboard.writeText(String(text || "")),
          openExternal: (/** @type {string} */ url) => { void shell.openExternal(url); },
          copyImage: () => { try { guest.copyImageAt(params.x, params.y); } catch { /* gone */ } },
          // The engine is a setting and the setting lives in the renderer, so
          // the TEXT is sent rather than a url built from a second copy of the
          // choice here, which would drift out of step with Settings.
          search: (/** @type {string} */ text) => win.webContents.send("ag:browser-search", text),
          back: () => guestNav(guest, -1),
          forward: () => guestNav(guest, 1),
          reload: () => guest.reload(),
          /* Asked of the PANEL rather than done here: the inspector is a pane
             in the window now, and the panel is what mounts it. It comes back
             through ag:browserDevtools with these coordinates. */
          inspect: () => win.webContents.send("ag:browser-inspect", { x: params.x, y: params.y }),
        },
      });
      // At the pointer, which is where a context menu belongs — unlike the app
      // menu, which is anchored under the button that opens it.
      /* browserMenuTemplate lives in browser-menu.js, which is plain JS with no
         `// @ts-check`: its `type: "separator"` entries infer as `type: string`,
         which is not the union Electron's template takes. The cast is at the
         boundary rather than in that file so the menu stays testable there. */
      Menu.buildFromTemplate(/** @type {import("electron").MenuItemConstructorOptions[]} */ (items)).popup({ window: win });
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
  /* `undefined` rather than `null` as the empty value, so the type is the one
     setTimeout hands back and clearTimeout takes. Both are a no-op on nothing;
     only the checker can tell them apart. */
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let saveTimer;
  const remember = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(win), 400);
  };
  /* Listed rather than looped, for the reason spelled out beside the winState
     subscriptions above — and because a `for (const ev of [...])` gives tsc a
     `string` where each `on()` overload wants its own literal. */
  win.on("resize", remember);
  win.on("move", remember);
  win.on("maximize", remember);
  win.on("unmaximize", remember);
  win.on("enter-full-screen", remember);
  win.on("leave-full-screen", remember);
  /* The one transition worth a line of its own. `resize` fires continuously
     during a drag and would drown the file; leaving maximised happens once. */
  win.on("unmaximize", () => noteWindow("unmaximize", win));
  win.on("leave-full-screen", () => noteWindow("leave-full-screen", win));
  /*
   * And what the relaunch made of the saved state.
   *
   * Every install of this app kills the running one and reopens it, so a window
   * that "changed on its own" may simply be a new window that came back
   * differently. `maximize()` above runs before the window is shown, and a
   * window manager is free to ignore it that early — measured here rather than
   * assumed, and re-asserted once if it did not take.
   */
  win.once("ready-to-show", () => {
    noteWindow(`opened wanted-max=${st.max === true}`, win);
    if (st.max && !win.isMaximized() && !win.isFullScreen()) {
      askedAt = Date.now();
      win.maximize();
      noteWindow("re-maximised after open", win);
    }
  });
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
/** @param {AppWindow} win */
function keepUsefulShortcuts(win) {
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    const ctrl = input.control || input.meta;
    /* Chords only — never a plain key. See noteWindow for why this is here at
       all and why it stops at the modifiers plus a key name. */
    if (ctrl || input.alt) lastChord = { at: Date.now(), key: String(input.key).slice(0, 12), ctrl, shift: input.shift, alt: input.alt };
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

/** @param {AppWindow} win */
function openLinksOutside(win) {
  /** @param {string} url */
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
  /* Asked at CALL time, not captured at load like the line above: the renderer
     needs this exactly when it does not yet know, and a page that came up
     before the sidecar would freeze a false forever and go back to asking the
     network — the /health this exists to remove. */
  ipcMain.on("ag:sidecarUp", (e) => { e.returnValue = sidecarUp === true; });
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
  /* Never fatal. A window that keeps the machine awake is a convenience; a
     window that does not open is not one. */
  try { power.init({ configDir: CONFIG_DIR, apiOrigin: () => apiOrigin, token: currentToken }); }
  catch (e) { console.error("[power] not started:", e instanceof Error ? e.message : e); }
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
  try { power.shutdown(); } catch { /* nothing held */ }
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

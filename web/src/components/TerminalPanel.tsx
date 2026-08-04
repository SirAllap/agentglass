// In-browser terminal — a REAL machine terminal (xterm.js ⇄ WebSocket ⇄ PTY).
// The server spawns your login shell inside a pseudo-terminal per repo/worktree,
// so everything a local terminal does works here: job control, Ctrl+C/Ctrl+R,
// tab-completion, colors, vim/htop/lazygit. Shell sessions are kept alive in a
// module-level store, so closing the panel (or switching repos) never kills a
// running job — reopening reattaches to the live session, scrollback intact.
import { Fragment, useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { subscribeTermReview, termReview, clearTermReview } from "../lib/termReview.ts";
import { subscribeTermIssue, termIssue, clearTermIssue } from "../lib/termIssue.ts";
import { useDismiss } from "../lib/useDismiss.ts";
import { keepTermFocus } from "../lib/keepFocus.ts";
import { viewHeaderClass, viewHeaderStyle, viewTitleClass } from "./workspace/ViewHeader.tsx";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { answerDecrqm } from "../lib/xtermDecrqm.ts";
import { openExternal } from "../lib/externalUrl.ts";
import type { GitRepoRef, GitBranch, TerminalCommands, TmuxWindow } from "../../../shared/types.ts";
import { api, IS_DEMO, ptyWsUrl, hasToken, probeAuth, reauthPrompt } from "../lib/api.ts";
import { CommandBar, loadCommands } from "./CommandBar.tsx";
import { SCROLLBAR_CSS } from "./ChangesModal.tsx";
import { wantsWebgl, fallBackToDom } from "../lib/termRenderer.ts";
import { isFindChord } from "../lib/termKeys.ts";
import { typingWouldLandInApp } from "../lib/termForeground.ts";
import { THEMES } from "../lib/themes.ts";
import { deriveAnsi } from "../lib/termPalette.ts";
import { termOptions } from "../lib/termPrefs.ts";

const ROOT_KEY = "agentglass.terminalRoot";
/** The repo the terminal view last used — what a docked console should open
 *  in, so the console and the terminal are the same shell in the same place. */
export function lastTerminalRoot(): string {
  try { return localStorage.getItem(ROOT_KEY) || ""; } catch { return ""; }
}

/** Marks the one shell per repo that belongs to a docked console strip. */
const CONSOLE_TITLE = "console";

/**
 * Where the docked console is pointed, remembered separately from the terminal
 * view's own repo.
 *
 * They are not the same question. The view is "where am I working"; the console
 * under Docker's logs is "which checkout do I want to run migrations in", and
 * on a machine with a worktree per ticket those are routinely different
 * directories. Sharing one key made picking a repo in the console silently move
 * the terminal view too.
 */
const CONSOLE_ROOT_KEY = "agentglass.consoleRoot";
export function consoleRoot(): string {
  try { return localStorage.getItem(CONSOLE_ROOT_KEY) || lastTerminalRoot(); } catch { return lastTerminalRoot(); }
}

/** Status dot, for anywhere that shows a shell's state. TermView builds a
 *  richer one that names the shell; this is the shared minimum. */
const SESS_DOT: Record<SessStatus, { color: string; label: string }> = {
  idle: { color: "var(--text2)", label: "Idle" },
  connecting: { color: "var(--warning)", label: "Connecting…" },
  live: { color: "var(--success, #98c379)", label: "Live" },
  exited: { color: "var(--text2)", label: "Exited" },
  error: { color: "var(--error)", label: "Disconnected" },
  unauthorized: { color: "var(--error)", label: "Unauthorized ⚿" },
};
const repoName = (p: string) => p.split("/").pop() || p;

// xterm draws in its own DOM — resolve theme vars to concrete colors for it.
const rootStyle = () => getComputedStyle(document.documentElement); // one style-recalc per read batch
const readVar = (s: CSSStyleDeclaration, name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
const alpha = (hex: string, a: string) => (/^#[0-9a-fA-F]{6}$/.test(hex) ? hex + a : hex);
/** Exported so a one-off terminal — the file peek — paints in the same colours
 *  as the panel, rather than deriving a second palette that drifts from it. */
export function themeFromCss() {
  const s = rootStyle();
  const bg = readVar(s, "--bg", "#0d1117");
  // The 16 ANSI colours: a theme's pinned palette when it has one, otherwise
  // derived from the same UI colours the rest of the panel already follows — so
  // switching theme repaints the terminal's own output too, not just its frame.
  const id = document.documentElement.getAttribute("data-theme") || "";
  const ansi = THEMES.find((t) => t.id === id)?.ansi ?? deriveAnsi({
    bg,
    text: readVar(s, "--text", "#e6edf3"),
    primary: readVar(s, "--primary", "#a78bfa"),
    error: readVar(s, "--error", "#f06c75"),
    success: readVar(s, "--success", "#98c379"),
    warning: readVar(s, "--warning", "#e5c07b"),
    info: readVar(s, "--info", "#61afef"),
  });
  return {
    background: bg,
    // The terminal's default text is the theme's PRIMARY text, not the dimmer
    // secondary — uncoloured output should read as bright/white (like a proper
    // editor surface), not the washed-out grey that --text2 gave it.
    foreground: readVar(s, "--text", "#e6edf3"),
    cursor: readVar(s, "--primary", "#a78bfa"),
    cursorAccent: bg,
    selectionBackground: alpha(readVar(s, "--primary", "#a78bfa"), "44"),
    ...ansi,
  };
}
/* Same order as the rest of the app, so the terminal and the panel around it
   are not set in two different faces. The Nerd Font stays in the list — behind
   the stock monospaces rather than in front of them — because prompts and agent
   CLIs print powerline and icon codepoints no stock monospace carries, and
   per-glyph fallback picks it up for exactly those and nothing else. */
const TERM_FONT = '"SF Mono", SFMono-Regular, ui-monospace, "Cascadia Code", Menlo, Monaco, Consolas, "Liberation Mono", "JetBrainsMono Nerd Font Mono", monospace';


// --- persistent per-repo shell sessions (outlive the panel) ------------------
type SessStatus = "idle" | "connecting" | "live" | "exited" | "error" | "unauthorized";
type Sess = {
  id: string;             // many shells can share a repo, so the id is the key
  root: string;
  title: string;
  term: Terminal;
  fit: FitAddon;
  /** Per shell, because a match is a position in *this* scrollback: the find
   *  bar in the header drives whichever pane has the focus. */
  search: SearchAddon;
  holder: HTMLDivElement; // xterm's home element — reparented into the panel
  ws: WebSocket | null;
  status: SessStatus;
  mode: "pty" | "pipe" | null;
  shell: string;
  canResize: boolean;
  opened: boolean;
  /** A tmux client is running in this shell — the panel hides its own tabs and
   *  split while that's true, since tmux owns those. */
  tmux: boolean;
  /** tmux's own windows, as tmux reports them. The panel draws these as tabs so
   *  the strip belongs to the app rather than to whatever .tmux.conf this
   *  machine carries; tmux still decides what is in it and which is active. */
  tmuxWindows: TmuxWindow[];
  /** The session those windows belong to, for the status-line toggle. */
  tmuxSession: string | null;
  /** The keys tmux treats as its prefix, as tmux spells them ("C-f"). */
  tmuxPrefix: string[];
  /** When one of them was last pressed. The status line most configs draw
   *  flashes to say "tmux is listening"; hiding it for our tabs took that away,
   *  so the strip says it instead. */
  tmuxPrefixAt: number;
  pending: string[]; // input queued while (re)connecting — flushed on ready
  createdAt: number;
  lastUsed: number;
  retries: number;        // consecutive failed reconnects
  retryTimer: number | null;
  subs: Set<() => void>;
};
/** How long the "listening" mark stays up with no second key. tmux itself waits
 *  indefinitely, but a mark that never clears is a mark nobody reads. */
const PREFIX_MS = 2000;

/**
 * The byte a terminal sends for a key spelled the way tmux spells it.
 *
 * Only the two forms a prefix is ever bound to: `C-x` (the control byte) and
 * `M-x` (escape then the key). Anything else returns null and simply never
 * matches, which is the right failure — a missing indicator, not a wrong one.
 */
function keyByte(k: string): string | null {
  const m = /^([CM])-(.)$/.exec(k);
  if (!m) return null;
  const [, mod, ch] = m;
  if (mod === "C") {
    const code = ch!.toUpperCase().charCodeAt(0);
    return code >= 64 && code <= 95 ? String.fromCharCode(code & 0x1f) : null;
  }
  return "\u001b" + ch;
}

/**
 * A tmux key spelling, written the way a keyboard hint is usually written.
 *
 * `C-b` is how tmux says it and `^b` is how every cheat sheet says it. Anything
 * that is not a control key is left alone: `M-a` is already the way people
 * write that one, and inventing a notation for the rest would be worse than
 * repeating tmux's.
 */
const keyLabel = (k: string) => (/^C-.$/.test(k) ? `^${k.slice(2).toLowerCase()}` : k);

const sessions = new Map<string, Sess>();
let seq = 0;
/** Shells for one repo, in creation order. */
const sessionsFor = (root: string) => [...sessions.values()].filter((s) => s.root === root).sort((a, b) => a.createdAt - b.createdAt);
/** Shells the Terminal *view* owns: every one for a repo except the shell tagged
 *  for the docked console strip. That shell's xterm holder lives in the strip;
 *  a single holder can only be in one slot, so listing it here too would have the
 *  view mount it as a tab/pane and steal it — the console going blank the moment
 *  you open the terminal. The console strip keeps using sessionsFor to find it. */
const termSessionsFor = (root: string) => sessionsFor(root).filter((s) => s.title !== CONSOLE_TITLE);
const notify = (s: Sess) => { s.subs.forEach((fn) => fn()); rosterChanged(); };

// --- roster: "is any shell alive?", for the workspace rail ---------------------
// Per-session `subs` answer "did *this* shell change"; nothing could answer
// "is anything running at all" without holding a session. The rail needs
// exactly that, and needs it while the terminal view is hidden.
const rosterSubs = new Set<() => void>();
export function subscribeSessions(fn: () => void) {
  rosterSubs.add(fn);
  return () => { rosterSubs.delete(fn); };
}
let liveCount = 0;
function recount() {
  let n = 0;
  for (const s of sessions.values()) if (s.status === "live" || s.status === "connecting") n++;
  liveCount = n;
}
/** Cached so useSyncExternalStore sees a stable value between real changes —
 *  recomputing per call would hand React a new number and loop. */
export function liveSessionCount() { return liveCount; }
const rosterChanged = () => { const before = liveCount; recount(); if (before !== liveCount) rosterSubs.forEach((fn) => fn()); };
// Set by the mounted panel so the terminal itself can close it (Shift+Esc).
let panelClose: () => void = () => {};

/**
 * Open the find bar, when there is one to open.
 *
 * Set by the terminal view while it is mounted, the same way `panelClose` is.
 * It stays a no-op returning false everywhere else — a shell in the docked
 * console strip has no find bar in front of it, and swallowing the key there
 * would take a chord away from the program running in it and give nothing back.
 */
let panelFind: () => boolean = () => false;

/**
 * Tell the docked console that a command aimed at it was refused.
 *
 * `runInConsole` is called from other panels — the Docker one opens a shell
 * into a container this way — and those callers have nowhere to put the news.
 * The strip is where the shell is, so the strip is where the notice belongs.
 * A no-op while no strip is mounted, in which case the boolean return is the
 * only answer and the caller may ignore it.
 */
let consoleBlocked: (cmd: string) => void = () => {};

// The panel is built to keep many shells open at once, so eviction is a last
// resort rather than routine: it only runs at the server's own ceiling, and it
// never touches a shell that is still connected — closing a live job to make
// room for a new tab would lose work the user can't see.
const MAX_CLIENT_SESSIONS = 60;
function evictLru(exceptRoot: string) {
  if (sessions.size < MAX_CLIENT_SESSIONS) return;
  let lru: Sess | null = null;
  for (const s of sessions.values()) {
    if (s.root === exceptRoot || s.status === "live" || s.status === "connecting") continue;
    if (!lru || s.lastUsed < lru.lastUsed) lru = s;
  }
  if (!lru) return;
  const ws = lru.ws;
  lru.ws = null; // detach first so its handlers see a stale socket and stay quiet
  // An evicted session must not resurrect itself from a pending retry.
  if (lru.retryTimer) { clearTimeout(lru.retryTimer); lru.retryTimer = null; }
  try { ws?.close(); } catch { /* already gone */ }
  try { lru.term.dispose(); } catch { /* already disposed */ }
  lru.holder.remove();
  sessions.delete(lru.id);
  rosterChanged();
}

/**
 * Keep a terminal's colours in step with the app's theme, while it's open.
 *
 * xterm takes a theme as a snapshot of concrete colours — it can't read a CSS
 * variable. The theme was therefore only ever sampled when the session was
 * created and when the panel was reopened, so switching theme with the terminal
 * on screen left it painted in the old palette. The visible symptom is a strip
 * down the right where the container (which follows `var(--bg)` live) no longer
 * matches the terminal's own background — which reads as a layout bug rather
 * than a stale colour.
 *
 * Watched at the root element, because that's where the theme toggle writes:
 * both the `data-theme` attribute and the inline custom properties land there.
 */
function applyThemeLive(s: Sess): () => void {
  if (typeof MutationObserver === "undefined") return () => {};
  let raf = 0;
  const restyle = () => {
    // Coalesced: a theme switch rewrites several properties in one tick, and
    // re-theming a terminal forces a full repaint of every cell.
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      try {
        s.term.options.theme = themeFromCss();
        // Terminal typography rides the same observer (termPrefs pings a root
        // var when font/size/cursor change). Font and size change the cell box,
        // so refit when either moves.
        const o = termOptions();
        const needFit = s.term.options.fontFamily !== o.fontFamily || s.term.options.fontSize !== o.fontSize;
        if (s.term.options.fontFamily !== o.fontFamily) s.term.options.fontFamily = o.fontFamily;
        if (s.term.options.fontSize !== o.fontSize) s.term.options.fontSize = o.fontSize;
        if (s.term.options.cursorStyle !== o.cursorStyle) s.term.options.cursorStyle = o.cursorStyle;
        if (needFit) fitTerm(s);
        // The WebGL renderer caches cells in a texture atlas and won't always
        // repaint already-drawn scrollback on a theme swap; force it. On the DOM
        // renderer this is a cheap no-op beyond the redraw it would do anyway.
        s.term.refresh(0, s.term.rows - 1);
      } catch { /* disposed */ }
    });
  };
  const mo = new MutationObserver(restyle);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  mq?.addEventListener?.("change", restyle);
  return () => { cancelAnimationFrame(raf); mo.disconnect(); mq?.removeEventListener?.("change", restyle); };
}

function connect(s: Sess) {
  if (s.ws || IS_DEMO) return;
  s.status = "connecting";
  notify(s);
  const ws = new WebSocket(ptyWsUrl(s.root, s.term.cols, s.term.rows));
  ws.binaryType = "arraybuffer";
  s.ws = ws;
  ws.onmessage = (ev) => {
    if (s.ws !== ws) return; // a stale socket (replaced by ⟲ new shell) must not touch the session
    if (typeof ev.data !== "string") { s.term.write(new Uint8Array(ev.data as ArrayBuffer)); return; }
    let f: { t?: string; mode?: "pty" | "pipe"; shell?: string; resize?: boolean; code?: number; error?: string; active?: boolean; windows?: TmuxWindow[]; session?: string | null; prefix?: string[] };
    try { f = JSON.parse(ev.data); } catch { return; }
    if (f.t === "ready") {
      reconnected(s);
      s.status = "live"; s.mode = f.mode ?? null; s.shell = f.shell || "shell"; s.canResize = f.resize !== false;
      // Names the cure, not only the symptom: this mode is what a host with no
      // python3 gets, and "TUI apps won't render" alone left people believing
      // the terminal itself was broken.
      if (f.mode === "pipe") s.term.writeln("\x1b[2m(no pty on this host: plain-pipe shell, full-screen programs won't render. Install python3 and reopen; Settings ▸ Requirements has the details.)\x1b[0m");
      for (const d of s.pending.splice(0)) ws.send(JSON.stringify({ t: "in", d }));
      // the fit that ran while connecting may not have reached the server
      ws.send(JSON.stringify({ t: "resize", cols: s.term.cols, rows: s.term.rows }));
      notify(s);
    } else if (f.t === "tmux") {
      // tmux brings its own tabs, splits and status line. The panel's split and
      // its own shell tabs stand down while it runs, since two pane models is
      // how you get a split inside a split you didn't ask for. The *window*
      // list is different: we draw that one ourselves, from what tmux reports,
      // so it stops being the one strip of the workspace styled by a config
      // file the app has never seen.
      s.tmux = f.active === true;
      s.tmuxWindows = Array.isArray(f.windows) ? f.windows : [];
      s.tmuxSession = typeof f.session === "string" ? f.session : null;
      s.tmuxPrefix = Array.isArray(f.prefix) ? f.prefix : [];
      notify(s);
    } else if (f.t === "exit" || f.t === "fatal") {
      s.status = f.t === "exit" ? "exited" : "error";
      if (f.t === "exit") s.term.write(`\r\n\x1b[2m— shell exited (${f.code ?? "?"}) · press Enter for a new one —\x1b[0m\r\n`);
      else s.term.writeln(`\r\n\x1b[31m${f.error || "terminal error"}\x1b[0m`);
      s.ws = null; // detach now so Enter can reconnect without waiting for onclose
      try { ws.close(); } catch { /* server closes it anyway */ }
      notify(s);
    }
  };
  ws.onclose = () => {
    if (s.ws !== ws) return; // stale socket — the session already moved on
    const wasLive = s.status === "live";
    s.ws = null;
    if (s.status === "connecting" || s.status === "live") {
      s.status = "error";
      notify(s);
      // The server is on this machine, so a drop is nearly always something
      // restarting rather than a real outage — the shell itself survives it.
      // Making the user press Enter to come back is asking them to do the
      // computer's job; retry on our own and say so, with the manual path
      // still there if the retries give up.
      maybeReconnect(s, wasLive);
    }
  };
}

/** Reconnect delay, backing off so a server that's down for a while isn't
 *  hammered, but a quick restart is picked up almost immediately. */
const RETRY_MS = [400, 800, 1500, 3000, 5000, 8000];
// Stop after ~2 minutes of failed reconnects (the backoff tops out at 8s). Left
// unbounded, a wrong/rotated token — which rejects every upgrade with a 401 a
// browser WS can't read — printed a reconnect dot forever (~450/hour).
const MAX_RETRIES = 15;

/** Decide whether to keep reconnecting after a socket dropped. A close before
 *  the shell ever went live, on a token-protected server, is almost always the
 *  401 that rejects the WS upgrade — unreadable off a browser WebSocket — so we
 *  probe an authenticated endpoint to tell an auth wall from a plain outage and
 *  stop retrying (with a way back) instead of spinning forever. */
async function maybeReconnect(s: Sess, wasLive: boolean) {
  if (!wasLive && hasToken()) {
    const state = await probeAuth();
    if (s.ws) return; // a manual reconnect (Enter / ⟲) beat us to it
    if (state === "unauthorized") {
      if (s.retryTimer) { clearTimeout(s.retryTimer); s.retryTimer = null; }
      s.retries = 0;
      s.status = "unauthorized";
      s.term.write("\r\n\x1b[31m— unauthorized: this server needs an access token —\x1b[0m\r\n\x1b[2m  reopen the dashboard with ?token=… (or click the ⚿ status) to re-enter it\x1b[0m\r\n");
      notify(s);
      return;
    }
  }
  scheduleReconnect(s);
}

function scheduleReconnect(s: Sess) {
  if (s.retryTimer) return;
  if (s.retries >= MAX_RETRIES) {
    s.status = "error";
    s.term.write("\r\n\x1b[2m— still no server after many tries · press Enter to retry —\x1b[0m\r\n");
    notify(s);
    return;
  }
  const wait = RETRY_MS[Math.min(s.retries, RETRY_MS.length - 1)];
  s.retries++;
  if (s.retries === 1) s.term.write("\r\n\x1b[2m— disconnected · reconnecting…\x1b[0m");
  else s.term.write("\x1b[2m.\x1b[0m");
  s.retryTimer = setTimeout(() => {
    s.retryTimer = null;
    if (s.ws) return; // something else already reconnected it
    connect(s);
  }, wait) as unknown as number;
}

/** Called once a socket reports ready: the connection is good again. */
function reconnected(s: Sess) {
  if (s.retries) s.term.write("\r\n\x1b[2m— reconnected —\x1b[0m\r\n");
  s.retries = 0;
  if (s.retryTimer) { clearTimeout(s.retryTimer); s.retryTimer = null; }
}

/** A brand-new shell for `root`. Repos hold as many as you open. */
function createSession(root: string): Sess {
  evictLru(root);
  const tp = termOptions();
  const term = new Terminal({
    fontFamily: tp.fontFamily,
    fontSize: tp.fontSize,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: tp.cursorStyle,
    /*
     * Scrollback, and why it is not ten thousand any more.
     *
     * xterm keeps every line as cell data, so a wide window at 10k lines is
     * tens of megabytes per shell — and this app holds several open at once,
     * deliberately, so a build in one keeps running while you work in another.
     * It is also what a resize has to reflow: every line, on every fit, which
     * is the multi-second freeze people report when dragging a pane.
     *
     * Four thousand lines is still more than a screenful of build output by two
     * orders of magnitude, and it is what the scroll bar can realistically be
     * dragged through.
     */
    scrollback: 4_000,
    theme: themeFromCss(),
    macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const search = new SearchAddon();
  term.loadAddon(search);
  /*
   * URLs in output become clickable, and open where the user's links open.
   *
   * `openExternal` rather than the addon's default handler: it is the one path
   * the whole app already uses, which the desktop shell intercepts
   * (`setWindowOpenHandler` in electron/main.js) to hand the URL to the OS
   * browser instead of opening a chromeless window inside the app. It also
   * refuses anything that is not http(s), which matters more here than
   * anywhere else — the text being linkified is whatever a program printed.
   */
  // Same guard as the file viewer. A shell here usually has tmux in front of
  // it, which answers DECRQM itself — but a bare shell running `nvim` does not,
  // and then xterm 6.0.0 throws inside its own parser and the screen stops
  // updating. See xtermDecrqm.
  answerDecrqm(term as never);
  term.loadAddon(new WebLinksAddon((_e, uri) => { openExternal(uri); }));
  /*
   * Draw on the GPU when the machine will let us.
   *
   * xterm's default renderer builds DOM for every cell, which is the single
   * biggest source of multi-second stalls when a shell is producing output
   * quickly — a build log or `cat` on anything large. The WebGL renderer draws
   * the same cells as textured quads and does not care how fast they arrive.
   *
   * Guarded twice, because a GPU is not a promise. The constructor throws where
   * there is no WebGL2 context at all (a software-rendered session, a remote
   * desktop, `--disable-gpu`), and a context can be lost *later* — a driver
   * reset, the compositor reclaiming memory, waking from suspend. Both paths
   * fall back to the DOM renderer, which is slower and always works; a terminal
   * that renders slowly is a terminal, a terminal that renders nothing is a
   * bug report. Neither case is worth a message: the shell keeps running and
   * the user has nothing to decide.
   */
  if (wantsWebgl()) {
    try {
      const gl = new WebglAddon();
      // A lost context can leave the terminal blank-white with no repaint. Drop
      // to the DOM renderer app-wide and remember it, so no new shell hits it.
      gl.onContextLoss(() => { fallBackToDom(); try { gl.dispose(); } catch { /* already gone */ } });
      term.loadAddon(gl);
    } catch { /* no WebGL2 here — the DOM renderer stays */ }
  }
  // Shift+Esc closes the panel — plain Esc belongs to the shell (vim, fzf…).
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    if (e.key === "Escape" && e.shiftKey) { panelClose(); return false; }
    if (isFindChord(e) && panelFind()) return false;
    return true;
  });
  // Copy on select, the tmux way: the instant a selection is made it is on the
  // clipboard — no Ctrl+Shift+C, no right-click menu (a terminal has none), no
  // fighting the shell over Ctrl+C. A cleared selection (a plain click) returns
  // "" and is skipped, so clicking away never wipes what you just copied. Writes
  // may fail mid-drag if the document is momentarily unfocused; the settled
  // selection on mouse-up lands, and the failures are silent.
  term.onSelectionChange(() => {
    const sel = term.getSelection();
    if (sel) navigator.clipboard?.writeText(sel).catch(() => { /* no clipboard permission */ });
  });
  const holder = document.createElement("div");
  // Opaque themed backing, so any frame where the renderer paints nothing (a
  // WebGL context loss, a swap to the DOM renderer) shows the terminal's own
  // background colour instead of a white flash.
  holder.style.cssText = "width:100%;height:100%;background:var(--bg)";
  const id = `t${++seq}-${Date.now().toString(36)}`;
  const sess: Sess = { id, root, title: `shell ${sessionsFor(root).length + 1}`, term, fit, search, holder, ws: null, status: "idle", mode: null, shell: "shell", canResize: true, opened: false, tmux: false, tmuxWindows: [], tmuxSession: null, tmuxPrefix: [], tmuxPrefixAt: 0, pending: [], createdAt: Date.now(), lastUsed: Date.now(), retries: 0, retryTimer: null, subs: new Set() };
  term.onData((d) => {
    sess.lastUsed = Date.now();
    /*
     * "tmux is listening."
     *
     * Read off the keystroke on its way past rather than asked of tmux,
     * because this has to land on the same frame as the keypress: a poll, at
     * any interval anyone would accept, answers after the moment it is meant
     * to describe. tmux is told which key it is (see prefixKeys), so a rebound
     * prefix — and anyone who rebinds it is exactly who notices this missing —
     * lights up the same as the default.
     *
     * A best-effort mirror of tmux's own state, not a model of it: the byte is
     * also the prefix when it is being sent *through* to a nested tmux or to
     * an application that wants it. Wrong in that case for two seconds, and it
     * never touches what the shell receives.
     */
    if (sess.tmux && d.length === 1 && sess.tmuxPrefix.some((k) => keyByte(k) === d)) {
      sess.tmuxPrefixAt = Date.now();
      notify(sess);
      setTimeout(() => { if (Date.now() - sess.tmuxPrefixAt >= PREFIX_MS) notify(sess); }, PREFIX_MS + 50);
    } else if (sess.tmuxPrefixAt) {
      // The next key is the one the prefix was for: tmux has stopped waiting.
      sess.tmuxPrefixAt = 0;
      notify(sess);
    }
    if (sess.status === "live" && sess.ws?.readyState === WebSocket.OPEN) sess.ws.send(JSON.stringify({ t: "in", d }));
    else if (sess.status === "connecting") sess.pending.push(d); // don't drop keys typed before the shell is up
    else if (sess.status === "unauthorized" && d.includes("\r")) reauthPrompt(); // Enter → re-enter the token
    else if ((sess.status === "exited" || sess.status === "error") && d.includes("\r")) { sess.retries = 0; connect(sess); } // Enter → new shell, scrollback kept
  });
  term.onResize(({ cols, rows }) => {
    if (sess.ws?.readyState === WebSocket.OPEN) sess.ws.send(JSON.stringify({ t: "resize", cols, rows }));
  });
  sessions.set(id, sess);
  return sess;
}

/** xterm's private handle on its renderer. The exact CSS cell size lives only
 *  in there — FitAddon reads the very same field. */
type TermCore = {
  _core?: {
    _renderService?: {
      dimensions?: { css?: { cell?: { width: number; height: number } } };
      clear?: () => void;
    };
  };
};

/**
 * Size a terminal to its slot. Ours, not `FitAddon.fit()`.
 *
 * The addon subtracts a flat 14px from the width whenever scrollback is on —
 * `options.overviewRuler?.width || 14`. That is a constant, not a measurement
 * of anything, so hiding the scrollbar in CSS cannot win it back, and asking
 * for `{ width: 0 }` lands on 14 again because 0 is falsy. At this font size
 * it costs two whole columns, and they show up as a dead strip down the right
 * of anything that draws edge to edge: nano's title bar, vim's status line,
 * tmux's border. Nothing is reserved here — the viewport's scrollbar is an
 * overlay (see the style block below) and takes no layout width.
 */
function fitTerm(s: Sess) {
  const el = s.term.element;
  const parent = el?.parentElement;
  const core = (s.term as unknown as TermCore)._core;
  const cell = core?._renderService?.dimensions?.css?.cell;
  // Before the first render there is no cell size to divide by; the addon has
  // its own guards for that, so let it decide there's nothing to do yet.
  if (!el || !parent || !cell?.width || !cell?.height) { s.fit.fit(); return; }
  const box = getComputedStyle(parent);   // computed width/height are content-box px
  const own = getComputedStyle(el);
  const px = (v: string) => parseFloat(v) || 0;
  const w = px(box.width) - px(own.paddingLeft) - px(own.paddingRight);
  const h = px(box.height) - px(own.paddingTop) - px(own.paddingBottom);
  const cols = Math.max(2, Math.floor(w / cell.width));
  const rows = Math.max(1, Math.floor(h / cell.height));
  if (cols === s.term.cols && rows === s.term.rows) return;
  core?._renderService?.clear?.(); // as the addon does — drop the old grid before reflowing
  s.term.resize(cols, rows);
}

/** Close a shell and drop it: its socket, its terminal and its pending retry. */
function killSession(s: Sess) {
  if (s.retryTimer) { clearTimeout(s.retryTimer); s.retryTimer = null; }
  const ws = s.ws;
  s.ws = null; // detach first so the close handler stays quiet
  try { ws?.close(); } catch { /* already gone */ }
  try { s.term.dispose(); } catch { /* already disposed */ }
  s.holder.remove();
  sessions.delete(s.id);
  rosterChanged();
}

/**
 * Find in scrollback, for whichever pane has the focus.
 *
 * Lives in the header rather than floating over the terminal: the shell below
 * is a fixed grid of cells, and an overlay would cover output while you are
 * reading it looking for the very thing you searched for.
 *
 * The highlight colours are the app's own tokens rather than xterm's defaults,
 * which are a fixed yellow that disappears on the light themes.
 */
function FindBar({ sess, onClose }: { sess: Sess | undefined; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState<{ index: number; count: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  // `onDidChangeResults` is the only honest source for "3 of 17": the addon
  // counts as it walks the buffer, and a running shell keeps adding to it.
  useEffect(() => {
    if (!sess) return;
    const sub = sess.search.onDidChangeResults((r) => setAt(r ? { index: r.resultIndex + 1, count: r.resultCount } : null));
    return () => { sub.dispose(); };
  }, [sess]);

  const opts = {
    decorations: {
      matchBackground: "#00000000",
      matchOverviewRuler: readVar(rootStyle(), "--warning", "#fbbf24"),
      activeMatchBackground: readVar(rootStyle(), "--primary", "#a78bfa"),
      activeMatchColorOverviewRuler: readVar(rootStyle(), "--primary", "#a78bfa"),
      matchBorder: readVar(rootStyle(), "--warning", "#fbbf24"),
    },
  };

  const step = (back: boolean) => {
    if (!sess || !q) return;
    if (back) sess.search.findPrevious(q, opts); else sess.search.findNext(q, opts);
  };

  // Clearing the term clears the highlights with it — leaving them on screen
  // after the box is empty is the kind of stale state nobody can dismiss.
  const change = (v: string) => {
    setQ(v);
    if (!sess) return;
    if (!v) { sess.search.clearDecorations(); setAt(null); return; }
    sess.search.findNext(v, { ...opts, incremental: true });
  };

  const close = () => { try { sess?.search.clearDecorations(); } catch { /* disposed */ } onClose(); };

  return (
    <div className="flex items-center gap-1" onMouseDown={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey); }
          if (e.key === "Escape") { e.preventDefault(); close(); }
        }}
        placeholder="Find in scrollback…"
        aria-label="Find in scrollback"
        className="px-2 py-1 rounded-md text-[11px] outline-none"
        style={{ width: 190, background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text)" }}
      />
      <span className="text-[10px] tabular-nums t-dim2" style={{ minWidth: 46 }}>
        {q ? (at?.count ? `${at.index}/${at.count}` : "none") : ""}
      </span>
      <button onClick={() => step(true)} disabled={!q} title="Previous match (Shift+Enter)" className="text-[11px] px-1.5 py-1 rounded-lg" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>↑</button>
      <button onClick={() => step(false)} disabled={!q} title="Next match (Enter)" className="text-[11px] px-1.5 py-1 rounded-lg" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>↓</button>
      <button onClick={close} title="Close find (Esc)" className="text-[11px] px-1.5 py-1 rounded-lg" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>✕</button>
    </div>
  );
}

/**
 * "That did not go anywhere, and here is what to do about it."
 *
 * Shown when a command was refused because a full-screen program had the
 * screen. Silence would be worse than the old behaviour: a chip that does
 * nothing reads as broken, where a chip that types into vim at least tells you
 * what happened, eventually, badly.
 */
function BlockedNotice({ cmd, onSend, onDismiss }: { cmd: string; onSend: () => void; onDismiss: () => void }) {
  return (
    <div className="flex items-center gap-2 text-[10.5px] px-2 py-1 rounded-lg min-w-0"
      style={{ color: "var(--text2)", background: "color-mix(in srgb, var(--warning) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--warning) 35%, transparent)" }}>
      <span className="truncate" title={`Not sent: ${cmd}`}>
        A full-screen program is running — <b className="font-mono">{cmd}</b> was not typed
      </span>
      <button onClick={onSend} className="shrink-0 px-1.5 py-0.5 rounded" style={{ color: "var(--text)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>Send anyway</button>
      <button onClick={onDismiss} className="shrink-0 px-1 t-dim2" aria-label="Dismiss">✕</button>
    </div>
  );
}

/**
 * Type a command into the repo's shell (starting one if needed).
 *
 * Returns false without typing anything when a full-screen program has the
 * screen — vim, htop, lazygit — because the keystrokes would land in it rather
 * than at a prompt: `:wq` typed into a buffer, `git status` inserted into the
 * file you were editing. `force` sends it anyway, which is what the notice the
 * caller shows offers, since only the person watching knows whether the program
 * on screen wants that line.
 */
function runInShell(s: Sess, cmd: string, force = false): boolean {
  if (!force && typingWouldLandInApp(s.term.buffer.active)) return false;
  const line = cmd + "\r";
  s.lastUsed = Date.now();
  if (s.status === "live" && s.ws?.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ t: "in", d: line }));
  else { s.pending.push(line); if (!s.ws) connect(s); }
  s.term.focus();
  return true;
}

/**
 * Type a command into the docked console, opening its shell if needed.
 *
 * Finds the session the same way ConsoleStrip does — by title, per repo — so
 * calling this before the strip has mounted converges on one shell rather than
 * racing it into two. `runInShell` queues into `pending` when the socket is not
 * up yet, so the command still runs once it connects.
 *
 * Returns false when a full-screen program is holding that shell and the
 * command was therefore not typed. Callers from other panels get a plain answer
 * rather than a command that vanished into somebody's editor.
 */
export function runInConsole(root: string, cmd: string): boolean {
  if (!root || IS_DEMO) return false;
  const existing = sessionsFor(root).find((x) => x.title === CONSOLE_TITLE);
  const s = existing ?? createSession(root);
  s.title = CONSOLE_TITLE;
  const sent = runInShell(s, cmd);
  if (!sent) consoleBlocked(cmd);
  return sent;
}

// --- the panel ---------------------------------------------------------------
/** The terminal as a workspace view.
 *
 *  `onClose` is still needed here (unlike the other views) because the shell
 *  itself can dismiss the workspace with Shift+Esc — see `panelClose`. */
/**
 * A shell strip that lives at the bottom of another panel.
 *
 * Same machinery as the terminal view — same module-level session store, same
 * PTY, same xterm — deliberately: a second, lesser terminal would be a second
 * set of bugs, and a console you cannot run `make migrate` in properly is not
 * worth the room it takes.
 *
 * Keyed on the repo, not on the panel's selection, which is the point. Docker's
 * console must not restart because you clicked a different container: the whole
 * value of a console under the logs is that it keeps its history and its
 * running job while you look around above it.
 */
export function ConsoleStrip({ root: fallbackRoot, open, height, onHeight, onClose }: {
  root: string; open: boolean; height: number; onHeight: (h: number) => void; onClose: () => void;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const [, redraw] = useReducer((x: number) => x + 1, 0);
  const [sid, setSid] = useState<string>("");
  /**
   * Which checkout this console is in — its own choice, falling back to the
   * terminal view's repo until someone makes one. Changing it swaps which
   * per-repo console session the strip is showing; the one you were in keeps
   * running, which is the same promise the strip already makes when you close
   * it.
   */
  const [picked, setPicked] = useState<string>(() => { try { return localStorage.getItem(CONSOLE_ROOT_KEY) || ""; } catch { return ""; } });
  const root = picked || fallbackRoot;
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [repoOpen, setRepoOpen] = useState(false);
  const [repoQuery, setRepoQuery] = useState("");
  const pickerRef = useRef<HTMLDivElement>(null);
  /** Put the cursor back in the console after a menu that had to borrow the
   *  focus (the repo filter, the commands filter) closes again. Deferred a
   *  frame so it lands after the menu's own input has finished unmounting —
   *  otherwise the browser moves focus to <body> right after we set it. */
  const focusConsole = useCallback(() => {
    const s = sessions.get(sid);
    if (s) requestAnimationFrame(() => { try { s.term.focus(); } catch { /* disposed mid-frame */ } });
  }, [sid]);
  useDismiss(repoOpen, pickerRef, () => { setRepoOpen(false); setRepoQuery(""); focusConsole(); });
  // Every time the picker OPENS — not once. The `repos.length` short-circuit was
  // a fetch-once, so a worktree cut after this strip first loaded never showed:
  // the list stayed frozen until a full app restart. Re-reading on each open is
  // cheap and is the only way new worktrees (and branches) appear here the way
  // they already do in Source control.
  const [branchData, setBranchData] = useState<{ current: string; branches: GitBranch[] }>({ current: "", branches: [] });
  useEffect(() => {
    if (!repoOpen || IS_DEMO) return;
    api.gitRepos().then(({ repos: r }) => setRepos(r)).catch(() => {});
    if (root) api.gitBranches(root).then(setBranchData).catch(() => {});
  }, [repoOpen, root]);
  const chooseRepo = (next: string) => {
    setPicked(next);
    try { localStorage.setItem(CONSOLE_ROOT_KEY, next); } catch { /* private mode — lasts the session */ }
    setRepoOpen(false); setRepoQuery("");
    focusConsole();
  };
  // A local branch with no worktree of its own: switch by checking it out in the
  // console's current directory, then refresh so the list reflects the move.
  const checkoutHere = (name: string) => {
    api.gitCheckout(root, name).then((r) => {
      if (!r.ok) return;
      setRepoOpen(false); setRepoQuery("");
      api.gitRepos().then(({ repos: rr }) => setRepos(rr)).catch(() => {});
      focusConsole();
    }).catch(() => {});
  };
  /** Same guard as the terminal view: a chip must not type into vim. */
  const [blocked, setBlocked] = useState<string | null>(null);
  // Also carries refusals from `runInConsole`, which other panels call.
  useEffect(() => {
    if (!open) return;
    consoleBlocked = setBlocked;
    return () => { consoleBlocked = () => {}; };
  }, [open]);
  const runHere = useCallback((cmd: string, force = false) => {
    const s = sessions.get(sid);
    if (!s || IS_DEMO) return;
    if (runInShell(s, cmd, force)) setBlocked(null);
    else setBlocked(cmd);
  }, [sid]);

  // One console shell per repo, reused. `sessionsFor` already orders by
  // creation, so the first console-tagged one is stable across remounts.
  useEffect(() => {
    if (!open || !root || IS_DEMO) return;
    const existing = sessionsFor(root).find((x) => x.title === CONSOLE_TITLE);
    const s = existing ?? createSession(root);
    s.title = CONSOLE_TITLE;
    setSid(s.id);
  }, [open, root]);

  useEffect(() => {
    if (!open || IS_DEMO) return;
    const s = sessions.get(sid);
    const el = slot.current;
    if (!s || !el) return;
    el.appendChild(s.holder);
    if (!s.opened) { s.term.open(s.holder); s.opened = true; }
    s.term.options.theme = themeFromCss();
    const unTheme = applyThemeLive(s);
    s.subs.add(redraw);
    // Debounced: a ResizeObserver fires on every frame of a drag, and each fit
    // reflows the entire scrollback *and* sends a resize ioctl to the shell.
    // Undebounced that is the drag stuttering and the shell being told sixty
    // different sizes on the way to the one that matters.
    let fitTimer: ReturnType<typeof setTimeout> | null = null;
    const doFit = () => { try { fitTerm(s); } catch { /* not measurable yet */ } };
    const fitSoon = () => { if (fitTimer) clearTimeout(fitTimer); fitTimer = setTimeout(doFit, 100); };
    doFit();
    if (s.status === "idle") connect(s);
    // Opening a shell is asking to type in it. The strip mounted focused on
    // nothing, so every open cost a click on the black area before the first
    // keystroke landed — and a click that does nothing visible is a click you
    // forget you have to make. Same rAF as the terminal view's own focus: the
    // element has to be attached and laid out first.
    requestAnimationFrame(() => { try { s.term.focus(); } catch { /* disposed mid-frame */ } });
    const ro = new ResizeObserver(fitSoon);
    ro.observe(el);
    return () => {
      if (fitTimer) clearTimeout(fitTimer);
      ro.disconnect();
      unTheme();
      s.subs.delete(redraw);
      // Detached, never killed: the shell and its scrollback outlive the strip
      // being closed, so reopening lands you back in the same session.
      if (s.holder.parentElement === el) el.removeChild(s.holder);
    };
  }, [open, sid]);

  // Drag the top edge. Bounded so it can neither vanish nor swallow the panel
  // it is a strip of.
  const drag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const move = (ev: MouseEvent) => {
      const next = Math.min(0.85, Math.max(0.08, startH + (startY - ev.clientY) / window.innerHeight));
      onHeight(next);
    };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const sess = sessions.get(sid);
  if (!open) return null;
  return (
    <div className="shrink-0 flex flex-col" style={{ height: `${Math.round(height * 100)}%`, borderTop: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
      {/* The strip's own toolbar. Everything in it stops the drag from
          starting — the whole bar is the resize handle, so a click that also
          began a drag would move the console every time you opened a menu. */}
      <div onMouseDown={drag}
        className="shrink-0 flex items-center gap-2 px-3 py-1 cursor-row-resize select-none"
        style={{ background: "color-mix(in srgb, var(--bg3) 45%, transparent)" }}>
        <span className="text-[10px] uppercase tracking-wider shrink-0" style={{ color: "var(--primary-hover)" }}>console</span>

        {/* Which checkout this shell is in. The console is where migrations get
            run, and on a worktree-per-ticket repo the right directory is rarely
            the one the terminal view happens to be sitting in — so it picks its
            own, and remembers it. */}
        <div className="relative shrink-0" ref={pickerRef} onMouseDown={(e) => e.stopPropagation()}>
          {/* keepTermFocus so opening the picker does not blur the console; the
              filter input inside autofocuses on its own, and closing hands the
              cursor back (see chooseRepo / the useDismiss above). */}
          <button onMouseDown={keepTermFocus} onClick={() => setRepoOpen((o) => !o)} disabled={IS_DEMO}
            className="flex items-center gap-1.5 text-[10px] px-2 py-0.5 rounded-md max-w-[200px]"
            style={{ background: "color-mix(in srgb, var(--bg3) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text2)" }}
            title={root || "No repo"}>
            <span className="truncate">{root ? repoName(root) : "No repo"}</span><span className="t-dim2">▼</span>
          </button>
          {repoOpen && (
            <div className="absolute left-0 rounded-lg text-[11px] shadow-2xl flex flex-col"
              style={{ zIndex: 40, bottom: "calc(100% + 4px)", background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)", minWidth: 320, maxHeight: 360, overflow: "hidden" }}>
              <input autoFocus value={repoQuery} onChange={(e) => setRepoQuery(e.target.value)} placeholder="Filter repos…"
                className="m-1.5 px-2.5 py-1.5 rounded-md text-[11px] outline-none shrink-0"
                style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text)" }} />
              <div className="agx-scroll overflow-y-auto pb-1" style={{ minHeight: 0 }}>
                {repos.filter((r) => { const q = repoQuery.trim().toLowerCase(); return !q || (r.name + " " + r.branch + " " + r.root).toLowerCase().includes(q); }).map((r) => (
                  <button key={r.root} onClick={() => chooseRepo(r.root)} className="w-full text-left px-2.5 py-1.5 flex items-center gap-2"
                    style={{ background: r.root === root ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent" }}>
                    {/* Same badge and same name rule as every other picker: a
                        worktree IS its branch, a project is its folder. */}
                    <span className="shrink-0 text-[8.5px] leading-none px-1 py-[2px] rounded"
                      style={r.worktreeOf
                        ? { color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 32%, transparent)" }
                        : { color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>{r.worktreeOf ? "WT" : "REPO"}</span>
                    <span className="min-w-0 flex-1 truncate font-medium" style={{ color: "var(--text)" }} title={r.root}>{r.worktreeOf ? r.branch : r.name}</span>
                    {r.dirty > 0 && <span className="shrink-0 text-[9px] tabular-nums" style={{ color: "var(--warning)" }}>●{r.dirty}</span>}
                  </button>
                ))}
                {/* Local branches with no worktree — switch by checking out in
                    the console's current directory, same as Source control. */}
                {(() => {
                  const q = repoQuery.trim().toLowerCase();
                  const checkedOut = new Set(repos.map((r) => r.branch));
                  const branches = branchData.branches.filter((b) => !checkedOut.has(b.name) && (!q || b.name.toLowerCase().includes(q)));
                  if (!branches.length) return null;
                  return (
                    <>
                      <div className="px-2.5 pt-2 pb-1 text-[9px] uppercase tracking-wider t-dim2" style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 25%, transparent)" }}>Branches — checkout here</div>
                      {branches.slice(0, 80).map((b) => (
                        <button key={b.name} onClick={() => checkoutHere(b.name)} className="w-full text-left px-2.5 py-1.5 flex items-center gap-2">
                          <span className="shrink-0 text-[8.5px] leading-none px-1 py-[2px] rounded" title="local branch — checked out in the current directory" style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>BR</span>
                          <span className="min-w-0 flex-1 truncate font-medium" style={{ color: "var(--text)" }} title={b.name}>{b.name}</span>
                        </button>
                      ))}
                    </>
                  );
                })()}
                {!repos.length && <div className="px-3 py-2 t-dim2">Reading repos…</div>}
              </div>
            </div>
          )}
        </div>

        {sess && <span className="text-[9px] shrink-0" style={{ color: SESS_DOT[sess.status].color }}>● {SESS_DOT[sess.status].label}</span>}

        {/* The same control the terminal view mounts — commands and pins, one
            component, so the two shells cannot drift apart again. Opens upward:
            there is nothing below this strip to open into. */}
        <div className="flex items-center gap-2 min-w-0" onMouseDown={(e) => e.stopPropagation()}>
          <CommandBar root={root} disabled={!sid} font={TERM_FONT} onRun={runHere} onClose={focusConsole} dropUp />
        </div>

        {blocked && (
          <div className="min-w-0" onMouseDown={(e) => e.stopPropagation()}>
            <BlockedNotice cmd={blocked} onSend={() => { runHere(blocked, true); setBlocked(null); }} onDismiss={() => setBlocked(null)} />
          </div>
        )}

        <span className="ml-auto text-[9px] t-dim2 shrink-0">Drag to resize</span>
        <button onClick={(e) => { e.stopPropagation(); onClose(); }} onMouseDown={(e) => e.stopPropagation()} className="text-[12px] leading-none px-1.5 t-dim2 hover:opacity-70 shrink-0" title="Hide the console (the shell keeps running)">✕</button>
      </div>
      <div ref={slot} className="flex-1 min-h-0" style={{ background: "var(--bg)" }} onClick={() => sess?.term.focus()} />
    </div>
  );
}

export function TermView({ active, onClose = () => {} }: { active: boolean; onClose?: () => void }) {
  const open = active;
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [root, setRoot] = useState<string>(() => { try { return localStorage.getItem(ROOT_KEY) || ""; } catch { return ""; } });
  const [repoOpen, setRepoOpen] = useState(false);
  const [repoQuery, setRepoQuery] = useState("");
  /** Only whether the server allows commands at all — the list, its dropdown
   *  and the pins are the shared CommandBar's business now. */
  const [cmds, setCmds] = useState<TerminalCommands | null>(null);
  /** Both dropdowns live in here, so one listener can tell "clicked outside"
   *  from "clicked a row". */
  const pickersRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [, force] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    if (!open) return;
    api.gitRepos().then(({ repos }) => {
      setRepos(repos);
      // When the scoped repo list doesn't contain the remembered root, DROP it
      // rather than keep it: a stale localStorage root from a previous scope
      // would silently open shells (and list commands) in an out-of-scope repo
      // while the header claims "pick a repo".
      setRoot((cur) => (cur && repos.some((r) => r.root === cur) ? cur : repos[0]?.root || ""));
    }).catch(() => {});
  }, [open]);
  useEffect(() => { if (root) { try { localStorage.setItem(ROOT_KEY, root); } catch { /* ignore */ } } }, [root]);
  // Local branches, so the picker offers them the way Source control does — the
  // ones with a worktree are already worktree rows; these switch by checking out
  // in the current directory. Fetched only when the picker is open.
  const [branchData, setBranchData] = useState<{ current: string; branches: GitBranch[] }>({ current: "", branches: [] });
  // Refresh repos AND branches whenever the picker opens — so a worktree or
  // branch made after this view first loaded shows without a restart.
  useEffect(() => {
    if (!repoOpen || !root || IS_DEMO) return;
    api.gitRepos().then(({ repos }) => setRepos(repos)).catch(() => {});
    api.gitBranches(root).then(setBranchData).catch(() => {});
  }, [repoOpen, root]);
  const checkoutBranch = (name: string) => {
    api.gitCheckout(root, name).then((r) => {
      if (!r.ok) return;
      setRepoOpen(false); setRepoQuery("");
      api.gitRepos().then(({ repos }) => setRepos(repos)).catch(() => {});
      focusTerm();
    }).catch(() => {});
  };
  useEffect(() => {
    if (!open || !root) return;
    setCmds(null);
    loadCommands(root).then(setCmds);
  }, [open, root]);

  // Which shells are on screen. One id per visible pane: a single pane is the
  // plain case, and a split shows several at once the way tmux does — the point
  // being to watch a build in one while working in another.
  const [paneIds, setPaneIds] = useState<string[]>([]);
  const [focusIdx, setFocusIdx] = useState(0);
  const paneRefs = useRef<(HTMLDivElement | null)[]>([]);

  /** Put the cursor back in the pane you were in. Called when a menu that had
   *  to borrow the focus for its own input — the repo filter, the commands
   *  filter, a window rename — closes again: the terminal is where typing
   *  should resume. Deferred a frame so it lands after the menu's input has
   *  unmounted, or the browser moves focus to <body> straight after we set it. */
  const focusTerm = useCallback(() => {
    const s = sessions.get(paneIds[focusIdx] ?? "");
    if (s) requestAnimationFrame(() => { try { s.term.focus(); } catch { /* disposed mid-frame */ } });
  }, [paneIds, focusIdx]);
  // The repo picker's filter takes focus off the shell while it is open, so
  // dismissing it (Escape, an outside click) has to give the shell its cursor
  // back — see focusTerm.
  useDismiss(repoOpen, pickersRef, () => { setRepoOpen(false); focusTerm(); });

  const tabs = !IS_DEMO && root ? termSessionsFor(root) : [];

  // Every repo opens with a shell, and the panes always name shells that still
  // exist — closing one must not leave an empty frame behind.
  useEffect(() => {
    if (!open || !root || IS_DEMO) return;
    const live = termSessionsFor(root);
    const first = live[0] ?? createSession(root);
    setPaneIds((prev) => {
      const kept = prev.filter((id) => sessions.get(id)?.root === root);
      return kept.length ? kept : [first.id];
    });
    setFocusIdx(0);
  }, [open, root]);

  // Mount each pane's terminal into its slot. xterm keeps its own DOM, so the
  // holder is moved between slots rather than re-created — that's what keeps
  // scrollback and running jobs intact across splits and reopens.
  // Held in a ref and read through it, so `onClose` can change identity without
  // this effect — the one that moves the live xterm DOM between slots — tearing
  // down. Callers pass what they like; terminals do not remount for it.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  /** The find bar is open over the focused pane. Reset when the repo changes:
   *  a search is about one shell's scrollback, not about the panel. */
  const [findOpen, setFindOpen] = useState(false);
  useEffect(() => { setFindOpen(false); }, [root]);

  useEffect(() => {
    if (!open || IS_DEMO) return;
    panelClose = () => closeRef.current();
    // Claim the find chord only while this view is on screen and has a pane to
    // search — see `panelFind`.
    panelFind = () => { setFindOpen(true); return true; };
    const mounted: { s: Sess; el: HTMLDivElement; ro: ResizeObserver; unTheme: () => void; stopFit: () => void }[] = [];
    paneIds.forEach((id, i) => {
      const s = sessions.get(id);
      const el = paneRefs.current[i];
      if (!s || !el) return;
      el.appendChild(s.holder);
      if (!s.opened) { s.term.open(s.holder); s.opened = true; }
      s.term.options.theme = themeFromCss(); // pick up theme switches between opens
      const unTheme = applyThemeLive(s);
      s.subs.add(force);
      // Same debounce as the console strip: one fit when the drag settles, not
      // one per frame of it — each costs a full reflow of the scrollback and a
      // resize ioctl to the shell.
      let fitTimer: ReturnType<typeof setTimeout> | null = null;
      const doFit = () => { try { fitTerm(s); } catch { /* not measurable yet */ } };
      const fitSoon = () => { if (fitTimer) clearTimeout(fitTimer); fitTimer = setTimeout(doFit, 100); };
      doFit();
      if (s.status === "idle") connect(s);
      const ro = new ResizeObserver(fitSoon);
      ro.observe(el);
      mounted.push({ s, el, ro, unTheme, stopFit: () => { if (fitTimer) clearTimeout(fitTimer); } });
    });
    const focused = sessions.get(paneIds[focusIdx] ?? "");
    if (focused) requestAnimationFrame(() => focused.term.focus());
    return () => {
      panelClose = () => {};
      panelFind = () => false;
      for (const { s, el, ro, unTheme, stopFit } of mounted) {
        ro.disconnect();
        stopFit();
        unTheme();
        s.subs.delete(force);
        if (s.holder.parentElement === el) el.removeChild(s.holder);
      }
    };
    // `onClose` deliberately absent: see closeRef above. Re-running this for a
    // callback identity detaches a live terminal, which loses the selection you
    // were dragging and cycles focus mid-keystroke.
  }, [open, paneIds, focusIdx]);

  // Return the keyboard focus to the shell when the terminal view becomes
  // visible again — e.g. after clicking the left sidebar to another view and
  // coming back, or dismissing the app header. The mount effect above
  // deliberately omits `active` so returning does not detach/reload the
  // terminal, so it never refocuses on return; this does, and only that. Guard
  // on the rising edge (hidden → visible) so an already-focused shell is not
  // re-grabbed on every unrelated re-render.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current && open) {
      const s = sessions.get(paneIds[focusIdx] ?? "");
      if (s) requestAnimationFrame(() => { try { s.term.focus(); } catch { /* disposed mid-frame */ } });
    }
    wasActive.current = active;
  }, [active, open, paneIds, focusIdx]);

  const sess = sessions.get(paneIds[focusIdx] ?? "");
  // tmux is running in the shell you're looking at, so it owns the tabs and the
  // splits. Ours would be a second set of controls doing the same job worse —
  // and two competing pane models is exactly how you end up with a split inside
  // a split you didn't ask for.
  const tmuxActive = !!sess?.tmux;
  const status: SessStatus = sess?.status ?? "idle";

  /*
   * tmux's windows, drawn by us.
   *
   * The panel stands down from tabs and splits while tmux runs, because two
   * pane models fight. Its *window list* is a different case: it is the one
   * strip of the workspace styled by a file the app has never seen, so the same
   * user on two machines gets two different looking bars across an otherwise
   * coherent panel. So the list comes from tmux and the pixels come from here.
   *
   * Nothing about the keyboard changes. Every button below sends a command tmux
   * would have run anyway, and "which window is active" is always tmux's answer
   * arriving on the next poll, never a local guess that could disagree with it.
   */
  const tmuxWindows = sess?.tmuxWindows ?? [];
  // Lit while tmux is waiting for the second half of a prefix sequence.
  const prefixLive = !!sess?.tmuxPrefixAt && Date.now() - sess.tmuxPrefixAt < PREFIX_MS;
  /*
   * The prefix, spelled for a keyboard hint.
   *
   * Every key this panel advertises starts with it, and it used to be written
   * `^b` everywhere regardless of what tmux was actually listening for. That is
   * wrong for exactly the people who rebound it — who are the people who use
   * tmux enough to have rebound anything — and it is wrong silently: the hints
   * still read as instructions, they just do not work. `^b` remains the
   * fallback for the moment before tmux has answered, because it is right for
   * everyone who never touched it.
   */
  const px = keyLabel(sess?.tmuxPrefix[0] ?? "C-b");
  /*
   * The tab you clicked highlights now, not when tmux confirms it.
   *
   * The server re-reads tmux the moment the command returns, so the real answer
   * is a round trip away rather than a poll away — but a round trip is still
   * long enough to feel like the click missed, and this is the one interaction
   * where the user already knows what the answer will be. Cleared on the next
   * frame, so if tmux disagrees (the window went away underneath), tmux wins.
   */
  const [pendingWindow, setPendingWindow] = useState<string | null>(null);
  useEffect(() => { setPendingWindow(null); }, [tmuxWindows]);
  const activeWindow = pendingWindow ?? tmuxWindows.find((w) => w.active)?.id ?? null;
  const tmuxCmd = useCallback((cmd: string, extra: Record<string, unknown> = {}) => {
    const s = sess;
    if (!s || s.ws?.readyState !== WebSocket.OPEN) return;
    s.ws.send(JSON.stringify({ t: "tmux", cmd, ...extra }));
  }, [sess]);
  // Keyed by tmux's window id, not the index: a rename in flight must follow the
  // window even if killing another one renumbers the strip underneath it.
  const [renaming, setRenaming] = useState<string | null>(null);
  /** The same box, for `move-window`: a number rather than a name, so it is a
   *  separate mode rather than a flag on the one above. */
  const [moving, setMoving] = useState<string | null>(null);

  /**
   * `prefix ,` and `prefix .`, arriving from tmux.
   *
   * While this strip owns the bar there is no row for tmux to prompt in, so the
   * keys leave a note on the window instead and the server forwards it once.
   * Opening our own input here is what makes the takeover honest: the keys
   * people already have in their fingers keep working, and they land in a box
   * that looks like the rest of the app rather than in a tmux prompt drawn over
   * the first line of the shell.
   *
   * The server clears the note as it forwards it, so this fires once per press.
   */
  useEffect(() => {
    const asked = tmuxWindows.find((w) => w.ask);
    if (!asked) return;
    if (asked.ask === "rename") { setMoving(null); setRenaming(asked.id); }
    else { setRenaming(null); setMoving(asked.id); }
  }, [tmuxWindows]);

  /*
   * Whether tmux keeps drawing its own status line underneath our tabs.
   *
   * Hidden by default, because leaving it on means two window lists stacked on
   * top of each other and the point of this was to stop the workspace carrying
   * a strip it does not control. It is only ever hidden when we actually have
   * tabs to put in its place, it is one click to bring back, the choice is
   * remembered, and the server restores it when the panel closes.
   *
   * The caveat, and the reason the button is right there in the strip rather
   * than buried in settings: `status` is a session option, not a client one.
   * Someone attached to the same session from a real terminal loses their
   * status line too, and some people keep things there we do not draw — the
   * session name, a battery, a prefix indicator.
   */
  const [tmuxBar, setTmuxBar] = useState<boolean>(() => {
    try { return localStorage.getItem("agentglass-tmux-bar") === "on"; } catch { return false; }
  });
  useEffect(() => {
    // Nothing to replace it with means nothing to hide: if the session never
    // resolved (no /proc, an unusual socket, a tmux we could not reach), the
    // user keeps exactly the bar they had.
    if (!tmuxActive || !tmuxWindows.length) return;
    tmuxCmd("status", { visible: tmuxBar });
    try { localStorage.setItem("agentglass-tmux-bar", tmuxBar ? "on" : "off"); } catch { /* private mode */ }
  }, [tmuxActive, tmuxBar, tmuxCmd, tmuxWindows.length]);

  /*
   * A review asked for from the pull request panel.
   *
   * It waits here until there is a tmux to open a window in — the button can be
   * pressed while this view has never been opened, so the socket may still be
   * connecting, and a request dropped for arriving early would look like a
   * button that sometimes does nothing. Cleared on send, not on arrival.
   */
  const review = useSyncExternalStore(subscribeTermReview, termReview, termReview);
  useEffect(() => {
    if (!review || !tmuxActive) return;
    tmuxCmd("review", { root: review.root, number: review.number });
    clearTermReview();
  }, [review, tmuxActive, tmuxCmd]);

  /** The same door for starting work on an issue: a worktree the server has
   *  already cut, and a prompt it wrote. Never a command — see termIssue.ts. */
  const issue = useSyncExternalStore(subscribeTermIssue, termIssue, termIssue);
  useEffect(() => {
    if (!issue || !tmuxActive) return;
    tmuxCmd("issue", { cwd: issue.cwd, name: issue.name, prompt: issue.prompt, agent: issue.agent });
    clearTermIssue();
  }, [issue, tmuxActive, tmuxCmd]);

  const addShell = useCallback(() => {
    if (!root || IS_DEMO) return;
    const s = createSession(root);
    setPaneIds([s.id]);
    setFocusIdx(0);
  }, [root]);

  /** Show one more shell beside the current one (new if there isn't a spare). */
  const splitPane = useCallback(() => {
    if (!root || IS_DEMO) return;
    setPaneIds((prev) => {
      if (prev.length >= 4) return prev; // beyond four a pane is too small to use
      const spare = termSessionsFor(root).find((s) => !prev.includes(s.id)) ?? createSession(root);
      return [...prev, spare.id];
    });
  }, [root]);

  const showOnly = useCallback((id: string) => { setPaneIds([id]); setFocusIdx(0); }, []);

  const closeShell = useCallback((id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    const r = s.root;
    killSession(s);
    setPaneIds((prev) => {
      const kept = prev.filter((x) => x !== id);
      if (kept.length) return kept;
      const next = termSessionsFor(r)[0] ?? createSession(r);
      return [next.id];
    });
    setFocusIdx(0);
  }, []);

  /** The command a full-screen program stopped, kept so it can still be sent. */
  const [blocked, setBlocked] = useState<string | null>(null);
  const run = useCallback((cmd: string, force = false) => {
    if (!root || IS_DEMO) return;
    const s = sessions.get(paneIds[focusIdx] ?? "") ?? createSession(root);
    if (runInShell(s, cmd, force)) setBlocked(null);
    else setBlocked(cmd);
  }, [root, paneIds, focusIdx]);

  const restart = useCallback(() => {
    const s = sessions.get(paneIds[focusIdx] ?? "");
    if (!s || IS_DEMO) return;
    if (s.ws) { s.status = "exited"; s.ws.close(); s.ws = null; }
    s.term.write("\r\n\x1b[2m— restarting shell —\x1b[0m\r\n");
    connect(s);
    s.term.focus();
  }, [paneIds, focusIdx]);

  const repoRef = repos.find((r) => r.root === root);
  const disabled = cmds ? !cmds.enabled : false;

  const statusDot: Record<SessStatus, { color: string; label: string }> = {
    idle: { color: "var(--text2)", label: "Idle" },
    connecting: { color: "var(--warning)", label: "Connecting…" },
    live: { color: "var(--success, #98c379)", label: sess ? `${sess.shell} · ${sess.mode === "pipe" ? "pipe" : "pty"}${sess.mode !== "pipe" && !sess.canResize ? " · fixed size" : ""}` : "live" },
    exited: { color: "var(--text2)", label: "Exited" },
    error: { color: "var(--error)", label: "Disconnected" },
    unauthorized: { color: "var(--error)", label: "Unauthorized ⚿" },
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
                {/* The plan meters live in the top bar, which is over every view
                    rather than only over the terminal. */}
                <style>{SCROLLBAR_CSS}</style>
                {/* Pin xterm's own boxes flush. The stylesheet ships no padding
                    today, but it has before and it is one release away from
                    doing so again — and the symptom (a TUI missing its bottom
                    border) reads as a bug in tmux, not as a stray CSS rule.

                    The scrollbar rule keeps the viewport from covering the last
                    column with a real 15px gutter — an overlay scrollbar takes
                    no layout width, and the wheel still scrolls. It does NOT
                    win back the strip down the right on its own: the columns
                    are counted in `fitTerm`, which is where that was actually
                    fixed, because FitAddon reserves its 14px unconditionally
                    and never looks at what the scrollbar really costs. */}
                <style>{`.xterm,.xterm-screen,.xterm-viewport{padding:0!important;margin:0!important}
.xterm-viewport{scrollbar-width:none!important}
.xterm-viewport::-webkit-scrollbar{width:0!important;height:0!important}`}</style>

                {/* header: repo picker + command launcher + actions */}
                <div className={viewHeaderClass} style={viewHeaderStyle}>
                  <span className={viewTitleClass} style={{ color: "var(--text)" }}>Terminal</span>
                  {/* keepTermFocus on the picker group so pressing the trigger
                      or a repo row never blurs the shell; the filter input is
                      excluded by the handler and still takes focus, and every
                      way out of the menu below hands the cursor back. */}
                  <div ref={pickersRef} className="flex items-center gap-3" onMouseDown={keepTermFocus}>
                  <div className="relative">
                    <button onClick={() => { if (repoOpen) { setRepoOpen(false); focusTerm(); } else setRepoOpen(true); }} className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg" style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text)" }}>
                      <span className="font-medium">{repoRef ? repoName(repoRef.root) : "Pick a repo"}</span><span className="t-dim2">▼</span>
                    </button>
                    {repoOpen && (
                      /* Wide enough for the whole worktree name and its branch.
                         It used to be 320px with the branch clipped at 150, so
                         a card-per-worktree checkout showed as "orbit-WEB-1042"
                         beside an elided branch — the two pieces that tell them
                         apart, both cut off. Source control shows them in full;
                         this now matches it. */
                      <div className="absolute left-0 mt-1 rounded-lg text-[11px] shadow-2xl flex flex-col" style={{ zIndex: 30, background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)", minWidth: 460, maxWidth: "min(86vw, 760px)", maxHeight: 420, overflow: "hidden" }}>
                        <input autoFocus value={repoQuery} onChange={(e) => setRepoQuery(e.target.value)} placeholder="Filter repos…" className="m-1.5 px-2.5 py-1.5 rounded-md text-[11px] outline-none shrink-0" style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text)" }} />
                        <div className="agx-scroll overflow-y-auto pb-1" style={{ minHeight: 0 }}>
                          {/* The path is searchable too: with a worktree per card,
                              "20343" is how you find one — it's in the directory
                              name and the branch, not in the project name. */}
                          {repos.filter((r) => { const q = repoQuery.trim().toLowerCase(); return !q || (r.name + " " + r.branch + " " + r.root).toLowerCase().includes(q); }).map((r) => {
                            const live = sessionsFor(r.root).some((s) => s.status === "live");
                            return (
                              <button key={r.root} onClick={() => { setRoot(r.root); setRepoOpen(false); setRepoQuery(""); focusTerm(); }} className="w-full text-left px-2.5 py-1.5 flex items-center gap-2" style={{ background: r.root === root ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent" }}>
                                {/* Indented under its project — a shell in a
                                    worktree is a shell in that branch, not in
                                    some unrelated repo that looks similar. */}
                                {/* A worktree gets its own mark rather than an
                                    indent. "└" only says "child of the line
                                    above", which stops meaning anything once
                                    the list is filtered and the parent is off
                                    screen — and it reads as tree drawing, not
                                    as a kind of thing. */}
                                <span
                                  className="shrink-0 text-[8.5px] leading-none px-1 py-[2px] rounded"
                                  title={r.worktreeOf ? `Worktree of ${r.worktreeOf}` : "Main checkout"}
                                  style={r.worktreeOf
                                    ? { color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 32%, transparent)" }
                                    : { color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}
                                >{r.worktreeOf ? "WT" : "REPO"}</span>
                                {/* A worktree IS its branch — one per ticket is
                                    the whole point — so the branch is the name
                                    worth the wide column, and the directory is
                                    only a terse stub of it. A project is the
                                    other way round: the folder is the identity
                                    and the branch is just what happens to be
                                    checked out. Same rule Source control uses,
                                    so the two pickers read alike.

                                    `truncate` matters: without it a long
                                    worktree name wrapped to seven lines and
                                    collided with the branch beside it. */}
                                <span className="min-w-0 flex-1 truncate font-medium" style={{ color: "var(--text)" }} title={r.worktreeOf ? `${r.branch}\n${r.root}` : r.root}>
                                  {r.worktreeOf ? r.branch : r.name}
                                  {live && <span title="Live shell" style={{ color: "var(--success, #98c379)" }}> ●</span>}
                                </span>
                                {!r.worktreeOf && <span className="shrink-0 truncate t-dim2 text-[9.5px]" style={{ maxWidth: 150 }} title={r.branch}>{r.branch}</span>}
                                {r.dirty > 0 && <span className="shrink-0 text-[9px] tabular-nums" style={{ color: "var(--warning)" }} title={`${r.dirty} changed file${r.dirty === 1 ? "" : "s"}`}>●{r.dirty}</span>}
                                {r.behind > 0 && <span className="shrink-0 text-[9px] tabular-nums" style={{ color: "var(--warning)" }} title={`${r.behind} behind upstream`}>↓{r.behind}</span>}
                                {r.ahead > 0 && <span className="shrink-0 text-[9px] tabular-nums" style={{ color: "var(--success)" }} title={`${r.ahead} ahead of upstream`}>↑{r.ahead}</span>}
                              </button>
                            );
                          })}
                          {/* Local branches with no checkout of their own —
                              switch by checking out in the current directory,
                              same as Source control's picker. */}
                          {(() => {
                            const q = repoQuery.trim().toLowerCase();
                            const checkedOut = new Set(repos.map((r) => r.branch));
                            const branches = branchData.branches.filter((b) => !checkedOut.has(b.name) && (!q || b.name.toLowerCase().includes(q)));
                            if (!branches.length) return null;
                            return (
                              <>
                                <div className="px-2.5 pt-2 pb-1 text-[9px] uppercase tracking-wider t-dim2" style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 25%, transparent)" }}>Branches — checkout here</div>
                                {branches.slice(0, 80).map((b) => (
                                  <button key={b.name} onClick={() => checkoutBranch(b.name)} className="w-full text-left px-2.5 py-1.5 flex items-center gap-2">
                                    <span className="shrink-0 text-[8.5px] leading-none px-1 py-[2px] rounded" title="local branch — checked out in the current directory" style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>BR</span>
                                    <span className="min-w-0 flex-1 truncate font-medium" style={{ color: "var(--text)" }} title={b.name}>{b.name}</span>
                                  </button>
                                ))}
                              </>
                            );
                          })()}
                          {!repos.length && <div className="px-3 py-2 t-dim2">No repos seen yet</div>}
                        </div>
                      </div>
                    )}
                  </div>

                  </div>

                  {/* Commands and pins — the same control the docked console
                      mounts, so the two shells offer the same thing. Its own
                      dropdown state lives inside it, which is why it sits
                      outside the pickers group above. */}
                  <CommandBar root={root} disabled={disabled} font={TERM_FONT} onRun={run} onClose={focusTerm} />

                  {/* keepTermFocus so none of these buttons — split, restart,
                      clear, the status pill — steals the shell's cursor on
                      press; they act and the terminal keeps the keyboard. */}
                  {/* Find sits outside the keepTermFocus group on purpose: its
                      input is the one control here that has to take the cursor
                      off the shell, and closing it hands the cursor back. */}
                  {blocked && <BlockedNotice cmd={blocked} onSend={() => { run(blocked, true); setBlocked(null); }} onDismiss={() => setBlocked(null)} />}

                  <div className="ml-auto flex items-center gap-1.5 shrink-0">
                    {findOpen
                      ? <FindBar sess={sessions.get(paneIds[focusIdx] ?? "")} onClose={() => { setFindOpen(false); focusTerm(); }} />
                      : <button onMouseDown={keepTermFocus} onClick={() => setFindOpen(true)} disabled={!root || IS_DEMO || disabled} title="Find in scrollback (Ctrl+Shift+F)" className="text-[11px] px-2 py-1 rounded-lg" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>⌕ Find</button>}
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0" onMouseDown={keepTermFocus}>
                    <span onClick={status === "unauthorized" ? reauthPrompt : undefined}
                      className={`flex items-center gap-1.5 text-[10px] t-dim2 mr-1 ${status === "unauthorized" ? "cursor-pointer" : ""}`}
                      title={status === "unauthorized" ? "This server needs an access token — click to enter it" : "Shell status"}>
                      <span style={{ color: statusDot[status].color }}>●</span>{statusDot[status].label}
                    </span>
                    {!tmuxActive && <button onClick={splitPane} disabled={!root || IS_DEMO || disabled || paneIds.length >= 4} title="Show another shell beside this one" className="text-[11px] px-2 py-1 rounded-lg" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)", opacity: paneIds.length >= 4 ? 0.45 : 1 }}>⊞ Split</button>}
                    <button onClick={restart} disabled={!root || IS_DEMO || disabled} title="Kill this shell and start a fresh one" className="text-[11px] px-2 py-1 rounded-lg" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>⟲ Restart</button>
                    <button onClick={() => sess?.term.clear()} className="text-[11px] px-2 py-1 rounded-lg" style={{ color: "var(--text2)" }}>Clear</button>
                    {/* The way back, and it lives here because the way out
                        lives in the strip — which is the thing being hidden.
                        A toggle whose "off" state removes the button that
                        turns it on is a one-way door. Exactly one of the two
                        is on screen at any time. */}
                    {tmuxActive && tmuxWindows.length > 0 && tmuxBar && (
                      <button onClick={() => setTmuxBar(false)} className="text-[11px] px-2 py-1 rounded-lg" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}
                        title="Draw the window list here instead, and take tmux's row back for the shell">
                        Use agentglass bar
                      </button>
                    )}
                  </div>
                </div>

                {/* shells open in this repo — scrolls, so the count can grow.
                    keepTermFocus on the strip so switching, closing or adding a
                    shell by click doesn't blur the terminal underneath. */}
                {!IS_DEMO && !disabled && !tmuxActive && (
                  <div onMouseDown={keepTermFocus} className="shrink-0 flex items-center gap-1 px-3 py-1 border-b overflow-x-auto agw-noscrollbar" style={{ borderColor: "color-mix(in srgb, var(--border) 30%, transparent)" }}>
                    {tabs.map((t) => {
                      const shown = paneIds.includes(t.id);
                      const focused = t.id === paneIds[focusIdx];
                      return (
                        <div key={t.id} onClick={() => showOnly(t.id)}
                          className="group flex items-center gap-1.5 px-2 py-1 rounded-md text-[10.5px] cursor-pointer shrink-0"
                          style={focused
                            ? { background: "color-mix(in srgb, var(--primary) 20%, transparent)", color: "var(--primary-hover)" }
                            : shown
                              ? { background: "color-mix(in srgb, var(--bg3) 55%, transparent)", color: "var(--text2)" }
                              : { color: "var(--text3)" }}>
                          <span className="w-1.5 h-1.5 rounded-full" style={{ background: t.status === "live" ? "var(--success, #98c379)" : t.status === "error" ? "var(--error)" : "color-mix(in srgb, var(--text4) 60%, transparent)" }} />
                          <span>{t.title}</span>
                          <button onClick={(e) => { e.stopPropagation(); closeShell(t.id); }} className="opacity-0 group-hover:opacity-100 leading-none px-0.5" title="Close shell">✕</button>
                        </div>
                      );
                    })}
                    <button onClick={addShell} className="shrink-0 px-2 py-1 rounded-md text-[10.5px]" style={{ color: "var(--text3)" }} title="New shell in this repo">+</button>
                  </div>
                )}

                {/* tmux's windows, as our own tabs.
                    Same shape as the shell tabs above on purpose: from the
                    user's side this is the same control, and which program is
                    behind it should not change how the workspace looks. */}
                {/* One window list or the other, never both. `tmuxBar` is the
                    user's answer to "whose bar is this", so it gates the strip
                    as well as tmux's row — a blanked row under our tabs was two
                    bars pretending to be one, and a row we keep for a prompt
                    that no longer arrives there is just a gap. */}
                {tmuxActive && tmuxWindows.length > 0 && !tmuxBar && (
                  // keepTermFocus so switching tmux windows by click (and the +,
                  // kill, hide-bar buttons) never blurs the pane — tmux keeps
                  // owning the keyboard the instant the tab changes. The rename
                  // input is excluded by the handler, so it can still be typed
                  // in; it hands focus back on close (see below).
                  <div onMouseDown={keepTermFocus} className="shrink-0 flex items-center gap-1 px-3 py-1 border-b overflow-x-auto agw-noscrollbar" style={{ borderColor: "color-mix(in srgb, var(--border) 30%, transparent)" }}>
                    <span
                      title={prefixLive ? "tmux is waiting for the rest of the sequence" : `tmux prefix: ${(sess?.tmuxPrefix ?? []).join(" or ") || "unknown"}`}
                      className="shrink-0 px-1.5 py-1 rounded-md text-[10px] font-semibold tabular-nums transition-colors duration-75"
                      style={prefixLive
                        ? { background: "var(--primary)", color: "var(--bg2)" }
                        : { color: "var(--text4)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>
                      {(sess?.tmuxPrefix[0] ?? "tmux")}
                    </span>
                    {/* Which session this strip is describing.
                        It was in most people's status line, and with several
                        sessions on one socket the tabs alone do not say which
                        one you are looking at — a distinction that stopped
                        being academic the moment a restore could move the
                        client from one session to another underneath you. */}
                    {sess?.tmuxSession && (
                      <span className="shrink-0 px-1 text-[10px] max-w-[9rem] truncate" style={{ color: "var(--text4)" }} title={`tmux session: ${sess.tmuxSession}`}>
                        {sess.tmuxSession}
                      </span>
                    )}
                    {tmuxWindows.map((w) => {
                      // tmux's own marks, straight through, and kept apart
                      // rather than merged: `!` is a bell, which the window
                      // rang on purpose, and `#` is activity, which is only
                      // output arriving. One dot for both said "something
                      // happened over here" and left you to go and find out
                      // which — and `monitor-activity` is off in most configs,
                      // so the loud one is usually the only one that fires.
                      const bell = w.flags.includes("!");
                      const activity = w.flags.includes("#");
                      // Zoom is the flag that changes what the keyboard does:
                      // one pane is filling the window and the others are still
                      // there, which is confusing precisely when it is invisible.
                      const zoomed = w.flags.includes("Z");
                      return (
                        <div key={w.id}
                          onClick={() => { if (w.id !== activeWindow) { setPendingWindow(w.id); tmuxCmd("select", { window: w.id }); } }}
                          onDoubleClick={() => setRenaming(w.id)}
                          title={`Window ${w.index}${w.flags ? ` (${w.flags})` : ""} — double-click to rename`}
                          className="group flex items-center gap-1.5 px-2 py-1 rounded-md text-[10.5px] cursor-pointer shrink-0"
                          style={w.id === activeWindow
                            ? { background: "color-mix(in srgb, var(--primary) 20%, transparent)", color: "var(--primary-hover)" }
                            : { background: "color-mix(in srgb, var(--bg3) 55%, transparent)", color: "var(--text2)" }}>
                          {/* The index doubles as the move box: `prefix .`
                              asks which number, and the number it is asking
                              about is right here. Typing over it is a more
                              direct answer than a prompt somewhere else. */}
                          {moving === w.id ? (
                            <input
                              autoFocus
                              defaultValue={String(w.index)}
                              inputMode="numeric"
                              onClick={(e) => e.stopPropagation()}
                              onBlur={() => setMoving(null)}
                              onKeyDown={(e) => {
                                if (e.key === "Escape") { setMoving(null); focusTerm(); return; }
                                if (e.key !== "Enter") return;
                                const to = (e.target as HTMLInputElement).value.trim();
                                if (/^\d{1,3}$/.test(to) && Number(to) !== w.index) tmuxCmd("move", { window: w.id, name: to });
                                setMoving(null);
                                focusTerm();
                              }}
                              className="bg-transparent outline-none w-7 text-[10.5px] tabular-nums text-center"
                              style={{ color: "var(--text)", borderBottom: "1px solid color-mix(in srgb, var(--primary) 60%, transparent)" }}
                            />
                          ) : (
                            <span className="tabular-nums" style={{ color: "var(--text4)" }}>{w.index}</span>
                          )}
                          {renaming === w.id ? (
                            <input
                              autoFocus
                              defaultValue={w.name}
                              onClick={(e) => e.stopPropagation()}
                              onBlur={() => setRenaming(null)}
                              onKeyDown={(e) => {
                                // Escape and Enter close the rename box on
                                // purpose, so both hand the keyboard back to the
                                // pane rather than leaving it on the vanishing
                                // input.
                                if (e.key === "Escape") { setRenaming(null); focusTerm(); return; }
                                if (e.key !== "Enter") return;
                                const name = (e.target as HTMLInputElement).value.trim();
                                if (name && name !== w.name) tmuxCmd("rename", { window: w.id, name });
                                setRenaming(null);
                                focusTerm();
                              }}
                              className="bg-transparent outline-none w-20 text-[10.5px]"
                              style={{ color: "var(--text)", borderBottom: "1px solid color-mix(in srgb, var(--primary) 60%, transparent)" }}
                            />
                          ) : (
                            <span>{w.name || "shell"}</span>
                          )}
                          {zoomed && <span className="text-[9px] font-semibold leading-none" style={{ color: "var(--text4)" }} title="A pane in this window is zoomed">⤢</span>}
                          {bell && <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--error)" }} title="Bell" />}
                          {!bell && activity && <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--warning)" }} title="Activity" />}
                          <button onClick={(e) => { e.stopPropagation(); tmuxCmd("kill", { window: w.id }); }}
                            className="opacity-0 group-hover:opacity-100 leading-none px-0.5" title="Close window (kill-window)">✕</button>
                        </div>
                      );
                    })}
                    <button onClick={() => tmuxCmd("new")} className="shrink-0 px-2 py-1 rounded-md text-[10.5px]" style={{ color: "var(--text3)" }} title={`New tmux window (${px} c puts it next to this one)`}>+</button>
                    <button onClick={() => setTmuxBar(true)} className="ml-auto shrink-0 px-2 py-1 rounded-md text-[10px]" style={{ color: "var(--text3)" }}
                      title="Give tmux its own status line back — this strip steps aside, so you are never looking at two window lists">
                      Use tmux's bar
                    </button>
                  </div>
                )}

                {/* the terminals — one slot per visible pane */}
                <div className="flex-1 min-h-0 relative" style={{ background: "var(--bg)" }}>
                  {/* The gap survives — it separates two panes and is doing real
                      work. The outer padding does not: with one pane it is pure
                      dead margin, and a full-screen TUI is drawn right to the
                      edge. Only inset when there is more than one pane, so the
                      split doesn't sit flush against the panel border. */}
                  <div className={`absolute inset-0 grid gap-1.5 ${paneIds.length > 1 ? "p-1.5" : ""}`}
                    style={{
                      gridTemplateColumns: paneIds.length > 1 ? "1fr 1fr" : "1fr",
                      gridTemplateRows: paneIds.length > 2 ? "1fr 1fr" : "1fr",
                    }}>
                    {paneIds.map((id, i) => (
                      <div key={id}
                        ref={(el) => { paneRefs.current[i] = el; }}
                        onMouseDown={() => setFocusIdx(i)}
                        // No padding. A full-screen TUI — tmux, nvim, htop —
                        // draws its own borders and status lines flush to the
                        // edge, so any inset here shows up as a dead margin
                        // around the app and costs a column and a row of the
                        // grid the shell was told it had.
                        // Square under tmux. A rounded corner clips the corner
                        // cell of a TUI that draws its own border right to the
                        // edge, so tmux's frame and vim's status line come out
                        // visibly chewed. Only round it when the pane is ours
                        // to decorate.
                        className={`min-w-0 min-h-0 overflow-hidden ${tmuxActive ? "" : "rounded-lg"}`}
                        style={{
                          // Match the terminal's own background. xterm can only
                          // draw whole character cells, so a container that
                          // isn't an exact multiple of the cell size leaves a
                          // strip of remainder down the right and along the
                          // bottom — a few pixels wide, and glaringly obvious
                          // when it shows the panel behind it instead.
                          background: "var(--bg)",
                          border: paneIds.length > 1 && i === focusIdx
                            ? "1px solid color-mix(in srgb, var(--primary) 45%, transparent)"
                            : "1px solid transparent",
                        }} />
                    ))}
                  </div>
                  {(IS_DEMO || disabled) && (
                    <div className="absolute inset-0 flex items-center justify-center text-[12px] t-dim2" style={{ background: "color-mix(in srgb, var(--bg) 80%, transparent)" }}>
                      {IS_DEMO
                        ? "The terminal is disabled in the demo — run agentglass locally for a real shell"
                        : cmds?.reason === "windows"
                        ? "The terminal is not available on Windows yet (the PTY backend needs POSIX; ConPTY support is planned)"
                        : cmds?.reason === "config"
                        ? "Terminal disabled (terminalDisabled in config.json)"
                        : "Terminal disabled (AGENTGLASS_TERMINAL_DISABLED=1)"}
                    </div>
                  )}
                </div>

                {/* status line */}
                <div className="shrink-0 flex items-center gap-3 px-4 py-1.5 border-t text-[9.5px] t-dim2" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                  {/* Under tmux the panel's own advice is wrong — its tabs and
                      split are gone, and the keys that matter are tmux's. Say
                      those instead, since the prefix is the one thing you can't
                      guess and everything else follows from it. */}
                  {tmuxActive ? (
                    <span className="flex items-center gap-2 flex-wrap">
                      <span className="px-1.5 rounded" style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 14%, transparent)" }}>tmux</span>
                      <span>Panel chrome hidden — tmux owns the panes</span>
                      <span className="t-dim2">·</span>
                      {[["c", "Window"], ['"', "Split ↓"], ["%", "Split →"], ["o", "Next pane"], ["z", "Zoom"], ["d", "Detach"], ["?", "All keys"]].map(([key, what]) => (
                        <Fragment key={key}>
                          <b style={{ color: "var(--text2)" }}>{px} {key}</b><span>{what}</span>
                        </Fragment>
                      ))}
                    </span>
                  ) : IS_DEMO || disabled ? (
                    // The shell isn't running here (demo, Windows, or disabled by
                    // env), so promising a real shell with working TUIs would be
                    // the lie the overlay above just corrected. Say nothing.
                    <span className="t-dim2">{cmds?.reason === "windows" ? "Terminal not available on Windows yet" : "Terminal unavailable"}</span>
                  ) : (
                    <span>Real shell — Ctrl+C, Ctrl+R, Tab-complete, vim/htop all work · sessions survive closing this panel · Shift+Esc closes it</span>
                  )}
                  <span className="ml-auto">{sess ? `${sess.term.cols}×${sess.term.rows}` : ""}</span>
                </div>
    </div>
  );
}


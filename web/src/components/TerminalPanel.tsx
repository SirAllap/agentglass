// In-browser terminal — a REAL machine terminal (xterm.js ⇄ WebSocket ⇄ PTY).
// The server spawns your login shell inside a pseudo-terminal per repo/worktree,
// so everything a local terminal does works here: job control, Ctrl+C/Ctrl+R,
// tab-completion, colors, vim/htop/lazygit. Shell sessions are kept alive in a
// module-level store, so closing the panel (or switching repos) never kills a
// running job — reopening reattaches to the live session, scrollback intact.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useDismiss } from "../lib/useDismiss.ts";
import { viewHeaderClass, viewHeaderStyle, viewTitleClass } from "./workspace/ViewHeader.tsx";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { GitRepoRef, TerminalCommands, TmuxWindow } from "../../../shared/types.ts";
import { api, IS_DEMO, ptyWsUrl, hasToken, probeAuth, reauthPrompt } from "../lib/api.ts";
import { CommandBar, loadCommands } from "./CommandBar.tsx";
import { SCROLLBAR_CSS } from "./ChangesModal.tsx";

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
  idle: { color: "var(--text2)", label: "idle" },
  connecting: { color: "var(--warning)", label: "connecting…" },
  live: { color: "var(--success, #98c379)", label: "live" },
  exited: { color: "var(--text2)", label: "exited" },
  error: { color: "var(--error)", label: "disconnected" },
  unauthorized: { color: "var(--error)", label: "unauthorized ⚿" },
};
const repoName = (p: string) => p.split("/").pop() || p;

// xterm draws in its own DOM — resolve theme vars to concrete colors for it.
const rootStyle = () => getComputedStyle(document.documentElement); // one style-recalc per read batch
const readVar = (s: CSSStyleDeclaration, name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
const alpha = (hex: string, a: string) => (/^#[0-9a-fA-F]{6}$/.test(hex) ? hex + a : hex);
function themeFromCss() {
  const s = rootStyle();
  const bg = readVar(s, "--bg", "#0d1117");
  return {
    background: bg,
    foreground: readVar(s, "--text2", "#c8ccd4"),
    cursor: readVar(s, "--primary", "#a78bfa"),
    cursorAccent: bg,
    selectionBackground: alpha(readVar(s, "--primary", "#a78bfa"), "44"),
    black: "#5b6472", red: "#f06c75", green: "#98c379", yellow: "#e5c07b",
    blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#c8ccd4",
    brightBlack: "#7f8896", brightRed: "#ff7b86", brightGreen: "#b5e08f", brightYellow: "#f0d08a",
    brightBlue: "#82c0ff", brightMagenta: "#d79be8", brightCyan: "#7fd6df", brightWhite: "#ffffff",
  };
}
const TERM_FONT = '"JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", "JetBrains Mono", "SF Mono", ui-monospace, "Cascadia Code", "Fira Code", Menlo, Monaco, "Roboto Mono", Consolas, "Liberation Mono", monospace';

// --- persistent per-repo shell sessions (outlive the panel) ------------------
type SessStatus = "idle" | "connecting" | "live" | "exited" | "error" | "unauthorized";
type Sess = {
  id: string;             // many shells can share a repo, so the id is the key
  root: string;
  title: string;
  term: Terminal;
  fit: FitAddon;
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

const sessions = new Map<string, Sess>();
let seq = 0;
/** Shells for one repo, in creation order. */
const sessionsFor = (root: string) => [...sessions.values()].filter((s) => s.root === root).sort((a, b) => a.createdAt - b.createdAt);
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
    raf = requestAnimationFrame(() => { try { s.term.options.theme = themeFromCss(); } catch { /* disposed */ } });
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
      if (f.mode === "pipe") s.term.writeln("\x1b[2m(no pty available on this host — plain-pipe shell: TUI apps won't render)\x1b[0m");
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
  const term = new Terminal({
    fontFamily: readVar(rootStyle(), "--font-mono", "") ? `var(--font-mono), ${TERM_FONT}` : TERM_FONT,
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
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
  // Shift+Esc closes the panel — plain Esc belongs to the shell (vim, fzf…).
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === "keydown" && e.key === "Escape" && e.shiftKey) { panelClose(); return false; }
    return true;
  });
  const holder = document.createElement("div");
  holder.style.cssText = "width:100%;height:100%";
  const id = `t${++seq}-${Date.now().toString(36)}`;
  const sess: Sess = { id, root, title: `shell ${sessionsFor(root).length + 1}`, term, fit, holder, ws: null, status: "idle", mode: null, shell: "shell", canResize: true, opened: false, tmux: false, tmuxWindows: [], tmuxSession: null, tmuxPrefix: [], tmuxPrefixAt: 0, pending: [], createdAt: Date.now(), lastUsed: Date.now(), retries: 0, retryTimer: null, subs: new Set() };
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

/** Type a command into the repo's shell (starting one if needed). */
function runInShell(s: Sess, cmd: string) {
  const line = cmd + "\r";
  s.lastUsed = Date.now();
  if (s.status === "live" && s.ws?.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ t: "in", d: line }));
  else { s.pending.push(line); if (!s.ws) connect(s); }
  s.term.focus();
}

/**
 * Type a command into the docked console, opening its shell if needed.
 *
 * Finds the session the same way ConsoleStrip does — by title, per repo — so
 * calling this before the strip has mounted converges on one shell rather than
 * racing it into two. `runInShell` queues into `pending` when the socket is not
 * up yet, so the command still runs once it connects.
 */
export function runInConsole(root: string, cmd: string) {
  if (!root || IS_DEMO) return;
  const existing = sessionsFor(root).find((x) => x.title === CONSOLE_TITLE);
  const s = existing ?? createSession(root);
  s.title = CONSOLE_TITLE;
  runInShell(s, cmd);
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
  useDismiss(repoOpen, pickerRef, () => { setRepoOpen(false); setRepoQuery(""); });
  // On demand: the Docker panel mounts this strip on every open, and most opens
  // never touch the picker.
  useEffect(() => {
    if (!repoOpen || repos.length || IS_DEMO) return;
    api.gitRepos().then(({ repos: r }) => setRepos(r)).catch(() => {});
  }, [repoOpen, repos.length]);
  const chooseRepo = (next: string) => {
    setPicked(next);
    try { localStorage.setItem(CONSOLE_ROOT_KEY, next); } catch { /* private mode — lasts the session */ }
    setRepoOpen(false); setRepoQuery("");
  };
  const runHere = useCallback((cmd: string) => {
    const s = sessions.get(sid);
    if (!s || IS_DEMO) return;
    runInShell(s, cmd);
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
          <button onClick={() => setRepoOpen((o) => !o)} disabled={IS_DEMO}
            className="flex items-center gap-1.5 text-[10px] px-2 py-0.5 rounded-md max-w-[200px]"
            style={{ background: "color-mix(in srgb, var(--bg3) 60%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text2)" }}
            title={root || "no repo"}>
            <span className="truncate">{root ? repoName(root) : "no repo"}</span><span className="t-dim2">▼</span>
          </button>
          {repoOpen && (
            <div className="absolute left-0 rounded-lg text-[11px] shadow-2xl flex flex-col"
              style={{ zIndex: 40, bottom: "calc(100% + 4px)", background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)", minWidth: 320, maxHeight: 360, overflow: "hidden" }}>
              <input autoFocus value={repoQuery} onChange={(e) => setRepoQuery(e.target.value)} placeholder="filter repos…"
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
                {!repos.length && <div className="px-3 py-2 t-dim2">reading repos…</div>}
              </div>
            </div>
          )}
        </div>

        {sess && <span className="text-[9px] shrink-0" style={{ color: SESS_DOT[sess.status].color }}>● {SESS_DOT[sess.status].label}</span>}

        {/* The same control the terminal view mounts — commands and pins, one
            component, so the two shells cannot drift apart again. Opens upward:
            there is nothing below this strip to open into. */}
        <div className="flex items-center gap-2 min-w-0" onMouseDown={(e) => e.stopPropagation()}>
          <CommandBar root={root} disabled={!sid} font={TERM_FONT} onRun={runHere} dropUp />
        </div>

        <span className="ml-auto text-[9px] t-dim2 shrink-0">drag to resize</span>
        <button onClick={(e) => { e.stopPropagation(); onClose(); }} onMouseDown={(e) => e.stopPropagation()} className="text-[12px] leading-none px-1.5 t-dim2 hover:opacity-70 shrink-0" title="hide the console (the shell keeps running)">✕</button>
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

  useDismiss(repoOpen, pickersRef, () => setRepoOpen(false));

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

  const tabs = !IS_DEMO && root ? sessionsFor(root) : [];

  // Every repo opens with a shell, and the panes always name shells that still
  // exist — closing one must not leave an empty frame behind.
  useEffect(() => {
    if (!open || !root || IS_DEMO) return;
    const live = sessionsFor(root);
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

  useEffect(() => {
    if (!open || IS_DEMO) return;
    panelClose = () => closeRef.current();
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
      const spare = sessionsFor(root).find((s) => !prev.includes(s.id)) ?? createSession(root);
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
      const next = sessionsFor(r)[0] ?? createSession(r);
      return [next.id];
    });
    setFocusIdx(0);
  }, []);

  const run = useCallback((cmd: string) => {
    if (!root || IS_DEMO) return;
    const s = sessions.get(paneIds[focusIdx] ?? "") ?? createSession(root);
    runInShell(s, cmd);
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
    idle: { color: "var(--text2)", label: "idle" },
    connecting: { color: "var(--warning)", label: "connecting…" },
    live: { color: "var(--success, #98c379)", label: sess ? `${sess.shell} · ${sess.mode === "pipe" ? "pipe" : "pty"}${sess.mode !== "pipe" && !sess.canResize ? " · fixed size" : ""}` : "live" },
    exited: { color: "var(--text2)", label: "exited" },
    error: { color: "var(--error)", label: "disconnected" },
    unauthorized: { color: "var(--error)", label: "unauthorized ⚿" },
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
                {/* The plan meters moved to the workspace's DynamicIsland, which
                    covers every view now rather than only the terminal. */}
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
                  <div ref={pickersRef} className="flex items-center gap-3">
                  <div className="relative">
                    <button onClick={() => setRepoOpen((o) => !o)} className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg" style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text)" }}>
                      <span className="font-medium">{repoRef ? repoName(repoRef.root) : "pick a repo"}</span><span className="t-dim2">▼</span>
                    </button>
                    {repoOpen && (
                      /* Wide enough for the whole worktree name and its branch.
                         It used to be 320px with the branch clipped at 150, so
                         a card-per-worktree checkout showed as "orbit-WEB-1042"
                         beside an elided branch — the two pieces that tell them
                         apart, both cut off. Source control shows them in full;
                         this now matches it. */
                      <div className="absolute left-0 mt-1 rounded-lg text-[11px] shadow-2xl flex flex-col" style={{ zIndex: 30, background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)", minWidth: 460, maxWidth: "min(86vw, 760px)", maxHeight: 420, overflow: "hidden" }}>
                        <input autoFocus value={repoQuery} onChange={(e) => setRepoQuery(e.target.value)} placeholder="filter repos…" className="m-1.5 px-2.5 py-1.5 rounded-md text-[11px] outline-none shrink-0" style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text)" }} />
                        <div className="agx-scroll overflow-y-auto pb-1" style={{ minHeight: 0 }}>
                          {/* The path is searchable too: with a worktree per card,
                              "20343" is how you find one — it's in the directory
                              name and the branch, not in the project name. */}
                          {repos.filter((r) => { const q = repoQuery.trim().toLowerCase(); return !q || (r.name + " " + r.branch + " " + r.root).toLowerCase().includes(q); }).map((r) => {
                            const live = sessionsFor(r.root).some((s) => s.status === "live");
                            return (
                              <button key={r.root} onClick={() => { setRoot(r.root); setRepoOpen(false); setRepoQuery(""); }} className="w-full text-left px-2.5 py-1.5 flex items-center gap-2" style={{ background: r.root === root ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent" }}>
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
                                  title={r.worktreeOf ? `worktree of ${r.worktreeOf}` : "main checkout"}
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
                                  {live && <span title="live shell" style={{ color: "var(--success, #98c379)" }}> ●</span>}
                                </span>
                                {!r.worktreeOf && <span className="shrink-0 truncate t-dim2 text-[9.5px]" style={{ maxWidth: 150 }} title={r.branch}>{r.branch}</span>}
                                {r.dirty > 0 && <span className="shrink-0 text-[9px] tabular-nums" style={{ color: "var(--warning)" }} title={`${r.dirty} changed file${r.dirty === 1 ? "" : "s"}`}>●{r.dirty}</span>}
                                {r.behind > 0 && <span className="shrink-0 text-[9px] tabular-nums" style={{ color: "var(--warning)" }} title={`${r.behind} behind upstream`}>↓{r.behind}</span>}
                                {r.ahead > 0 && <span className="shrink-0 text-[9px] tabular-nums" style={{ color: "var(--success)" }} title={`${r.ahead} ahead of upstream`}>↑{r.ahead}</span>}
                              </button>
                            );
                          })}
                          {!repos.length && <div className="px-3 py-2 t-dim2">no repos seen yet</div>}
                        </div>
                      </div>
                    )}
                  </div>

                  </div>

                  {/* Commands and pins — the same control the docked console
                      mounts, so the two shells offer the same thing. Its own
                      dropdown state lives inside it, which is why it sits
                      outside the pickers group above. */}
                  <CommandBar root={root} disabled={disabled} font={TERM_FONT} onRun={run} />

                  <div className="ml-auto flex items-center gap-1.5 shrink-0">
                    <span onClick={status === "unauthorized" ? reauthPrompt : undefined}
                      className={`flex items-center gap-1.5 text-[10px] t-dim2 mr-1 ${status === "unauthorized" ? "cursor-pointer" : ""}`}
                      title={status === "unauthorized" ? "this server needs an access token — click to enter it" : "shell status"}>
                      <span style={{ color: statusDot[status].color }}>●</span>{statusDot[status].label}
                    </span>
                    {!tmuxActive && <button onClick={splitPane} disabled={!root || IS_DEMO || disabled || paneIds.length >= 4} title="show another shell beside this one" className="text-[11px] px-2 py-1 rounded-lg" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)", opacity: paneIds.length >= 4 ? 0.45 : 1 }}>⊞ split</button>}
                    <button onClick={restart} disabled={!root || IS_DEMO || disabled} title="kill this shell and start a fresh one" className="text-[11px] px-2 py-1 rounded-lg" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>⟲ restart</button>
                    <button onClick={() => sess?.term.clear()} className="text-[11px] px-2 py-1 rounded-lg" style={{ color: "var(--text2)" }}>clear</button>
                  </div>
                </div>

                {/* shells open in this repo — scrolls, so the count can grow */}
                {!IS_DEMO && !disabled && !tmuxActive && (
                  <div className="shrink-0 flex items-center gap-1 px-3 py-1 border-b overflow-x-auto agw-noscrollbar" style={{ borderColor: "color-mix(in srgb, var(--border) 30%, transparent)" }}>
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
                          <button onClick={(e) => { e.stopPropagation(); closeShell(t.id); }} className="opacity-0 group-hover:opacity-100 leading-none px-0.5" title="close shell">✕</button>
                        </div>
                      );
                    })}
                    <button onClick={addShell} className="shrink-0 px-2 py-1 rounded-md text-[10.5px]" style={{ color: "var(--text3)" }} title="new shell in this repo">+</button>
                  </div>
                )}

                {/* tmux's windows, as our own tabs.
                    Same shape as the shell tabs above on purpose: from the
                    user's side this is the same control, and which program is
                    behind it should not change how the workspace looks. */}
                {tmuxActive && tmuxWindows.length > 0 && (
                  <div className="shrink-0 flex items-center gap-1 px-3 py-1 border-b overflow-x-auto agw-noscrollbar" style={{ borderColor: "color-mix(in srgb, var(--border) 30%, transparent)" }}>
                    <span
                      title={prefixLive ? "tmux is waiting for the rest of the sequence" : `tmux prefix: ${(sess?.tmuxPrefix ?? []).join(" or ") || "unknown"}`}
                      className="shrink-0 px-1.5 py-1 rounded-md text-[10px] font-semibold tabular-nums transition-colors duration-75"
                      style={prefixLive
                        ? { background: "var(--primary)", color: "var(--bg2)" }
                        : { color: "var(--text4)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>
                      {(sess?.tmuxPrefix[0] ?? "tmux")}
                    </span>
                    {tmuxWindows.map((w) => {
                      // tmux's own marks, straight through: `!` is a bell, `#`
                      // is activity in a window you are not looking at. Both
                      // mean "something happened over here", which is the whole
                      // reason the strip is worth looking at at all.
                      const alerting = w.flags.includes("!") || w.flags.includes("#");
                      return (
                        <div key={w.id}
                          onClick={() => { if (w.id !== activeWindow) { setPendingWindow(w.id); tmuxCmd("select", { window: w.id }); } }}
                          onDoubleClick={() => setRenaming(w.id)}
                          title={`window ${w.index}${w.flags ? ` (${w.flags})` : ""} — double-click to rename`}
                          className="group flex items-center gap-1.5 px-2 py-1 rounded-md text-[10.5px] cursor-pointer shrink-0"
                          style={w.id === activeWindow
                            ? { background: "color-mix(in srgb, var(--primary) 20%, transparent)", color: "var(--primary-hover)" }
                            : { background: "color-mix(in srgb, var(--bg3) 55%, transparent)", color: "var(--text2)" }}>
                          <span className="tabular-nums" style={{ color: "var(--text4)" }}>{w.index}</span>
                          {renaming === w.id ? (
                            <input
                              autoFocus
                              defaultValue={w.name}
                              onClick={(e) => e.stopPropagation()}
                              onBlur={() => setRenaming(null)}
                              onKeyDown={(e) => {
                                if (e.key === "Escape") { setRenaming(null); return; }
                                if (e.key !== "Enter") return;
                                const name = (e.target as HTMLInputElement).value.trim();
                                if (name && name !== w.name) tmuxCmd("rename", { window: w.id, name });
                                setRenaming(null);
                              }}
                              className="bg-transparent outline-none w-20 text-[10.5px]"
                              style={{ color: "var(--text)", borderBottom: "1px solid color-mix(in srgb, var(--primary) 60%, transparent)" }}
                            />
                          ) : (
                            <span>{w.name || "shell"}</span>
                          )}
                          {alerting && <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--warning)" }} title="activity" />}
                          <button onClick={(e) => { e.stopPropagation(); tmuxCmd("kill", { window: w.id }); }}
                            className="opacity-0 group-hover:opacity-100 leading-none px-0.5" title="close window (kill-window)">✕</button>
                        </div>
                      );
                    })}
                    <button onClick={() => tmuxCmd("new")} className="shrink-0 px-2 py-1 rounded-md text-[10.5px]" style={{ color: "var(--text3)" }} title="new tmux window (^b c)">+</button>
                    <button onClick={() => setTmuxBar((v) => !v)} className="ml-auto shrink-0 px-2 py-1 rounded-md text-[10px]" style={{ color: "var(--text3)" }}
                      title={tmuxBar ? "hide tmux's own status line for this session" : "show tmux's own status line again"}>
                      {tmuxBar ? "hide tmux bar" : "show tmux bar"}
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
                      {IS_DEMO ? "the terminal is disabled in the demo — run agentglass locally for a real shell" : "terminal disabled (AGENTGLASS_TERMINAL_DISABLED=1)"}
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
                      <span>panel chrome hidden — tmux owns the panes</span>
                      <span className="t-dim2">·</span>
                      <b style={{ color: "var(--text2)" }}>^b c</b><span>window</span>
                      <b style={{ color: "var(--text2)" }}>^b "</b><span>split ↓</span>
                      <b style={{ color: "var(--text2)" }}>^b %</b><span>split →</span>
                      <b style={{ color: "var(--text2)" }}>^b o</b><span>next pane</span>
                      <b style={{ color: "var(--text2)" }}>^b z</b><span>zoom</span>
                      <b style={{ color: "var(--text2)" }}>^b d</b><span>detach</span>
                      <b style={{ color: "var(--text2)" }}>^b ?</b><span>all keys</span>
                    </span>
                  ) : (
                    <span>real shell — Ctrl+C, Ctrl+R, Tab-complete, vim/htop all work · sessions survive closing this panel · Shift+Esc closes it</span>
                  )}
                  <span className="ml-auto">{sess ? `${sess.term.cols}×${sess.term.rows}` : ""}</span>
                </div>
    </div>
  );
}


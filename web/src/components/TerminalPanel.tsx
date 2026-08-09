// In-browser terminal — a REAL machine terminal (xterm.js ⇄ WebSocket ⇄ PTY).
// The server spawns your login shell inside a pseudo-terminal per repo/worktree,
// so everything a local terminal does works here: job control, Ctrl+C/Ctrl+R,
// tab-completion, colors, vim/htop/lazygit. Shell sessions are kept alive in a
// module-level store, so closing the panel (or switching repos) never kills a
// running job — reopening reattaches to the live session, scrollback intact.
import { Fragment, useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { subscribeTermReview, termReview, clearTermReview } from "../lib/termReview.ts";
import { subscribeTermIssue, termIssue, clearTermIssue, type TermIssue } from "../lib/termIssue.ts";
import { useDismiss } from "../lib/useDismiss.ts";
import { dirName } from "../lib/worktree.ts";
import { requestWorktreeJump } from "../lib/worktreeJump.ts";
import { useDialogs } from "./ConfirmDialog.tsx";
import { checkoutConfirm, needsCheckoutConfirm } from "../lib/checkoutWarning.ts";
import { keepTermFocus } from "../lib/keepFocus.ts";
import { focusFollowsMouse, subscribeFocusFollowsMouse, shouldFocusOnHover } from "../lib/termFocusPref.ts";
import { cellAt, paneAt } from "../lib/tmuxHover.ts";
import { viewHeaderClass, viewHeaderStyle } from "./workspace/ViewHeader.tsx";
import { CheckoutPicker } from "./CheckoutPicker.tsx";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { CanvasAddon } from "@xterm/addon-canvas";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { answerDecrqm } from "../lib/xtermDecrqm.ts";
import { openExternal } from "../lib/externalUrl.ts";
import type { GitRepoRef, GitBranch, PrBranchSummary, TerminalCommands, TmuxWindow, TmuxPane, PtyServerFrame, PtyClientFrame } from "../../../shared/types.ts";
import { chipTarget } from "../lib/chipTarget.ts";
import { openPr } from "../lib/openPrs.ts";
import { api, IS_DEMO, ptyWsUrl, hasToken, probeAuth, reauthPrompt } from "../lib/api.ts";
import { playDemoSession } from "../lib/demoTerm.ts";
import { CommandBar, loadCommands } from "./CommandBar.tsx";
import { SCROLLBAR_CSS } from "./ChangesModal.tsx";
import { wantsWebgl, wantsCanvas, fallBackToCanvas } from "../lib/termRenderer.ts";
import { isFindChord, isAppChord } from "../lib/termKeys.ts";
import { typingWouldLandInApp } from "../lib/termForeground.ts";
import { THEMES } from "../lib/themes.ts";
import { deriveAnsi } from "../lib/termPalette.ts";
import { termOptions, copyOnSelect, rightClickPaste } from "../lib/termPrefs.ts";
import { useModernWidths } from "../lib/termUnicode.ts";
import { dragHold } from "../lib/dragHold.ts";
import { mouseModeGuard, type MouseModeGuard } from "../lib/mouseModeGuard.ts";
import { CloseButton } from "./CloseButton.tsx";

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
  /** The server refused an open and said why. Read once by whoever asked and
   *  then cleared: it is an answer to a request, not a state of the shell. */
  openFail?: string | null;
  /** A one-use agent ticket this pane was created with, spent on first connect.
   *  Held rather than passed so a reconnect cannot try to spend it twice — the
   *  server would refuse the second, but a shell that silently became an agent
   *  on reconnect is worse than either. */
  agentTicket?: string | null;
  /** tmux's own windows, as tmux reports them. The panel draws these as tabs so
   *  the strip belongs to the app rather than to whatever .tmux.conf this
   *  machine carries; tmux still decides what is in it and which is active. */
  tmuxWindows: TmuxWindow[];
  /** The panes of the tmux window on screen, when it has more than one. Empty
   *  otherwise — see the server's sweep. */
  tmuxPanes: TmuxPane[];
  /** The session those windows belong to, for the status-line toggle. */
  tmuxSession: string | null;
  /** The grid tmux thinks THIS client has — the terminal on this desk, not the
   *  window it is drawing. They are the same number until something smaller
   *  attaches to the same session, which is the whole reason it is on the wire:
   *  the window's own size says nothing without the size it should have been. */
  tmuxClient: { cols: number; rows: number } | null;
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

/**
 * Fits owed to terminals the user is currently dragging inside.
 *
 * Reported as two bugs and it is one: a selection dragged up a pane stops on
 * its own halfway through the paragraph, and a tmux divider dragged sideways
 * stops halfway and needs grabbing again. Both gestures live entirely inside
 * tmux — with mouse mode on, xterm reports the pointer to the shell and tmux is
 * what selects and what resizes — and both end the instant tmux's client
 * changes size. `fitTerm` is that resize: it calls `term.resize()`, whose
 * `onResize` sends the new grid to the server, which SIGWINCHes the shell.
 *
 * Measured against a real tmux over a real pty, with the drag sent as the exact
 * SGR reports xterm produces: a 30-column divider drag moves 30 columns
 * untouched and 13 with one resize dropped in at column 15; a 25-row selection
 * holds all 25 rows untouched and 11 with one resize dropped in at row 12. In
 * both the drag dies exactly where the resize landed.
 *
 * The refit is not wrong, only badly timed — so it waits for the button rather
 * than being dropped. What arms this is a mousedown on a terminal's own holder,
 * so the panel's own drags (the console strip's top edge) still refit live as
 * they always have: those resize the slot on purpose and nothing is mid-gesture
 * inside the shell.
 */
const fitHold = dragHold<Sess>((s) => fitTerm(s));

/**
 * The second way a drag dies, which is not the panel's doing but is the panel's
 * to survive: xterm unbinds the `document` listener that reports the drag as
 * soon as the shell turns mouse tracking off, and putting the mode back does
 * not put the listener back. See mouseModeGuard for the measurement. One guard
 * per session, because the byte stream it filters is per terminal.
 */
const modeGuards = new Map<Sess, MouseModeGuard>();
const guardFor = (s: Sess) => {
  let g = modeGuards.get(s);
  if (!g) { g = mouseModeGuard(); modeGuards.set(s, g); }
  return g;
};

/** Released on the window rather than the element: a drag ends wherever the
 *  pointer happens to be by then, which is regularly outside the terminal it
 *  started in. `blur` too, because a window that loses focus mid-drag (an
 *  alt-tab, a dialog from another app) never sees the mouseup at all, and a
 *  latch left set would hold every fit for the rest of the session. */
function releaseTermDrag() {
  window.removeEventListener("mouseup", releaseTermDrag);
  window.removeEventListener("blur", releaseTermDrag);
  fitHold.end();
  // Hand the terminals back whatever was withheld from them, now that there is
  // no gesture left for it to interrupt.
  for (const [s, guard] of modeGuards) {
    const held = guard.flush();
    if (held.length) try { s.term.write(held); } catch { /* disposed mid-drag */ }
  }
}
function armTermDrag() {
  if (fitHold.active()) return;
  fitHold.begin();
  window.addEventListener("mouseup", releaseTermDrag);
  window.addEventListener("blur", releaseTermDrag);
}

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
//
// What it spares beyond that is what is ON SCREEN. It used to spare everything
// sharing the root of the shell being created, which worked only while the
// terminal had a repo picker and shells came in per-repo pools: with one root
// for the whole view, that clause spared every session there is and the ceiling
// quietly stopped applying. Panes are the honest version of the same intent —
// "don't close what I am looking at" — and they were what it meant all along.
const MAX_CLIENT_SESSIONS = 60;
/** Ids currently mounted in a pane, kept here because eviction is module-level
 *  and the panes are the view's state. Written by the view on every layout
 *  change; empty before it mounts, which is also when nothing is on screen. */
let onScreen: readonly string[] = [];
export function setOnScreenSessions(ids: readonly string[]): void { onScreen = ids; }
function evictLru() {
  if (sessions.size < MAX_CLIENT_SESSIONS) return;
  let lru: Sess | null = null;
  for (const s of sessions.values()) {
    if (onScreen.includes(s.id) || s.status === "live" || s.status === "connecting") continue;
    if (!lru || s.lastUsed < lru.lastUsed) lru = s;
  }
  if (!lru) return;
  const ws = lru.ws;
  lru.ws = null; // detach first so its handlers see a stale socket and stay quiet
  // An evicted session must not resurrect itself from a pending retry.
  if (lru.retryTimer) { clearTimeout(lru.retryTimer); lru.retryTimer = null; }
  try { ws?.close(); } catch { /* already gone */ }
  stopDemoFor(lru.id);
  try { lru.term.dispose(); } catch { /* already disposed */ }
  lru.holder.remove();
  sessions.delete(lru.id);
  rosterChanged();
}

/**
 * The demo's canned session, and the two things that have to be remembered
 * about it: which sessions have already played it, and how to stop one.
 *
 * Module scope rather than component state, because `sessions` is module scope
 * too — the panel unmounts and remounts as views are switched while a terminal
 * outlives it, and a replay tracked in a hook would restart on every remount.
 * A timer chain that writes into a disposed xterm throws from a callback nobody
 * is awaiting, so eviction and close both stop it first.
 */
const demoPlayed = new Set<string>();
const stopDemo = new Map<string, () => void>();
function stopDemoFor(id: string) {
  const stop = stopDemo.get(id);
  if (!stop) return;
  stop();
  stopDemo.delete(id);
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
        // Line height changes the cell, so it refits for the same reason the
        // font does: the grid is laid out on a cell measured once.
        const needFit = s.term.options.fontFamily !== o.fontFamily || s.term.options.fontSize !== o.fontSize
          || s.term.options.lineHeight !== o.lineHeight;
        if (s.term.options.fontFamily !== o.fontFamily) s.term.options.fontFamily = o.fontFamily;
        if (s.term.options.fontSize !== o.fontSize) s.term.options.fontSize = o.fontSize;
        if (s.term.options.lineHeight !== o.lineHeight) s.term.options.lineHeight = o.lineHeight;
        if (s.term.options.cursorStyle !== o.cursorStyle) s.term.options.cursorStyle = o.cursorStyle;
        // Live, both of them: shrinking the scrollback trims the buffer, and a
        // word boundary is read on the next double click. Neither touches the
        // cell box, so neither needs a refit.
        if (s.term.options.scrollback !== o.scrollback) s.term.options.scrollback = o.scrollback;
        if (s.term.options.wordSeparator !== o.wordSeparator) s.term.options.wordSeparator = o.wordSeparator;
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

/**
 * A client frame out, as a string.
 *
 * The other half of the protocol had no declaration either: every send below
 * built its own object literal, so the desk and the phone and the server each
 * described `{t:"tmux", cmd:…}` separately and none of them could contradict
 * another. Going through here costs nothing — the guards each caller already
 * has are untouched — and buys the compiler a say in what leaves this file.
 */
const ptyFrame = (frame: PtyClientFrame): string => JSON.stringify(frame);

function connect(s: Sess) {
  if (s.ws || IS_DEMO) return;
  s.status = "connecting";
  notify(s);
  const ticket = s.agentTicket ?? undefined;
  // Spent here, not on arrival: a reconnect after a drop must open a shell,
  // not start the agent a second time in the same worktree.
  s.agentTicket = null;
  const ws = new WebSocket(ptyWsUrl(s.root, s.term.cols, s.term.rows, undefined, false, ticket));
  ws.binaryType = "arraybuffer";
  s.ws = ws;
  ws.onmessage = (ev) => {
    if (s.ws !== ws) return; // a stale socket (replaced by ⟲ new shell) must not touch the session
    if (typeof ev.data !== "string") {
      const bytes = new Uint8Array(ev.data as ArrayBuffer);
      // Only while the user is dragging inside a terminal — see mouseModeGuard.
      // Every other chunk of every other second goes through untouched.
      s.term.write(fitHold.active() ? guardFor(s).filter(bytes) : bytes);
      return;
    }
    /*
     * The protocol, from the one declaration of it.
     *
     * This was a bag of optional fields written out here, and the phone had its
     * own — a different one. Neither could be wrong about a frame it did not
     * name: this end declared no `pane`, no `fit` and no `by`, so the whole
     * `t:"pane"` frame could have changed shape and nothing on this side would
     * have said a word. Narrowing on `t` against the union is also what makes
     * each field readable only from the frame that carries it.
     */
    let f: PtyServerFrame;
    try { f = JSON.parse(ev.data) as PtyServerFrame; } catch { return; }
    if (f.t === "ready") {
      reconnected(s);
      s.status = "live"; s.mode = f.mode ?? null; s.shell = f.shell || "shell"; s.canResize = f.resize !== false;
      // Names the cure, not only the symptom: this mode is what a host with no
      // python3 gets, and "TUI apps won't render" alone left people believing
      // the terminal itself was broken.
      if (f.mode === "pipe") s.term.writeln("\x1b[2m(no pty on this host: plain-pipe shell, full-screen programs won't render. Install python3 and reopen; Settings ▸ Requirements has the details.)\x1b[0m");
      for (const d of s.pending.splice(0)) ws.send(ptyFrame({ t: "in", d }));
      // the fit that ran while connecting may not have reached the server
      ws.send(ptyFrame({ t: "resize", cols: s.term.cols, rows: s.term.rows }));
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
      s.tmuxPanes = Array.isArray(f.panes) ? f.panes : [];
      s.tmuxSession = typeof f.session === "string" ? f.session : null;
      s.tmuxClient = f.client ?? null;
      s.tmuxPrefix = Array.isArray(f.prefix) ? f.prefix : [];
      notify(s);
    } else if (f.t === "openfail") {
      // Not fatal to the shell — the socket is fine and this pane keeps
      // working. It is an answer to something that was asked, so it is recorded
      // for the asker and also written where the person is looking.
      s.openFail = f.error || "could not open that";
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
function createSession(root: string, agentTicket?: string): Sess {
  evictLru();
  const tp = termOptions();
  const term = new Terminal({
    fontFamily: tp.fontFamily,
    fontSize: tp.fontSize,
    lineHeight: tp.lineHeight,
    cursorBlink: true,
    // Required before a custom width table can be registered, and harmless
    // otherwise — see termUnicode.
    allowProposedApi: true,
    cursorStyle: tp.cursorStyle,
    // Scrollback and word boundaries are preferences now — see termPrefs for
    // what each costs and why the default is what it is.
    scrollback: tp.scrollback,
    wordSeparator: tp.wordSeparator,
    theme: themeFromCss(),
    macOptionIsMeta: true,
  });
  // Before anything is written: the width table decides how many columns each
  // character claims, and a line already parsed under the old one keeps the
  // widths it was parsed with.
  useModernWidths(term);
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
      // off the GPU app-wide and remember it — to canvas, not the slow DOM
      // renderer — so no new shell hits it and none crawls either.
      gl.onContextLoss(() => { fallBackToCanvas(); try { gl.dispose(); } catch { /* already gone */ } });
      term.loadAddon(gl);
    } catch { /* no WebGL2 here — canvas below, or the DOM renderer */ }
  } else if (wantsCanvas()) {
    // Not a consolation prize for missing a GPU: this is the renderer that
    // draws box-drawing characters itself, so `│` between two tmux panes is a
    // line rather than whatever the machine's fallback font happens to have.
    // The DOM renderer cannot do that, and which font you had chosen decided
    // whether your rules were solid. Failure here is not worth a word to the
    // user — the DOM renderer takes over and the shell never noticed.
    try { term.loadAddon(new CanvasAddon()); } catch { /* the DOM renderer stays */ }
  }
  // Shift+Esc closes the panel — plain Esc belongs to the shell (vim, fzf…).
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    if (e.key === "Escape" && e.shiftKey) { panelClose(); return false; }
    if (isFindChord(e) && panelFind()) return false;
    // The app's own chords — today the file palette. Returning false keeps the
    // keystroke out of the PTY; the window listener in App still sees it, so
    // the palette opens and the shell never hears about it.
    if (isAppChord(e)) return false;
    return true;
  });
  // Copy on select, the tmux way: the instant a selection is made it is on the
  // clipboard — no Ctrl+Shift+C, no right-click menu (a terminal has none), no
  // fighting the shell over Ctrl+C. A cleared selection (a plain click) returns
  // "" and is skipped, so clicking away never wipes what you just copied. Writes
  // may fail mid-drag if the document is momentarily unfocused; the settled
  // selection on mouse-up lands, and the failures are silent.
  term.onSelectionChange(() => {
    // Read at selection time rather than captured here: the switch has to take
    // effect on the next drag, not on the next shell.
    if (!copyOnSelect()) return;
    const sel = term.getSelection();
    if (sel) navigator.clipboard?.writeText(sel).catch(() => { /* no clipboard permission */ });
  });
  const holder = document.createElement("div");
  // Every gesture that can be interrupted by a refit starts here — see fitHold.
  // On the holder rather than on xterm's own element because xterm calls
  // `preventDefault` on its mousedown, and because the holder is what outlives
  // a renderer swap.
  holder.addEventListener("mousedown", armTermDrag);
  // Opaque themed backing, so any frame where the renderer paints nothing (a
  // WebGL context loss, a swap to the DOM renderer) shows the terminal's own
  // background colour instead of a white flash.
  holder.style.cssText = "width:100%;height:100%;background:var(--bg)";
  /*
   * Right-click pastes, when asked for.
   *
   * Off by default because a right click opens a menu everywhere else in this
   * app, and a terminal that silently swallows it is a terminal you cannot get
   * a menu out of. Ctrl+right-click is left alone either way, so the menu is
   * always one modifier away.
   *
   * The text is written to the shell rather than to xterm's own paste path: the
   * pty is what needs the bytes, and this is the same route every other write
   * takes.
   */
  holder.addEventListener("contextmenu", (e) => {
    if (!rightClickPaste() || (e as MouseEvent).ctrlKey) return;
    e.preventDefault();
    navigator.clipboard?.readText()
      .then((text) => { if (text) sess.ws?.send(JSON.stringify({ t: "d", d: text })); })
      .catch(() => { /* no clipboard permission — the menu stayed shut, nothing pasted */ });
  });
  const id = `t${++seq}-${Date.now().toString(36)}`;
  const sess: Sess = { id, root, title: `shell ${sessionsFor(root).length + 1}`, term, fit, search, holder, ws: null, status: "idle", mode: null, shell: "shell", canResize: true, opened: false, tmux: false, openFail: null, agentTicket: agentTicket ?? null, tmuxWindows: [], tmuxPanes: [], tmuxSession: null, tmuxClient: null, tmuxPrefix: [], tmuxPrefixAt: 0, pending: [], createdAt: Date.now(), lastUsed: Date.now(), retries: 0, retryTimer: null, subs: new Set() };
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
    if (sess.status === "live" && sess.ws?.readyState === WebSocket.OPEN) sess.ws.send(ptyFrame({ t: "in", d }));
    else if (sess.status === "connecting") sess.pending.push(d); // don't drop keys typed before the shell is up
    else if (sess.status === "unauthorized" && d.includes("\r")) reauthPrompt(); // Enter → re-enter the token
    else if ((sess.status === "exited" || sess.status === "error") && d.includes("\r")) { sess.retries = 0; connect(sess); } // Enter → new shell, scrollback kept
  });
  term.onResize(({ cols, rows }) => {
    if (sess.ws?.readyState === WebSocket.OPEN) sess.ws.send(ptyFrame({ t: "resize", cols, rows }));
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
  // Not while the user is dragging inside this terminal — see fitHold. The fit
  // is owed, not cancelled: it runs on the release, when there is no gesture
  // left for the SIGWINCH to interrupt.
  if (fitHold.hold(s)) return;
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
  stopDemoFor(s.id);
  modeGuards.delete(s);
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
      <CloseButton onClick={close} title="Close find (Esc)" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }} />
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
      <CloseButton onClick={onDismiss} title="Dismiss" className="shrink-0" />
    </div>
  );
}

/** A grid width in the "somebody took your columns" notice. The two numbers are
 *  the entire content of that sentence — everything around them is there to say
 *  which is which — so they are the only bright thing in the row. */
const Cols = ({ n }: { n: number }) => <b className="tabular-nums" style={{ color: "var(--text)" }}>{n}</b>;

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
  /*
   * tmux is the exception the guard has to make.
   *
   * `typingWouldLandInApp` exists so a command is never typed into vim or less,
   * where it would be read as keystrokes rather than run. tmux trips it — it is
   * a full-screen program by every test there is — but it is the one that hands
   * what you type straight to the shell in its active pane. So under tmux the
   * guard was answering a question nobody asked: not "will this land in an
   * application" but "is an application on screen", and refusing every command
   * with "was not typed. Send anyway".
   *
   * That made `keep running` and any saved recipe mutually exclusive, which is
   * the opposite of the point: a long build is exactly what you want in tmux.
   *
   * Only tmux, and only because the app already knows: `s.tmux` is set from
   * tmux's own report, not guessed from what the screen looks like. A pager
   * INSIDE a tmux pane is still a pager, and that is a real limit of this — the
   * guard cannot see through tmux to what is running in the pane.
   */
  if (!force && !s.tmux && typingWouldLandInApp(s.term.buffer.active)) return false;
  const line = cmd + "\r";
  s.lastUsed = Date.now();
  if (s.status === "live" && s.ws?.readyState === WebSocket.OPEN) s.ws.send(ptyFrame({ t: "in", d: line }));
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
/**
 * Whether the console for this checkout is already inside tmux.
 *
 * Exported because the button that puts it there needs to know not to do it
 * twice. Pressing again typed the command AT tmux rather than at a prompt, and
 * the panel's own full-screen guard then had to explain itself — a warning
 * about a keystroke nobody meant to send, over a state the button could simply
 * have read.
 */
export function consoleInTmux(root: string): boolean {
  if (!root) return false;
  return !!sessionsFor(root).find((x) => x.title === CONSOLE_TITLE)?.tmux;
}

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
  /** Whether a hover takes the keyboard — see lib/termFocusPref.ts. */
  const ffm = useSyncExternalStore(subscribeFocusFollowsMouse, focusFollowsMouse, () => false);
  /**
   * Which checkout this console is in — its own choice, falling back to the
   * terminal view's repo until someone makes one. Changing it swaps which
   * per-repo console session the strip is showing; the one you were in keeps
   * running, which is the same promise the strip already makes when you close
   * it.
   */
  const [picked, setPicked] = useState<string>(() => { try { return localStorage.getItem(CONSOLE_ROOT_KEY) || ""; } catch { return ""; } });
  /** The checkout menu has the keyboard, so focus-follows-mouse must leave it
   *  alone — hovering the shell while you are typing into the filter would drag
   *  the cursor out from under the letters. */
  const [pickerOpen, setPickerOpen] = useState(false);
  const root = picked || fallbackRoot;
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const { ask, dialog } = useDialogs();
  /** The row for the directory we are standing in — what "here" means, by name,
   *  what it currently holds, and whether it has uncommitted work in it. */
  const here = repos.find((r) => r.root === root) ?? null;
  /** Put the cursor back in the console after a menu that had to borrow the
   *  focus (the repo filter, the commands filter) closes again. Deferred a
   *  frame so it lands after the menu's own input has finished unmounting —
   *  otherwise the browser moves focus to <body> right after we set it. */
  const focusConsole = useCallback(() => {
    const s = sessions.get(sid);
    if (s) requestAnimationFrame(() => { try { s.term.focus(); } catch { /* disposed mid-frame */ } });
  }, [sid]);

  // Every time the picker OPENS — not once. The `repos.length` short-circuit was
  // a fetch-once, so a worktree cut after this strip first loaded never showed:
  // the list stayed frozen until a full app restart. Re-reading on each open is
  // cheap and is the only way new worktrees (and branches) appear here the way
  // they already do in Source control.
  const [branchData, setBranchData] = useState<{ current: string; branches: GitBranch[] }>({ current: "", branches: [] });
  const refreshPicker = useCallback(() => {
    if (IS_DEMO) return;
    api.gitRepos().then(({ repos: r }) => setRepos(r)).catch(() => {});
    if (root) api.gitBranches(root).then(setBranchData).catch(() => {});
  }, [root]);
  const chooseRepo = (next: string) => {
    setPicked(next);
    try { localStorage.setItem(CONSOLE_ROOT_KEY, next); } catch { /* private mode — lasts the session */ }
    focusConsole();
  };
  // A local branch with no worktree of its own: switch by checking it out in the
  // console's current directory, then refresh so the list reflects the move.
  const checkoutHere = async (name: string) => {
    // Never silently. See lib/checkoutWarning.ts for why each sentence is there.
    const t = { branch: name, dir: here?.name ?? root.split("/").pop() ?? root, displacing: here?.branch ?? null, dirty: here?.dirty ?? 0 };
    if (needsCheckoutConfirm(t) && !(await ask(checkoutConfirm(t)))) return;
    api.gitCheckout(root, name).then((r) => {
      if (!r.ok) return;
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
      {/* Rendered, or the question it asks is a promise nobody ever answers. */}
      {dialog}
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
        <div className="shrink-0" onMouseDown={(e) => e.stopPropagation()}>
          {/* keepTermFocus so opening the picker does not blur the console; the
              filter input inside autofocuses on its own, and closing hands the
              cursor back. */}
          <span onMouseDown={keepTermFocus}>
            <CheckoutPicker
              repos={repos} value={root} onPick={chooseRepo}
              branches={{ items: branchData.branches, onCheckout: checkoutHere }}
              onOpenChange={(o) => { setPickerOpen(o); if (o) refreshPicker(); }} onDismiss={focusConsole}
              disabled={IS_DEMO} placeholder="No repo" triggerMaxWidth={200}
              emptyLabel="Reading repos…"
            />
          </span>
        </div>

        {sess && <span className="text-[10px] shrink-0" style={{ color: SESS_DOT[sess.status].color }}>● {SESS_DOT[sess.status].label}</span>}

        {/* The same control the terminal view mounts — commands and pins, one
            component, so the two shells cannot drift apart again. Opens upward:
            there is nothing below this strip to open into. */}
        <div className="flex items-center gap-2 min-w-0" onMouseDown={(e) => e.stopPropagation()}>
          <CommandBar root={root} disabled={!sid} font={TERM_FONT} onRun={runHere} runTargetInTmux={consoleInTmux(root)} onClose={focusConsole} dropUp />
        </div>

        {blocked && (
          <div className="min-w-0" onMouseDown={(e) => e.stopPropagation()}>
            <BlockedNotice cmd={blocked} onSend={() => { runHere(blocked, true); setBlocked(null); }} onDismiss={() => setBlocked(null)} />
          </div>
        )}

        <span className="ml-auto text-[10px] t-dim2 shrink-0">Drag to resize</span>
        <CloseButton onClick={(e) => { e.stopPropagation(); onClose(); }} onMouseDown={(e) => e.stopPropagation()} title="Hide the console (the shell keeps running)" className="shrink-0" />
      </div>
      {/* The strip is a terminal pane too, and the one with the strongest case:
          it lives UNDER another panel, so you arrive at it from above every
          time. Same switch and the same guards — a picker open above it is
          somebody typing, and a held button is a selection being dragged. */}
      <div ref={slot} className="flex-1 min-h-0" style={{ background: "var(--bg)" }}
        onClick={() => sess?.term.focus()}
        onMouseEnter={(e) => {
          if (shouldFocusOnHover({ enabled: ffm, buttons: e.buttons, typing: pickerOpen, visible: open })) focusConsole();
        }} />
    </div>
  );
}

/**
 * The worktree the focused pane's agent is working in, read from what it prints.
 *
 * The process cwd is no help — every agent's shell, its `claude`, and their
 * children sit in the PARENT repo; the agent reaches into a worktree with
 * `git -C` and `cd` in subcommands without moving its own directory. But the
 * tool calls it prints DO name the checkout it edits (`Update(~/code/orbit-
 * WEB-1042/…)`), and that is on screen. So scan the scrollback bottom-up for the
 * most recently named worktree folder — matched as a whole path segment, so
 * `code/orbit` is not caught inside `code/orbit-WEB-1042`. Only linked worktrees
 * are candidates; the parent repo is the shell's own cwd (the noise) and never
 * what we mean. Null when nothing recognisable is there (a fresh agent, one in
 * the repo root), where the caller falls back to the picker.
 *
 * Best-effort by nature: it reads output, not a fact the app was handed. Bounded
 * to the last screens so a stale line from a tmux window switched away from does
 * not win over the window on screen now.
 */
function detectPaneWorktree(term: Terminal | undefined, worktrees: GitRepoRef[]): GitRepoRef | null {
  if (!term || !worktrees.length) return null;
  const cands = worktrees.map((r) => ({ r, leaf: dirName(r.root) }));
  const AFTER = "/ ):'\",";
  try {
    const buf = term.buffer.active;
    const top = buf.baseY + buf.cursorY;
    for (let y = top; y >= Math.max(0, top - 250); y--) {
      const line = buf.getLine(y)?.translateToString(true);
      if (!line) continue;
      for (const c of cands) {
        let i = line.indexOf(c.leaf);
        while (i >= 1) {
          const after = line[i + c.leaf.length];
          if (line[i - 1] === "/" && (after === undefined || AFTER.includes(after))) return c.r;
          i = line.indexOf(c.leaf, i + 1);
        }
      }
    }
  } catch { /* buffer not ready — fall back to the picker */ }
  return null;
}

/**
 * The pull request out of a branch, remembered for a minute.
 *
 * The chip re-asks whenever the focused pane changes worktree, and switching
 * between two tmux tabs is something you do several times a minute — without a
 * cache that is a GitHub call per switch, on a rate limit shared with the whole
 * PR panel. A minute is short enough that opening a pull request and coming
 * back shows it, and long enough that flipping between tabs costs nothing.
 *
 * Module-level, so it survives the panel being closed and reopened. Keyed by
 * root AND branch: the same branch name in two checkouts is two branches.
 */
const branchPrCache = new Map<string, { at: number; repo: string | null; pr: PrBranchSummary | null }>();
const BRANCH_PR_TTL = 60_000;

export function TermView({ active, onClose = () => {} }: { active: boolean; onClose?: () => void }) {
  const open = active;
  /** Whether a hover takes the keyboard — see lib/termFocusPref.ts. Subscribed
   *  rather than read once, so flipping the switch in Settings takes effect in
   *  the terminal you are looking at rather than at the next reload. */
  const ffm = useSyncExternalStore(subscribeFocusFollowsMouse, focusFollowsMouse, () => false);
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const { ask, dialog } = useDialogs();
  const [root, setRoot] = useState<string>(() => { try { return localStorage.getItem(ROOT_KEY) || ""; } catch { return ""; } });
  /** The row for the directory we are standing in — what "here" means, by name,
   *  what it currently holds, and whether it has uncommitted work in it.
   *
   *  Below the `root` it reads, and that is not a style point: it sat above,
   *  and `root` is a `const` from useState, so the lookup ran in its temporal
   *  dead zone and threw on the panel's first render — a white window for
   *  anyone whose last view was the terminal. tsc cannot see it because the
   *  read is inside the `find` callback, where it looks deferred. */
  const here = repos.find((r) => r.root === root) ?? null;
  /** Only whether the server allows commands at all — the list, its dropdown
   *  and the pins are the shared CommandBar's business now. */
  const [cmds, setCmds] = useState<TerminalCommands | null>(null);
  /** Both dropdowns live in here, so one listener can tell "clicked outside"
   *  from "clicked a row". */
  // The "jump to a worktree's git / changes" dropdown. Separate from the repo
  // picker above (which switches the terminal itself): this one leaves the
  // terminal where it is and takes you to Source control / File changes for the
  // chosen worktree — with the one the focused pane's agent is in pinned on
  // top, which is a question the server answers (see panewt.ts) rather than one
  // this end guesses from the pane's own directory: that is the parent repo for
  // every agent in a fleet, which is what made it look unanswerable.
  const [wtOpen, setWtOpen] = useState(false);
  const [wtQuery, setWtQuery] = useState("");
  const [wtShowAll, setWtShowAll] = useState(false);
  /** The worktree the focused pane's agent is working in — shown compact in the
   *  status bar and pinned atop the picker. */
  const [detectedWt, setDetectedWt] = useState<GitRepoRef | null>(null);
  /** No answer for the pane in front of you YET. Distinct from "no worktree":
   *  the first is a read in flight and says so, the second is silence. Without
   *  it a tab switch either kept the previous tab's worktree on screen or fell
   *  back to the panel's own checkout, and both are confident wrong answers. */
  const [wtDetecting, setWtDetecting] = useState(false);
  /** The tmux window+pane the current detection belongs to, so a read that comes
   *  up empty keeps the last worktree (an agent between turns names nothing)
   *  rather than flickering it away — but moving the focus starts fresh. */
  const detectedWinRef = useRef("");
  /** Focus key → the worktree root last read there. Coming back to a tab you
   *  have already been in answers from this instantly, so the "reading" state
   *  is only ever paid once per pane. */
  const wtSeen = useRef(new Map<string, string>());
  const wtRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // The value is used, not just the dispatch: a session is MUTATED in place
  // and notified through `subs`, so an effect watching `sess.openFail` has no
  // identity change to fire on. This tick is that change.
  const [sessTick, force] = useReducer((x: number) => x + 1, 0);

  /*
   * Where a new shell opens. Not a choice any more — the open project.
   *
   * `repos[0]` is that project: the scoped repo list leads with it and orders
   * the worktrees after. A remembered root that is no longer in the list is
   * DROPPED rather than kept, because a stale one from a previous scope would
   * silently open shells, and list commands, in a repo outside the project.
   */
  useEffect(() => {
    if (!open) return;
    api.gitRepos().then(({ repos }) => {
      setRepos(repos);
      setRoot((cur) => (cur && repos.some((r) => r.root === cur) ? cur : repos[0]?.root || ""));
    }).catch(() => {});
  }, [open]);
  /*
   * Still written, even though nobody picks it.
   *
   * The docked console falls back to this key when it has no pick of its own
   * (see `consoleRoot`). Dropping the write is what would silently break
   * `docker exec` and recipe runs on a profile that has never opened the
   * console's own picker — `runInConsole` just returns false, with no error and
   * no toast.
   */
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
  // Eviction is module-level and the panes are here, so it is told rather than
  // left to guess — see setOnScreenSessions.
  useEffect(() => { setOnScreenSessions(paneIds); }, [paneIds]);
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
  useDismiss(wtOpen, wtRef, () => { setWtOpen(false); setWtQuery(""); setWtShowAll(false); focusTerm(); });
  // Keep the focused pane's worktree fresh.
  //
  // The server answers first, from the agent's own working directory and the
  // transcript it is writing — see panewt.ts for why the screen cannot. The
  // scan of the terminal buffer stays behind it as a fallback, for a machine
  // whose agents do not report to this app at all: it can only add an answer
  // where there was none, and it is what this feature did on its own before.
  //
  // Polled rather than read on render because neither source changes in a way
  // React can see, and re-asked whenever the focused pane or the repo list
  // changes. Both ends are bounded — one tmux call and a cached tail.
  //
  // WHICH pane has the focus is not polled, though, and that was the bug: the
  // window id came off the same 4-second tick, so `^f n` moved the terminal
  // instantly and both worktree readouts sat on the previous tab's answer for
  // up to four seconds — long enough to read them, believe them, and click one.
  // tmux pushes the window and pane lists (~70ms after a switch redraws the
  // pane, see terminal.ts), so the focus is a value this render already holds:
  // read it here, key the effect on it, and the re-ask happens on the switch.
  const focusSess = sessions.get(paneIds[focusIdx] ?? "");
  const focusWin = focusSess?.tmuxWindows?.find((w) => w.active)?.id ?? "";
  // Panes are only reported while the window is split, so this is "" for an
  // unsplit window — which is right: there is nothing to move between. When
  // there is, `^f o` changes the answer without changing the window, and the
  // server reads the ACTIVE pane of the window it is given.
  const focusPane = focusSess?.tmuxPanes?.find((p) => p.active)?.id ?? "";
  const focusKey = focusWin ? `${focusWin}:${focusPane}` : "";
  useEffect(() => {
    if (!open || IS_DEMO) return;
    const project = here?.worktreeOf || here?.root || root;
    const cands = repos.filter((r) => r.worktreeOf && (r.worktreeOf || r.root) === project);
    /*
     * The focus moved. Answer from what this pane read last time if we have it,
     * and otherwise say we are reading.
     *
     * Done here, in the effect's body, rather than when the read comes back:
     * leaving the previous pane's worktree up while the new one is being read
     * is the wrong answer with a click target on it, and "Reading…" for the
     * ~100ms a first visit costs is the honest one.
     */
    if (focusKey !== detectedWinRef.current) {
      detectedWinRef.current = focusKey;
      const remembered = focusKey ? wtSeen.current.get(focusKey) : "";
      const known = remembered ? cands.find((r) => r.root === remembered) ?? null : null;
      setDetectedWt(known);
      setWtDetecting(!known);
    }
    let stopped = false;
    const run = async () => {
      const s = sessions.get(paneIds[focusIdx] ?? "");
      let d: GitRepoRef | null = null;
      if (focusWin) {
        try {
          const { dirs } = await api.paneDirs(focusWin);
          // In the order the server gave them: newest first, so an agent that
          // has moved between worktrees answers with the one it is in now.
          for (const p of dirs) {
            const hit = cands.find((r) => p === r.root || p.startsWith(r.root + "/"));
            if (hit) { d = hit; break; }
          }
        } catch { /* server busy or offline — the buffer scan below still works */ }
      }
      if (stopped) return;
      if (!d) d = detectPaneWorktree(s?.term, cands);
      if (stopped) return;
      // Read, whatever it said. A pane with no worktree is an answer too, and
      // leaving the spinner up for it would be a chip that never settles.
      setWtDetecting(false);
      // Sticky WITHIN one pane: a worktree does not vanish because the agent
      // stopped naming it between turns, so only a fresh detection replaces it.
      // Across a switch it is not sticky at all — that is the reset above.
      const found = d;
      if (found) {
        if (focusKey) wtSeen.current.set(focusKey, found.root);
        setDetectedWt((prev) => (prev?.root === found.root ? prev : found));
      }
    };
    void run();
    const id = setInterval(() => { void run(); }, 4000);
    return () => { stopped = true; clearInterval(id); };
  }, [open, focusIdx, paneIds, repos, root, here?.worktreeOf, here?.root, focusKey, focusWin]);
  /**
   * What the header chip and the status bar both name: the worktree the focused
   * pane is working in, and the panel's own checkout only as a fallback for a
   * shell no agent is reporting from.
   *
   * The fallback is deliberately NOT used while a read is in flight — see
   * `wtDetecting`. Falling back mid-switch made the chip flash the parent repo
   * between two worktrees, which reads as the app having lost the answer.
   */
  const chipWt = detectedWt ?? (wtDetecting ? null : here) ?? null;
  /**
   * The pull request out of the chip's branch, when there is one.
   *
   * Same question Source control's header chip asks, and the same answer, so
   * the two agree: `prsForBranch` + `chipTarget`, which is where the "opens a
   * search box instead of the pull request" bug was fixed once already.
   */
  const [chipPr, setChipPr] = useState<{ repo: string; pr: PrBranchSummary } | null>(null);
  const prRoot = chipWt?.root ?? "";
  const prBranch = chipWt?.branch ?? "";
  useEffect(() => {
    if (!open || IS_DEMO || !prRoot || !prBranch) { setChipPr(null); return; }
    const key = `${prRoot}\u0000${prBranch}`;
    const seen = branchPrCache.get(key);
    if (seen && Date.now() - seen.at < BRANCH_PR_TTL) {
      const t = chipTarget(seen.repo, seen.pr);
      setChipPr(t.kind === "open" ? { repo: t.repo, pr: t.pr } : null);
      return;
    }
    // Not "keep the last one until the new answer lands": that is the same
    // stale-under-a-new-tab bug the worktree read just stopped having.
    setChipPr(null);
    let live = true;
    void api.prsForBranch(prRoot, prBranch)
      .then((r) => {
        branchPrCache.set(key, { at: Date.now(), repo: r.repo ?? null, pr: r.from ?? null });
        if (!live) return;
        const t = chipTarget(r.repo, r.from);
        setChipPr(t.kind === "open" ? { repo: t.repo, pr: t.pr } : null);
      })
      /* No GitHub, no auth, no network: the chip simply has no pull request to
         offer. The Source control header is where that distinction is drawn and
         explained; repeating it in the terminal's chrome would be noise. */
      .catch(() => { if (live) setChipPr(null); });
    return () => { live = false; };
  }, [open, prRoot, prBranch]);

  const tabs = root ? termSessionsFor(root) : [];

  // Every repo opens with a shell, and the panes always name shells that still
  // exist — closing one must not leave an empty frame behind.
  //
  // The demo creates them too. `createSession` builds an xterm and touches
  // nothing else — `connect` is the only step that opens a socket, and it
  // returns early in a demo build — so what the demo gets is the real terminal
  // with nothing talking to it, which is what `playDemoSession` then fills.
  useEffect(() => {
    if (!open || !root) return;
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

  /**
   * Hovering a pane types into it — when that has been asked for.
   *
   * Two things are set, and they are not the same thing: the pane INDEX is what
   * the chrome acts on (find, the window strip, the worktree readout), and
   * xterm's own focus is where the next character lands. A click sets both
   * because it lands inside xterm's textarea; a hover has to say so.
   *
   * Declared down here, below `findOpen`, and that placement is load-bearing: a
   * `useCallback` reads its dependency array during render, so naming a `const`
   * declared further down the component is a temporal dead zone — which in this
   * app means a white window rather than a warning.
   */
  const hoverFocus = useCallback((i: number, buttons: number) => {
    if (!shouldFocusOnHover({ enabled: ffm, buttons, typing: wtOpen || findOpen, visible: active && open })) return;
    const s = sessions.get(paneIds[i] ?? "");
    if (!s) return;
    // Only when it moves. Re-entering the pane you are already in would re-run
    // the mount effect below, which detaches and re-attaches a live terminal.
    setFocusIdx((cur) => (cur === i ? cur : i));
    requestAnimationFrame(() => { try { s.term.focus(); } catch { /* disposed mid-frame */ } });
  }, [ffm, wtOpen, findOpen, active, open, paneIds]);

  /** The tmux pane last asked for, so a pointer resting inside one does not
   *  re-send for every mousemove in the half-second before the sweep reports
   *  it active. */
  const askedPane = useRef<string | null>(null);

  /**
   * The same idea one level down: inside tmux.
   *
   * Giving the terminal the keyboard is not enough when tmux is running in it.
   * tmux has its own idea of which pane is current, and keystrokes go THERE —
   * so hovering the right-hand split and typing still lands on the left one
   * until you click. The click works because tmux's own mouse mode acts on the
   * button; hovering has no such event, so the pane is worked out here from the
   * geometry tmux reports and tmux is told to select it.
   *
   * Rate is not the concern the shape of the guard suggests: `mousemove` fires
   * often, but the send happens only when the pane UNDER the pointer changes,
   * so crossing a divider is one command and sitting in a pane is none.
   */
  const hoverTmuxPane = useCallback((i: number, e: { clientX: number; clientY: number; buttons: number }) => {
    if (!shouldFocusOnHover({ enabled: ffm, buttons: e.buttons, typing: wtOpen || findOpen, visible: active && open })) return;
    const s = sessions.get(paneIds[i] ?? "");
    // Fewer than two panes and there is nothing to choose between — the server
    // sends an empty list for exactly that case.
    if (!s || !s.tmux || s.tmuxPanes.length < 2 || s.ws?.readyState !== WebSocket.OPEN) return;
    // xterm's screen element, not the container: the container can be a few
    // pixels taller than a whole number of rows, and dividing by the wrong
    // height puts the pointer a row off at the bottom of a tall pane.
    const screen = s.term.element?.querySelector(".xterm-screen") ?? s.term.element;
    if (!screen) return;
    const cell = cellAt(screen.getBoundingClientRect(), s.term.cols, s.term.rows, e.clientX, e.clientY);
    if (!cell) return;
    const pane = paneAt(s.tmuxPanes, cell.col, cell.row);
    // No pane owns this cell (tmux's status line), it is already the current
    // one, or we have just asked for it.
    if (!pane || pane.active || askedPane.current === pane.id) return;
    askedPane.current = pane.id;
    s.ws.send(ptyFrame({ t: "tmux", cmd: "selectpane", pane: pane.id }));
  }, [ffm, wtOpen, findOpen, active, open, paneIds]);

  useEffect(() => {
    if (!open) return;
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
      // Once per session, not once per mount: switching views and coming back
      // would otherwise replay the same test run on top of itself, and the
      // scrollback would read as a shell stuck in a loop.
      if (IS_DEMO && !demoPlayed.has(s.id)) {
        demoPlayed.add(s.id);
        stopDemo.set(s.id, playDemoSession(s.term));
      }
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

  // The same session the worktree read above is keyed on — one lookup, so the
  // two can never disagree about which pane is in front of you.
  const sess = focusSess;
  // tmux is running in the shell you're looking at, so it owns the tabs and the
  // splits. Ours would be a second set of controls doing the same job worse —
  // and two competing pane models is exactly how you end up with a split inside
  // a split you didn't ask for.
  const tmuxActive = !!sess?.tmux;
  const status: SessStatus = sess?.status ?? "idle";
  /* Whether a request can be SENT at all — a question about the transport.
     What used to gate these was `tmuxActive`, which is a question about the
     machine, and answering it in the client is what made six buttons do
     nothing on every Mac. The server answers the tmux question now. */
  const socketLive = status === "live";
  /** The dispatch we are waiting on an answer for, so a refusal can be served
   *  by the pane path rather than only reported. */
  const lastIssue = useRef<TermIssue | null>(null);

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
  /*
   * Re-fit the terminal when tmux takes the panel over, or its window list
   * changes shape.
   *
   * The moment tmux is detected, the panel's own chrome changes height — the
   * shell-tab strip is swapped for tmux's window strip, the status hint row
   * changes — so the number of rows that fit is not what it was a frame ago.
   * The mount effect above measures ONCE, before any of that, and then keys on
   * `[open, paneIds, focusIdx]` (deliberately not `tmuxActive`, so returning to
   * the view never detaches a live terminal) — so nothing re-measures when tmux
   * arrives. A view-switch does, but only incidentally: the panel goes to zero
   * size and back, and the mount effect's ResizeObserver fires on the way in.
   * The initial attach has no such transition, so the tmux window kept the
   * taller pre-tmux grid and its bottom rows — an agent's input box — were drawn
   * below the panel until the user happened to switch views. This is the missing
   * re-fit, on the same rising edge a view-switch gets for free.
   *
   * rAF so it runs after the new chrome has laid out; `fitTerm` no-ops when the
   * grid is unchanged, so the common re-render costs a measurement and no
   * resize.
   */
  useEffect(() => {
    if (!open || IS_DEMO) return;
    const raf = requestAnimationFrame(() => {
      for (const id of paneIds) {
        const s = sessions.get(id);
        if (s) try { fitTerm(s); } catch { /* not measurable yet */ }
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [open, tmuxActive, tmuxWindows.length, paneIds]);
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
  const tmuxClient = sess?.tmuxClient ?? null;
  /*
   * The window is bigger than the pane you can see.
   *
   * `window-size largest` keeps a phone from shrinking the desk, and its cost
   * is this: with anything BIGGER attached — another agentglass window, a
   * `tmux attach` in a real terminal — tmux sizes the window to that one and
   * this panel shows its top-left corner. Measured on a private server, one
   * 80x24 client gives `window 80x23`; a 240x60 client joining takes it to
   * `window 240x59` while the small client stays 80x24.
   *
   * What that costs is not "some rows": it is the LAST row of the pane, which
   * is where every editor puts its status line. Reported as exactly that,
   * because "nvim has no status bar" is how it presents and is a different
   * thing to go looking for.
   */
  const hiddenRows = (() => {
    const rows = tmuxClient?.rows ?? 0;
    if (!tmuxActive || !rows) return 0;
    const deepest = (sess?.tmuxPanes ?? []).reduce((n, p) => Math.max(n, p.bottom + 1), 0);
    return deepest > rows ? deepest - rows : 0;
  })();
  /*
   * The window on screen is narrower than the terminal drawing it.
   *
   * tmux sizes a shared window to fit every client, so a phone attaching with a
   * fit reflows this desk to 80 columns and the desk is given no explanation
   * whatsoever — the panes just get small and stay small.
   *
   * The condition is the size comparison, never `w.phone` and never a
   * server-side list of who is attached. A phone with no fit costs the desk
   * nothing and is the common case, so a notice keyed on presence would cry
   * wolf on it; and a registry disagrees with tmux the moment a fit fails, a
   * phone changes window, or a phone's socket dies without cleanup running.
   * This asks tmux what the window is, which cannot be wrong about it.
   *
   * Columns ONLY. Measured: a 200×50 client gives a 200×49 window, because tmux
   * spends a row on the status line — so a rows comparison fires on every desk
   * that has a bar, forever.
   *
   * A window with no `cols` is one tmux did not answer a size for, which is not
   * the same claim as "narrow" — it takes the notice off, not on.
   */
  const activeWin = tmuxWindows.find((w) => w.id === activeWindow) ?? null;
  /*
   * And the second way a phone takes this window: it zooms it.
   *
   * A phone attaches to a WINDOW, so a four-pane window gave it four tabs
   * drawing the same 2x2 grid — the server now zooms the pane that was tapped
   * so one tab means one pane. That flag is on the shared window, so the desk
   * gets a window with one pane where it had four. It is not narrow, so the
   * comparison above cannot see it, and it is just as much of a "what happened
   * to my layout" as the width is.
   *
   * `phone` IS the condition here, and that is the opposite of the rule above
   * on purpose. Zoom is a key people press for themselves several times a day
   * (`prefix z`); a notice on every zoomed window would be an explanation for
   * something that needs none, forever. So it fires only while a phone is on
   * the window. The cost is the mirror image of what the width notice avoids: a
   * desk that zoomed a window ITSELF while a phone happened to be on it is told
   * the phone did it. Wrong attribution on a rare case beats a permanent false
   * alarm on a common one — and the button gives the panes back either way.
   *
   * The other end of it — a phone that dies without its teardown running leaves
   * the window zoomed and this notice gone — is left alone deliberately. That
   * state is one `prefix z` from fixed, which is a key the person already has,
   * unlike a window pinned at 80 columns.
   */
  const zoomedByPhone = tmuxActive && !!activeWin?.phone && !!activeWin?.flags.includes("Z");
  const narrow = tmuxActive && activeWin?.cols && tmuxClient && activeWin.cols < tmuxClient.cols
    ? { winCols: activeWin.cols, deskCols: tmuxClient.cols }
    : null;
  // One card for both reasons rather than two that can stack: they have the
  // same cause, the same button, and the same fix — and a desk that has lost
  // both its width and its panes has one problem, not two.
  const held = activeWin && (narrow || zoomedByPhone)
    ? { win: activeWin, narrow, zoomed: zoomedByPhone }
    : null;
  /**
   * The state the card is describing, as one string.
   *
   * Only used to decide whether a dismiss still applies. Closing the card puts
   * this key in `heldHidden`, so the card stays gone while nothing changes and
   * comes back by itself the moment the situation is a different one: another
   * window, another width, or a zoom on top of a width that was already wrong.
   * That keeps the dismiss from turning into the optimistic flag the button
   * below deliberately does not have — nothing here is remembered ACROSS a
   * change of state, so a phone that grabs the window again is announced again.
   */
  const heldKey = held ? `${held.win.id}:${held.narrow?.winCols ?? 0}:${held.zoomed ? "z" : "-"}` : null;
  const [heldHidden, setHeldHidden] = useState<string | null>(null);
  /**
   * A tmux command, minus the discriminant this helper supplies.
   *
   * Distributed over the union by hand, through the defaulted parameter:
   * `Omit<A | B, "t">` collapses to the keys A and B have in COMMON, which
   * would leave `{cmd:"issue"}` sendable with no `cwd` and put us back where
   * `(cmd: string, extra: Record<string, unknown>)` was.
   */
  type TmuxCmdBody<F = Extract<PtyClientFrame, { t: "tmux" }>> = F extends unknown ? Omit<F, "t"> : never;
  const tmuxCmd = useCallback((body: TmuxCmdBody) => {
    const s = sess;
    if (!s || s.ws?.readyState !== WebSocket.OPEN) return;
    s.ws.send(ptyFrame({ t: "tmux", ...body }));
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
    tmuxCmd({ cmd: "status", visible: tmuxBar });
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
    if (!review || !socketLive) return;
    tmuxCmd({ cmd: "review", root: review.root, number: review.number });
    clearTermReview();
  }, [review, socketLive, tmuxCmd]);

  /** The same door for starting work on an issue: a worktree the server has
   *  already cut, and a prompt it wrote. Never a command — see termIssue.ts. */
  const issue = useSyncExternalStore(subscribeTermIssue, termIssue, termIssue);
  useEffect(() => {
    if (!issue || !socketLive) return;
    // Remembered before it is sent, because the fallback below needs it and the
    // slot is cleared here: a second press must not be blocked waiting on the
    // first one's answer.
    lastIssue.current = issue;
    tmuxCmd({ cmd: "issue", cwd: issue.cwd, name: issue.name, prompt: issue.prompt, agent: issue.agent, yolo: issue.yolo, title: issue.title });
    clearTermIssue();
  }, [issue, socketLive, tmuxCmd]);

  /*
   * The server refused, so open the agent in a pane instead.
   *
   * This is the half of the dispatch that did not exist. Both effects above
   * used to require `tmuxActive`, so on a machine with no tmux client the
   * request was dropped before it was sent — and `tmuxActive` came from a
   * detection that read /proc and returned false on every Mac, whatever was
   * installed. Six buttons, no message, nothing in a log.
   *
   * The gate is the SOCKET now, not tmux: whether this can be sent at all is a
   * question about the transport, and whether tmux can serve it is the server's
   * to answer — it resolves its own sweep before refusing, so "not looked up
   * yet" is never mistaken for "no tmux here".
   *
   * A refusal is not an error to show and move on from. It is the request
   * arriving at the other path: a pane, opened in the same worktree, running
   * the same agent with the same argv.
   */
  useEffect(() => {
    const why = sess?.openFail;
    if (!why || !sess) return;
    sess.openFail = null;
    const want = lastIssue.current;
    lastIssue.current = null;
    if (!want) { sess.term.writeln(`\r\n\x1b[33m${why}\x1b[0m`); return; }
    void (async () => {
      const r = await api.termAgentTicket(want.cwd, want.agent ? want.prompt : "", !!want.yolo, want.title ?? "")
        .catch(() => ({ ok: false, error: "could not reach the server" } as { ok: boolean; ticket?: string; error?: string }));
      if (!r.ok || !r.ticket) {
        // Said in the terminal the person is looking at, rather than swallowed.
        // This is the case the audit was about, so it does not get to be quiet.
        sess.term.writeln(`\r\n\x1b[33mcould not start the agent here: ${r.error ?? "no ticket"}\x1b[0m`);
        return;
      }
      const pane = createSession(want.cwd, r.ticket);
      setPaneIds((ids) => (ids.length >= 4 ? [...ids.slice(1), pane.id] : [...ids, pane.id]));
      setFocusIdx((i) => Math.min(i + 1, 3));
    })();
  }, [sess, sessTick]);

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

  /* The demo has no server to ask, so `loadCommands` answers with a terminal
     that is switched off — and the overlay that message drives was covering the
     canned session. The demo's terminal is not disabled: it has no shell, which
     is a different thing and is what the status line says. */
  const disabled = !IS_DEMO && cmds ? !cmds.enabled : false;

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
      {dialog}
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

                {/* header: where this pane is + command launcher + actions */}
                <div className={viewHeaderClass} style={viewHeaderStyle}>
                  <h2 className="sr-only">Terminal</h2>
                  {/*
                    * Where this pane is, not where to go.
                    *
                    * There was a repo picker here, and it could not do what it
                    * looked like it did: the server reads a shell's directory
                    * once, when the PTY opens (`terminal.ts`), so picking a
                    * worktree never moved the shell in front of you — it hid
                    * your shells and started a new one somewhere else. Moving a
                    * live shell for real means typing `cd` into it, over
                    * whatever you were typing, in whichever of several panes,
                    * possibly under a running build. tmux already answers that
                    * question, and answers it better.
                    *
                    * So the slot states a fact instead of offering a choice.
                    * Which matters twice over: with no picker, nothing else on
                    * this bar said which checkout you were in, and "I thought I
                    * was in the worktree" is the same surprise the picker used
                    * to cause, just mirrored.
                    *
                    * The answer comes from the server (see panewt.ts) rather
                    * than from this end guessing off the pane's own directory —
                    * that is the parent repo for every agent in a fleet, which
                    * is what made it look unanswerable.
                    */}
                  {/*
                    * Three doors, not one.
                    *
                    * The chip named the worktree and could only open Source
                    * control, so the two things you actually do with a branch an
                    * agent is working on — read its diff, look at its pull
                    * request — were a view switch and a search away from the one
                    * place already holding the branch's name. The status bar's
                    * copy had grown Git and Diff for exactly that reason; this
                    * is the complete one, and the pull request is the part
                    * neither had.
                    *
                    * Separate buttons rather than one button with a menu: a menu
                    * is a click to find out what the options are, and there are
                    * three.
                    */}
                  {(() => {
                    // Mid-switch, with the read still out: say so rather than
                    // fall back to the panel's own checkout, which is a
                    // different branch stated with the same confidence.
                    if (!chipWt) {
                      return wtDetecting ? (
                        <span
                          className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg shrink-0"
                          title="Reading which worktree this pane is working in"
                          style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text3)" }}
                        >
                          <span className="shrink-0 text-[8.5px] leading-none px-1 py-0.5 rounded" style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>WT</span>
                          <span className="animate-pulse">Reading this pane…</span>
                        </span>
                      ) : null;
                    }
                    const at = chipWt;
                    const label = at.worktreeOf ? at.branch : at.name;
                    return (
                      <span
                        className="flex items-center gap-1 text-[11px] pl-2.5 pr-1.5 py-1 rounded-lg min-w-0 shrink"
                        style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text)" }}
                      >
                        <span
                          className="shrink-0 text-[8.5px] leading-none px-1 py-0.5 rounded"
                          title={at.worktreeOf ? `worktree of ${at.worktreeOf}` : "main checkout"}
                          style={at.worktreeOf
                            ? { color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 32%, transparent)" }
                            : { color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}
                        >{at.worktreeOf ? "WT" : "REPO"}</span>
                        {/* The name still opens Source control on its own — that
                            was the chip's one action and muscle memory for it is
                            older than the buttons beside it. */}
                        <button
                          onMouseDown={keepTermFocus}
                          onClick={() => requestWorktreeJump({ view: "git", root: at.root })}
                          title={`${at.root}\nOpen its Source control`}
                          className="agx-btn flex items-center gap-1.5 min-w-0 shrink rounded px-1"
                          style={{ color: "var(--text)" }}
                        >
                          <span className="font-medium truncate min-w-0">{label}</span>
                          {at.dirty > 0 && <span className="shrink-0 text-[10px] tabular-nums" style={{ color: "var(--warning)" }} title={`${at.dirty} changed file${at.dirty === 1 ? "" : "s"}`}>●{at.dirty}</span>}
                          <span className="t-dim2 shrink-0 text-[10px]">↗</span>
                        </button>
                        <button
                          onMouseDown={keepTermFocus}
                          onClick={() => requestWorktreeJump({ view: "diff", filter: dirName(at.root) })}
                          title={`Open ${dirName(at.root)}'s changes in File changes`}
                          className="agx-btn shrink-0 flex items-center gap-1 px-2 py-px rounded leading-none"
                          style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}
                        >Diff <span className="t-dim2 text-[10px]">↗</span></button>
                        {/* Only when the branch HAS one. A dashed "no pull
                            request" pill in the terminal's chrome would be a
                            permanent fixture on every local branch, and Source
                            control is where that fact belongs. */}
                        {chipPr && (
                          <button
                            onMouseDown={keepTermFocus}
                            onClick={() => openPr(chipPr.repo, chipPr.pr.number)}
                            title={`#${chipPr.pr.number} ${chipPr.pr.title}\n${chipPr.pr.state === "OPEN" && chipPr.pr.isDraft ? "Draft" : chipPr.pr.state.toLowerCase()} · open it in Pull requests`}
                            className="agx-btn shrink-0 flex items-center gap-1 px-2 py-px rounded leading-none tabular-nums"
                            style={{ color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }}
                          >PR #{chipPr.pr.number} <span className="t-dim2 text-[10px]">↗</span></button>
                        )}
                      </span>
                    );
                  })()}

                  {/* Commands and pins — the same control the docked console
                      mounts, so the two shells offer the same thing. Its own
                      dropdown state lives inside it, which is why it sits
                      outside the pickers group above. */}
                  <CommandBar root={root} disabled={disabled} font={TERM_FONT} onRun={run} runTargetInTmux={!!sess?.tmux} onClose={focusTerm} />

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
                    {/* Jump straight to a worktree's changes. The one the
                        focused pane's agent is in is pinned at the top when the
                        server can say (panewt.ts); the rest are picked, with
                        dirty checkouts first, which is where the work is. */}
                    <div className="relative" ref={wtRef}>
                      <button onClick={() => { if (wtOpen) { setWtOpen(false); focusTerm(); } else setWtOpen(true); }} disabled={!root || IS_DEMO || disabled} title="Open a worktree's Source control or File changes" className="text-[11px] px-2 py-1 rounded-lg" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>↗ Worktree ▾</button>
                      {wtOpen && (() => {
                        const project = here?.worktreeOf || here?.root || root;
                        const ACTIVE_MS = 3 * 60 * 60 * 1000; // dirty, or touched within 3h — where an agent actually is
                        // Worktrees only — the parent repo (the main checkout, on
                        // its trunk) is where the shell's own cwd sits, not a
                        // checkout you jump to from a button called Worktree, and
                        // filtering the diff by its folder would match everything.
                        const all = repos
                          .filter((r) => r.worktreeOf && (r.worktreeOf || r.root) === project)
                          .sort((a, b) => (b.dirty - a.dirty) || (b.touchedAt - a.touchedAt) || dirName(a.root).localeCompare(dirName(b.root)));
                        const active = all.filter((r) => r.dirty > 0 || (r.touchedAt > 0 && Date.now() - r.touchedAt < ACTIVE_MS));
                        const q = wtQuery.trim().toLowerCase();
                        // Empty box shows only what is live — a dozen idle checkouts is the
                        // noise the picker was drowning in. A search, or "Show all", looks
                        // through every one.
                        // What THIS pane's agent is working in, read from its terminal output.
                        const detected = detectedWt;
                        const base = (q || wtShowAll || active.length === 0) ? all : active;
                        const list = base.filter((r) => !q || (r.branch + " " + dirName(r.root)).toLowerCase().includes(q)).filter((r) => r.root !== detected?.root);
                        const hiddenCount = all.length - active.length;
                        return (
                          <div className="absolute right-0 mt-1 rounded-lg text-[11px] shadow-2xl flex flex-col" style={{ zIndex: 30, background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)", minWidth: 400, maxWidth: "min(90vw, 640px)", maxHeight: 440, overflow: "hidden" }}>
                            <div className="px-2.5 pt-2 pb-1.5 shrink-0 flex items-center gap-2" style={{ borderBottom: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>
                              <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text3)" }}>Open a worktree's changes</span>
                              {!q && hiddenCount > 0 && (
                                <button onMouseDown={keepTermFocus} onClick={() => setWtShowAll((v) => !v)} className="agx-btn ml-auto text-[9.5px] px-1.5 py-0.5 rounded" style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }} title={wtShowAll ? "Show only worktrees with recent activity" : "Show every worktree, active or not"}>{wtShowAll ? `Active only (${active.length})` : `Show all (${all.length})`}</button>
                              )}
                            </div>
                            <input autoFocus value={wtQuery} onChange={(e) => setWtQuery(e.target.value)} placeholder="Filter by ticket or name…" className="m-1.5 px-2.5 py-1.5 rounded-md text-[11px] outline-none shrink-0" style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text)" }} />
                            {detected && !wtQuery && (
                              /* Auto-detected from what the focused pane's agent is doing — the one you
                                 almost certainly want, pinned above the list and out of the filter. */
                              <div className="w-full px-2.5 py-1.5 flex items-center gap-2 shrink-0" style={{ background: "color-mix(in srgb, var(--primary) 12%, transparent)", borderBottom: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>
                                <span className="shrink-0 text-[10px] uppercase tracking-wider px-1 py-0.5 rounded self-start mt-0.5" title="Where this pane's agent is working — from its directory and its transcript" style={{ color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }}>This pane</span>
                                <span className="min-w-0 flex-1 flex flex-col leading-tight" title={`${detected.branch}\n${detected.root}`}>
                                  <span className="truncate font-medium" style={{ color: "var(--text)" }}>{detected.branch}</span>
                                  <span className="truncate text-[10px]" style={{ color: "var(--text3)" }}>{dirName(detected.root)}</span>
                                </span>
                                {detected.dirty > 0 && <span className="shrink-0 text-[10px] tabular-nums self-start mt-0.5" style={{ color: "var(--warning)" }} title={`${detected.dirty} changed file${detected.dirty === 1 ? "" : "s"}`}>●{detected.dirty}</span>}
                                <button onClick={() => { requestWorktreeJump({ view: "git", root: detected.root }); setWtOpen(false); setWtQuery(""); setWtShowAll(false); }} className="agx-btn shrink-0 px-1.5 py-0.5 rounded text-[10px]" style={{ color: "var(--text)", border: "1px solid color-mix(in srgb, var(--primary) 50%, transparent)" }} title="Open in Source control">Git</button>
                                <button onClick={() => { requestWorktreeJump({ view: "diff", filter: dirName(detected.root) }); setWtOpen(false); setWtQuery(""); setWtShowAll(false); }} className="agx-btn shrink-0 px-1.5 py-0.5 rounded text-[10px]" style={{ color: "var(--text)", border: "1px solid color-mix(in srgb, var(--primary) 50%, transparent)" }} title="Open its changes in File changes">Diff</button>
                              </div>
                            )}
                            <div className="agx-scroll overflow-y-auto pb-1" style={{ minHeight: 0 }}>
                              {list.map((r) => {
                                const wt = !!r.worktreeOf;
                                return (
                                  <div key={r.root} className="w-full px-2.5 py-1.5 flex items-center gap-2" style={{ background: r.root === root ? "color-mix(in srgb, var(--primary) 12%, transparent)" : "transparent" }}>
                                    <span className="shrink-0 text-[8.5px] leading-none px-1 py-0.5 rounded self-start mt-0.5" title={wt ? `Worktree of ${r.worktreeOf}` : "Main checkout"} style={wt ? { color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 32%, transparent)" } : { color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }}>{wt ? "WT" : "REPO"}</span>
                                    {/* The branch is the descriptive name (`WEB-1042-fix-the-cart`); the
                                        folder (`orbit-WEB-1042`) is the terse stub below it. A ticket number
                                        alone is not something anyone recognises without having memorised it. */}
                                    <span className="min-w-0 flex-1 flex flex-col leading-tight" title={`${r.branch}\n${r.root}`}>
                                      <span className="truncate font-medium" style={{ color: "var(--text)" }}>{wt ? r.branch : r.name}</span>
                                      <span className="truncate text-[10px]" style={{ color: "var(--text3)" }}>{wt ? dirName(r.root) : r.branch}</span>
                                    </span>
                                    {r.dirty > 0 && <span className="shrink-0 text-[10px] tabular-nums self-start mt-0.5" style={{ color: "var(--warning)" }} title={`${r.dirty} changed file${r.dirty === 1 ? "" : "s"}`}>●{r.dirty}</span>}
                                    <button onClick={() => { requestWorktreeJump({ view: "git", root: r.root }); setWtOpen(false); setWtQuery(""); setWtShowAll(false); }} className="agx-btn shrink-0 px-1.5 py-0.5 rounded text-[10px]" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }} title="Open in Source control">Git</button>
                                    <button onClick={() => { requestWorktreeJump({ view: "diff", filter: dirName(r.root) }); setWtOpen(false); setWtQuery(""); setWtShowAll(false); }} className="agx-btn shrink-0 px-1.5 py-0.5 rounded text-[10px]" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)" }} title="Open its changes in File changes">Diff</button>
                                  </div>
                                );
                              })}
                              {list.length === 0 && <div className="px-2.5 py-2 text-[10.5px]" style={{ color: "var(--text3)" }}>{q ? "No match." : active.length === 0 ? "No worktree changed recently." : "No worktrees for this repo."}</div>}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                    {!tmuxActive && <button onClick={splitPane} disabled={!root || IS_DEMO || disabled || paneIds.length >= 4} title="Show another shell beside this one" className="text-[11px] px-2 py-1 rounded-lg" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)", opacity: paneIds.length >= 4 ? 0.45 : 1 }}>⊞ Split</button>}
                    {/* Under tmux this button does not restart anything: it
                        drops the pty connection and re-attaches. tmux is a
                        daemon, so a detach ends the client, not the session —
                        every window and agent keeps running (see terminal.ts,
                        "a detach ends the client, not the server"). Calling it
                        "Restart" beside a pane full of working agents reads as a
                        button that could throw the work away, which it cannot.
                        Only a bare, non-tmux shell is actually restarted. */}
                    <button onClick={restart} disabled={!root || IS_DEMO || disabled} title={tmuxActive ? "Re-attach this terminal to tmux — every window and agent keeps running, nothing is killed" : "Kill this shell and start a fresh one"} className="text-[11px] px-2 py-1 rounded-lg" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 30%, transparent)" }}>⟲ {tmuxActive ? "Reconnect" : "Restart"}</button>
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
                          <CloseButton onClick={(e) => { e.stopPropagation(); closeShell(t.id); }} title="Close shell" className="opacity-0 group-hover:opacity-100" />
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
                  <div onMouseDown={keepTermFocus} className="shrink-0 flex items-center gap-2 px-3 py-0.5 border-b overflow-x-auto agw-noscrollbar" style={{ borderColor: "color-mix(in srgb, var(--border) 30%, transparent)" }}>
                    <span
                      title={prefixLive ? "tmux is waiting for the rest of the sequence" : `tmux prefix: ${(sess?.tmuxPrefix ?? []).join(" or ") || "unknown"}`}
                      className="shrink-0 px-1.5 py-0.5 rounded-md text-[10px] font-semibold tabular-nums transition-colors duration-75"
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
                      // `!` is a bell — a window that rang on purpose, kept. `#`
                      // (activity) is deliberately NOT drawn: it fires on any
                      // output — an agent still working, nvim redrawing, every
                      // window at once when the desk re-attaches — which is noise,
                      // not "done". The honest "the agent here finished its turn"
                      // is w.agentDone, derived server-side from the transcript's
                      // own end-of-turn (Stop) event, not from tmux's flag.
                      const bell = w.flags.includes("!");
                      // Zoom is the flag that changes what the keyboard does:
                      // one pane is filling the window and the others are still
                      // there, which is confusing precisely when it is invisible.
                      const zoomed = w.flags.includes("Z");
                      return (
                        <div key={w.id}
                          onClick={() => { if (w.id !== activeWindow) { setPendingWindow(w.id); tmuxCmd({ cmd: "select", window: w.id }); } }}
                          onDoubleClick={() => setRenaming(w.id)}
                          title={`Window ${w.index}${w.flags ? ` (${w.flags})` : ""} — double-click to rename`}
                          className={`group flex items-center gap-1.5 px-1 py-px text-[10.5px] cursor-pointer shrink-0 transition-colors${w.id === activeWindow ? " font-semibold" : ""}`}
                          style={w.id === activeWindow
                            ? { color: "var(--primary-hover)" }
                            : { color: "var(--text2)" }}>
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
                                if (/^\d{1,3}$/.test(to) && Number(to) !== w.index) tmuxCmd({ cmd: "move", window: w.id, name: to });
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
                                if (name && name !== w.name) tmuxCmd({ cmd: "rename", window: w.id, name });
                                setRenaming(null);
                                focusTerm();
                              }}
                              className="bg-transparent outline-none w-20 text-[10.5px]"
                              style={{ color: "var(--text)", borderBottom: "1px solid color-mix(in srgb, var(--primary) 60%, transparent)" }}
                            />
                          ) : (
                            <span>{w.name || "shell"}</span>
                          )}
                          {zoomed && <span className="text-[10px] font-semibold leading-none" style={{ color: "var(--text4)" }} title="A pane in this window is zoomed">⤢</span>}
                          {/* A phone is watching a pane in this window.
                              Loud on purpose, and the only mark in this strip
                              that is about a PERSON rather than about the work.
                              A phone joins as a grouped tmux session, so it
                              shares the window — whatever it does arrives here
                              looking like the machine did it by itself, and
                              this is the only thing on the desk that says
                              otherwise. Drawn rather than typed: a phone emoji
                              is a different picture on every platform and this
                              one has to be recognisable at 9px. */}
                          {/* The title names both grids, because "a phone is
                              here" and "a phone is costing you 140 columns" are
                              different news and the mark is identical for both
                              — it is the same pixels either way. */}
                          {w.phone && (
                            <span className="inline-flex items-center"
                              title={w.cols && tmuxClient
                                ? `Your phone is on a pane in this window — it is ${w.cols} columns and your terminal is ${tmuxClient.cols}`
                                : "Your phone is on a pane in this window"}>
                              {/* A mark to notice rather than a target to hit: it annotates a
                                  one-digit window number, and at the 12px floor it would be
                                  larger than the number it annotates.
                                  icon-floor-exempt: a status badge, not a control */}
                              <svg width="9" height="13" viewBox="0 0 10 14" aria-label="phone attached"
                                style={{ color: "var(--phone)", animation: "agx-phone-pulse 1.8s ease-in-out infinite" }}>
                                <rect x="0.7" y="0.7" width="8.6" height="12.6" rx="1.6"
                                  fill="none" stroke="currentColor" strokeWidth="1.4" />
                                <circle cx="5" cy="10.8" r="0.9" fill="currentColor" />
                              </svg>
                            </span>
                          )}
                          {bell && <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--error)" }} title="Bell" />}
                          {/* The agent in this tab finished its turn and you have
                              not looked yet. Green = ready-for-you, distinct from
                              the bell's red. Set from the transcript's Stop event,
                              not tmux activity, so nvim and a still-working agent
                              stay dark; clears the moment you switch to this tab. */}
                          {!bell && w.agentDone && <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--success, #98c379)" }} title="Agent finished — not seen yet" />}
                          {/* Ultra-minimal: the close × lives ONLY on the active
                              window. Switching means clicking a NON-active tab,
                              which has no × to hit by accident — the whole point
                              of this style. To close another window you select it
                              first, then its × is there. */}
                          {w.id === activeWindow && (
                            <CloseButton onClick={(e) => { e.stopPropagation(); tmuxCmd({ cmd: "kill", window: w.id }); }} title="Close window (kill-window)" className="opacity-50 hover:opacity-100" />
                          )}
                        </div>
                      );
                    })}
                    <button onClick={() => tmuxCmd({ cmd: "new" })} className="shrink-0 px-1.5 py-0.5 rounded-md text-[11px]" style={{ color: "var(--text3)" }} title={`New tmux window (${px} c puts it next to this one)`}>+</button>
                    <button onClick={() => setTmuxBar(true)} className="ml-auto shrink-0 px-2 py-0.5 rounded-md text-[10px]" style={{ color: "var(--text3)" }}
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
                        onMouseEnter={(e) => hoverFocus(i, e.buttons)}
                        // And inside tmux, where the panes are painted rather
                        // than rendered — so this needs the pointer's position,
                        // not just the fact that it arrived.
                        onMouseMove={(e) => hoverTmuxPane(i, e)}
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
                  {/* Not in the demo any more. The overlay is for a terminal
                      that cannot draw anything — Windows, or disabled by config
                      — and in the demo it was covering a terminal that now has
                      a session in it. What the demo owes a visitor is the note
                      in the status line below, not a sheet over the feature. */}
                  {disabled && (
                    <div className="absolute inset-0 flex items-center justify-center text-[12px] t-dim2" style={{ background: "color-mix(in srgb, var(--bg) 80%, transparent)" }}>
                      {cmds?.reason === "windows"
                        ? "The terminal is not available on Windows yet (the PTY backend needs POSIX; ConPTY support is planned)"
                        : cmds?.reason === "config"
                        ? "Terminal disabled (terminalDisabled in config.json)"
                        : "Terminal disabled (AGENTGLASS_TERMINAL_DISABLED=1)"}
                    </div>
                  )}

                  {/* Your terminal is being drawn at somebody else's width.

                      A card that floats over the bottom right corner of the
                      panes, NOT a row above them. As a row it took its height
                      out of the terminal, so a phone connecting reflowed every
                      pane on the desk and disconnecting reflowed them back:
                      the notice about a resize was itself causing one, and a
                      full-screen TUI redrew underneath it both times. Floating,
                      it costs the terminal no rows at all and nothing moves.

                      Anchored inside the pane box rather than to the viewport,
                      which puts it in the screen's bottom right corner without
                      covering the status line, and, because the whole terminal
                      view is hidden with `visibility` when you are looking at
                      another view, means it cannot follow you into chat or the
                      diff the way a portal to the body would.

                      Deliberately OUTSIDE the `!tmuxBar` guard above: this is
                      not the tab strip, and someone who kept tmux's own status
                      line has exactly the same broken layout and none of the
                      strip.

                      keepTermFocus for the same reason the strip has it — the
                      button must not take the keyboard off the pane. Pointer
                      events stop at the card itself, so a drag that starts
                      anywhere else on the pane still selects text as usual. */}
                  {held && heldKey !== heldHidden && (
                    <div onMouseDown={keepTermFocus} role="status"
                      className="absolute bottom-3 right-3 max-w-[21rem] flex flex-col gap-2 px-3.5 py-2.5 rounded-xl text-[10.5px] leading-relaxed"
                      style={{
                        zIndex: 20,
                        color: "var(--text2)",
                        // Opaque rather than blurred: this sits over a terminal
                        // that repaints constantly, and a backdrop-filter here
                        // is a per-frame cost for the whole rectangle.
                        background: "var(--bg2)",
                        border: "1px solid color-mix(in srgb, var(--phone) 45%, transparent)",
                        boxShadow: "0 18px 40px -18px var(--shadow)",
                        animation: "agx-zoom-in .12s ease-out",
                      }}>
                      <div className="flex items-start gap-2">
                        {/* The width sentence has two states, split on `w.phone`,
                            so the present tense is only used when a phone is
                            actually there.

                            The second one no longer blames the phone, and that
                            is a consequence of the server putting these back by
                            itself: a window a phone pinned carries a mark, and
                            a marked window with nobody on it is restored within
                            a couple of seconds without anybody clicking. So by
                            the time this sentence is on screen the size is one
                            this app cannot prove it took — most often somebody's
                            own `resize-window` — and "your phone left without
                            putting it back" would be a guess presented as a
                            fact. The numbers are still worth saying, and the
                            button still works on either.
                            The zoom sentence has one state, because it is only
                            ever shown while a phone is here (see
                            `zoomedByPhone`), and it says the panes are still
                            RUNNING: that is the actual question — a window that
                            went from four panes to one reads like three
                            programs died. */}
                        <span className="min-w-0">
                          {held.narrow && (held.win.phone ? (
                            <>Your phone is driving this window. It is <Cols n={held.narrow.winCols} /> columns while your terminal is <Cols n={held.narrow.deskCols} />, so tmux is drawing everything at phone width.</>
                          ) : (
                            <>This window is <Cols n={held.narrow.winCols} /> columns to your terminal&apos;s <Cols n={held.narrow.deskCols} />, with nothing attached to it at that size. A phone&apos;s reflow is put back on its own, so this one came from somewhere else.</>
                          ))}
                          {held.narrow && held.zoomed && " "}
                          {held.zoomed && (
                            <>Your phone opened one pane here, so tmux has zoomed the window onto it — your other panes are still running, they are just not being drawn.</>
                          )}
                        </span>
                        {/* Closing hides the card, never the situation: the
                            width stays wrong, and the same card comes back on
                            its own as soon as the state is a different one (see
                            `heldKey`). It exists because this now sits over your
                            output instead of above it, and a card you cannot put
                            away would be a permanent hole in the corner of a
                            full-screen TUI. */}
                        <CloseButton onClick={() => setHeldHidden(heldKey)}
                          className="shrink-0 opacity-50 hover:opacity-100"
                          title="Hide this until the window changes — the width stays as it is" />
                      </div>
                      {/* Nothing is remembered from this click. The notice is a
                          pure function of the next sweep, so if tmux did not
                          actually move it correctly stays up — an optimistic
                          "taken over" flag would hide a take-over that failed,
                          and unlike the tab click above, this is not an answer
                          the user already knows. */}
                      {/* The label follows what is actually wrong. "Take the
                          width back" on a window that is the right width and
                          missing three panes would name the wrong problem, and a
                          button that names the wrong problem is one nobody
                          presses. */}
                      <button onClick={() => tmuxCmd({ cmd: "takeover", window: held.win.id })}
                        className="agx-btn self-end shrink-0 px-2 py-0.5 rounded"
                        style={{ color: "var(--text)", border: "1px solid color-mix(in srgb, var(--phone) 45%, transparent)" }}
                        title={held.zoomed
                          ? "Unzoom this window and resize it to your terminal, then leave it following your terminal — the phone stays connected and can still ask for the pane back later"
                          : "Resize this window to your terminal and leave it following your terminal — the phone stays connected and can still ask for a reflow later"}>
                        {held.zoomed ? "Give me my window back" : held.win.phone ? "Take the width back" : "Restore the width"}
                      </button>
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
                      {hiddenRows > 0 ? (
                        <>
                          <span style={{ color: "var(--warning)" }}>
                            {hiddenRows} row{hiddenRows === 1 ? "" : "s"} of this pane are below the panel —
                            a bigger client is attached, so the last line (an editor's status bar) is off-screen
                          </span>
                          <button onClick={() => tmuxCmd({
                              cmd: "fit",
                              window: tmuxWindows.find((w) => w.active)?.id ?? "",
                              cols: sess?.term.cols, rows: sess?.term.rows,
                            })}
                            title="Size this tmux window to this panel. The other client keeps working; it just stops deciding the size."
                            className="agx-btn px-2 py-0.5 rounded"
                            style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)" }}>
                            Fit to this window
                          </button>
                        </>
                      ) : [["c", "Window"], ['"', "Split ↓"], ["%", "Split →"], ["o", "Next pane"], ["z", "Zoom"], ["d", "Detach"], ["?", "All keys"]].map(([key, what]) => (
                        <Fragment key={key}>
                          <b style={{ color: "var(--text2)" }}>{px} {key}</b><span>{what}</span>
                        </Fragment>
                      ))}
                    </span>
                  ) : IS_DEMO ? (
                    // The renderer, the theme and the scrollback are real; the
                    // bytes are written into the build. Said here rather than
                    // over the pane, because a visitor should be able to read
                    // the session and be told what it is at the same time.
                    <span className="flex items-center gap-2">
                      <span className="px-1.5 rounded" style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 14%, transparent)" }}>demo</span>
                      <span>A canned session — the terminal is real, nothing is running behind it. Run agentglass locally for a shell you can type in.</span>
                    </span>
                  ) : disabled ? (
                    // The shell isn't running here (Windows, or disabled by env),
                    // so promising a real shell with working TUIs would be the
                    // lie the overlay above just corrected. Say nothing.
                    <span className="t-dim2">{cmds?.reason === "windows" ? "Terminal not available on Windows yet" : "Terminal unavailable"}</span>
                  ) : (
                    <span>Real shell — Ctrl+C, Ctrl+R, Tab-complete, vim/htop all work · sessions survive closing this panel · Shift+Esc closes it</span>
                  )}
                  <span className="ml-auto flex items-center gap-2 shrink-0">
                    {/* The focused pane's worktree, offered right in the bar —
                        read from the agent's output, one click to its changes.

                        This chip must NOT make the status bar any taller than it
                        is without it — the row is `items-center`, so a child
                        taller than the surrounding 9.5px text grows the whole
                        bar. `leading-none` here + `py-0` on the buttons keep
                        every element inside the text's own line box. Give one
                        back a normal line-height, or vertical padding, and the
                        bar jumps a few pixels the moment a worktree is detected
                        — which is why the buttons below were given room to
                        breathe SIDEWAYS only.

                        The badge wears the same filled pill as `tmux` at the
                        other end of this bar: one bar, one way of marking what a
                        stretch of it is about. The bordered 9px capital version
                        it replaced was a third style in a row that already had
                        two, and at that size the letters had no room. */}
                    {detectedWt ? (
                      <span className="flex items-center gap-1.5 leading-none" title={`This pane's worktree — ${detectedWt.branch}\n${detectedWt.root}`}>
                        <span className="px-1.5 rounded" style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 14%, transparent)" }}>This pane</span>
                        {/* Branch is the name of the thing you are working on; the
                            folder is where it lives. Show the branch, and the
                            folder after it in a dimmer hand — both on one line, so
                            the bar keeps its height. */}
                        <span className="truncate max-w-[190px]" style={{ color: "var(--text2)" }}>{detectedWt.branch || dirName(detectedWt.root)}</span>
                        {detectedWt.branch && detectedWt.branch !== dirName(detectedWt.root) && (
                          <span className="truncate max-w-[110px] text-[9px]" style={{ color: "var(--text3)" }}>{dirName(detectedWt.root)}</span>
                        )}
                        {detectedWt.dirty > 0 && <span className="tabular-nums" style={{ color: "var(--warning)" }}>●{detectedWt.dirty}</span>}
                        {/* The arrow is what keeps these reading as buttons once
                            they have room around the word — the same ↗ the
                            worktree chip in the header uses for the same promise:
                            pressing this leaves the terminal. */}
                        <button onMouseDown={keepTermFocus} onClick={() => requestWorktreeJump({ view: "git", root: detectedWt.root })} className="agx-btn inline-flex items-center gap-1 px-2 py-0 rounded" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }} title="Open in Source control">Git <span className="t-dim2">↗</span></button>
                        <button onMouseDown={keepTermFocus} onClick={() => requestWorktreeJump({ view: "diff", filter: dirName(detectedWt.root) })} className="agx-btn inline-flex items-center gap-1 px-2 py-0 rounded" style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }} title="Open its changes in File changes">Diff <span className="t-dim2">↗</span></button>
                        <span className="t-dim2">·</span>
                      </span>
                    ) : wtDetecting ? (
                      /* The switch has happened and the answer has not arrived.
                         Holding the previous pane's worktree here for the ~100ms
                         a first read costs is how the bar came to disagree with
                         the tab strip above it. */
                      <span className="flex items-center gap-1.5 leading-none" title="Reading which worktree this pane is working in">
                        <span className="px-1.5 rounded" style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 14%, transparent)" }}>This pane</span>
                        <span className="animate-pulse" style={{ color: "var(--text3)" }}>Reading…</span>
                        <span className="t-dim2">·</span>
                      </span>
                    ) : null}
                    <span>{sess ? `${sess.term.cols}×${sess.term.rows}` : ""}</span>
                  </span>
                </div>
    </div>
  );
}


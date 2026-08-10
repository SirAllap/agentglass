// Real-terminal backend — a PTY-backed interactive shell per WebSocket.
//
// The browser panel is a true machine terminal (xterm.js in front): the server
// spawns the user's login shell inside a pseudo-terminal in a chosen
// repo/worktree and shuttles raw bytes over the socket. Job control, colors,
// cursor addressing, vim/htop/lazygit — everything a local terminal does.
//
// PTY strategy (best available, in order):
//   1. python3 + pty_bridge.py — full PTY with live resize (SIGWINCH), the
//      normal path on macOS/Linux (python3 is already an agentglass prereq).
//   2. util-linux `script -qfec` — full PTY, fixed initial size (Linux).
//   3. plain pipes — degraded (no TUI apps) but still a usable shell.
//
// Shells run in their OWN session/process group (via `setsid`) so hangup on
// socket close reaches the whole job tree, not just the shell. Gated by
// AGENTGLASS_TERMINAL_DISABLED; cwd must be a real git dir; the CSRF/origin
// guard is applied at the upgrade route.
import { readFileSync, existsSync, statSync, mkdtempSync, writeFileSync, renameSync, rmSync, readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import type { ServerWebSocket } from "bun";
import { isViewTemp, viewTempDirOf } from "./viewtemp.ts";
import type { ProjectCommand, TerminalCommands, TerminalDisabledReason, TmuxWindow, PtyServerFrame, PtyClientMessage } from "../../shared/types.ts";
import { safeAbs, repoRootOf, repoRootOfAsync } from "./git.ts";
import { terminalActive } from "./loopwatch.ts";
import { inScope, workspaceRoot, terminalDisabledSource } from "./config.ts";
import { SKIP_DIRS } from "./gitwork.ts";

// The PTY backend is POSIX-only: every strategy below needs a real
// pseudo-terminal (python3's pty, util-linux `script`) plus setsid job control
// and SIGWINCH resize, none of which exist on Windows — ConPTY would be a
// separate integration (issue #98). So Windows is a first-class "off" state at
// the SAME seam as the env-var kill switch: the panel greys its buttons, the
// PTY socket is never opened, and the overlay reads the reason off the wire —
// rather than a shell that opens and then dies on the first spawn. This gate is
// server-side on purpose: the shell runs here, so process.platform is the host
// that matters, not the browser's navigator (a Windows laptop can open a
// dashboard served by a Linux box, and that terminal works fine).
const IS_WINDOWS = process.platform === "win32";
// Windows first — the PTY backend needs POSIX, so no env or config toggle can
// turn it on there. Otherwise the env/config layer decides, resolved the same
// way chatBypass is (env overrides the file) so a desktop launcher, which
// inherits no shell env, can still turn the shell off from config.json.
export const TERMINAL_DISABLED_REASON: TerminalDisabledReason | null =
  IS_WINDOWS ? "windows" : terminalDisabledSource();
export const TERMINAL_ENABLED = TERMINAL_DISABLED_REASON === null;

const HAS_SETSID = !!Bun.which("setsid");
const PYTHON = Bun.which("python3") || Bun.which("python");
const HAS_SCRIPT = process.platform === "linux" && !!Bun.which("script");
/**
 * Which of the three backends below a new shell will get.
 *
 * Resolved here because this is where the choice is made, and exported because
 * "pipe" is the one degraded state the user cannot see coming: the shell opens,
 * and only a full-screen program not rendering says anything is wrong. The
 * requirements report reads this to name the cause (no python3) rather than
 * leaving the terminal to mention it in grey, inside itself, after the fact.
 */
export const PTY_BACKEND: "pty" | "script" | "pipe" = PYTHON ? "pty" : HAS_SCRIPT ? "script" : "pipe";
// Embedded rather than resolved from import.meta.url: once the server is
// compiled into a standalone binary there is no pty_bridge.py on disk next to
// it, and the terminal would die on a path that never existed.
import bridgeFile from "./pty_bridge.py" with { type: "file" };

/**
 * A real on-disk path to the PTY bridge script.
 *
 * In a compiled binary the embedded file lives in Bun's virtual filesystem
 * (`/$bunfs/...`), which only this process can see — python3 is a *separate*
 * process and would fail to open it. Copy it out to a real temp file once so
 * the spawn works either way. `existsSync` can't be used to detect this: Bun
 * patches fs to answer for its virtual paths too, so both cases look present.
 */
function materializeBridge(src: string): string {
  if (!src.startsWith("/$bunfs/")) return src; // running from source
  // A predictable /tmp name written with default perms is a symlink/TOCTOU
  // target: another local user pre-creates the path as a symlink and the write
  // lands on their chosen file, or they race the write→exec to swap in their
  // own python. Write inside a fresh 0700 dir with an owner-only, no-follow,
  // exclusive create instead, and clean it up on exit.
  try {
    const dir = mkdtempSync(join(tmpdir(), "agentglass-bridge-"));
    const out = join(dir, "pty_bridge.py");
    writeFileSync(out, readFileSync(src), { mode: 0o600, flag: "wx" });
    process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });
    return out;
  } catch {
    return src; // let the spawn fail loudly rather than silently degrade
  }
}
const BRIDGE = materializeBridge(bridgeFile);
// A ceiling, not a working limit: the panel is meant to hold many shells at
// once (tmux-style), so this only exists to stop a runaway client forking
// processes without bound. Each idle shell costs a pty and a sleeping process.
const MAX_SESSIONS = Math.max(4, Number(process.env.AGENTGLASS_MAX_TERMINALS || 200));

/**
 * How many times the sweep will re-hide the bar on the same session after it
 * was turned back on, before the flip stands. Re-asserting FOREVER would make
 * `prefix : set status on` a fight the user cannot win, and nobody owns a
 * setting that reverts on its own — so each session gets this many heals per
 * explicit hide, then the user's choice on it wins. A plugin or reload that
 * flips the bar once is healed without ceremony; a person who flips it back
 * three times is deciding. See the sweep in ptyOpen.
 */
const TMUX_BAR_HEAL_BUDGET = 3;

/** How many failed remounts in a row buy a minute off — a switch that keeps
 *  failing must not loop creating and killing a mirror every tick. */
const REMOUNT_FAILS_BEFORE_QUIET = 3;
const REMOUNT_QUIET_MS = 60_000;
export type PtyWsData = { kind: "pty"; root: string; cols: number; rows: number;
  /** A file to open in an editor instead of dropping to a shell. A PATH, never
   *  a command: this socket is reachable from the UI, and "run this string"
   *  would turn a terminal into arbitrary execution. The server picks what
   *  runs; see editorFor. */
  view?: string;
  /**
   * A ticket for an agent to start in this pane, minted by POST /terminal/agent.
   *
   * A ticket rather than the prompt itself, and that is not indirection for its
   * own sake: the prompt is a card's description or a review brief, which is
   * kilobytes and has no business in a query string. What the client holds is
   * an opaque single-use id for text it supplied a moment earlier; the binary
   * and every flag are chosen by the server, exactly as for `view`. See
   * agentticket.ts.
   */
  agent?: string;
  /**
   * Open that file for EDITING rather than for reading.
   *
   * Two different intents, and they must not be one flag with a default. Read
   * is what a diff and a pull request want — you are looking at somebody's
   * code, often a copy of a branch you do not even have. Write is what a file
   * tree wants — it is your checkout and the reason you opened it is to change
   * it. Defaulting to write would make every glance at a review one keystroke
   * away from editing a file nobody meant to touch; defaulting to read (as it
   * does) makes the editable case say so.
   */
  edit?: boolean;
  /**
   * A live tmux pane to show instead of a new shell — tmux's own id, `%58`.
   *
   * DATA, not a command: see the resolution in ptyOpen. The phone lists panes
   * from /terminal/panes and sends back the id of the one that was tapped, so
   * "the terminal on my phone" is the work already running on the machine
   * rather than a second, empty shell beside it.
   */
  pane?: string;
  /** Let this client's size win over the desk's — see attachArgvFor. */
  fit?: boolean };
type PtyWs = ServerWebSocket<unknown>;

/**
 * What a phone's attach wrote onto the USER'S tmux, and everything needed to
 * put it back.
 *
 * A record and not a set of fields on the session because the way back has to
 * outlive the session: it is handed to a pair of timers when the socket closes,
 * and to `shutdownTerminals` when there is no time for timers at all.
 */
type PhoneAttach = {
  socket: string[];
  sessionId: string;
  /**
   * The window this phone attached to — ROUTING ONLY.
   *
   * It answers "which socket do I tell about window @3", and nothing else. It
   * is NOT what the phone is currently looking at: a phone can walk to another
   * window with tmux's own keys and this will not follow it, which is exactly
   * why the mark on the strip comes from `phoneWindows` asking tmux instead.
   * Using this as truth would put the same invisible lie back.
   */
  windowId: string;
  /**
   * The pane this socket was opened on — the id the client asked for.
   *
   * Routing again, and honest about the same limit as `windowId`: it is where
   * this attach STARTED, not where the phone has since walked. That is enough
   * for the one thing it is read for, which is "which project is this person
   * looking at" when they ask for a new window: a phone that walked away with
   * `^b n` is not the case the `+` button is for, and the answer would still be
   * a directory on the same machine rather than a wrong action.
   */
  paneId: string;
  /** `window-size` as each window of the group had it before this phone
   *  arrived, so the way out is a restore and not a guess. */
  hadWindowSize: Record<string, string>;
  /** Whether this phone asked for the window to follow it. Kept because the
   *  fit has to be applied more than once — see `fitWindow`. */
  fit: boolean;
  /**
   * The window this phone zoomed, and onto which pane — null when it zoomed
   * nothing.
   *
   * The other half of the width, and owed back for the same reason: a zoom is a
   * flag on the SHARED window, so the desk gets a one-pane window where it had
   * four, and killing the phone does not put it back. Held whole rather than as
   * a boolean because the teardown has to address exactly what was zoomed —
   * `windowId` above is routing and follows nothing.
   */
  zoomed: { windowId: string; paneId: string } | null;
  /**
   * The grouped session WE made for this phone, by name.
   *
   * Only the shutdown path uses it, and it is the whole reason that path can
   * work: `restoreWindows` skips any window a phone is still on, and on the way
   * out there is no time to wait for tmux to notice the client has gone. Ending
   * our own session makes that true instead of waiting for it. See
   * `endPhoneSession` — the name is checked against the one pattern this app
   * ever creates before anything is killed.
   */
  phoneSession: string;
  /**
   * Which attach this was, counted from the start of the process.
   *
   * Ordering, and it decides an outcome rather than tidying a list. Two fitted
   * phones on one window capture different things: the first reads the window's
   * real `window-size` (usually nothing at all), the second reads the `manual`
   * the first one's fit had already written. Whichever restore runs LAST is the
   * one the window keeps — so the oldest capture has to go last, and "oldest"
   * is not readable off the session map once a socket has closed and left it.
   */
  seq: number;
};
let attachSeq = 0;

type Session = {
  proc: ReturnType<typeof Bun.spawn>;
  mode: "pty" | "pipe";
  grouped: boolean;
  sizeDir: string | null; // tmp dir holding the resize file (pty_bridge mode)
  /** The temp dir holding a pull request's fetched copy of a file, when this
   *  session is one of those. Removed with the session: a viewer that leaves a
   *  directory behind every time it opens is a slow leak nobody notices until
   *  /tmp is full of them. */
  viewDir: string | null;
  closed: boolean;
  exited: boolean;
  killTimer: ReturnType<typeof setTimeout> | null;
  /** Cleared on close — a stray interval would keep reading /proc for a pty
   *  that no longer exists, once per session, forever. */
  tmuxPoll?: ReturnType<typeof setInterval> | null;
  /** A one-shot sweep armed off pty output, so a keyboard window switch (which
   *  redraws) shows in the tab strip without waiting out the poll. Cleared on
   *  close like the poll. */
  tmuxNudge?: ReturnType<typeof setTimeout> | null;
  /** The tmux client in this shell, once one is found. Survives a session
   *  switch, which is the whole reason it is kept apart from the target. */
  tmuxClient?: TmuxClient | null;
  /** The tmux session that client is showing, re-read every poll. */
  tmux?: TmuxTarget | null;
  /** tmux's prefix keys, re-read whenever the session changes rather than every
   *  tick: it is a config value, not a live one. */
  tmuxPrefix?: string[];
  /** The windows the last sweep read. Held so an action can be refused for a
   *  window that was not in the frame this client was shown — see `takeover`
   *  in ptyMessage. */
  tmuxWindows?: TmuxWindow[];
  /** Re-read tmux and push if anything moved. Held so an action can refresh
   *  immediately instead of leaving the strip stale until the next tick. */
  tmuxSweep?: () => void;
  /** Whether the panel wants tmux's own status line drawn. Remembered rather
   *  than applied and forgotten, so the answer can be re-applied to whatever
   *  session the client moves to next. Undefined until the panel says. */
  tmuxStatusVisible?: boolean;
  /** The session we actually hid it on, so it can be given back on the way out.
   *  Restoring is not optional: a session left with `status off` after the panel
   *  closed would look broken in the user's real terminal, and they would have
   *  no reason to connect it to us. It is the session and not a boolean because
   *  the one we borrowed from is not always the one we end up on. */
  tmuxStatusHiddenOn?: TmuxTarget | null;
  /** The re-hides still owed to the session whose bar came back on. Each heal
   *  spends one; when it reaches zero the flip stands, because re-asserting
   *  forever is a fight the user cannot win. Reset to a fresh budget whenever
   *  the panel explicitly asks to hide again — that is a new consent. See
   *  `TMUX_BAR_HEAL_BUDGET` and the sweep in ptyOpen. */
  tmuxBarHealBudget?: { sessionId: string; left: number } | null;
  /** Consecutive failed remounts (each would otherwise have created and killed
   *  a mirror) and the timestamp until which the sweep stops trying. */
  remountFails?: number;
  remountQuietUntil?: number;
  /**
   * The group this session joined, when it is a phone looking at a pane.
   *
   * Held for the way out. `fit` sets `window-size latest`, which is read per
   * window and reaches every window in the group — so a phone on one pane of a
   * five-window session pulls all five down to phone width, and letting go does
   * not put them back on its own. See `restoreWindows`.
   */
  phoneAttach?: PhoneAttach | null;
  /**
   * The pane THIS phone put into copy mode, and has not been given back.
   *
   * Copy mode is a property of the shared pane, so a phone that scrolled back
   * and then went away leaves the desk a pane that reads their next keystroke as
   * a copy-mode command. Held only when we are the ones who started it — a copy
   * mode the person at the desk opened is theirs and is not ours to cancel — and
   * cleared as soon as tmux has left it on its own, which `copy-mode -e` does
   * the moment a scroll reaches the bottom.
   */
  copyMode?: string | null;
};
const sessions = new Map<PtyWs, Session>();

/**
 * Restores this process owes the user's tmux and has not delivered yet.
 *
 * `cleanup` hands its restore to a pair of timers, and a timer is not a
 * promise. A socket that closed one second before a SIGTERM has its window put
 * back by nothing at all: the handler calls `shutdownTerminals` and then
 * `process.exit(0)`, and a pending timer does not get a turn. That is the same
 * window left at 80x24 and `window-size manual` as the live case, reached by
 * being slightly earlier — and it looks identical to the user, who restarted
 * the server and got a pinned window.
 *
 * So the record stays on this ledger until the last of the two timers has had
 * it, and `shutdownTerminals` drains whatever is still on it. Removed by the
 * +3000ms call and not the +1500ms one, because the second is not a retry: it
 * is the one that catches a tmux session which had not finished going away at
 * 1.5s.
 */
const owed = new Set<PhoneAttach>();

/**
 * The last tmux client any terminal here was attached to.
 *
 * Kept because the question "which pane is that agent in" outlives the panel
 * that can answer it: the tmux server goes on running with every pane in it
 * whether or not this app has a shell open, and the top bar can be asked from
 * any view. A target from a shell that has since closed still names a reachable
 * server — the socket is the durable half — and if it does not, the tmux call
 * simply fails and the caller reports no panes.
 *
 * Null until a terminal has been opened once this run, which is the honest
 * answer: we learn the socket by finding a client on it, and until then we do
 * not know which of the machine's tmux servers is the user's.
 */
let lastTarget: TmuxTarget | null = null;

/**
 * Seeded from disk, so the answer survives a restart.
 *
 * "Null until a terminal has been opened once this run" was honest and it was
 * also the whole of the complaint: close the app, reopen it, and the session
 * you were in is not on offer — the panel's client was the only one on that
 * server, so closing detached it, and a detached server is one `listPanes`
 * skips. You had to attach from a terminal outside the app to be shown your
 * own session back.
 *
 * A remembered socket is not a live client and is not pretended to be one: the
 * pid is 0, the id is empty, and nothing that needs a client will accept it.
 * What it does carry is the socket, which is the durable half and the only part
 * anybody asks a stale target for.
 */
export const lastTmuxTarget = (): TmuxTarget | null => {
  if (lastTarget) return lastTarget;
  const seen = recall();
  return seen ? { pid: 0, socket: ["-S", seen.socket], session: seen.session, id: "" } : null;
};

/**
 * Write it down, when it has changed.
 *
 * `readFrame` runs on a poll, so this is reached constantly; the guard is what
 * keeps that from being a write per tick. `socketPath` resolves `-L work` and
 * the path it means to one spelling — the stored value has to be comparable
 * with what discovery finds, and only the path is.
 */
let remembered = "";
let settling = "";
let settlingSince = 0;
function rememberTarget(t: TmuxTarget, now = Date.now()): void {
  const path = socketPath(t.socket);
  if (!path) return;
  /*
   * A phone's mirror is a session this app made, not a place the user works.
   * Remembering one would bring back an empty grouped session on the next cold
   * start, named after a device that is not here.
   */
  if (isPhoneSession(t.session)) return;

  const key = `${path}\u0000${t.session}`;
  /*
   * Only once the panel has SETTLED here. tmux moves a client through sessions
   * on its way past — after a restore it put this one on `docker` for a moment
   * — and the last one touched is not the one the day was spent in. See
   * SETTLE_MS.
   */
  if (key !== settling) { settling = key; settlingSince = now; return; }
  if (now - settlingSince < SETTLE_MS) return;
  if (key === remembered) return;
  remembered = key;
  remember(path, t.session);
}

const clampCols = (v: unknown) => Math.min(500, Math.max(20, Math.floor(Number(v)) || 0));
const clampRows = (v: unknown) => Math.min(300, Math.max(5, Math.floor(Number(v)) || 0));

/** Atomically publish a new pty size (the bridge reads it on SIGWINCH). */
function writeSizeFile(dir: string, rows: number, cols: number) {
  writeFileSync(join(dir, "size.tmp"), `${rows} ${cols}`);
  renameSync(join(dir, "size.tmp"), join(dir, "size"));
}

function pickShell(): { shell: string; args: string[] } {
  const fromEnv = process.env.SHELL;
  const shell = fromEnv && existsSync(fromEnv) ? fromEnv : Bun.which("bash") || "bash";
  const name = basename(shell);
  // Interactive login shell → the user's real PATH, aliases, and prompt.
  const args = ["bash", "zsh", "fish"].includes(name) ? ["-il"] : ["-i"];
  return { shell, args };
}

function killGroup(s: Session, sigNum: number) {
  try {
    if (s.grouped) process.kill(-s.proc.pid, sigNum);
    else s.proc.kill(sigNum);
  } catch { /* already gone */ }
}

import { findTmuxBelow } from "./procchildren.ts";
import { recall, remember, SETTLE_MS } from "./tmuxmemory.ts";
import { deskAttachArgv } from "./tmuxctl.ts";
import { resolveClient, readFrame, runAction, setStatusLine, releaseStale, clearAsk, prefixKeys, newWindowRunning, paneCwd, selectPane, attachArgvFor, restoreWindows, endPhoneSession, phoneWindows, fitWindow, reclaimPinnedWindow, windowSize, socketPath, scrollPhonePane, leaveCopyMode, remountPhoneClient, isPhoneSession, type TmuxClient, type TmuxTarget, type TmuxAction } from "./tmuxctl.ts";
import { paneFinished, markSeen } from "./agentdone.ts";
import { prepareReviewPrompt } from "./prs.ts";
import { claudeCode, supportsSessionName } from "./agents/claudecode.ts";
import { agentArgv, claimAgentTicket } from "./agentticket.ts";

/*
 * What a client is told when it sends a tmux-shaped request to a terminal with
 * no tmux in it.
 *
 * Said rather than implied: the panel's own answer is to open the agent in a
 * pane instead (see the `agent` ticket below), so a client reaching this line
 * is one that could not — an older build, or the phone, which has no pane to
 * open. Both deserve the reason.
 */
const NO_TMUX = "this terminal has no tmux — open the agent in a pane instead, or start tmux here";
import { applyThemeTo } from "./themesync.ts";

const enc = new TextEncoder();

/**
 * A card's title, as a session name.
 *
 * Control characters out (a newline or an escape in an argv element is how a
 * name becomes something else on a status line), whitespace collapsed, and
 * capped — the CLI puts this in a terminal title and a picker column, and a
 * ninety-character card title makes both useless. Empty in means empty out,
 * and the caller then passes no flag at all rather than an empty one.
 */
export function sessionTitle(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const flat = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > 72 ? flat.slice(0, 71).trimEnd() + "…" : flat;
}
/**
 * A control frame out.
 *
 * Typed against the contract rather than `Record<string, unknown>`, the way
 * `broadcast(frame: WsFrame)` already constrains /stream. It was the looser
 * signature that let this end be the only description of the protocol: with
 * anything at all acceptable here, a field could be renamed, dropped or nested
 * and nothing on the server or the desk would notice — only the phone, at
 * runtime, silently. See PtyServerFrame.
 */
const ctl = (ws: PtyWs, frame: PtyServerFrame) => { try { ws.send(JSON.stringify(frame)); } catch { /* closed */ } };

/**
 * Is a tmux client running inside this shell?
 *
 * Worth knowing because tmux brings its own tabs, its own splits and its own
 * status line — so the panel's versions of all three become a second, worse
 * copy sitting above the real ones. Detecting it lets the panel get out of the
 * way instead of forcing everyone into tmux, which would be a poor trade for
 * anyone who doesn't use it.
 *
 * Reads the process tree rather than asking the shell: the shell is busy being
 * a terminal and injecting a command to interrogate it would echo into whatever
 * the user is typing.
 *
 * It used to say "Linux-only by design — on anything else the answer is 'no'
 * and the panel keeps its own chrome, which is the correct fallback". That was
 * true of THIS caller and false of the flag's other reader: `tmuxActive` also
 * gated the dispatch of a pull request or a card to an agent, where "no" was
 * not a fallback but a button that did nothing, on every Mac. The walk is
 * portable now (procchildren.ts); this caller's behaviour is unchanged, since
 * a machine with no tmux still answers no and still keeps its own chrome.
 */
function tmuxRunning(pid: number, depth = 0): boolean {
  return findTmuxBelow(pid, depth) !== null;
}

/**
 * Where a shell opens when the requested directory can't be used.
 *
 * Always inside scope: the scope root itself when the cockpit is scoped to one
 * project (it is in scope by definition), otherwise the user's HOME, otherwise
 * "/". So a scoped instance never lands a shell outside its project even on the
 * fallback — it gives you the project's own root instead of refusing outright,
 * and inScope keeps confining WHERE the shell may be, just not WHETHER you get one.
 */
function fallbackCwd(): string {
  const scope = workspaceRoot();
  for (const c of [scope, process.env.HOME, "/"]) {
    if (!c || !inScope(c)) continue; // HOME is out of a scoped instance — skip to "/"
    try { if (statSync(c).isDirectory()) return c; } catch { /* gone; try the next */ }
  }
  return "/";
}

/**
 * What opens a file for reading.
 *
 * The user's own choice first — somebody who set $VISUAL meant it — then the
 * editors most likely to be installed, and `less` last so a machine with no
 * editor still shows the file rather than an error. Resolved from PATH, so a
 * name that is not installed is skipped rather than spawned and failed.
 */
export function editorFor(env: NodeJS.ProcessEnv = process.env): string | null {
  const asked = (env.VISUAL || env.EDITOR || "").trim();
  const candidates = [...(asked ? [asked] : []), "nvim", "vim", "vi", "less"];
  for (const c of candidates) {
    // A configured $EDITOR can carry flags ("code -w"); take the binary.
    const bin = c.split(/\s+/)[0]!;
    if (Bun.which(bin)) return c;
  }
  return null;
}

/** WebSocket opened at /terminal/pty — spawn the shell and start pumping. */
export function ptyOpen(ws: PtyWs) {
  const d = ws.data as PtyWsData;
  if (!TERMINAL_ENABLED) {
    const why = TERMINAL_DISABLED_REASON === "windows"
      ? "terminal is not available on Windows yet (no POSIX PTY backend)"
      : TERMINAL_DISABLED_REASON === "config"
      ? "terminal is disabled (terminalDisabled in config.json)"
      : "terminal is disabled (AGENTGLASS_TERMINAL_DISABLED=1)";
    ctl(ws, { t: "fatal", error: why }); ws.close(1008, "disabled"); return;
  }
  // A shell is the widest thing this app hands out, and a terminal that refuses
  // to give you one is not a terminal — so it ALWAYS opens. The requested
  // directory is used only when it is genuinely usable: a real repo, in scope.
  // Anything else — not a repo, git not installed, a path that has since gone,
  // out of scope — is not an error but a fallback to a directory that is in
  // scope by construction (see fallbackCwd). The blast radius stays confined —
  // an out-of-scope request lands in the scope root, never where it asked — it
  // just no longer costs the user their shell.
  const requested = safeAbs(d.root);
  const cwd = requested && repoRootOf(requested) && inScope(requested) ? requested : fallbackCwd();
  if (sessions.size >= MAX_SESSIONS) { ctl(ws, { t: "fatal", error: `too many open terminals (max ${MAX_SESSIONS})` }); ws.close(1013, "busy"); return; }

  const cols = clampCols(d.cols) || 80;
  const rows = clampRows(d.rows) || 24;
  const { shell, args } = pickShell();
  const baseEnv = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };

  /*
   * Opening a file rather than a shell.
   *
   * The path is held to the same rule the directory is: absolute, inside the
   * open project, and actually there. A path that fails any of those does NOT
   * fall back to opening something else — it falls back to a plain shell in the
   * directory, because silently viewing a different file is worse than viewing
   * none. `run` is built here from a validated path and a resolved binary, so
   * nothing the client sent is ever interpreted as a command.
   */
  const wanted = d.view ? safeAbs(d.view) : null;
  const tempCopy = !!wanted && isViewTemp(wanted);
  // In scope, or a copy this server itself wrote: a pull request's file is
  // fetched to a temp path precisely because it is not in the workspace, and
  // the check has to admit that without admitting /tmp in general.
  const viewable = !!wanted && (inScope(wanted) || tempCopy);
  const editor = viewable && existsSync(wanted!) ? editorFor() : null;
  /*
   * Read-only unless the caller asked for an editor, and never for a copy.
   *
   * Opened from a diff or a pull request — places you go to *look* — an editor
   * is one keystroke from changing a file nobody meant to touch, in a worktree
   * that may be somebody else's, with no diff to notice it in. So read is the
   * default and write is a request.
   *
   * The temp copy is read-only whatever the caller asked, and that is not
   * caution: it is a fetched snapshot of a branch under /tmp, so a save there
   * writes to a file that will be deleted, having changed nothing anybody will
   * ever see. Refusing the edit is the honest answer; accepting it silently is
   * not.
   *
   * `-R` marks the buffer read-only; `-M` also takes 'modifiable' and 'write'
   * away, so it refuses the edit rather than refusing the save. Neither is a
   * sandbox — `:set ma` still exists — and that is the right level: a guard
   * against the accident, not a cage around somebody who means it.
   */
  const bin = editor ? editor.split(/\s+/)[0]! : "";
  const readOnly = !d.edit || tempCopy;
  const readonlyFlags = readOnly && /\b(nvim|vim|view)$/.test(bin) ? ["-R", "-M"] : [];

  /*
   * Showing a tmux pane that already exists, rather than starting a shell.
   *
   * The client sends an id and nothing else — `%58`. It never sends a socket,
   * a session name or a command, and it could not: `attachArgvFor` looks the
   * pane up in the live list on this machine and builds the command from what
   * it finds. An id that names no live pane produces no command, which is the
   * only safe answer for a socket the UI can reach.
   *
   * That is the same rule the file-viewer above follows — the client says WHAT,
   * the server decides HOW — and it is the rule that keeps a terminal endpoint
   * from being arbitrary execution.
   */
  const attach = d.pane
    // The client's own grid goes in, because a fit is now one explicit
    // `resize-window` on the window that was opened rather than an option that
    // reaches the whole group. See `attachArgvFor`.
    ? attachArgvFor(lastTmuxTarget()?.socket, String(d.pane), undefined, d.fit === true, { cols, rows })
    : null;
  if (d.pane && !attach) {
    // Named rather than silently falling back to a shell: somebody tapped a
    // specific pane, and a prompt in a directory is not that pane. Panes die
    // between the list being drawn and a tap arriving, and saying so is what
    // lets the caller re-read the list.
    ctl(ws, { t: "fatal", error: "that pane is gone — the list may be out of date" });
    ws.close(1008, "no such pane");
    return;
  }

  /*
   * An agent, in a pane, for a terminal with no tmux.
   *
   * The fourth thing a session can be, alongside a shell, a file in an editor
   * and an existing tmux pane — and it follows the same rule as the other
   * three: the client names WHAT (a ticket it was given for text it supplied),
   * and the server decides HOW. The binary and every flag are chosen here.
   *
   * The ticket is claimed once, and a claim that fails is not an error: it is a
   * reload of a page whose ticket has already been spent, or one that sat past
   * its minute. Falling back to a plain shell in the requested directory is the
   * same answer the tmux path gives when there is no agent binary — a shell in
   * the right tree is still most of what was asked for.
   */
  const ticket = typeof d.agent === "string" && d.agent ? claimAgentTicket(d.agent) : null;
  const agentBin = ticket ? claudeCode.bin() : null;
  const agentRun = ticket ? agentArgv(agentBin, ticket, supportsSessionName(agentBin)) : [];

  /*
   * Where the pane opens.
   *
   * The ticket's directory wins when it still validates, rather than the `root`
   * the socket happened to carry: a worktree cut for an issue is the whole
   * point of the request, and an agent started in the wrong tree is the failure
   * that is invisible once it has happened. Re-checked here rather than trusted
   * from the mint — the ticket has been out of our hands, and scope can change
   * while it is.
   */
  const startIn = ticket && inScope(ticket.cwd) && existsSync(ticket.cwd) ? ticket.cwd : cwd;

  /*
   * A plain terminal, opened where you left it.
   *
   * The panel's client is normally the only client on its tmux server, so
   * closing agentglass detaches the session — and opening it again started a
   * BARE SHELL, so the work was still running and simply not on screen. The
   * way back was `tmux attach -t <name>` typed into that new shell, every
   * time, which is the complaint this answers.
   *
   * Last on purpose, so it can only ever replace the bare shell: a tap on a
   * specific pane, an agent ticket and the file viewer all still win, because
   * each of those is somebody asking for a particular thing. This is the case
   * where nobody asked for anything, and "the session you were in" is a better
   * answer to that than "a fresh prompt".
   *
   * `deskAttachArgv` returns null unless that session is still live on that
   * socket, so a machine rebooted since — or a session killed — falls through
   * to the shell exactly as before. See tmuxmemory.ts.
   */
  const resume = (!attach && !agentRun.length && !editor && !d.pane)
    ? (() => { const seen = recall(); return seen ? deskAttachArgv(seen.socket, seen.session) : null; })()
    : null;

  const run = attach
    ? attach.argv
    : agentRun.length ? agentRun
    : editor ? [...editor.split(/\s+/), ...readonlyFlags, wanted!] : resume ?? [shell, ...args];

  let argv: string[];
  let mode: Session["mode"] = "pty";
  let sizeDir: string | null = null;
  let env: Record<string, string | undefined> = baseEnv;
  if (PYTHON) {
    sizeDir = mkdtempSync(join(tmpdir(), "agentglass-pty-"));
    writeSizeFile(sizeDir, rows, cols);
    env = { ...baseEnv, AGENTGLASS_PTY_SIZE_FILE: join(sizeDir, "size") };
    argv = [...(HAS_SETSID ? ["setsid"] : []), PYTHON, BRIDGE, ...run];
  } else if (HAS_SCRIPT) {
    env = { ...baseEnv, COLUMNS: String(cols), LINES: String(rows) };
    argv = [...(HAS_SETSID ? ["setsid"] : []), "script", "-qfec", `exec ${run.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ")}`, "/dev/null"];
  } else {
    mode = "pipe";
    argv = [...(HAS_SETSID ? ["setsid"] : []), ...(editor ? run : [shell, "-i"])];
  }

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, { cwd: startIn, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    ctl(ws, { t: "fatal", error: `could not start shell: ${String(e)}` });
    ws.close(1011, "spawn failed");
    if (sizeDir) rmSync(sizeDir, { recursive: true, force: true });
    return;
  }

  // Only ours, and only the directory we made — never the file's own folder,
  // which for a working-tree peek is somebody's repository.
  const viewDir = editor ? viewTempDirOf(wanted!) : null;
  const session: Session = {
    proc, mode, grouped: HAS_SETSID, sizeDir, viewDir, closed: false, exited: false, killTimer: null,
    phoneAttach: attach
      ? { socket: attach.socket, sessionId: attach.groupedWith, windowId: attach.windowId, paneId: String(d.pane), hadWindowSize: attach.hadWindowSize, fit: d.fit === true, zoomed: attach.zoomed, phoneSession: attach.session, seq: ++attachSeq }
      : null,
  };
  sessions.set(ws, session);
  // `pane` carries the window's real size when this is a pane attach. The phone
  // needs it to know it is looking at a slice: without a fit, tmux renders at
  // the desk's width and the columns past the phone's own never arrive.
  ctl(ws, {
    t: "ready", mode, shell: basename(shell), cwd: startIn, resize: !!sizeDir,
    ...(attach?.grid ? { pane: attach.grid } : {}),
  });

  /**
   * The client moved to a different session — follow it there.
   *
   * Everything we hold about a session is about *that* session: the prefix we
   * advertise, and the status line we borrowed. Hand the old one its status line
   * back before borrowing the next one's, so a user who switches away with `^b s`
   * finds their other session exactly as their config left it.
   */
  const followSession = (t: TmuxTarget) => {
    const borrowed = session.tmuxStatusHiddenOn;
    if (borrowed && borrowed.id !== t.id) {
      setStatusLine(borrowed, true);
      session.tmuxStatusHiddenOn = null;
    }
    session.tmux = t;
    session.tmuxPrefix = prefixKeys(t);
    // Repaint this server in the cockpit's palette. A tmux that started after
    // the last theme switch — a reboot, or a continuum restore — has never
    // heard of it, and the parts the panel does not draw itself (the message
    // row, the prompt, the pane borders) come up in tmux's own colours in the
    // middle of a themed panel. Best-effort, and silent when there is no theme
    // file yet: this is a repaint, not a precondition.
    applyThemeTo(t.socket);
  };

  /*
   * Watch for tmux coming and going, and for the session under it moving.
   *
   * Polled rather than detected once at startup, because the interesting cases
   * are exactly the ones that change: you open a plain shell, type `tmux`, and
   * the panel's split button should stand down at that moment — and come back
   * when you detach. The same is true one level down, for which session that
   * client is showing.
   */
  let sawTmux = false;
  let sent = "";
  const sweep = () => {
    if (session.closed || session.exited) return;
    const now = tmuxRunning(proc.pid);
    if (now !== sawTmux) {
      sawTmux = now;
      if (!now) {
        // Detached. Hand the session its status line back before forgetting we
        // borrowed it — a detach ends the client, not the server: the session
        // stays alive, so a status left hidden here comes up blank on every
        // future attach. Same restore followSession() does when the client
        // moves on with `^b s`; the sweep missing it was the leak.
        const borrowed = session.tmuxStatusHiddenOn;
        if (borrowed) setStatusLine(borrowed, true);
        // Forget the client rather than keep polling a target that is no longer
        // ours, and stop describing windows nobody is looking at.
        session.tmuxClient = null;
        session.tmux = null;
        session.tmuxPrefix = [];
        session.tmuxStatusHiddenOn = null;
        sent = "";
        ctl(ws, { t: "tmux", active: false, windows: [], panes: [] });
        return;
      }
    }
    if (!now) return;
    // The client is resolved once per attach — that walk is /proc and it does
    // not change while the same client is up. Which session it is *showing* is
    // read every tick, because that does change: `^b s`, and every continuum
    // restore, which switches the client to the restored session and kills the
    // one it attached to. A target cached at attach time points at that dead
    // session for the rest of the shell's life.
    if (!session.tmuxClient) {
      session.tmuxClient = resolveClient(proc.pid);
      // First contact with this tmux server: hand back anything a previous run
      // took and was killed before returning. See releaseStale.
      if (session.tmuxClient) releaseStale(session.tmuxClient);
    }
    const frame = session.tmuxClient ? readFrame(session.tmuxClient) : null;
    if (frame) {
      lastTarget = frame.target;
      // And on disk, so the next run knows where you were. Cheap enough to do
      // on every frame: it is one small write and only when the target changed.
      rememberTarget(frame.target);
      if (frame.target.id !== session.tmux?.id) followSession(frame.target);
      else session.tmux = frame.target; // a rename keeps the id and changes the name
      /*
       * The strip's half of the bargain: while the panel draws its own window
       * list, tmux's own bar must not be on screen — and the ways it can get
       * there are keybindings, not bugs: `prefix :` and a bare `set status on`,
       * a plugin's or config's `set status …` without `-g`, a reload that
       * re-sources one, a client moved onto a session that never had `status
       * off`. None of them change the session we are tracking, so `followSession`
       * never sees them — which is exactly how the bar used to come back and
       * STAY. So the choice is re-asserted every tick, off the two fields the
       * frame already reads, and a flip heals within half a second instead of
       * sticking until the session changes or the panel is reopened.
       *
       * The block stands back only when the panel has explicitly asked for
       * tmux's own bar (`visible: true` — the web panel's toggle). Until the
       * panel says, the strip is the app's and the bar is asserted: the phone
       * never sends the toggle, and its strip is always the app's.
       *
       * Who gets re-asserted depends on whose session the client is on:
       *
       *  - OUR mirror (`agx-phone-…`): the bar belongs to the app here, so
       *    anything that turns it on or drops the claim is undone, with no
       *    budget. Hiding on the mirror costs nobody else anything, and the
       *    claim plus the prompt keys are what the phone's own prompts run
       *    on — which is also why a config that never had a bar still gets
       *    them on the mirror.
       *  - A user's own session, on an ATTACH that had a mirror: the client
       *    wandered (`^b s`, an `attach-session` typed in, a continuum
       *    restore), and re-hiding there would take the DESK's bar away —
       *    `status` is a session option and the desk is on that session too.
       *    A fresh mirror of it is made and the client switched back, which
       *    is how the panel keeps its strip without touching the user's.
       *    A switch that keeps failing is braked: three misses in a row buy
       *    a minute off, because looping a create-and-kill every tick would
       *    be its own bug.
       *  - A user's own session with no mirror behind it (a plain shell that
       *    ran `tmux`): the panel's answer hides it, as it always has, and
       *    this is also what heals a flip on it — up to a budget. See
       *    `TMUX_BAR_HEAL_BUDGET`: forever would take the user's own
       *    override away.
       */
      if (session.tmuxStatusVisible !== true) {
        const t = frame.target;
        if (isPhoneSession(t.session)) {
          if (frame.status !== "off" || !frame.owned) {
            if (setStatusLine(t, false)) session.tmuxStatusHiddenOn = t;
          }
        } else if (session.phoneAttach) {
          if (session.tmuxClient && (session.remountQuietUntil ?? 0) <= Date.now()) {
            if (remountPhoneClient(session.tmuxClient, t)) {
              session.remountFails = 0;
            } else {
              session.remountFails = (session.remountFails ?? 0) + 1;
              if (session.remountFails >= REMOUNT_FAILS_BEFORE_QUIET) {
                session.remountQuietUntil = Date.now() + REMOUNT_QUIET_MS;
                // The reason, said once at the moment of giving up rather than
                // every tick: run the failing switch once more and keep what
                // tmux answers. `remountPhoneClient` swallows stderr, which is
                // exactly what a loop must not do with it.
                const r = Bun.spawnSync(
                  ["tmux", ...session.tmuxClient.socket, "switch-client", "-c", session.tmuxClient.tty, "-t", t.id],
                  { stdout: "pipe", stderr: "pipe", timeout: 4000, env: process.env },
                );
                const why = r.stderr.toString().trim() || r.stdout.toString().trim() || "switch-client failed";
                console.warn(`[terminal] could not put the phone back on a mirror (${why}); not trying again for a minute`);
              }
            }
          }
        } else if (frame.status === "on") {
          const budget = session.tmuxBarHealBudget;
          if (budget?.sessionId === t.id && budget.left <= 0) {
            // Argued out: the flip on this session stands — the user won.
          } else if (setStatusLine(t, false)) {
            session.tmuxStatusHiddenOn = t;
            session.tmuxBarHealBudget = budget?.sessionId === t.id
              ? { sessionId: t.id, left: budget.left - 1 }
              : { sessionId: t.id, left: TMUX_BAR_HEAL_BUDGET - 1 };
          }
        }
      }
    } else {
      // Unreachable: the server went away, or the client is mid-attach. Drop it
      // and resolve again next tick rather than answer from something stale.
      session.tmuxClient = null;
      session.tmux = null;
    }
    const windows = frame?.windows ?? [];
    /*
     * Which of these a phone is on, marked before the change check below so
     * that a phone arriving or leaving is itself a change worth sending.
     *
     * One extra tmux call per tick in the ordinary case: `phoneWindows` asks
     * for the session list, finds no `agx-phone-…` in it, and stops without
     * listing a single pane.
     */
    if (frame) {
      const onPhone = phoneWindows(frame.target.socket);
      for (const w of windows) if (onPhone.has(w.id)) w.phone = true;

      /*
       * And a window still at phone width with no phone on it gets its columns
       * back, without anybody clicking anything.
       *
       * The notice this used to leave on the desk said it out loud: "your phone
       * left without putting it back", beside a button. Everything in that
       * sentence is something the machine already knows — the window is narrow,
       * the mark says we narrowed it, and nothing is attached to it — so making
       * somebody read it and press a button is asking them to do a job that has
       * no decision in it. Found on a real machine as a window pinned at 80
       * columns inside a 285-column terminal, hours after the phone had gone.
       *
       * The teardown still owes the restore and still usually pays it. This is
       * for the three ways it cannot: a socket that never closed, a restore
       * that ran while the phone was briefly still there, and a server killed
       * between the fit and the teardown. See `reclaimPinnedWindow`, which
       * holds the patience and the proof; here we only answer "is this window
       * narrower than the terminal looking at it, and is it free".
       *
       * Free means more than tmux's answer. A phone whose socket is up but
       * whose tmux client has not landed yet is between two attaches, and its
       * own teardown owes the window — reclaiming it there is the tab-switch
       * flicker `RECLAIM_AFTER_MS` exists to avoid, arriving by another road.
       */
      const client = frame.client;
      if (client) for (const w of windows) {
        const narrow = !!w.cols && w.cols < client.cols;
        const held = onPhone.has(w.id) || phoneAttachedTo(frame.target.socket, w.id);
        reclaimPinnedWindow(frame.target.socket, frame.target.id, w.id, narrow && !held);
      }

      // "The agent in this tab finished its turn." Group the frame's panes by
      // their window, then: the active window (the one the desk is looking at) is
      // marked seen so its dot goes out; every other window lights if any pane in
      // it holds an agent whose most recent event ended a turn and the desk has
      // not looked since. A pane with no agent (nvim, a plain shell) never lights.
      const panesByWindow = new Map<string, string[]>();
      for (const [paneId, winId] of frame.windowOfPane) {
        const list = panesByWindow.get(winId);
        if (list) list.push(paneId); else panesByWindow.set(winId, [paneId]);
      }
      for (const w of windows) {
        const paneIds = panesByWindow.get(w.id) ?? [];
        if (w.active) markSeen(paneIds);
        else if (paneIds.some(paneFinished)) w.agentDone = true;
      }
    }
    // Only the active window's, and only while tmux is drawing them — see
    // parsePaneGeometry. Empty is the honest answer for an unsplit window too:
    // one pane covering everything is nothing to choose between.
    const panes = (frame?.panes ?? []).length > 1 ? frame!.panes : [];
    /**
     * A prompt tmux would have drawn, taken off the window and forwarded once.
     *
     * Cleared here rather than by the panel: the note is on the tmux side and
     * the sweep is the only thing holding a target for it, and leaving it set
     * would have the panel reopening its rename box twice a second for as long
     * as the option lived. Forwarded first, cleared second — the frame below
     * still carries `ask`, and the next sweep will not.
     */
    if (frame && windows.some((w) => w.ask)) {
      for (const w of windows) if (w.ask) clearAsk(frame.target, w.id);
      // Deliberately outside the change check below: two renames in a row on
      // the same window are the same shape, and the second must still open the
      // box. `sent` is reset so the following sweep — which no longer carries
      // the note — is seen as a change and clears it from the client's copy.
      sent = "";
    }
    // Only speak when something changed. A tab strip that re-renders on every
    // tick is a tab strip that drops the click you were halfway through. The
    // session is part of "changed": switching between two sessions with the
    // same window names is still a switch, and the panel says which one it is.
    /*
     * The windows this client was last SHOWN, kept so an action can be checked
     * against them. Assigned before the change check below on purpose: a sweep
     * that finds nothing new still returns early, and a guard reading a list
     * that only updates on change would reject a legitimate click on a quiet
     * session.
     */
    session.tmuxWindows = windows;
    /*
     * `client` is part of the shape, not merely of the frame.
     *
     * The panel says "this window is 80 columns while your terminal is 220" by
     * comparing the two, so a desk that drags its terminal narrower changes the
     * answer without changing a single window. Left out, the notice would stay
     * up (or stay down) until something else happened to move the shape —
     * including the case of somebody resizing back to matching, where it is the
     * TERMINAL that changed and no window did.
     */
    const shape = JSON.stringify([session.tmux?.id ?? null, windows, panes, frame?.client ?? null]);
    if (shape === sent) return;
    sent = shape;
    ctl(ws, {
      t: "tmux", active: true, session: session.tmux?.session ?? null,
      prefix: session.tmuxPrefix ?? [], windows, panes, client: frame?.client ?? null,
    });
  };
  session.tmuxSweep = sweep;
  /*
   * How often to look.
   *
   * Two seconds was chosen for "has tmux appeared", where being a beat late
   * costs nothing. It is far too slow for a tab strip: `^b n` moved the focus
   * instantly in the terminal and the tabs sat on the old answer for up to two
   * seconds, which reads as the app being broken rather than behind. Half a
   * second is the ceiling for "instant" and the check is one small tmux call
   * that only speaks when something actually changed.
   */
  const tmuxPoll = setInterval(sweep, 500);
  session.tmuxPoll = tmuxPoll;

  /*
   * Keep the tab strip up with the KEYBOARD, not just the poll.
   *
   * `^b n`, `^b <num>` and friends switch the window inside tmux — this server
   * never sees the keystroke — so the strip only learned on the next 500ms
   * sweep, which is the "mini retardo" a switch by hand feels (a click is
   * instant because the panel updates optimistically; the keyboard has nobody
   * to do that for it).
   *
   * But a switch REDRAWS the pane, so output lands right after it. Arm a sweep
   * off that output. A trailing debounce with a ceiling: quiet for ~70ms after a
   * burst → sweep (a switch is a short redraw then silence, so it fires fast);
   * a log that never pauses keeps resetting it, so it does not turn every write
   * into a tmux call — capped at ~220ms so even mid-stream it is never far off.
   * The sweep already de-dupes, so a nudge that finds nothing sends nothing.
   */
  let nudgeFrom = 0;
  const nudgeTmux = () => {
    if (!session.tmux || session.closed) return;
    const now = Date.now();
    if (session.tmuxNudge) clearTimeout(session.tmuxNudge);
    else nudgeFrom = now;
    const wait = Math.min(70, Math.max(0, 220 - (now - nudgeFrom)));
    session.tmuxNudge = setTimeout(() => { session.tmuxNudge = null; if (!session.closed) sweep(); }, wait);
  };

  /**
   * Shell output → socket, coalesced and back-pressured.
   *
   * It used to be one WebSocket frame per read off the pty. That is fine for a
   * prompt and terrible for `cat` on a large file or a build log: the pty hands
   * over whatever the kernel has, so a fast producer becomes thousands of tiny
   * frames a second, each one a send here, a message event there, and a
   * separate `term.write()` in the renderer. The cost is not the bytes, it is
   * the per-frame overhead on both ends.
   *
   * Two things fix it, and they are the two the terminal actually needs:
   *
   *   * **Coalesce.** Hold what arrives for one frame's worth of time (8ms) and
   *     send it as one message. A burst collapses into ~120 frames a second
   *     instead of thousands. Typing is unaffected in any way a human can
   *     perceive — 8ms is a third of the time it takes the key to travel — and
   *     anything already large goes immediately rather than waiting.
   *   * **Push back.** If the socket is behind, stop reading the pty. There is
   *     no pause/resume call to make: not draining the stream lets the pipe
   *     fill, and the kernel stops the producer for us — which is the whole
   *     point of a pty being a pty. Without this, a runaway `yes` is buffered
   *     in this process until something gives, and the something is memory.
   */
  const FRAME_MS = 8;
  const BIG = 64 * 1024;          // send at once rather than waiting out the frame
  const HIGH_WATER = 512 * 1024;  // socket queue past which we stop reading

  const pump = async (readable: ReadableStream<Uint8Array> | null | undefined) => {
    if (!readable) return;
    const reader = readable.getReader();
    let held: Uint8Array[] = [];
    let size = 0;
    let backedUp = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!held.length) return;
      const out = held.length === 1 ? held[0] : (() => {
        const all = new Uint8Array(size);
        let at = 0;
        for (const c of held) { all.set(c, at); at += c.length; }
        return all;
      })();
      held = []; size = 0;
      if (session.closed) return;
      // Bun answers with the bytes queued, or -1 when the socket is already
      // backed up. That is a real backpressure signal from the transport
      // itself — better than inferring it from a byte count — so remember it
      // and let the read loop stop pulling on the pty until it clears.
      try { if (ws.send(out) === -1) backedUp = true; } catch { /* socket gone; the read loop will notice */ }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (session.closed) break;
        if (value?.length) {
          held.push(value);
          size += value.length;
          if (size >= BIG) flush();
          else if (!timer) timer = setTimeout(flush, FRAME_MS);
          // A redraw means the window may have changed under the keyboard —
          // catch it without waiting for the poll. Cheap: a debounce reset.
          nudgeTmux();
        }
        // Let the client catch up before pulling more out of the shell. Two
        // ways to know it is behind: the transport said so on the last send, or
        // the queue is deep. The wait is bounded — a client that never drains
        // is a dead client, and holding the shell for it forever is worse than
        // dropping behind.
        let waited = 0;
        while (!session.closed && waited < 10_000 &&
               (backedUp || (ws.getBufferedAmount?.() ?? 0) > HIGH_WATER)) {
          flush();
          await Bun.sleep(4);
          waited += 4;
          backedUp = (ws.getBufferedAmount?.() ?? 0) > HIGH_WATER;
        }
      }
    } catch { /* stream torn down */ }
    finally { flush(); }
  };

  (async () => {
    await Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>), pump(proc.stderr as ReadableStream<Uint8Array>)]);
    const code = await proc.exited;
    session.exited = true; // the pid is reaped now — no signal may target it again
    if (session.killTimer) { clearTimeout(session.killTimer); session.killTimer = null; }
    if (!session.closed) {
      ctl(ws, { t: "exit", code });
      try { ws.close(1000, "shell exited"); } catch { /* already closed */ }
    }
    cleanup(ws, session);
  })();
}

/**
 * Tell whoever is looking at this window from a phone that it just changed size
 * under them.
 *
 * The desk's take-over is complete without this — the window is already back at
 * the desk's width. What is not complete is the phone: its `fit` flag is still
 * true, so its own "you are seeing 80 of 200 columns" hint stays suppressed, and
 * the width it quotes was written once when it attached and never again. It
 * would be showing a fitted UI over a window that is no longer fitted, which is
 * the same invisible lie the phone mark on the strip exists to kill.
 *
 * Sent, not asked for. The window is found by walking the live sockets rather
 * than by asking tmux who is there: `phoneAttach.windowId` is how a socket is
 * reached, and a socket that has since moved to another window gets a frame it
 * will correct itself on its next attach — the alternative, trusting that id as
 * truth, is the thing its own comment forbids.
 *
 * Sockets are matched by resolved PATH: the desk's client usually names no
 * socket at all in its argv while the phone's attach carries `-S /tmp/...`, so
 * comparing the two spellings never matches even on the same server.
 */
/**
 * Whether a phone socket in THIS process is on that window, whatever tmux says.
 *
 * tmux answers "which windows have a phone client attached right now", and that
 * is a narrower question than "is a phone here". A socket that is up but whose
 * tmux client has not landed — or has just gone, with its teardown already
 * scheduled — is a phone between two attaches, and the window it names is owed
 * a restore by that teardown rather than by anything else.
 *
 * Matched by resolved socket PATH for the reason `tellPhonesTheWindowMoved`
 * spells out: the desk's argv usually names no socket and the phone's carries
 * the resolved one, so comparing the arrays never matches on the same server.
 */
function phoneAttachedTo(socket: string[], windowId: string): boolean {
  const server = socketPath(socket);
  for (const s of sessions.values()) {
    const at = s.phoneAttach;
    if (at && at.windowId === windowId && socketPath(at.socket) === server) return true;
  }
  return false;
}

function tellPhonesTheWindowMoved(t: TmuxTarget, windowId: string) {
  const size = windowSize(t.socket, windowId);
  if (!size) return;
  const server = socketPath(t.socket);
  for (const [ws, s] of sessions) {
    const at = s.phoneAttach;
    if (!at || at.windowId !== windowId || socketPath(at.socket) !== server) continue;
    /*
     * The FLAG, and not only the frame. This is the whole of a reported bug.
     *
     * `at.fit` is what the resize handler reads to decide whether a phone's
     * geometry moves the real window, and it was written once at attach and
     * never again. So the take-over gave the desk its columns back and left
     * the attach still claiming the window: the phone's very next `resize`
     * frame ran `fitWindow` and squeezed it to 80 again. That frame does not
     * need anybody to touch the phone — a WebView re-measuring after the app
     * comes back to the foreground sends one, which is exactly the shape it
     * was reported in ("I take the width back on the computer and it goes
     * narrow again on its own").
     *
     * Clearing it does not hang up on the phone and does not end its session;
     * it ends this phone's CLAIM on the window's size. The phone tapping fit
     * again reattaches with `fit=1` and gets it back, which is the rule the
     * take-over already states: it ends the reflow that is happening, it is
     * not a lock.
     *
     * Before the frame rather than after, so a send that throws still leaves
     * the server's own state true.
     */
    at.fit = false;
    ctl(ws, { t: "pane", cols: size.cols, rows: size.rows, fit: false, by: "desk" });
  }
}

/** Client frame: {t:"in",d} keystrokes → shell stdin · {t:"resize",cols,rows}. */
export function ptyMessage(ws: PtyWs, raw: string | Buffer) {
  const s = sessions.get(ws);
  if (!s) return;
  /*
   * The field names come from `PtyClientFrame`; the optionality does not.
   *
   * This used to be a hand-written bag of `?` fields, which was the third
   * private copy of a protocol with no contract — `number` and `root` here,
   * `{cmd:"review"}` on the desk, nothing anywhere that said they were the same
   * message. `PtyClientMessage` is that union with every field made a maybe, so
   * a rename in the contract stops compiling at the line below that reads it.
   *
   * Deliberately NOT the union itself. This is `JSON.parse` of whatever a
   * client sent, and asserting it into `PtyClientFrame` would tell the compiler
   * that `msg.d` is a string and `msg.cwd` is a path — retiring every guard on
   * a socket that is reachable from the UI. The guards are the boundary; the
   * type only makes sure they are guarding the right names.
   */
  let msg: PtyClientMessage;
  try { msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()); } catch { return; }
  if (msg.t === "in" && typeof msg.d === "string" && msg.d) {
    // A keystroke is the least ambiguous "a human is waiting on this process"
    // signal there is; the background sweeps stand back while it is fresh.
    terminalActive();
    try {
      const sink = s.proc.stdin as { write?: (b: Uint8Array) => void; flush?: () => void };
      sink.write?.(enc.encode(msg.d));
      sink.flush?.();
    } catch { /* shell gone */ }
  } else if (msg.t === "resize") {
    const cols = clampCols(msg.cols);
    const rows = clampRows(msg.rows);
    if (!cols || !rows || !s.sizeDir || s.exited) return; // resize is pty_bridge-only
    try {
      writeSizeFile(s.sizeDir, rows, cols);
      process.kill(s.proc.pid, "SIGWINCH"); // bridge applies TIOCSWINSZ + forwards
    } catch { /* shell gone */ }
    /*
     * And the window with it, when this phone asked the window to follow it.
     *
     * The fit at attach used the size on the query string, which for a fresh
     * WebView is the 80x24 default — it has not measured itself yet. Reported
     * from a phone: the text wrapped correctly at 80 columns and then stopped a
     * third of the way down the screen, because the window really was 24 rows
     * tall. tmux does not follow a grouped client on its own here, by design:
     * `window-size` is `largest` and the desk is larger.
     */
    const at = s.phoneAttach;
    if (at?.fit) fitWindow(at.socket, at.sessionId, at.windowId, cols, rows);
    /*
     * And then say how wide the window REALLY came out, whether or not this
     * phone asked it to follow.
     *
     * `ready.pane` fires once and `t:"pane"` only ever fired when the desk moved
     * the window, so a phone that changed its own width had no way to learn the
     * consequence — and the consequence is not a constant. `window-size largest`
     * means the window is as wide as the widest client, so asking for 60 columns
     * moves the real window when this phone is the only one attached and moves
     * nothing at all when an 80-column desk is looking. The screen was left
     * inferring which by comparing the last size it had been told against the
     * width it was asking for when it was told, and at a fresh attach those
     * agree for a reason that has nothing to do with the phone: an 80-column
     * desk and an 80-column default. That is how it came to say "it is 60
     * columns for the computer too" with twenty columns falling off the right —
     * proved with an 80-column ruler, where `shared` arrived as `sha`.
     *
     * One `windowSize` call per resize, and a resize is a width tap or a
     * keyboard appearing, not something that happens per frame.
     */
    if (at) {
      const real = windowSize(at.socket, at.windowId);
      if (real) ctl(ws, { t: "pane", cols: real.cols, rows: real.rows, fit: at.fit, by: "phone" });
    }
  } else if (msg.t === "tmux") {
    /*
     * A tab was clicked.
     *
     * Everything here is something a keybinding could already do, so this adds
     * no capability to a socket that already carries a shell — it adds a second
     * way to reach four commands. The target is the session *we* resolved from
     * /proc, never one the client names, so a page cannot address somebody
     * else's tmux by asking nicely.
     */
    if (msg.cmd === "status") {
      const visible = msg.visible !== false;
      // Remembered before it is applied, and remembered even with no session
      // resolved yet: this is a preference about tmux's chrome, not about one
      // session, and it has to survive the client being switched to another.
      s.tmuxStatusVisible = visible;
      // A fresh explicit hide is a fresh consent: the next session whose bar
      // comes back on gets a full heal budget again, whatever a previous one
      // spent arguing.
      s.tmuxBarHealBudget = null;
      if (!s.tmux) return;
      if (setStatusLine(s.tmux, visible)) s.tmuxStatusHiddenOn = visible ? null : s.tmux;
      return;
    }

    /*
     * A finger, moving this phone's own pane through its scrollback.
     *
     * The narrowest thing that could serve it: a signed count, on the pane the
     * phone's own grouped session is looking at, resolved from the session name
     * WE made. The client names nothing — not a pane, not a session, not a
     * command — which is the same division every other branch here follows.
     *
     * It is on this socket rather than being a route of its own because it is
     * per-attach state: which pane, and whether we are the ones who opened copy
     * mode on it, are facts about this socket and die with it.
     *
     * Above the `s.tmux` guard below, because it does not use it. That guard is
     * about the tmux the SWEEP resolved out of /proc, which arrives up to half a
     * second after the attach; this reaches the phone's own grouped session by
     * name, which the attach knew before the socket said it was ready. Behind
     * the guard, the first swipe of a freshly opened tab was dropped in silence.
     */
    if (msg.cmd === "scroll") {
      const at = s.phoneAttach;
      if (!at || typeof msg.lines !== "number") return;
      const did = scrollPhonePane(at.socket, at.phoneSession, msg.lines);
      if (!did) return;
      // Remembered on the way in, and forgotten when tmux has left the mode by
      // itself — `-e` exits at the bottom of the history, which is the ordinary
      // end of a scroll and must not leave a debt recorded against a pane that
      // is no longer in copy mode.
      if (did.entered) s.copyMode = did.paneId;
      if (!did.inMode) s.copyMode = null;
      return;
    }

    /*
     * The phone's `+`: a new window with the agent in it, in THIS project.
     *
     * ── where, and why the server decides it ─────────────────────────────
     * `new-window` with no `-c` inherits the session's default directory,
     * which on this machine is the home directory — so the button that was
     * asked for ("open a Claude here") would have opened one in `~`, in no
     * repository at all, and the only sign of it would be an agent that
     * cannot find the file you then ask it about. The pane this socket is
     * attached to is what "here" means, so its cwd is read from tmux at the
     * moment of the press (see `paneCwd` — the sweep's copy is up to two
     * seconds old) and rolled up to that checkout's git root.
     *
     * `repoRootOf` and not `projectRootOf`: a pane sitting in a linked
     * worktree is somebody working on that branch, and folding it up to the
     * main checkout would open the agent in the wrong tree. A directory that
     * is not a repository at all keeps the pane's own cwd, which is still
     * where the person is.
     *
     * ── and the flag ─────────────────────────────────────────────────────
     * The client sends a boolean. Everything that reaches a command line here
     * — the binary, the flag, the directory — is resolved on this side, which
     * is the same division `cmd:"issue"` above already makes and the reason
     * this socket being reachable from the UI is not a way to run things.
     */
    if (msg.cmd === "agent") {
      /*
       * Above the `!s.tmux` guard below, and that placement is a fix rather
       * than a style choice.
       *
       * Everything under that guard answers a client by DOING something to
       * tmux, so "there is no tmux" is correctly a silent no-op there. This
       * command is the one with a caller WAITING on a reply: the phone turns
       * its `+` into a spinner and only a frame turns it back. Reported from
       * QA against a session whose sweep had not resolved a target — the press
       * registered, nothing came back, and the control sat on `…` for as long
       * as anybody watched. A button with no way out is worse than one that
       * refuses.
       */
      const target = s.tmux;
      if (!target) {
        ctl(ws, { t: "openfail", error: "this terminal is not attached to tmux yet — try again in a moment" });
        return;
      }
      const at = s.phoneAttach;
      const where = at ? paneCwd(target.socket, at.paneId) : null;
      // Nothing to anchor to is a reason to refuse, not to fall back on a home
      // directory: an agent in the wrong tree is the failure this exists to
      // prevent, and it is invisible once it has happened.
      if (!where || !existsSync(where)) {
        ctl(ws, { t: "openfail", error: "could not tell which project this pane is in" });
        return;
      }
      const root = repoRootOf(where) ?? where;
      if (!inScope(root)) {
        ctl(ws, { t: "openfail", error: "that project is outside the workspace" });
        return;
      }
      const bin = claudeCode.bin();
      // The window is named after the checkout, which is what tells six of them
      // apart in a strip — `agentglass`, `width-toast`, `phone-new-tab`.
      const name = basename(root) || "agent";
      const opened = bin
        ? newWindowRunning(target, root, name, [
            bin,
            ...(msg.yolo === true ? ["--dangerously-skip-permissions"] : []),
          ])
        // No agent on this machine is not a reason to open nothing: a shell in
        // the right project is still most of what was asked for, and the same
        // answer `cmd:"issue"` gives.
        : newWindowRunning(target, root, name, []);
      if (!opened) {
        ctl(ws, { t: "openfail", error: "tmux would not open a window" });
        return;
      }
      ctl(ws, { t: "opened", pane: opened.paneId, window: opened.windowId, cwd: root });
      s.tmuxSweep?.();
      return;
    }

    /*
     * "The pointer is over that pane" — focus follows mouse, inside tmux.
     *
     * The narrowest of these commands on purpose. It cannot change window or
     * session, it carries no strings that reach a shell, and the pane id is
     * checked against tmux's syntax before it is passed. It is also the only
     * one sent without a click behind it, which is exactly why it is kept
     * unable to do anything a hover should not.
     */
    if (msg.cmd === "selectpane") {
      if (s.tmux && typeof msg.pane === "string") selectPane(s.tmux, msg.pane);
      return;
    }

    /*
     * Open a pull request review in a window of the user's own tmux.
     *
     * Deliberately a review of a *number* rather than a "run this": the client
     * sends an integer and a directory it already had, and the server builds
     * everything that will actually execute — the same prompt the chat uses,
     * from `prepareReviewPrompt`, which is also where the scope check lives.
     * Handing this socket a command string instead would have turned four
     * button actions into arbitrary execution in the user's shell.
     */
    if (msg.cmd === "review") {
      let target = s.tmux;
      if (!target) {
        /*
         * Resolve NOW rather than wait for the next poll.
         *
         * The sweep runs every 500ms and the first one is 500ms after the
         * socket opens, so a button pressed the instant this terminal appears
         * asks a question nobody has looked up yet. Answering "no tmux" then
         * would send a tmux user's card to a pane — right answer, wrong
         * machine. The sweep is synchronous and cheap, so it is simply run.
         */
        s.tmuxSweep?.();
        target = s.tmux;
      }
      if (!target) { ctl(ws, { t: "openfail", error: NO_TMUX }); return; }
      const number = msg.number;
      // A review of nothing, in nowhere, is not a request this can serve.
      if (typeof number !== "number" || !msg.root) return;
      const root = msg.root;
      // Kept off `ptyMessage`'s signature: it is called for every keystroke on
      // this socket, and making the hot path return a promise to serve one
      // message would be a poor trade.
      void (async () => {
        const plan = await prepareReviewPrompt(root, number);
        if (!plan.ok) return;
        const bin = claudeCode.bin();
        if (!bin) return;
        // The prompt as a single argument. Claude Code takes a positional
        // prompt and submits it, so the window opens with the review already
        // running rather than with something typed that nobody pressed return
        // on.
        newWindowRunning(target, plan.cwd, `pr-${number}`, [bin, plan.prompt]);
        s.tmuxSweep?.();
      })();
      return;
    }

    /*
     * Start work on an issue in a window of the user's own tmux.
     *
     * The directory has already been created by the server (issues.ts cut the
     * worktree) and the prompt was written there too — this only opens a window
     * and, when asked, starts the agent in it. The client still never sends a
     * command: the binary comes from claudeCode.bin() and the prompt is a single
     * positional argument, exactly as the pull-request review does it.
     *
     * The scope check is owed even though the path came from us, because this
     * socket is reachable from the UI and "we made it earlier" is not something
     * this handler can verify.
     */
    if (msg.cmd === "issue") {
      let target = s.tmux;
      if (!target) {
        /*
         * Resolve NOW rather than wait for the next poll.
         *
         * The sweep runs every 500ms and the first one is 500ms after the
         * socket opens, so a button pressed the instant this terminal appears
         * asks a question nobody has looked up yet. Answering "no tmux" then
         * would send a tmux user's card to a pane — right answer, wrong
         * machine. The sweep is synchronous and cheap, so it is simply run.
         */
        s.tmuxSweep?.();
        target = s.tmux;
      }
      if (!target) { ctl(ws, { t: "openfail", error: NO_TMUX }); return; }
      const cwd = safeAbs(msg.cwd);
      if (!cwd || !inScope(cwd) || !existsSync(cwd)) return;
      const name = typeof msg.name === "string" ? msg.name : "issue";
      const prompt = typeof msg.prompt === "string" ? msg.prompt : "";
      const title = sessionTitle(msg.title);
      if (msg.agent === true && prompt) {
        const bin = claudeCode.bin();
        /*
         * What runs is decided HERE, not by the client.
         *
         * The client sends text and two booleans; the binary, `--name` and
         * `--dangerously-skip-permissions` are the server's, so a socket
         * reachable from the UI cannot become a way to pass arbitrary
         * arguments. `sessionTitle` is what makes sure a card title cannot be
         * anything but a title. The reasoning for each flag, and the argv
         * itself, live in agentticket.ts — shared with the pane path.
         */
        // Built by agentticket.ts, which the tmux-less pane path also uses.
        // Two call sites building the same command line is how the two paths
        // would quietly stop doing the same thing.
        const argv = agentArgv(bin, { prompt, yolo: msg.yolo === true, title }, supportsSessionName(bin));
        // No agent available is not a reason to open nothing: a shell in the
        // right worktree is still most of what was asked for.
        newWindowRunning(target, cwd, name, argv);
      } else {
        newWindowRunning(target, cwd, name, []);
      }
      s.tmuxSweep?.();
      return;
    }

    /*
     * Everything below acts ON tmux, so with none there is nothing to do and
     * silence is right.
     *
     * It used to sit ABOVE `review` and `issue`, and that is what the dispatch
     * audit found: those two are not commands about tmux, they are a pull
     * request or a card being sent to an agent, and they were swallowed here on
     * every machine with no tmux client — which, until procchildren.ts, meant
     * every Mac, with no message. They answer for themselves now, above.
     * `cmd:"agent"` was moved out earlier for the same reason: a button with no
     * way out is worse than one that refuses.
     */
    if (!s.tmux) return;

    const action = msg.cmd as TmuxAction;
    if (!["select", "new", "kill", "rename", "move", "takeover", "fit"].includes(action)) return;
    /*
     * A window this client was actually shown, and not merely a well-formed id.
     *
     * `runAction` checks the id against tmux's syntax and runs it on the socket
     * WE resolved, which is what stops a page addressing another user's tmux.
     * It does not stop this client naming a window on our own server that
     * belongs to a session it has never seen — and take-over writes an option
     * on a window rather than acting on the one the tab strip is drawing, so
     * "it is on the frame we sent" is the narrower and honest envelope.
     *
     * Take-over specifically, because it is the one action here that changes
     * what somebody ELSE sees: a window in another session is a different
     * screen and a different person's layout. The four older actions keep the
     * looser check — the strip only ever offers ids it was given, and
     * tightening them here is a behaviour change nobody asked for.
     */
    if (action === "takeover" && !(s.tmuxWindows ?? []).some((w) => w.id === msg.window)) return;
    // The panel's own grid goes with it, for `fit`: only the client knows how
    // big the thing you are looking at is. Range-checked in runAction, because
    // it ends up as an argument to `resize-window`.
    if (!runAction(s.tmux, action, msg.window, msg.name, msg.cols, msg.rows)) return;
    if (action === "takeover") tellPhonesTheWindowMoved(s.tmux, msg.window!);
    // Answer now rather than at the next tick. The command has already been
    // applied by the time it returns, so the strip can be correct within a
    // round trip instead of within half a second — and the click that caused
    // it is exactly when a stale answer is most obvious.
    s.tmuxSweep?.();
  }
}

/** Socket closed → hang up the whole job tree (SIGHUP, then SIGKILL). */
export function ptyClose(ws: PtyWs) {
  const s = sessions.get(ws);
  if (!s) return;
  s.closed = true;
  if (!s.exited) {
    killGroup(s, 1); // SIGHUP: what a real closing terminal sends
    // Escalate only if the job survives the hangup — and never after the pid
    // has been reaped (a recycled pid/pgid must not catch a stray SIGKILL).
    s.killTimer = setTimeout(() => { s.killTimer = null; if (!s.exited) killGroup(s, 9); }, 3000);
  }
  cleanup(ws, s);
}

function cleanup(ws: PtyWs, s: Session) {
  sessions.delete(ws);
  if (s.tmuxPoll) { clearInterval(s.tmuxPoll); s.tmuxPoll = null; }
  if (s.tmuxNudge) { clearTimeout(s.tmuxNudge); s.tmuxNudge = null; }
  // Give the status line back before letting go. The panel borrowed it; a
  // session left with `status off` after the panel closed looks broken in the
  // user's real terminal, and nothing there would point back at us.
  if (s.tmuxStatusHiddenOn) { setStatusLine(s.tmuxStatusHiddenOn, true); s.tmuxStatusHiddenOn = null; }
  /*
   * Give the desk its width and its panes back.
   *
   * Twice, and not immediately, and both numbers are races that were lost.
   *
   * Not immediately, because our own tmux session goes away when its client
   * detaches (`destroy-unattached on`) and that happens after the pty dies — a
   * resize asked for right now still sees the phone's own client and recomputes
   * to it.
   *
   * And not at 300ms either, which is what this was: flipping `fit` closes this
   * socket and opens another, and at 300ms the old session can be gone while
   * the new one has not finished attaching. The restore then landed in that gap
   * and undid a fit that was about to be a second old — which from the phone is
   * a switch that does nothing at all. `restoreWindows` skips a window a
   * phone is still on, and 1.5s is long enough for the new one to be there to
   * be seen. The desk waits that long for its width back, and does not notice.
   *
   * Both of those delays are also why a take-over marks the window: this fires
   * up to three seconds after the socket closed, and by then the desk may have
   * asked for its width back on the same window. Restoring on top of that hands
   * it to the phone again (measured: 80x24 with the phone still attached), so
   * `restoreWindows` leaves a claimed window entirely alone.
   *
   * `zoomed` rides along on the same schedule and through the same skips. It
   * has to: the zoom is the reason one tab means one pane on the phone, and it
   * is a flag on the desk's own window, so the phone leaving without putting it
   * back is a desk with three of its panes invisible and nothing on screen to
   * say who did it.
   */
  const back = s.phoneAttach;
  /*
   * Copy mode back too, and before the window is — it is the same debt.
   *
   * A phone that scrolled into the history and then put the phone down leaves
   * the shared pane in copy mode, so the desk's next keystroke is read as a
   * copy-mode command by a pane that looks entirely ordinary. Immediately,
   * unlike the window size below: nothing about it races the detach, because a
   * pane's mode has nothing to do with which clients are attached. And only when
   * WE opened it — `leaveCopyMode` checks the mode is still on before acting, so
   * a person who has since started their own copy mode on that pane keeps it.
   */
  if (back && s.copyMode) {
    try { leaveCopyMode(back.socket, s.copyMode); } catch { /* the server went away */ }
    s.copyMode = null;
  }
  s.phoneAttach = null;
  if (back) {
    // On the ledger before either timer is armed, because the gap this closes
    // is exactly "the process died between the socket closing and 3000ms" —
    // see `owed`.
    owed.add(back);
    const put = () => { try { restoreWindows(back.socket, back.sessionId, back.hadWindowSize, back.zoomed); } catch { /* the server went away */ } };
    setTimeout(put, 1500);
    // Off the ledger only after the SECOND call has run, in that order and in
    // one timer rather than two racing at the same delay.
    setTimeout(() => { put(); owed.delete(back); }, 3000);
  }
  if (s.sizeDir) { try { rmSync(s.sizeDir, { recursive: true, force: true }); } catch { /* tmp reaper will get it */ } s.sizeDir = null; }
  if (s.viewDir) { try { rmSync(s.viewDir, { recursive: true, force: true }); } catch { /* tmp reaper will get it */ } s.viewDir = null; }
}

/**
 * Hang up every live shell, remove their temp dirs, and give the user's tmux
 * back everything a phone borrowed from it.
 *
 * Called when the server is going down: a plain exit only reaps children the
 * kernel happens to HUP, and the `script`/pipe fallbacks have no such
 * guarantee, so a killed server would otherwise leave orphaned shells and /tmp
 * dirs behind.
 *
 * THE TMUX HALF WAS MISSING, and it is the fault this shape exists for. This
 * function is wired to SIGINT/SIGTERM in index.ts with `process.exit(0)` on the
 * next line. It never called `cleanup`, so `restoreWindows` never ran — and
 * restarting the server left the desk's window at the phone's 80x24 with
 * `window-size manual` written on it, on every window of that session, for
 * ever, with nothing on screen to explain it. Measured on a private server
 * (tmux 3.6a, `-f /dev/null`): with a fitted phone attached and its client
 * killed, the window still reads `80x24`, `window-size manual`,
 * `window_zoomed_flag 1`. Nothing puts that back on its own. It is the same
 * fault that pinned seven of the user's windows, arriving through a different
 * door.
 *
 * WHAT "RESTORE ON THE WAY OUT" MEANS WITH NO TIME TO BE ASYNCHRONOUS.
 *
 * `cleanup` is allowed to wait, and does: +1500ms and +3000ms, because tmux
 * takes a moment to notice a client has gone and `restoreWindows` skips any
 * window a phone is still on. A shutdown has no moment — `process.exit(0)`
 * would not let a timer run, and deferring to a next tick that never arrives is
 * the same as not restoring at all.
 *
 * So the precondition is MADE TRUE instead of waited for. `endPhoneSession`
 * kills the grouped session this app made for that phone, which measured on a
 * private server is gone from the very next `list-sessions` — the same call
 * `phoneWindows` makes. `restoreWindows` then runs exactly as it does on the
 * timer path, unmodified, skipping nothing it should not. No bypass flag: a
 * teardown that could be told to ignore "a phone is still on this window" is
 * one argument away from being the bug it was written to prevent.
 *
 * Two passes, and the order decides the outcome twice.
 *
 * Every phone session is ended BEFORE anything is restored: with two phones on
 * one window, restoring after ending only the first finds the window still busy
 * and skips it — a restore that silently does nothing is the original bug, not
 * a smaller version of it.
 *
 * And the restores run newest first so the OLDEST capture is applied last and
 * wins. Two fitted phones on one window: the first captured the window's real
 * `window-size` (usually nothing), the second captured the `manual` the first
 * one's fit had already written. In attach order the window keeps `manual` —
 * which is the pinning this whole function is fixing, put back by the fix.
 *
 * Synchronous throughout: every tmux call underneath is a `spawnSync`. Measured
 * on a private server, one fitted phone on a three-window session — eleven tmux
 * calls — at 17.2ms, 15.4ms and 14.3ms over three runs. That is what a signal
 * handler can afford to spend before `process.exit(0)`, and it is the number to
 * re-measure if this ever grows a loop over something unbounded.
 *
 * RESIDUAL, both named rather than papered over:
 *
 *  - SIGKILL, an OOM kill, and the power going out. No handler runs there at
 *    all. The status line survives that because it writes `@agx-owned` onto the
 *    session and `releaseStale` sweeps it on the next run's first contact with
 *    that server; `window-size` has no such mark, so a later run cannot tell a
 *    `manual` we wrote from one the user set, and guessing would cost somebody
 *    their own option to fix a squeeze they never had.
 *  - A window the desk took back in the last ten seconds is skipped by
 *    `restoreWindows`, deliberately. It is already at the desk's size, and the
 *    `largest` it carries is `takeover`'s own effect — the user asking to stop
 *    following the newest client — not the phone's squeeze. A window on
 *    `largest` still follows the desk's terminal (measured in `runAction`: the
 *    desk going to 160x45 takes it to 160x44), so this is not the pinning.
 */
export function shutdownTerminals() {
  // The ledger first: these are sockets that closed moments ago whose timers
  // are still in flight and are about to be cancelled by the exit.
  const back: PhoneAttach[] = [...owed];
  owed.clear();
  for (const [ws, s] of sessions) {
    if (!s.exited) killGroup(s, 1);
    /*
     * The status line, missing through the same door and given back for the
     * same reason. `cleanup` returns it and this did not, so a server killed
     * with a panel open left the user's real session with `status off` and
     * `@agx-owned` set. It does heal — `releaseStale` sweeps that on the next
     * run's first contact with the server — but "eventually" there means the
     * next time they open a terminal in this app, and until then their session
     * has no status line and nothing anywhere points at us.
     */
    if (s.tmuxStatusHiddenOn) { setStatusLine(s.tmuxStatusHiddenOn, true); s.tmuxStatusHiddenOn = null; }
    if (s.phoneAttach) back.push(s.phoneAttach);
    s.phoneAttach = null;
    if (s.sizeDir) { try { rmSync(s.sizeDir, { recursive: true, force: true }); } catch { /* best effort */ } }
    // A pull request's fetched copy, which this function claims to remove and
    // did not: every PR file opened since the server started was still under
    // /tmp after it was killed.
    if (s.viewDir) { try { rmSync(s.viewDir, { recursive: true, force: true }); } catch { /* best effort */ } }
    sessions.delete(ws);
  }
  if (!back.length) return;
  back.sort((a, b) => b.seq - a.seq); // newest first — see the note on `seq`
  for (const p of back) { try { endPhoneSession(p.socket, p.phoneSession); } catch { /* that server is already gone */ } }
  for (const p of back) { try { restoreWindows(p.socket, p.sessionId, p.hadWindowSize, p.zoomed); } catch { /* that server is already gone */ } }
}

// --- project commands: Makefile targets + package.json scripts ---------------

/**
 * How many targets to take from a single Makefile.
 *
 * Was 60, which is fewer than a real project's Makefile holds: a monorepo root
 * here defines 153, so 93 of them — everything after the sixtieth line of the
 * file — were dropped, silently, while the picker still advertised a total as
 * though that were all of them. `make migrate` sat at line 851 and simply did
 * not exist as far as the app was concerned.
 *
 * The cap exists to stop a generated Makefile from flooding the list, so it
 * stays; it is now set above what a hand-written Makefile plausibly contains,
 * and the picker has a filter, which is what actually makes a long list usable.
 */
const MAKE_MAX_PER_FILE = 400;

/** Parse Makefile text into named targets WITH their descriptions. A
 * description is taken from the `target: ## comment` convention, or from the
 * `# comment` line(s) directly above the target. */
export function parseMakeTargets(text: string): { name: string; desc: string }[] {
  const out: { name: string; desc: string }[] = [];
  const seen = new Set<string>();
  let pendingComment: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("\t")) { pendingComment = []; continue; } // recipe line — a comment above it belongs to the recipe, not the next target
    if (/^#(?!!)/.test(line)) { pendingComment.push(line.replace(/^#+\s?/, "").trim()); continue; }
    // target defs at column 0: `name [name…]: [deps] [## desc]` — not `:=` / `::=` assignments.
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9_.\/ %$-]*?)\s*::?(?![:=])([^=].*|)$/);
    if (m) {
      const inline = m[2].match(/##\s*(.+)$/);
      const desc = (inline ? inline[1] : pendingComment[pendingComment.length - 1] || "").trim().slice(0, 160);
      for (const t of m[1].split(/\s+/)) {
        // A leading dash turns the "target" into a make flag: a repo whose
        // Makefile names a target `-flib/evil.mk` yields `make -flib/evil.mk`,
        // which runs an attacker-supplied makefile. Skip anything not
        // starting alphanumeric.
        if (!t || !/^[A-Za-z0-9]/.test(t) || t.includes("$") || t.includes("%") || seen.has(t)) continue;
        seen.add(t);
        out.push({ name: t, desc });
      }
    }
    pendingComment = [];
  }
  return out.slice(0, MAKE_MAX_PER_FILE);
}

/** How deep below the repo root to look for Makefiles / package.jsons. A
 *  monorepo keeps them one or two levels down (`web/`, `packages/api/`);
 *  deeper is almost always vendored code. */
const CMD_SCAN_DEPTH = 3;
const CMD_MAX_DIRS = 40; // dropdown budget — beyond this it's noise, not help
// Across all folders; per-manifest caps still apply. Raised with the per-file
// cap: a monorepo root Makefile alone can hold 150+ targets, and a list you can
// filter is not made better by being short — it is made wrong by being
// incomplete, because a missing target reads as "this project has no such
// command" rather than "the picker stopped counting".
const CMD_MAX_TOTAL = 500;

/** Directories that never hold the *project's own* commands — the repo
 *  sweeper's list plus build-output names that don't contain git checkouts. */
const CMD_SKIP = new Set([...SKIP_DIRS, "out", "coverage"]);

// These strings end up verbatim in `make -C <dir>` / `--cwd <dir>` lines typed
// into the user's shell, so only plain path characters are allowed — a folder
// named `; rm -rf ~` (or just one with spaces) is skipped, not quoted.
export const shellSafeRel = (rel: string) => /^[A-Za-z0-9][A-Za-z0-9._@\/-]*$/.test(rel);

type CommandDir = { rel: string; makefile: string | null; pkg: boolean };

/**
 * Folders of the selected project that define commands: every subdirectory
 * (bounded depth) holding a Makefile or a package.json. The repo root comes
 * first; nested checkouts are someone else's project and are left alone.
 * One readdir per directory — presence of the manifest files, and of a nested
 * `.git`, is read off the listing instead of stat-probing each name.
 */
function commandDirs(root: string): CommandDir[] {
  const found: CommandDir[] = [];
  const visit = (dir: string, rel: string, left: number) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const names = new Set(entries.map((e) => e.name));
    if (rel && names.has(".git")) return; // a nested checkout is its own project
    // GNU make's own search order — parsing Makefile while `make` would read
    // the GNUmakefile advertises targets that then fail to run.
    const makefile = ["GNUmakefile", "makefile", "Makefile"].find((n) => names.has(n)) ?? null;
    const pkg = names.has("package.json");
    if (makefile || pkg) found.push({ rel, makefile, pkg });
    if (found.length >= CMD_MAX_DIRS || left <= 0) return;
    for (const ent of entries) {
      // real directories only — symlinks can loop or step outside the repo
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith(".") || CMD_SKIP.has(ent.name)) continue;
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (!shellSafeRel(childRel)) continue;
      visit(join(dir, ent.name), childRel, left - 1);
      if (found.length >= CMD_MAX_DIRS) return;
    }
  };
  visit(root, "", CMD_SCAN_DEPTH);
  return found;
}

/** Makefile targets across the whole project — the root Makefile plus any in
 *  subfolders, surfaced as `make -C <dir> <target>`. */
export function makeCommands(root: string, dirs: CommandDir[] = commandDirs(root)): ProjectCommand[] {
  const out: ProjectCommand[] = [];
  for (const { rel, makefile } of dirs) {
    if (!makefile) continue;
    let text: string;
    try { text = readFileSync(join(root, rel, makefile), "utf8"); } catch { continue; }
    for (const t of parseMakeTargets(text)) { // capped per file — see MAKE_MAX_PER_FILE
      out.push({ name: t.name, cmd: rel ? `make -C ${rel} ${t.name}` : `make ${t.name}`, desc: t.desc, dir: rel });
    }
    if (out.length >= CMD_MAX_TOTAL) break;
  }
  return out.slice(0, CMD_MAX_TOTAL);
}

/** The runner a directory's lockfile asks for, falling back to the repo's. */
function runnerFor(dir: string, fallback: string | null): string {
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun";
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "package-lock.json"))) return "npm";
  return fallback ?? "npm";
}

/** package.json scripts across the whole project, runner-aware per folder. */
export function scriptCommands(root: string, dirs: CommandDir[] = commandDirs(root)): ProjectCommand[] {
  let rootRunner: string | null = null; // resolved on first use — most repos have no package.json at all
  const out: ProjectCommand[] = [];
  for (const { rel, pkg } of dirs) {
    if (!pkg) continue;
    let scripts: Record<string, string>;
    try {
      const p = JSON.parse(readFileSync(join(root, rel, "package.json"), "utf8"));
      scripts = p && typeof p.scripts === "object" && p.scripts ? p.scripts : {};
    } catch { continue; }
    rootRunner ??= runnerFor(root, null);
    const runner = rel ? runnerFor(join(root, rel), rootRunner) : rootRunner;
    const cmdFor = (k: string) => {
      if (!rel) return runner === "yarn" ? `yarn ${k}` : `${runner} run ${k}`;
      // each runner spells "run it over there" differently
      if (runner === "bun") return `bun run --cwd ${rel} ${k}`;
      if (runner === "pnpm") return `pnpm -C ${rel} run ${k}`;
      if (runner === "yarn") return `yarn --cwd ${rel} ${k}`;
      return `npm --prefix ${rel} run ${k}`;
    };
    let fromFile = 0; // per-manifest cap: a generated 200-script root file must not starve the subfolders
    for (const [k, v] of Object.entries(scripts)) {
      if (typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,59}$/.test(k)) continue;
      if (++fromFile > 60) break;
      out.push({ name: k, cmd: cmdFor(k), desc: String(v).trim().slice(0, 160), dir: rel });
    }
    if (out.length >= CMD_MAX_TOTAL) break;
  }
  return out.slice(0, CMD_MAX_TOTAL);
}

/**
 * Awaited twin of {@link commandDirs}.
 *
 * The walk is the expensive half — a monorepo with no manifest in a subtree
 * makes it descend to the depth cap in every branch — and left synchronous it
 * was a readdirSync-per-directory burst holding the one thread the PTY rides.
 * Under interaction load the watchdog named GET /terminal/commands at 84s: it
 * was queued behind the git fan-out and then blocked the loop when it ran. Each
 * `await readdir` yields, so a keystroke lands between directories rather than
 * after the whole walk.
 */
async function commandDirsAsync(root: string): Promise<CommandDir[]> {
  const found: CommandDir[] = [];
  const visit = async (dir: string, rel: string, left: number): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    const names = new Set(entries.map((e) => e.name));
    if (rel && names.has(".git")) return; // a nested checkout is its own project
    const makefile = ["GNUmakefile", "makefile", "Makefile"].find((n) => names.has(n)) ?? null;
    const pkg = names.has("package.json");
    if (makefile || pkg) found.push({ rel, makefile, pkg });
    if (found.length >= CMD_MAX_DIRS || left <= 0) return;
    for (const ent of entries) {
      if (!ent.isDirectory()) continue; // real dirs only — symlinks loop or escape
      if (ent.name.startsWith(".") || CMD_SKIP.has(ent.name)) continue;
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (!shellSafeRel(childRel)) continue;
      await visit(join(dir, ent.name), childRel, left - 1);
      if (found.length >= CMD_MAX_DIRS) return;
    }
  };
  await visit(root, "", CMD_SCAN_DEPTH);
  return found;
}

/**
 * The command list per repo root, held briefly.
 *
 * A Makefile or package.json is edited far less often than the picker asks for
 * it — a scope switch, every new terminal, the ⚙ menu — and the answer is a
 * depth-3 walk plus a handful of file reads. So it is computed once and reused:
 * under the interaction load the same root was asked on every burst, and without
 * this each one re-walked the tree on the loop the PTY rides. Short enough that
 * an edited Makefile shows up almost at once. (The web layer has its own 30s
 * cache; this is the server-side half the fan-out was missing.)
 */
const CMD_CACHE_TTL_MS = 30_000;
const cmdCache = new Map<string, { at: number; data: TerminalCommands }>();

/** Everything runnable in a repo, for the terminal's command list. Awaited and
 *  cached — see commandDirsAsync and cmdCache for why. */
export async function projectCommands(root: unknown): Promise<TerminalCommands> {
  const cwd = safeAbs(root);
  // inScope, like the shell-spawn path: without it a cockpit opened for one
  // project answers /terminal/commands?root=/any/other/repo, handing back that
  // repo's Makefile targets and script names — the file contents of a project
  // outside the open scope. safeAbs alone does not confine to the workspace.
  // repoRootOfAsync, not repoRootOf: polled on every scope switch and new
  // terminal, so its `git rev-parse` queues through the shared pool rather than
  // blocking the loop between keystrokes.
  if (!cwd || !inScope(cwd) || !(await repoRootOfAsync(cwd))) return { enabled: TERMINAL_ENABLED, reason: TERMINAL_DISABLED_REASON ?? undefined, make: [], scripts: [] };
  const hit = cmdCache.get(cwd);
  if (hit && Date.now() - hit.at < CMD_CACHE_TTL_MS) return hit.data;
  const dirs = await commandDirsAsync(cwd); // one walk, shared by both lists, yielding between dirs
  const data: TerminalCommands = { enabled: TERMINAL_ENABLED, reason: TERMINAL_DISABLED_REASON ?? undefined, make: makeCommands(cwd, dirs), scripts: scriptCommands(cwd, dirs) };
  if (cmdCache.size > 40) cmdCache.clear();
  cmdCache.set(cwd, { at: Date.now(), data });
  return data;
}

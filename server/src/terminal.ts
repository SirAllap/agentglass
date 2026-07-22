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
import { readFileSync, existsSync, mkdtempSync, writeFileSync, renameSync, rmSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import type { ServerWebSocket } from "bun";
import type { ProjectCommand, TerminalCommands } from "../../shared/types.ts";
import { safeAbs, repoRootOf } from "./git.ts";
import { terminalActive } from "./loopwatch.ts";
import { inScope } from "./config.ts";
import { SKIP_DIRS } from "./gitwork.ts";

export const TERMINAL_ENABLED = process.env.AGENTGLASS_TERMINAL_DISABLED !== "1";

const HAS_SETSID = !!Bun.which("setsid");
const PYTHON = Bun.which("python3") || Bun.which("python");
const HAS_SCRIPT = process.platform === "linux" && !!Bun.which("script");
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

export type PtyWsData = { kind: "pty"; root: string; cols: number; rows: number };
type PtyWs = ServerWebSocket<unknown>;

type Session = {
  proc: ReturnType<typeof Bun.spawn>;
  mode: "pty" | "pipe";
  grouped: boolean;
  sizeDir: string | null; // tmp dir holding the resize file (pty_bridge mode)
  closed: boolean;
  exited: boolean;
  killTimer: ReturnType<typeof setTimeout> | null;
  /** Cleared on close — a stray interval would keep reading /proc for a pty
   *  that no longer exists, once per session, forever. */
  tmuxPoll?: ReturnType<typeof setInterval> | null;
  /** The tmux client in this shell, once one is found. Survives a session
   *  switch, which is the whole reason it is kept apart from the target. */
  tmuxClient?: TmuxClient | null;
  /** The tmux session that client is showing, re-read every poll. */
  tmux?: TmuxTarget | null;
  /** tmux's prefix keys, re-read whenever the session changes rather than every
   *  tick: it is a config value, not a live one. */
  tmuxPrefix?: string[];
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
};
const sessions = new Map<PtyWs, Session>();

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

import { resolveClient, readFrame, runAction, setStatusLine, prefixKeys, type TmuxClient, type TmuxTarget, type TmuxAction } from "./tmuxctl.ts";
import { applyThemeTo } from "./themesync.ts";

const enc = new TextEncoder();
const ctl = (ws: PtyWs, frame: Record<string, unknown>) => { try { ws.send(JSON.stringify(frame)); } catch { /* closed */ } };

/**
 * Is a tmux client running inside this shell?
 *
 * Worth knowing because tmux brings its own tabs, its own splits and its own
 * status line — so the panel's versions of all three become a second, worse
 * copy sitting above the real ones. Detecting it lets the panel get out of the
 * way instead of forcing everyone into tmux, which would be a poor trade for
 * anyone who doesn't use it.
 *
 * Reads /proc rather than asking the shell: the shell is busy being a terminal
 * and injecting a command to interrogate it would echo into whatever the user
 * is typing. Linux-only by design — on anything else the answer is "no" and
 * the panel keeps its own chrome, which is the correct fallback.
 */
function tmuxRunning(pid: number, depth = 0): boolean {
  if (process.platform !== "linux" || depth > 4) return false;
  let children: string[];
  try {
    // `children` needs CONFIG_PROC_CHILDREN; when absent this simply reads
    // empty and we report no tmux, rather than throwing.
    children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
  } catch { return false; }
  for (const c of children) {
    let comm: string;
    try { comm = readFileSync(`/proc/${c}/comm`, "utf8").trim(); } catch { continue; }
    // "tmux: client" / "tmux: server" both report as `tmux` in comm.
    if (comm === "tmux" || comm.startsWith("tmux")) return true;
    if (tmuxRunning(Number(c), depth + 1)) return true;
  }
  return false;
}

/** WebSocket opened at /terminal/pty — spawn the shell and start pumping. */
export function ptyOpen(ws: PtyWs) {
  const d = ws.data as PtyWsData;
  if (!TERMINAL_ENABLED) { ctl(ws, { t: "fatal", error: "terminal is disabled (AGENTGLASS_TERMINAL_DISABLED=1)" }); ws.close(1008, "disabled"); return; }
  const cwd = safeAbs(d.root);
  if (!cwd || !repoRootOf(cwd)) { ctl(ws, { t: "fatal", error: "invalid or non-repo directory" }); ws.close(1008, "bad root"); return; }
  // A shell is the widest capability here — anything it can reach, it can
  // change. An instance opened for one project must not hand one out anywhere
  // else, or "open a project" narrows the view while leaving the blast radius
  // machine-wide.
  if (!inScope(cwd)) { ctl(ws, { t: "fatal", error: "outside the open project — open the parent folder to work across repos" }); ws.close(1008, "out of scope"); return; }
  if (sessions.size >= MAX_SESSIONS) { ctl(ws, { t: "fatal", error: `too many open terminals (max ${MAX_SESSIONS})` }); ws.close(1013, "busy"); return; }

  const cols = clampCols(d.cols) || 80;
  const rows = clampRows(d.rows) || 24;
  const { shell, args } = pickShell();
  const baseEnv = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };

  let argv: string[];
  let mode: Session["mode"] = "pty";
  let sizeDir: string | null = null;
  let env: Record<string, string | undefined> = baseEnv;
  if (PYTHON) {
    sizeDir = mkdtempSync(join(tmpdir(), "agentglass-pty-"));
    writeSizeFile(sizeDir, rows, cols);
    env = { ...baseEnv, AGENTGLASS_PTY_SIZE_FILE: join(sizeDir, "size") };
    argv = [...(HAS_SETSID ? ["setsid"] : []), PYTHON, BRIDGE, shell, ...args];
  } else if (HAS_SCRIPT) {
    env = { ...baseEnv, COLUMNS: String(cols), LINES: String(rows) };
    argv = [...(HAS_SETSID ? ["setsid"] : []), "script", "-qfec", `exec ${shell} ${args.join(" ")}`, "/dev/null"];
  } else {
    mode = "pipe";
    argv = [...(HAS_SETSID ? ["setsid"] : []), shell, "-i"];
  }

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    ctl(ws, { t: "fatal", error: `could not start shell: ${String(e)}` });
    ws.close(1011, "spawn failed");
    if (sizeDir) rmSync(sizeDir, { recursive: true, force: true });
    return;
  }

  const session: Session = { proc, mode, grouped: HAS_SETSID, sizeDir, closed: false, exited: false, killTimer: null };
  sessions.set(ws, session);
  ctl(ws, { t: "ready", mode, shell: basename(shell), cwd, resize: !!sizeDir });

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
    // Re-apply the panel's answer to the new session. Without this a restored
    // session comes up with tmux's own status line on top of our tabs, and
    // nothing in the panel changed to make the browser re-ask for it.
    if (session.tmuxStatusVisible === false && !session.tmuxStatusHiddenOn) {
      if (setStatusLine(t, false)) session.tmuxStatusHiddenOn = t;
    }
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
        // Detached. Forget the client rather than keep polling a target that
        // is no longer ours, and stop describing windows nobody is looking at.
        session.tmuxClient = null;
        session.tmux = null;
        session.tmuxPrefix = [];
        session.tmuxStatusHiddenOn = null;
        sent = "";
        ctl(ws, { t: "tmux", active: false, windows: [] });
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
    if (!session.tmuxClient) session.tmuxClient = resolveClient(proc.pid);
    const frame = session.tmuxClient ? readFrame(session.tmuxClient) : null;
    if (frame) {
      if (frame.target.id !== session.tmux?.id) followSession(frame.target);
      else session.tmux = frame.target; // a rename keeps the id and changes the name
    } else {
      // Unreachable: the server went away, or the client is mid-attach. Drop it
      // and resolve again next tick rather than answer from something stale.
      session.tmuxClient = null;
      session.tmux = null;
    }
    const windows = frame?.windows ?? [];
    // Only speak when something changed. A tab strip that re-renders on every
    // tick is a tab strip that drops the click you were halfway through. The
    // session is part of "changed": switching between two sessions with the
    // same window names is still a switch, and the panel says which one it is.
    const shape = JSON.stringify([session.tmux?.id ?? null, windows]);
    if (shape === sent) return;
    sent = shape;
    ctl(ws, { t: "tmux", active: true, session: session.tmux?.session ?? null, prefix: session.tmuxPrefix ?? [], windows });
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

/** Client frame: {t:"in",d} keystrokes → shell stdin · {t:"resize",cols,rows}. */
export function ptyMessage(ws: PtyWs, raw: string | Buffer) {
  const s = sessions.get(ws);
  if (!s) return;
  let msg: { t?: string; d?: string; cols?: number; rows?: number; cmd?: string; window?: string; name?: string; visible?: boolean };
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
      if (!s.tmux) return;
      if (setStatusLine(s.tmux, visible)) s.tmuxStatusHiddenOn = visible ? null : s.tmux;
      return;
    }
    if (!s.tmux) return;
    const action = msg.cmd as TmuxAction;
    if (!["select", "new", "kill", "rename"].includes(action)) return;
    if (!runAction(s.tmux, action, msg.window, msg.name)) return;
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
  // Give the status line back before letting go. The panel borrowed it; a
  // session left with `status off` after the panel closed looks broken in the
  // user's real terminal, and nothing there would point back at us.
  if (s.tmuxStatusHiddenOn) { setStatusLine(s.tmuxStatusHiddenOn, true); s.tmuxStatusHiddenOn = null; }
  if (s.sizeDir) { try { rmSync(s.sizeDir, { recursive: true, force: true }); } catch { /* tmp reaper will get it */ } s.sizeDir = null; }
}

/** Hang up every live shell and remove their temp dirs. Called when the server
 *  is going down: a plain exit only reaps children the kernel happens to HUP,
 *  and the `script`/pipe fallbacks have no such guarantee, so a killed server
 *  would otherwise leave orphaned shells and /tmp dirs behind. */
export function shutdownTerminals() {
  for (const [ws, s] of sessions) {
    if (!s.exited) killGroup(s, 1);
    if (s.sizeDir) { try { rmSync(s.sizeDir, { recursive: true, force: true }); } catch { /* best effort */ } }
    sessions.delete(ws);
  }
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

/** Everything runnable in a repo, for the terminal's command list. */
export function projectCommands(root: unknown): TerminalCommands {
  const cwd = safeAbs(root);
  if (!cwd || !repoRootOf(cwd)) return { enabled: TERMINAL_ENABLED, make: [], scripts: [] };
  const dirs = commandDirs(cwd); // one walk, shared by both lists
  return { enabled: TERMINAL_ENABLED, make: makeCommands(cwd, dirs), scripts: scriptCommands(cwd, dirs) };
}

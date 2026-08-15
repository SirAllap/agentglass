// agentglass's own tmux server, and the panes it runs chats in.
//
// Why a server of our own rather than the user's: `tmux -L <name>` looks like
// isolation and is not. A named socket still reads ~/.tmux.conf, which on a real
// machine means tpm, tmux-resurrect and tmux-continuum come along for the ride —
// and continuum's autosave writes to the SAME ~/.tmux/resurrect/ the user's own
// server saves to. Two servers, one save file: fifteen minutes later the user's
// real layout has been overwritten with our chat panes, and they find out at the
// next boot restore. Measured on a live machine, not hypothesised.
//
// So every call carries BOTH `-L` (our socket) and `-f` (our config). The config
// below is deliberately tiny; it exists to stop tmux reaching for the user's.
//
// The user's server is never touched, never read, never attached to. Theirs is
// theirs. `tmux ls` in their terminal cannot see any of this, and ours cannot see
// their sessions — which is also what makes `tmux -L agentglass attach` a safe
// thing to hand them.
import { tmpdir } from "node:os";
import { resolveTmuxBin } from "./tmuxbin.ts";
import { confPath, confHealth, ensureConf } from "./tmuxconf.ts";

/** Our socket name. Overridable so tests get a server of their own and never
 *  race, kill, or inherit the one a running app is using.
 *
 *  Read per call rather than pinned at import, for the same reason
 *  `projectsDirs()` in transcripts.ts is: `bun test` runs every file in one
 *  process, so a module-level constant would be decided by whichever test file
 *  imported this module first — and here that means a test's redirected socket
 *  silently reverting to the real one the running app is using. */
export const tmuxSocket = (): string => process.env.AGENTGLASS_TMUX_SOCKET || "agentglass";

/**
 * One engine session per checkout, named after it.
 *
 * tmux refuses `.` and `:` in a session name, and the error it gives — "bad
 * session name" — says nothing about which character it minded. Everything
 * outside a safe set becomes `-`, so a worktree called `agentglass.tmux` or a
 * path with a colon in it opens a terminal instead of an error.
 */
export function engineSessionName(root: string): string {
  const base = root.split("/").filter(Boolean).pop() || "shell";
  // Trimmed of the dashes the substitution leaves behind: a directory named
  // entirely in characters tmux will not take would otherwise become "-", which
  // is a legal name and an unreadable one.
  const safe = base.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return safe || "shell";
}

/**
 * The command that opens a terminal ON THE ENGINE rather than on the user's own
 * tmux.
 *
 * Attach-or-create, so the second tab of the same checkout lands in the session
 * the first one made, and closing the app leaves it running exactly as their
 * own tmux would. `-f` is the engine's config, as everywhere else here: the
 * user's ~/.tmux.conf is never loaded on this server.
 *
 * Null when there is no tmux to run, which is the caller's cue to fall back to
 * a plain shell — a terminal that opens on "command not found" is worse than
 * one that opens somewhere unremarkable.
 */
export function engineAttachArgv(root: string): string[] | null {
  const bin = resolveTmuxBin();
  if (!bin) return null;
  if (!confHealth().ok) return null;
  ensureConf();
  return [bin, "-L", tmuxSocket(), "-f", confPath(), "new-session", "-A", "-s", engineSessionName(root), "-c", root];
}

/**
 * The docked console's own engine session.
 *
 * A SEPARATE session from the terminal view's, and the separation is the whole
 * function. Sharing one meant two clients attached to the same tmux session,
 * which tmux answers by mirroring: the console showed whatever the terminal was
 * showing, keystroke for keystroke, and both fought over the size. That was
 * reported as "the Docker console is a mirror of the Terminal".
 *
 * Attach-or-create like the other one, so the console you had is the console
 * you get back — and because it lives on the engine, it is still there after
 * the app is closed and reopened. That is what the console's "keep running"
 * button used to fake by typing `tmux` into the shell, on the user's own
 * server, with the user's own config.
 */
export function engineConsoleArgv(root: string): string[] | null {
  const base = engineAttachArgv(root);
  if (!base) return null;
  // Same argv with the session renamed. Built from the other one rather than
  // repeated, so the socket, the config and the flags cannot drift apart.
  const at = base.lastIndexOf("-s");
  if (at < 0 || !base[at + 1]) return null;
  const named = [...base];
  named[at + 1] = `${named[at + 1]}-console`;
  return named;
}

/**
 * Hand the running engine its config again, without restarting anything.
 *
 * tmux reads its config when the SERVER starts, so a saved prefix used to wait
 * for the engine to be restarted — and restarting it takes every pane on it
 * with it. `source-file` re-runs the generated conf in the live server instead:
 * `set -g`, `bind` and `unbind` are all idempotent, so the new key is in your
 * fingers a moment after Save and the sessions are untouched.
 *
 * False when there is no server to tell (nothing running yet, or no tmux),
 * which is not a failure: the config is on disk and the next start reads it.
 * Replace mode keeps one honest limit — an option the old config set and the
 * new one does not is not un-set by re-sourcing, and only a restart clears it.
 */
export async function reloadEngineConf(): Promise<boolean> {
  if (!resolveTmuxBin()) return false;
  const r = await tmux(["source-file", confPath()]);
  return r.ok;
}

/** Under `bun test`, nothing this module touches may be real.
 *
 *  Same guard main adopted for settings (#321) and the database (#319), for the
 *  same reason: `bun test` runs every file in one process, so a single import
 *  from an unrelated test is enough to reach the developer's own machine. Here
 *  the blast radius is worse than a stray file — an unguarded `new-session`
 *  would put chat panes in the user's real tmux. */
const IS_TEST = process.env.NODE_ENV === "test";
const underScratch = (p: string): boolean => p.startsWith(tmpdir());

/** How long a tmux call may take before we give up. A local socket answers in
 *  single-digit milliseconds; anything near this means the server is wedged, and
 *  a wedged tmux must not be able to hang a chat turn. */
const TMUX_TIMEOUT_MS = 5_000;

export interface TmuxResult { ok: boolean; stdout: string; stderr: string }

/** Run one tmux command against our server. `stdin` feeds commands that read it
 *  (`load-buffer -`), which is how prompt text gets in without ever being
 *  interpreted as arguments. The binary comes from the resolver (tmuxbin.ts) —
 *  bundled, system or env-override — and the config from the generation gate
 *  (tmuxconf.ts); this call only ever talks to OUR socket. */
export async function tmux(args: string[], stdin?: string): Promise<TmuxResult> {
  const bin = resolveTmuxBin();
  if (!bin) return { ok: false, stdout: "", stderr: "tmux is not installed" };
  const argv = [bin, "-L", tmuxSocket(), "-f", confPath(), ...args];
  try {
    const proc = Bun.spawn(argv, {
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
      /*
       * `env: process.env`, which reads like a no-op and is not one.
       *
       * Measured on Bun 1.3.9, and re-measured rather than taken from the
       * comment that already says it in tmuxctl.ts: a spawn with no `env` gets
       * the environment as it was when the PROCESS started, not `process.env`
       * as it is now — `Bun.spawnSync(["sh","-c","echo [$X]"])` after setting
       * `process.env.X` prints `[]`, and with `env: process.env` prints the
       * value. Same for the async form.
       *
       * So a test that points TMUX_TMPDIR at a directory of its own in
       * `beforeAll` was setting it for everything EXCEPT this, and the pane
       * engine's tmux went on resolving `-L <socket>` in /tmp/tmux-<uid> — the
       * developer's. Found by running the suite behind a tmux that records
       * where each call lands: with everything else clean, two calls from
       * chat-pane.test.ts were the only ones left in his directory.
       *
       * A no-op in production, and checked rather than assumed: nothing in
       * server/src assigns to `process.env`, so `process.env` here IS the
       * environment the child would have inherited anyway. It only ever gives a
       * caller that CAN set a variable a way to have it honoured. `tmuxctl.ts`
       * has done this for the same reason since its own version of this bug.
       */
      env: process.env,
    });
    const kill = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, TMUX_TIMEOUT_MS);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    clearTimeout(kill);
    return { ok: code === 0, stdout, stderr };
  } catch (e) {
    return { ok: false, stdout: "", stderr: String(e) };
  }
}

/** Is tmux usable at all here?
 *
 *  Two separate reasons it might not be, and they need different words in the
 *  UI: tmux missing is "install tmux", Windows is "this mode cannot work here".
 *  Windows is excluded outright rather than attempted — the terminal panel
 *  already stands down there, and a half-working chat engine is worse than an
 *  honestly absent one. */
export function tmuxCapability(): { available: boolean; reason: string } {
  if (process.platform === "win32") return { available: false, reason: "tmux chat panes need a Unix shell — not available on Windows" };
  if (!resolveTmuxBin()) return { available: false, reason: "tmux is not installed — install it, or use the bundled binary from the settings panel" };
  const health = confHealth();
  if (!health.ok) return { available: false, reason: health.reason };
  return { available: true, reason: "" };
}

/** A tmux session name we are willing to create.
 *
 *  Names come from session ids, which reach us from a browser request. tmux
 *  treats `:` and `.` as window/pane separators and would resolve a crafted name
 *  onto a target we did not mean, so the shape is pinned to what a uuid is
 *  rather than merely escaped. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,64}$/;
export const validPaneName = (n: string): boolean => NAME_RE.test(n);

/**
 * A session name this app is willing to ADDRESS — as opposed to one it made.
 *
 * `validPaneName` guards the names we generate for chat panes: UUID-shaped,
 * eight characters minimum. Using it to gate the layout and the restore made
 * both inert for every session a person had named — `orbit`, `scratch`, `7` —
 * silently: the first real capture on a machine using the engine for its
 * terminal held one session, the chat's, and had dropped the four that mattered.
 *
 * What needs guarding here is different and smaller. The name is passed to tmux
 * as its own argv entry, never through a shell, and it becomes a DIRECTORY under
 * the restore dir where the scrollback is written. So: nothing that can climb
 * out of that directory, nothing an option parser would read as a flag, no
 * control characters, and a length a filesystem takes. tmux itself already
 * refuses `.` and `:` in a session name.
 */
export function validSessionName(n: string): boolean {
  if (!n || n.length > 64) return false;
  if (n.startsWith("-")) return false;
  if (n.includes("/") || n.includes("\\") || n === "." || n === "..") return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(n);
}

/** How a session is addressed as a *session*: `=` is tmux's exact-match prefix,
 *  so a name can never prefix-match its way onto a different session. */
const sessionTarget = (name: string): string => `=${name}`;

/** How the same session is addressed as a *pane*.
 *
 *  The trailing colon is not cosmetic. `=name` is a session target and
 *  `capture-pane -t =name` fails outright with "can't find pane"; `=name:`
 *  resolves to that session's current window and active pane while keeping the
 *  exact-match guarantee. Found by a turn that spent its whole 45s readiness
 *  budget capturing nothing from a pane that was running fine. */
const paneTarget = (name: string): string => `=${name}:`;

/** Does a chat's pane exist right now? */
export async function paneAlive(name: string): Promise<boolean> {
  if (!validPaneName(name)) return false;
  const r = await tmux(["has-session", "-t", sessionTarget(name)]);
  return r.ok;
}

/** Session names currently on our server. `=` prefixes are not needed here; this
 *  is a plain listing. */
export async function listPanes(): Promise<string[]> {
  const r = await tmux(["list-sessions", "-F", "#{session_name}"]);
  if (!r.ok) return []; // no server running yet is the common case, not an error
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Start a chat's pane, running `argv` in `cwd`.
 *
 *  The command is wrapped so the pane outlives the CLI: when `claude` exits —
 *  crash, /exit, an OOM kill — the pane stays with a line saying so, instead of
 *  vanishing and leaving the UI to infer what happened from an absence. */
/** The tmux arguments that start a pane. Exported so the shape can be asserted
 *  without starting a tmux server — the bug this guards against was invisible
 *  from the outside, and reproducing it needs a machine whose login shell is not
 *  POSIX. */
/**
 * A window on the ENGINE, running something, for a checkout.
 *
 * The counterpart of tmuxctl's `newWindowRunning`, and the whole point of it is
 * the socket. That one opens windows in whatever tmux the panel's shell happens
 * to be running — the user's own server, with the user's own config. Everything
 * the app STARTS belongs here instead, for three measured reasons:
 *
 *   - It worked only if you had typed `tmux` in that pane. Without a client to
 *     resolve out of /proc, the review button and the issue button answered
 *     "this terminal has no tmux" — a feature whose availability depended on
 *     something you did in a shell.
 *   - It put the app's windows in among yours, where a `kill-window` or a
 *     `resize-window` aimed at one of ours could reach one of yours. Pane and
 *     window ids are per-SERVER, and that ambiguity has cost a real session
 *     more than once.
 *   - The engine survives the app closing and comes back on restart, which is
 *     what the user's tmux was being borrowed FOR.
 *
 * Attach-or-create on the session, so the second review of the day lands beside
 * the first rather than starting a server's worth of sessions.
 */
export async function engineWindowRunning(
  root: string, name: string, argv: string[], cwd: string = root,
): Promise<{ paneId: string; windowId: string } | null> {
  const session = engineSessionName(root);
  if (!validSessionName(session)) return null;
  /* The config, before the first tmux call rather than only on the attach path.
     `tmux()` passes `-f confPath()` whatever the caller is, so a window opened
     before anybody attached ran against a file that might be stale or not there
     at all — and tmux reads its config when the SERVER starts, so whichever
     call happens to be first decides what the engine believes for the rest of
     its life. */
  ensureConf();
  /*
   * Asked for, then created — not `new-session -A`.
   *
   * `-A` is attach-or-create and reads as exactly what is wanted here. It is
   * not: on a session that already exists it tries to ATTACH, and this runs
   * with no terminal, so tmux answers `open terminal failed: not a terminal`
   * and exits non-zero. `-d` does not save it.
   *
   * Measured, because the first call always worked and every one after it
   * returned null: the second pull request review of a day would have opened
   * nothing at all, silently. `has-session` costs one more call and cannot lie.
   */
  const there = await tmux(["has-session", "-t", `=${session}`]);
  if (!there.ok) {
    const made = await tmux(["new-session", "-d", "-s", session, "-c", root]);
    if (!made.ok) return null;
  }
  const clean = engineWindowName(name);
  const out = await tmux([
    "new-window", "-P", "-F", "#{pane_id}\t#{window_id}", "-t", session, "-c", cwd,
    ...(clean ? ["-n", clean] : []),
    ...argv,
  ]);
  if (!out.ok) return null;
  const [paneId = "", windowId = ""] = (out.stdout.split("\n")[0] ?? "").trim().split("\t");
  // Both or neither: tmux printing something this does not recognise is not a
  // reason to hand a caller a string that goes on a command line.
  return paneId.startsWith("%") && windowId.startsWith("@") ? { paneId, windowId } : null;
}

/** Window names reach a status line and a shell prompt, so they are held to
 *  printable, single-line and short — the same rule tmuxctl applies, and a dot
 *  removed on top: tmux reads one as a pane separator in a target, so a window
 *  named with one cannot be selected by name afterwards. */
export function engineWindowName(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const name = s.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\./g, "-").trim().slice(0, 64);
  return name || null;
}

export function newSessionArgv(name: string, cwd: string, argv: string[]): string[] {
  const quoted = argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  const cmd = `${quoted}; printf '\\n[agentglass] the CLI exited (%s). This pane is kept for inspection.\\n' "$?"; exec sleep 86400`;
  return [
    "new-session", "-d",
    "-s", name,
    "-c", cwd,
    // A generous fixed size. The pane is never shown as a terminal in the app —
    // the chat is rendered from the transcript — but Claude Code lays its TUI out
    // to the pane width, and a narrow pane makes the text it writes to the
    // transcript no different while making an attached human's view miserable.
    "-x", "200", "-y", "50",
    // Run by `sh`, explicitly, rather than handed to tmux as a bare string.
    //
    // A bare string is executed with the *user's login shell*, and `cmd` is
    // POSIX: `$?`, `exec`, `;`. On a machine whose shell is fish that is a
    // syntax error — "In fish, please use $status" — so the command died
    // instantly, the session went with it, and the tmux server exited leaving
    // an orphaned socket behind. What the chat then reported was "the pane
    // never became ready in 45s" with an empty screen under it, because by the
    // time anything looked there was nothing left to look at. Nothing about
    // that message points at a shell.
    //
    // The pane is ours, not a place anybody types: `sh` is the right shell for
    // it whatever the user has chosen for themselves.
    "sh", "-c", cmd,
  ];
}

export async function startPane(name: string, cwd: string, argv: string[]): Promise<TmuxResult> {
  if (!validPaneName(name)) return { ok: false, stdout: "", stderr: "invalid pane name" };
  // The one call in this module that CREATES something. Everything else asks
  // questions a missing server answers with "no". A test that reached here
  // without redirecting the socket would start a real `claude` in a real pane
  // on the developer's own tmux, so it is refused rather than trusted.
  if (IS_TEST && !process.env.AGENTGLASS_TMUX_SOCKET) {
    return { ok: false, stdout: "", stderr: "refusing to start a pane in tests without AGENTGLASS_TMUX_SOCKET" };
  }
  return tmux(newSessionArgv(name, cwd, argv));
}

export async function killPane(name: string): Promise<void> {
  if (!validPaneName(name)) return;
  await tmux(["kill-session", "-t", sessionTarget(name)]);
}

/** Put `text` into the pane's input box, verbatim, without submitting it.
 *
 *  `send-keys` is the obvious way to do this and the wrong one: it delivers the
 *  text keystroke by keystroke, so a prompt containing a newline submits early,
 *  and a line starting with `/` opens the slash-command popup which then eats
 *  what follows. `load-buffer` + `paste-buffer -p` uses bracketed paste instead,
 *  which the TUI receives as one atomic paste — verified with backticks, quotes,
 *  `$VAR` and a literal `/help` line all arriving unaltered.
 *
 *  `-d` deletes the buffer afterwards, so prompt text does not linger in tmux's
 *  buffer stack where the next `paste-buffer` (or an attached human) would find
 *  it. */
export async function pasteText(name: string, text: string): Promise<TmuxResult> {
  if (!validPaneName(name)) return { ok: false, stdout: "", stderr: "invalid pane name" };
  const buf = `agx-${name}`;
  const load = await tmux(["load-buffer", "-b", buf, "-"], text);
  if (!load.ok) return load;
  return tmux(["paste-buffer", "-b", buf, "-t", paneTarget(name), "-d", "-p"]);
}

/** Submit whatever is in the input box. */
export async function submit(name: string): Promise<TmuxResult> {
  if (!validPaneName(name)) return { ok: false, stdout: "", stderr: "invalid pane name" };
  return tmux(["send-keys", "-t", paneTarget(name), "Enter"]);
}

/** Interrupt the running turn, the way a person would. */
export async function interrupt(name: string): Promise<TmuxResult> {
  if (!validPaneName(name)) return { ok: false, stdout: "", stderr: "invalid pane name" };
  return tmux(["send-keys", "-t", paneTarget(name), "Escape"]);
}

/** Keys a chat may send to its own pane.
 *
 *  An allowlist of tmux's own key names, not free text. These reach the server
 *  from a browser request and land in a live terminal running an agent with
 *  tools: anything unbounded here would be a way to type arbitrary commands
 *  into it. Navigation and the two answers a prompt takes is the whole job —
 *  ordinary text still goes through the paste path, which cannot be mistaken
 *  for a keystroke. */
const SENDABLE = new Set(["Up", "Down", "Left", "Right", "Enter", "Escape", "Space", "Tab", "BSpace"]);
export const sendableKey = (k: unknown): k is string => typeof k === "string" && SENDABLE.has(k);

/** Press one key in the chat's pane. */
export async function sendKey(name: string, key: string): Promise<TmuxResult> {
  if (!validPaneName(name)) return { ok: false, stdout: "", stderr: "invalid pane name" };
  if (!sendableKey(key)) return { ok: false, stdout: "", stderr: "key not allowed" };
  return tmux(["send-keys", "-t", paneTarget(name), key]);
}

/** What the pane currently shows. Only for diagnostics and for the "why is this
 *  stuck" path — the conversation itself is read from the transcript, never
 *  scraped from here. */
export async function capture(name: string): Promise<string> {
  if (!validPaneName(name)) return "";
  const r = await tmux(["capture-pane", "-p", "-t", paneTarget(name)]);
  return r.ok ? r.stdout : "";
}

/** The command a human types to take over a chat in their own terminal. Shown in
 *  the UI, so it lives next to the flags it has to stay in step with. */
export const attachCommand = (name: string): string => `tmux -L ${tmuxSocket()} attach -t ${name}`;

// --- idle eviction ----------------------------------------------------------
// A warm `claude` is 380MB when it starts and 450-780MB once it has worked.
// That is the price of skipping the ~2.2s of MCP re-init a `claude -p` turn pays
// every time, and it is only worth paying for a chat you are actually using —
// under the old engine an idle chat cost nothing at all, because its process was
// already gone. So panes are evicted on idleness, and the next turn transparently
// relaunches with `--resume`: slower for that one turn, invisible otherwise.

const lastUsed = new Map<string, number>();

/** Minutes a pane may sit unused before it is reclaimed. 0 disables eviction,
 *  for someone who would rather spend the RAM than ever wait. */
// Read per call, like the socket name above and for the same one-process
// reason.
export const idleEvictMs = (): number =>
  Math.max(0, Number(process.env.AGENTGLASS_TMUX_IDLE_MINUTES ?? 30)) * 60_000;

/** `now` is a parameter for the same reason `evictIdlePanes` takes one: the two
 *  are judged against each other, and a test that fixes one clock and not the
 *  other is comparing a made-up timestamp with a real one. */
export function touchPane(name: string, now = Date.now()): void { lastUsed.set(name, now); }
export function forgetPane(name: string): void { lastUsed.delete(name); pinned.delete(name); }

/**
 * Panes the sweeper may not touch.
 *
 * Eviction is right for the common case and wrong for the one chat you are
 * actually living in: step away for lunch and the session you care about is
 * precisely the one reclaimed, so the turn you come back to is the slow one —
 * which is the cost the pane engine exists to remove. There was no way to say
 * "not this one".
 *
 * A pin is about *idleness only*. Closing a pinned chat still releases its
 * pane, because closing is an explicit "done" and pinning is a statement about
 * a gap in a conversation, not about keeping a process forever.
 *
 * Held in memory, alongside `lastUsed`, and dropped when the pane is — a pin on
 * a process that no longer exists is not a preference anybody holds. A server
 * restart therefore loses pins while the tmux panes survive it; the sweeper's
 * own rule covers that, since a pane it has no record of gets a fresh full
 * interval rather than being reaped immediately.
 */
const pinned = new Set<string>();

export function pinPane(name: string, on: boolean): boolean {
  if (!validPaneName(name)) return false;
  if (on) pinned.add(name); else pinned.delete(name);
  return true;
}

export const isPinned = (name: string): boolean => pinned.has(name);

/**
 * Every pane on our socket, with what is known about it.
 *
 * Panes outlive the app — quit or crash and the sessions are still there — and
 * until now the only way to see that was `tmux -L agentglass ls` in a terminal,
 * with `kill-session` by hand as the only cleanup. A person running five chats
 * and wondering where two gigabytes went had nowhere in the app to look.
 *
 * `lastUsedAt` is null for a pane this process has never served a turn for,
 * which is exactly the shape of an orphan from a previous run. Whether it *is*
 * one also depends on which chats are open, which this module does not know —
 * so that judgement is left to the caller (see /chat/panes).
 */
export interface PaneInfo {
  name: string;
  lastUsedAt: number | null;
  pinned: boolean;
}

/** `list` is a parameter for the same reason `reachableAddresses` takes its
 *  interfaces and `firewallHint` takes its `which`: everything else in this
 *  module shells out to tmux, and a test that reached a real one would be
 *  reading the developer's own sessions. */
/**
 * A pane, once it is known what is using it.
 *
 * Split out from `panes()` and pure, because the judgement needs two things
 * neither side of the wire holds alone: which chats are on screen, which only
 * the client knows, and which turns are in flight, which only the server does.
 * Combining them in the route left it reachable only through a machine with
 * tmux actually running, which is to say untested.
 */
export interface PaneStatus extends PaneInfo {
  /** Mid-turn at this instant. Never an orphan, and never safe to end. */
  running: boolean;
  /** Nothing open and nothing in flight points at it. */
  orphan: boolean;
}

export function classifyPanes(
  rows: PaneInfo[], open: Iterable<string>, running: Iterable<string>,
): PaneStatus[] {
  const isOpen = new Set(open);
  const isRunning = new Set(running);
  return rows.map((p) => ({
    ...p,
    running: isRunning.has(p.name),
    // A pane serving a turn is never an orphan, whatever anybody has on
    // screen — the turn is the proof that something is using it, and it is the
    // one row that must not be offered a one-click end.
    orphan: !isRunning.has(p.name) && !isOpen.has(p.name),
  }));
}

export async function panes(list: () => Promise<string[]> = listPanes): Promise<PaneInfo[]> {
  return (await list()).map((name) => ({
    name,
    lastUsedAt: lastUsed.get(name) ?? null,
    pinned: pinned.has(name),
  }));
}

/** Kill panes idle past the threshold. Returns the names it reclaimed.
 *
 *  A pane we have no record of is left alone rather than reaped: it is either a
 *  chat from before a server restart or something a human started by hand, and
 *  killing an agent mid-work to save memory it might be actively using is a much
 *  worse failure than holding the memory. It gets a record instead, so it is
 *  eligible for eviction one full interval from now.
 *
 *  A pinned pane is skipped entirely — see `pinned`. */
export async function evictIdlePanes(
  now = Date.now(),
  io: { list: () => Promise<string[]>; kill: (n: string) => Promise<void> } = { list: listPanes, kill: killPane },
): Promise<string[]> {
  const window = idleEvictMs();
  if (!window) return [];
  const evicted: string[] = [];
  for (const name of await io.list()) {
    // Checked before the bookkeeping, so a pinned pane is not silently given a
    // timestamp it will be judged on the moment it is unpinned.
    if (pinned.has(name)) continue;
    const seen = lastUsed.get(name);
    if (seen === undefined) { lastUsed.set(name, now); continue; }
    if (now - seen < window) continue;
    await io.kill(name);
    lastUsed.delete(name);
    evicted.push(name);
  }
  return evicted;
}

let sweeper: ReturnType<typeof setInterval> | null = null;
/** Start the eviction sweep. Idempotent; a no-op when eviction is disabled or
 *  tmux is unusable, so callers need not check either. */
export function startPaneSweeper(): void {
  if (sweeper || !idleEvictMs() || !tmuxCapability().available) return;
  sweeper = setInterval(() => { void evictIdlePanes(); }, 60_000);
  // Never hold the process open for a memory optimisation.
  (sweeper as unknown as { unref?: () => void }).unref?.();
}
export function stopPaneSweeper(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}

/** Test seam: drop the idle bookkeeping without touching any real server. */
export function __resetPaneState(): void { lastUsed.clear(); pinned.clear(); }

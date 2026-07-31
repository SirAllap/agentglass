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
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Our socket name. Overridable so tests get a server of their own and never
 *  race, kill, or inherit the one a running app is using.
 *
 *  Read per call rather than pinned at import, for the same reason
 *  `projectsDirs()` in transcripts.ts is: `bun test` runs every file in one
 *  process, so a module-level constant would be decided by whichever test file
 *  imported this module first — and here that means a test's redirected socket
 *  silently reverting to the real one the running app is using. */
export const tmuxSocket = (): string => process.env.AGENTGLASS_TMUX_SOCKET || "agentglass";

/** Under `bun test`, nothing this module touches may be real.
 *
 *  Same guard main adopted for settings (#321) and the database (#319), for the
 *  same reason: `bun test` runs every file in one process, so a single import
 *  from an unrelated test is enough to reach the developer's own machine. Here
 *  the blast radius is worse than a stray file — an unguarded `new-session`
 *  would put chat panes in the user's real tmux. */
const IS_TEST = process.env.NODE_ENV === "test";
const underScratch = (p: string): boolean => p.startsWith(tmpdir());

/** Where our tmux config lives. Under the state dir rather than a temp path so
 *  the same file is reused across restarts — a server started by yesterday's
 *  process must not be talked to with a config that has since been deleted. */
function stateDir(): string {
  const asked = process.env.AGENTGLASS_STATE_DIR;
  if (asked) {
    if (!IS_TEST || underScratch(asked)) return asked;
  } else if (!IS_TEST) {
    const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
    return join(base, "agentglass");
  }
  // A test that did not redirect, or redirected somewhere real, gets scratch
  // rather than the developer's state directory.
  return join(tmpdir(), "agentglass-test-state");
}

const CONF = `# Written by agentglass. Do not edit — it is regenerated.
#
# This server must never load the user's tmux.conf. Theirs loads tpm, and
# through it tmux-continuum, whose autosave would write our chat panes over
# their own saved layout in ~/.tmux/resurrect/. Hence \`-f\` on every call.
set -g default-terminal "tmux-256color"
set -g history-limit 20000
# Nothing ever looks at our status line; the chat UI is the status line. Off
# also removes the one place a plugin would have hooked itself in.
set -g status off
set -g mouse on
set -g escape-time 0
# Claude Code asks for this by name and warns in the pane without it.
set -g focus-events on
`;

let confPath: string | null = null;
/** Write (once per process) and return our config path. */
function ensureConf(): string {
  if (confPath) return confPath;
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "tmux.conf");
  // Rewritten every process start rather than only when missing: the file is
  // ours, tiny, and a stale one from an older version is a silent behaviour
  // difference that would be very hard to see from the symptoms.
  Bun.write(p, CONF);
  confPath = p;
  return p;
}

/** How long a tmux call may take before we give up. A local socket answers in
 *  single-digit milliseconds; anything near this means the server is wedged, and
 *  a wedged tmux must not be able to hang a chat turn. */
const TMUX_TIMEOUT_MS = 5_000;

export interface TmuxResult { ok: boolean; stdout: string; stderr: string }

/** Run one tmux command against our server. `stdin` feeds commands that read it
 *  (`load-buffer -`), which is how prompt text gets in without ever being
 *  interpreted as arguments. */
export async function tmux(args: string[], stdin?: string): Promise<TmuxResult> {
  const bin = Bun.which("tmux");
  if (!bin) return { ok: false, stdout: "", stderr: "tmux is not installed" };
  const argv = [bin, "-L", tmuxSocket(), "-f", ensureConf(), ...args];
  try {
    const proc = Bun.spawn(argv, {
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
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
  if (!Bun.which("tmux")) return { available: false, reason: "tmux is not installed" };
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
export async function startPane(name: string, cwd: string, argv: string[]): Promise<TmuxResult> {
  if (!validPaneName(name)) return { ok: false, stdout: "", stderr: "invalid pane name" };
  // The one call in this module that CREATES something. Everything else asks
  // questions a missing server answers with "no". A test that reached here
  // without redirecting the socket would start a real `claude` in a real pane
  // on the developer's own tmux, so it is refused rather than trusted.
  if (IS_TEST && !process.env.AGENTGLASS_TMUX_SOCKET) {
    return { ok: false, stdout: "", stderr: "refusing to start a pane in tests without AGENTGLASS_TMUX_SOCKET" };
  }
  const quoted = argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  const cmd = `${quoted}; printf '\\n[agentglass] the CLI exited (%s). This pane is kept for inspection.\\n' "$?"; exec sleep 86400`;
  return tmux([
    "new-session", "-d",
    "-s", name,
    "-c", cwd,
    // A generous fixed size. The pane is never shown as a terminal in the app —
    // the chat is rendered from the transcript — but Claude Code lays its TUI out
    // to the pane width, and a narrow pane makes the text it writes to the
    // transcript no different while making an attached human's view miserable.
    "-x", "200", "-y", "50",
    cmd,
  ]);
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

// Open a file at a line, in the editor you already have open.
//
// lazygit's `e` runs $EDITOR and hands you a fresh instance. That's the right
// default, but it's the wrong answer for the way this is actually used: you
// already have nvim open — very likely inside the tmux session in the panel
// next door — with your undo history, your marks and your LSP warmed up.
// Starting a second one there is worse than not opening anything.
//
// So: talk to the running one if there is one, and only fall back to spawning.
//
// Neovim makes this cheap. Every instance since 0.9 listens on a unix socket at
// $XDG_RUNTIME_DIR/nvim.<pid>.0 without being asked, and `--server <sock>
// --remote-send` drives it. No plugin, no config, nothing for the user to set
// up — which matters, because a feature that needs setup is a feature nobody
// turns on.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { safeAbs } from "./git.ts";
import { inScope } from "./config.ts";

export const EDITOR_ENABLED = process.env.AGENTGLASS_EDITOR_DISABLED !== "1";

/** Where nvim drops its default sockets. */
function runtimeDir(): string {
  return process.env.XDG_RUNTIME_DIR || join("/run/user", String(process.getuid?.() ?? 1000));
}

/** Every live nvim socket, for callers that want to reach all of them rather
 *  than the one owning a path — theme sync applies to every open editor. */
export async function liveNvimSockets(): Promise<string[]> {
  const socks = nvimSockets();
  const alive = await Promise.all(socks.map(async (s) => ((await ask(s, "1")) ? s : null)));
  return alive.filter((s): s is string => !!s);
}

/** Live nvim control sockets, newest first — a socket that was created most
 *  recently is the instance most likely to be the one in front of you. */
function nvimSockets(): string[] {
  const dir = runtimeDir();
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => /^nvim\.\d+\.\d+$/.test(n))
    .map((n) => join(dir, n))
    .map((p) => { try { return { p, at: statSync(p).mtimeMs }; } catch { return null; } })
    .filter((x): x is { p: string; at: number } => !!x)
    .sort((a, b) => b.at - a.at)
    .map((x) => x.p);
}

/**
 * Ask an nvim a question. Empty string when it can't or won't answer.
 *
 * Async, and that is not a style choice. A socket left behind by a wedged
 * editor doesn't refuse the connection — it accepts and never replies, so the
 * probe runs to its full timeout. Done with spawnSync that blocked this
 * server's only thread for two seconds per socket, meaning one stuck nvim
 * froze the whole dashboard every time someone pressed `e`.
 *
 * One second is plenty: a healthy nvim answers in single-digit milliseconds.
 */
async function ask(sock: string, expr: string): Promise<string> {
  try {
    const proc = Bun.spawn(["nvim", "--server", sock, "--remote-expr", expr], { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, 1000);
    const out = (await new Response(proc.stdout).text()).trim();
    clearTimeout(timer);
    // `--remote-expr` prints its own error and still exits 0, so the text is
    // the only signal that the connection failed.
    return out.startsWith("E247") || out.includes("Send expression failed") ? "" : out;
  } catch { return ""; }
}

/**
 * The running nvim that belongs to this file, if any.
 *
 * Matched on the editor's own working directory rather than on "most recent",
 * because the whole point of a worktree-per-ticket setup is that several nvims
 * are open at once. Throwing a file from `agentglass` into the nvim editing
 * `orbit-WEB-1042` would be worse than opening a new window — it lands in
 * someone else's session, silently.
 */
async function socketFor(absPath: string): Promise<{ sock: string | null; otherCwds: string[]; stuck: number }> {
  // All at once: probing serially means the worst case is the sum of every
  // stuck editor's timeout, and the whole point of the timeout is to bound it.
  const socks = nvimSockets();
  const cwds = await Promise.all(socks.map((s) => ask(s, "getcwd()")));
  const otherCwds: string[] = [];
  let stuck = 0;
  for (let i = 0; i < socks.length; i++) {
    const cwd = cwds[i];
    if (!cwd) { stuck++; continue; } // dead or wedged — left behind by a crash
    if (absPath === cwd || absPath.startsWith(cwd.replace(/\/$/, "") + "/")) return { sock: socks[i], otherCwds, stuck };
    otherCwds.push(cwd);
  }
  return { sock: null, otherCwds, stuck };
}

/** Escape for the inside of a `:edit` typed into nvim. */
const esc = (p: string) => p.replace(/([ \\|"'%#])/g, "\\$1");

export type OpenResult =
  | { ok: true; how: "remote"; socket: string }
  /** Nothing reachable for this file. `otherCwds` names the editors that ARE
   *  running elsewhere — "no nvim running" is a lie when one is open two panes
   *  away, and the real reason (it's editing another repo) is the useful one. */
  | { ok: true; how: "spawn"; command: string; otherCwds: string[]; stuck: number }
  | { ok: false; error: string };

/**
 * Open `path` at `line`.
 *
 * Returns how it was handled so the UI can say something true: "sent to your
 * open nvim" and "opened a new one" are different events, and a user whose file
 * appeared in a window they weren't looking at deserves to be told which.
 */
export async function openInEditor(pathIn: unknown, lineIn: unknown): Promise<OpenResult> {
  if (!EDITOR_ENABLED) return { ok: false, error: "editor integration is disabled (AGENTGLASS_EDITOR_DISABLED=1)" };
  const abs = safeAbs(pathIn);
  if (!abs) return { ok: false, error: "invalid path" };
  // The same boundary every other write-ish capability honours: an instance
  // opened for one project must not reach into another repo's files.
  if (!inScope(abs)) return { ok: false, error: "outside the open project" };
  try { statSync(abs); } catch { return { ok: false, error: "file does not exist" }; }
  const line = Math.max(1, Math.min(10_000_000, Math.floor(Number(lineIn)) || 1));

  const { sock, otherCwds, stuck } = await socketFor(abs);
  if (sock) {
    // <C-\><C-N> first: the editor may be in insert or terminal mode, and a
    // bare `:edit` typed into insert mode inserts the literal text instead.
    const keys = `<C-\\><C-N>:edit ${esc(abs)}<CR>:${line}<CR>zz`;
    try {
      const proc = Bun.spawn(["nvim", "--server", sock, "--remote-send", keys], { stdout: "ignore", stderr: "ignore" });
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, 2000);
      await proc.exited;
      clearTimeout(timer);
      return { ok: true, how: "remote", socket: sock };
    } catch { /* fall through to spawning one */ }
  }

  // Nothing to talk to — hand the caller a command line to run in the terminal
  // panel. Spawning a GUI editor from the server would put a window somewhere
  // the user may not even be looking; the panel is where they already are.
  // `+N` is the line-number convention nvim, vim, helix and emacs all accept.
  const ed = editorCapability().editor;
  if (!ed) return { ok: false, error: "no editor found — set $EDITOR, or install nvim" };
  return { ok: true, how: "spawn", command: `${ed} '+${line}' ${JSON.stringify(abs)}`, otherCwds, stuck };
}

/** Is there a reachable nvim for this path? Lets the UI label the key honestly
 *  — "open in nvim" vs "open a new nvim" — before anything is pressed. */
export async function editorTarget(pathIn: unknown): Promise<{ running: boolean }> {
  const abs = safeAbs(pathIn);
  if (!abs || !EDITOR_ENABLED || !inScope(abs)) return { running: false };
  return { running: !!(await socketFor(abs)).sock };
}

// A user with no nvim should never be offered an "edit in nvim" key, let alone
// watch it fail with "command not found". Resolved once at boot: PATH does not
// change under a running server.
export const HAS_NVIM = !!Bun.which("nvim");

/**
 * What this machine can actually do, without probing any sockets.
 *
 * Cheap on purpose — the UI asks on open to decide whether to advertise the
 * key at all, and that question must not cost a second of socket timeouts.
 *
 * `$EDITOR` rides along for the fallback command: someone on helix or emacs
 * still gets a correct line to paste, even though the live push is nvim-only
 * (it is the only one of the three with a control socket by default).
 */
export function editorCapability(): { hasNvim: boolean; editor: string | null } {
  const env = (process.env.VISUAL || process.env.EDITOR || "").trim();
  return { hasNvim: HAS_NVIM, editor: env || (HAS_NVIM ? "nvim" : null) };
}
export { homedir };

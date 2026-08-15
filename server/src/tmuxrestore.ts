// Layout and scrollback persistence for the pane engine's own tmux server.
//
// The engine's tmux server survives app restarts (it is a daemon of its own),
// so "quit and reopen the app" needs nothing here. What needs this is the case
// tmux itself cannot answer: the host rebooted, the daemon died with it, and
// the panes are gone — sessions, splits and scrollback included. This module
// periodically photographs the layout and the scrollback of every pane on OUR
// socket, and on demand rebuilds the whole tree in a fresh server.
//
// What a restore gives back, in order of decreasing fidelity:
//
//   * the session/window/pane tree, each pane's working directory and size;
//   * each pane's scrollback (up to 2000 lines, replayed into the new pane);
//   * each pane's start command — which for agent panes is the exact CLI
//     invocation the chat engine used, including `--resume` when the pane was
//     itself a resumed session. "all" mode replays those commands, so a fleet
//     of agents comes back with every conversation resumed; "lazy" (default)
//     restores the tree and lets the chat reopen resume each session.
//
// Nothing here touches the user's tmux. Only the engine's own socket is read,
// and the data lands in the engine's state dir. The user's ~/.tmux/resurrect
// saves are nobody's business but theirs (see tmuxsnapshot.ts).
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmuxStateDir } from "./tmuxbin.ts";
import { tmux, listPanes, validSessionName } from "./tmuxpane.ts";
import { paneAgentNote } from "./panewt.ts";
import { claudeCode } from "./agents/claudecode.ts";
import { windowTree, type TmuxWindowDetail, type TmuxPaneRow } from "./tmuxlayout.ts";
import { tmuxResume } from "./config.ts";

/** A pane as captured. `startCommand` is the exact argv the pane was born
 *  with — replaying it in "all" mode is what resumes agent sessions. */
export interface CapturedPane extends TmuxPaneRow {
  startCommand: string;
  /**
   * The agent conversation that was live in this pane, when there was one.
   *
   * `startCommand` alone cannot bring an agent back, and measuring it is what
   * made that plain: tmux only reports a start command for a pane it CREATED
   * with one. A `claude` somebody typed into a shell — which is most of them —
   * leaves it empty, so the first real restore gave back six windows of login
   * shells and nothing else.
   *
   * This is the other half, and the app already knew it: the hook that watches
   * each pane records which conversation is in it (see panewt.ts, and the same
   * note the chat panel reads). With the id, a restored pane can start on
   * `claude --resume <id>` and the conversation carries on.
   */
  agentSession?: string;
}

export interface CapturedWindow extends TmuxWindowDetail {
  panes: CapturedPane[];
}

export interface CapturedSession {
  name: string;
  windows: CapturedWindow[];
}

export interface RestoreState {
  capturedAt: number;
  sessions: CapturedSession[];
}

function restoreDir(): string {
  return join(tmuxStateDir(), "restore");
}
function layoutPath(): string {
  return join(restoreDir(), "layout.json");
}
/** The pane's born-with command. `#{pane_start_command}` is empty for a plain
 *  shell (tmux only records explicit commands), which is the right thing: a
 *  shell restores as a shell in the same directory. */
async function startCommandOf(name: string, windowId: string, paneId: string): Promise<string> {
  const r = await tmux(["display-message", "-t", `=${name}:${windowId}.${paneId}`, "-p", "#{pane_start_command}"]);
  return r.ok ? r.stdout.trim() : "";
}

/**
 * Is this pane running an agent at all?
 *
 * `pane_current_command` is the binary of the foreground process — `claude`,
 * `fish`, `nvim`. Compared against the CLI's own basename rather than a literal,
 * so a machine whose binary is named otherwise is not silently excluded.
 */
function looksLikeAgent(command: string | undefined): boolean {
  if (!command) return false;
  const bin = (claudeCode.bin() || "claude").split("/").pop() || "claude";
  return command === bin;
}

/**
 * The conversation id from the command line of what is running in the pane.
 *
 * A fallback for the note, and worth having because the two fail differently:
 * the note is written by our own hook when a session starts, so a pane that was
 * itself restored — started as `claude --resume <id>` — has the id in its argv
 * before any hook has fired. tmux-assistant-resurrect, which does this job on
 * the user's own tmux, keeps exactly these two methods in the same order, and
 * the second one is the reason a restored desk survives a SECOND reboot.
 *
 * `#{pane_current_command}` is only the binary, so the arguments come from the
 * process itself. The id is checked against a UUID before it can reach a
 * command line.
 */
async function resumeIdOf(name: string, windowId: string, paneId: string): Promise<string | undefined> {
  const r = await tmux(["display-message", "-t", `=${name}:${windowId}.${paneId}`, "-p", "#{pane_pid}"]);
  const pid = Number(r.stdout.trim());
  if (!r.ok || !Number.isInteger(pid) || pid <= 1) return undefined;
  try {
    // The pane's process is a shell; the agent is its child. `ps` walks that
    // for us rather than us reading /proc by hand for every pane on the desk.
    const ps = Bun.spawnSync(["ps", "-o", "args=", "--ppid", String(pid)], { stdout: "pipe", stderr: "pipe" });
    const line = new TextDecoder().decode(ps.stdout);
    const m = /--resume[= ]\s*([0-9a-fA-F-]{36})/.exec(line);
    return m?.[1] && SESSION_ID_RE.test(m[1]) ? m[1] : undefined;
  } catch { return undefined; }
}

/** Capture every session on the engine's socket into the state dir. Safe to
 *  call on a timer and safe to call twice — both are the same overwrite. */
export async function captureLayout(now = Date.now()): Promise<RestoreState | null> {
  const names = await listPanes();
  if (!names.length) return null;
  const sessions: CapturedSession[] = [];
  for (const name of names) {
    if (!validSessionName(name)) continue;
    const windows = await windowTree(name);
    const out: CapturedWindow[] = [];
    for (const w of windows) {
      const panes: CapturedPane[] = [];
      for (const p of w.panes) {
        const startCommand = await startCommandOf(name, w.id, p.id);
        // The pane id is this server's, and so is the note — both die with the
        // server, which is why the id is copied into the photograph rather than
        // looked up again at restore time.
        /*
         * Only for a pane that is RUNNING one.
         *
         * The note outlives the agent: a pane where somebody ran `claude`, quit
         * it and went back to their shell keeps its note, and pane ids are
         * reused. Measured on a test desk — two plain shells were photographed
         * carrying conversation ids, and in "all" mode both would have come
         * back as agents where their owner had left a prompt. What is running
         * now is the question, so ask what is running now.
         */
        const agentSession = looksLikeAgent(p.command)
          ? (paneAgentNote(p.id)?.session_id || await resumeIdOf(name, w.id, p.id))
          : undefined;
        panes.push({ ...p, startCommand, agentSession });
      }
      out.push({ ...w, panes });
    }
    sessions.push({ name, windows: out });
  }
  const state: RestoreState = { capturedAt: now, sessions };
  mkdirSync(restoreDir(), { recursive: true });
  writeFileSync(layoutPath(), JSON.stringify(state));
  return state;
}

/** The last capture, without re-reading tmux. */
export function readRestoreState(): RestoreState | null {
  try {
    if (!existsSync(layoutPath())) return null;
    return JSON.parse(readFileSync(layoutPath(), "utf8")) as RestoreState;
  } catch {
    return null;
  }
}

/** When the last capture was written, for the settings panel. */
export function lastCaptureAt(): number | null {
  return readRestoreState()?.capturedAt ?? null;
}

/*
 * There is no scrollback replay, and that is deliberate.
 *
 * It existed and it was harmful. The only way tmux offers to put text into a
 * pane is to send it as INPUT, and a restored pane holds a live shell: the old
 * screen was pasted into the prompt and fish ran it, line by line, answering
 * "Unknown command: Enter" to the tail of a previous session. Seen on the first
 * real restore, in a screenshot.
 *
 * What a person gets back is the desk — sessions, windows, their names, their
 * splits and each pane's directory — which is the part that is expensive to
 * rebuild by hand. The text that scrolled past is not, and a terminal that
 * types last week into your shell is worse than an empty one.
 */

/**
 * What a restored pane runs.
 *
 * "lazy" is a login shell in the pane's directory, always: the desk comes back
 * and nothing starts talking to a model until somebody asks it to.
 *
 * "all" resumes the conversation. Two ways in, and the second is the one that
 * covers a real desk: a pane the app CREATED carries its whole command line in
 * `startCommand` and is replayed verbatim; a `claude` typed into a shell leaves
 * that empty — measured — so the conversation id recorded for the pane is used
 * to build `claude --resume <id>` instead.
 *
 * The command is passed as argv, never through a shell, and the id it contains
 * came from our own hook rather than from anything a page could set.
 */
function runArgs(mode: "lazy" | "all", pane: CapturedPane | undefined): string[] {
  if (mode !== "all" || !pane) return [];
  if (pane.startCommand) return ["sh", "-c", pane.startCommand];
  const id = pane.agentSession;
  if (!id || !SESSION_ID_RE.test(id)) return [];
  const bin = claudeCode.bin();
  if (!bin) return [];
  return [bin, "--resume", id];
}

/** A conversation id as the CLI writes them: a UUID, and nothing else goes on
 *  a command line built here. */
const SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The id tmux just printed, or "" — `-P -F` gives us the NEW id, which is the
 *  only way to address something we have just made. */
const printed = (r: { ok: boolean; stdout: string }): string => (r.ok ? r.stdout.trim() : "");

/** The panes of a window beyond its first, split into the window that exists
 *  now and given their scrollback back. */
async function restorePanes(name: string, windowId: string, panes: CapturedPane[], mode: "lazy" | "all"): Promise<void> {
  for (const p of panes) {
    const r = await tmux(["split-window", "-d", "-v", "-P", "-F", "#{pane_id}", "-t", `=${name}:${windowId}`,
      "-c", p.path || ".", ...runArgs(mode, p)]);
    const pid = printed(r);
  }
}

/**
 * Rebuild every captured session in a fresh tmux server.
 *
 * "lazy" (default): restore the tree — sessions, windows, splits, directories,
 * scrollback — with login shells in each pane; agent conversations resume the
 * moment their chat is reopened (the chat engine resumes from the transcript,
 * which survives the reboot on disk). "all": additionally replay each pane's
 * captured start command, which for agent panes relaunches the CLI with its
 * `--resume` flags, so the fleet comes back running.
 *
 * Idempotent: a session that already exists is skipped, so a double boot (or a
 * manual re-trigger) cannot create twins.
 */
export async function restoreLayout(mode: "lazy" | "all" = tmuxResume()): Promise<{ ok: boolean; restored: number; error?: string }> {
  const state = readRestoreState();
  if (!state || !state.sessions.length) return { ok: false, restored: 0, error: "nothing captured yet — no restore state" };
  let restored = 0;
  for (const s of state.sessions) {
    if (!validSessionName(s.name)) continue;
    const have = await tmux(["has-session", "-t", `=${s.name}`]);
    if (have.ok) continue; // already back, or a live session never died
    const first = s.windows[0];
    if (!first) continue;
    const cwd0 = first.panes[0]?.path || ".";
    /* `-P -F` on every creation, and that is the fix.
       This used to address the windows and panes by the ids in the capture —
       `@3`, `%7` — which belong to the server that died. `split-window -t
       =session:@3` fails, and the failure was swallowed by `if (r.ok)`, so a
       session with six windows came back with one and nobody was told. tmux
       hands back the id of what it has just made; everything below uses that. */
    const mk = await tmux(["new-session", "-d", "-P", "-F", "#{window_id}", "-s", s.name,
      ...(first.name ? ["-n", first.name] : []), "-c", cwd0, ...runArgs(mode, first.panes[0])]);
    const firstWin = printed(mk);
    if (!firstWin) continue;
    restored++;
    const firstPane = printed(await tmux(["display-message", "-p", "-t", `=${s.name}:${firstWin}`, "#{pane_id}"]));
    await restorePanes(s.name, firstWin, first.panes.slice(1), mode);

    for (const w of s.windows.slice(1)) {
      const nw = await tmux(["new-window", "-d", "-P", "-F", "#{window_id}", "-t", `=${s.name}:`,
        ...(w.name ? ["-n", w.name] : []), "-c", w.panes[0]?.path || ".", ...runArgs(mode, w.panes[0])]);
      const wid = printed(nw);
      if (!wid) continue;
      const pid = printed(await tmux(["display-message", "-p", "-t", `=${s.name}:${wid}`, "#{pane_id}"]));
      await restorePanes(s.name, wid, w.panes.slice(1), mode);
    }
  }
  return { ok: true, restored };
}

/** Delete the captured state (used by the reset path in the settings panel). */
export function clearRestoreState(): void {
  try { rmSync(restoreDir(), { recursive: true, force: true }); } catch { /* gone */ }
}

let captureTimer: ReturnType<typeof setInterval> | null = null;
/** Start the periodic layout sweep. Idempotent; a no-op when tmux is unusable
 *  or the restore feature is off, so callers need not check either. */
export function startRestoreSweeper(enabled: () => boolean): void {
  if (captureTimer || !enabled()) return;
  captureTimer = setInterval(() => { if (enabled()) void captureLayout(); }, 60_000);
  (captureTimer as unknown as { unref?: () => void }).unref?.();
}
export function stopRestoreSweeper(): void {
  if (captureTimer) clearInterval(captureTimer);
  captureTimer = null;
}

/** Test seam: forget everything without touching any real tmux. */
export function __resetRestoreState(): void {
  stopRestoreSweeper();
  try { clearRestoreState(); } catch { /* gone */ }
}

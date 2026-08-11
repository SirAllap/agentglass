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
import { tmux, validPaneName, listPanes } from "./tmuxpane.ts";
import { windowTree, type TmuxWindowDetail, type TmuxPaneRow } from "./tmuxlayout.ts";
import { tmuxResume } from "./config.ts";

/** How much scrollback is kept per pane. The panel's own terminals keep 20k;
 *  disk and capture cost say 2k here, which is a working window back from a
 *  reboot, not an archive. */
const SCROLLBACK_LINES = 2000;

/** A pane as captured. `startCommand` is the exact argv the pane was born
 *  with — replaying it in "all" mode is what resumes agent sessions. */
export interface CapturedPane extends TmuxPaneRow {
  startCommand: string;
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
function scrollbackPath(name: string, paneId: string): string {
  return join(restoreDir(), name, `${paneId}.txt`);
}

/** The pane's born-with command. `#{pane_start_command}` is empty for a plain
 *  shell (tmux only records explicit commands), which is the right thing: a
 *  shell restores as a shell in the same directory. */
async function startCommandOf(name: string, windowId: string, paneId: string): Promise<string> {
  const r = await tmux(["display-message", "-t", `=${name}:${windowId}.${paneId}`, "-p", "#{pane_start_command}"]);
  return r.ok ? r.stdout.trim() : "";
}

/** Capture every session on the engine's socket into the state dir. Safe to
 *  call on a timer and safe to call twice — both are the same overwrite. */
export async function captureLayout(now = Date.now()): Promise<RestoreState | null> {
  const names = await listPanes();
  if (!names.length) return null;
  const sessions: CapturedSession[] = [];
  for (const name of names) {
    if (!validPaneName(name)) continue;
    const windows = await windowTree(name);
    const out: CapturedWindow[] = [];
    for (const w of windows) {
      const panes: CapturedPane[] = [];
      for (const p of w.panes) {
        const startCommand = await startCommandOf(name, w.id, p.id);
        panes.push({ ...p, startCommand });
        // Scrollback: read now, write now, so a pane that dies between the
        // sweep's list and its capture still leaves the layout honest.
        const cap = await tmux(["capture-pane", "-p", "-S", `-${SCROLLBACK_LINES}`, "-t", `=${name}:${w.id}.${p.id}`]);
        if (cap.ok && cap.stdout) {
          mkdirSync(join(restoreDir(), name), { recursive: true });
          writeFileSync(scrollbackPath(name, p.id), cap.stdout);
        }
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

function paneArgv(pane: CapturedPane): string[] {
  // A captured start command is `sh -c '<quoted argv>; printf ...; exec sleep 86400`
  // for agent panes. Replaying it whole is exactly right; for plain shells it
  // is empty and we fall back to nothing (a login shell in the pane's cwd).
  return pane.startCommand ? ["sh", "-c", pane.startCommand] : [];
}

function replayScrollback(name: string, windowId: string, paneId: string, cwd: string): void {
  const file = scrollbackPath(name, paneId);
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  if (!text) return;
  const buf = `agx-restore-${paneId}`;
  void (async () => {
    const load = await tmux(["load-buffer", "-b", buf, "-"], text);
    if (load.ok) {
      await tmux(["paste-buffer", "-b", buf, "-t", `=${name}:${windowId}.${paneId}`, "-d", "-p"]);
    }
  })();
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
    if (!validPaneName(s.name)) continue;
    const have = await tmux(["has-session", "-t", `=${s.name}`]);
    if (have.ok) continue; // already back, or a live session never died
    const first = s.windows[0];
    if (!first) continue;
    const cwd0 = first.panes[0]?.path || ".";
    const argv0 = mode === "all" ? paneArgv(first.panes[0]) : [];
    const mk = await tmux(["new-session", "-d", "-s", s.name, "-c", cwd0, ...(argv0.length ? ["sh", "-c", argv0[0] === "sh" ? (argv0[2] as string) : argv0.join(" ")] : [])]);
    if (!mk.ok) continue;
    replayScrollback(s.name, first.id, first.panes[0]?.id ?? "", cwd0);
    restored++;
    // The remaining panes of the first window, then the other windows.
    const others: { w: CapturedWindow; p: CapturedPane }[] = [];
    for (let i = 1; i < first.panes.length; i++) others.push({ w: first, p: first.panes[i] });
    for (const w of s.windows.slice(1)) for (const p of w.panes) others.push({ w, p });
    for (const { w, p } of others) {
      const argv = mode === "all" ? paneArgv(p) : [];
      const r = await tmux(["split-window", "-d", "-v", "-t", `=${s.name}:${w.id}`, "-c", p.path || ".", ...(argv.length ? ["sh", "-c", argv[0] === "sh" ? (argv[2] as string) : argv.join(" ")] : [])]);
      if (r.ok) replayScrollback(s.name, w.id, p.id, p.path || ".");
    }
    // Re-create windows beyond the first. The split loop above populated the
    // first window with its own panes; windows after it become fresh windows.
    // (A captured window that no longer exists on disk stays captured but is
    // not recreated — tmux windows have no independent on-disk identity.)
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

// Tabs and splits for the pane engine, driven entirely from the agentglass UI.
//
// tmux is the backend — sessions, windows and panes live in the engine's own
// server (`-L agentglass`, its own config, see tmuxconf.ts) — but every one of
// tmux's window/pane operations is exposed here as a typed function, and the
// settings panel and chat views call these rather than ever talking tmux
// syntax. The UI owns the tabs, the splits and the status line; tmux renders
// and runs them.
//
// Targets are validated against tmux's own id shapes (`@N` windows, `%N`
// panes, names via validPaneName) before they reach a command — these ids come
// from browser requests, and tmux treats `:` and `.` as separators it would
// happily resolve onto a target we did not mean.
import { tmux, validSessionName, type TmuxResult } from "./tmuxpane.ts";
import type { TmuxWindow } from "../../shared/types.ts";

/** A pane row, as the UI needs it. */
export interface TmuxPaneRow {
  /** tmux's own pane id (`%5`). */
  id: string;
  index: number;
  active: boolean;
  /** The command currently running in the pane, e.g. `sh` or `claude`. */
  command: string;
  /** The pane's working directory. */
  path: string;
}

/** A window with its panes, for a tab strip and split UI. */
export interface TmuxWindowDetail extends TmuxWindow {
  panes: TmuxPaneRow[];
}

const WINDOW_RE = /^@\d+$/;
const PANE_RE = /^%\d+$/;

/** One window row for a session, or null when the session is gone. */
export async function listWindows(name: string): Promise<TmuxWindow[]> {
  if (!validSessionName(name)) return [];
  const r = await tmux([
    "list-windows", "-t", `=${name}`,
    "-F", "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_flags}",
  ]);
  if (!r.ok) return [];
  return r.stdout.split("\n").filter(Boolean).map((line) => {
    const [id, index, name_, active, flags] = line.split("\t");
    return { id, index: Number(index), name: name_ ?? "", active: active === "1", flags: flags ?? "", ask: undefined, phone: undefined, agent: undefined };
  }).filter((w) => WINDOW_RE.test(w.id));
}

/** The panes inside one window, or null when the window is gone. */
export async function windowPanes(name: string, windowId: string): Promise<TmuxPaneRow[] | null> {
  if (!validSessionName(name) || !WINDOW_RE.test(windowId)) return null;
  const r = await tmux([
    "list-panes", "-t", `=${name}:${windowId}`,
    "-F", "#{pane_id}\t#{pane_index}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}",
  ]);
  if (!r.ok) return null;
  return r.stdout.split("\n").filter(Boolean).map((line) => {
    const [id, index, active, command, path] = line.split("\t");
    return { id, index: Number(index), active: active === "1", command: command ?? "", path: path ?? "" };
  }).filter((p) => PANE_RE.test(p.id));
}

/** A session's windows with their panes — the tree a restore and a tab strip
 *  both want. */
export async function windowTree(name: string): Promise<TmuxWindowDetail[]> {
  const windows = await listWindows(name);
  const out: TmuxWindowDetail[] = [];
  for (const w of windows) {
    const panes = await windowPanes(name, w.id);
    out.push({ ...w, panes: panes ?? [] });
  }
  return out;
}

/** The command a pane starts with. Same `sh`-wrapped, exit-surviving shape the
 *  chat engine uses (newSessionArgv), so a tool that exits leaves the pane
 *  alive with a line saying so instead of vanishing mid-layout. */
function paneCommand(argv: string[]): string {
  if (!argv.length) return "";
  const quoted = argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  return `${quoted}; printf '\\n[agentglass] the CLI exited (%s). This pane is kept for inspection.\\n' "$?"; exec sleep 86400`;
}

/** A new window (tab) in the session, running `argv` in `cwd` when given. */
export async function newWindow(name: string, cwd: string, argv: string[] = [], title?: string): Promise<TmuxResult> {
  if (!validSessionName(name)) return { ok: false, stdout: "", stderr: "invalid pane name" };
  const args = ["new-window", "-d", "-t", `=${name}`, "-c", cwd];
  if (title && /^[\w ._/-]{1,40}$/.test(title)) args.push("-n", title);
  if (argv.length) args.push(...["sh", "-c", paneCommand(argv)]);
  return tmux(args);
}

/** Split a pane, `-h` = left/right, `-v` = top/bottom. New pane runs `argv`
 *  in `cwd` when given, else a shell in `cwd`. */
export async function splitPane(
  name: string, windowId: string, direction: "horizontal" | "vertical", cwd: string, argv: string[] = [],
): Promise<TmuxResult> {
  if (!validSessionName(name) || !WINDOW_RE.test(windowId)) return { ok: false, stdout: "", stderr: "invalid target" };
  const args = ["split-window", "-d", direction === "horizontal" ? "-h" : "-v", "-t", `=${name}:${windowId}`, "-c", cwd];
  if (argv.length) args.push(...["sh", "-c", paneCommand(argv)]);
  return tmux(args);
}

/** Kill one window (tab) and everything in it. */
export async function killWindow(name: string, windowId: string): Promise<TmuxResult> {
  if (!validSessionName(name) || !WINDOW_RE.test(windowId)) return { ok: false, stdout: "", stderr: "invalid target" };
  return tmux(["kill-window", "-t", `=${name}:${windowId}`]);
}

/** Kill one pane. Pane ids are unique server-wide, so the window is only used
 *  to keep the request shape honest. */
export async function killPane(name: string, windowId: string, paneId: string): Promise<TmuxResult> {
  if (!validSessionName(name) || !WINDOW_RE.test(windowId) || !PANE_RE.test(paneId)) return { ok: false, stdout: "", stderr: "invalid target" };
  return tmux(["kill-pane", "-t", paneId]);
}

/** Bring a window to the front of its session. */
export async function selectWindow(name: string, windowId: string): Promise<TmuxResult> {
  if (!validSessionName(name) || !WINDOW_RE.test(windowId)) return { ok: false, stdout: "", stderr: "invalid target" };
  return tmux(["select-window", "-t", `=${name}:${windowId}`]);
}

/** Focus a pane within its window. */
export async function selectPane(name: string, windowId: string, paneId: string): Promise<TmuxResult> {
  if (!validSessionName(name) || !WINDOW_RE.test(windowId) || !PANE_RE.test(paneId)) return { ok: false, stdout: "", stderr: "invalid target" };
  return tmux(["select-pane", "-t", `=${name}:${windowId}.${paneId}`]);
}

/** Rename a tab. Newlines and tmux separators are rejected outright. */
export async function renameWindow(name: string, windowId: string, title: string): Promise<TmuxResult> {
  if (!validSessionName(name) || !WINDOW_RE.test(windowId)) return { ok: false, stdout: "", stderr: "invalid target" };
  if (!/^[\w ._/-]{1,40}$/.test(title)) return { ok: false, stdout: "", stderr: "title must be 1-40 characters of letters, digits, spaces, dots, underscores, dashes or slashes" };
  return tmux(["rename-window", "-t", `=${name}:${windowId}`, title]);
}

/** Resize a pane by rows/columns (both clamped to sane bounds). */
export async function resizePane(name: string, windowId: string, paneId: string, x: number, y: number): Promise<TmuxResult> {
  if (!validSessionName(name) || !WINDOW_RE.test(windowId) || !PANE_RE.test(paneId)) return { ok: false, stdout: "", stderr: "invalid target" };
  const cx = Math.max(2, Math.min(400, Math.round(x)));
  const cy = Math.max(2, Math.min(200, Math.round(y)));
  return tmux(["resize-pane", "-t", paneId, "-x", String(cx), "-y", String(cy)]);
}

export const tmuxWindowIdValid = (w: unknown): w is string => typeof w === "string" && WINDOW_RE.test(w);
export const tmuxPaneIdValid = (p: unknown): p is string => typeof p === "string" && PANE_RE.test(p);

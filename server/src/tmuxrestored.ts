/**
 * WHICH WINDOWS THE LAST RESTORE BUILT, so the strip can say so.
 *
 * A restore after a reboot hands back a plain shell in each pane with the old
 * scrollback and starts nothing (in `lazy`, the default). The strip used to
 * have no way to tell those tabs from any other, so a person came back to a
 * desk that looked alive and was not. This file only REMEMBERS what the
 * restore did: it never builds, moves or starts anything, and the restore
 * writes here after it has finished, so the layout is exactly what it was.
 *
 * Keyed by tmux's window id, which belongs to the tmux server the restore
 * built them on (`engine`, "pid.start"): a record for another server is
 * dropped, never shown. One record at a time, replaced by the next restore, so
 * a dismissal cannot outlive the restore it answered.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { tmuxStateDir } from "./tmuxbin.ts";
import { AGENT_KINDS, agentKind } from "../../shared/agentKinds.ts";
import type { CapturedPane, CapturedWindow } from "./tmuxrestore.ts";

export interface RestoredMark {
  /** The agent's title ("Claude Code"), only when the pane ran one and the
   *  restore did not start it again. */
  was?: string;
  /** The conversation a Resume continues. */
  resume?: string;
  /** The pane that held the agent, as photographed — what Resume replays. */
  pane?: CapturedPane;
  /** Its position in the window, to find it again in the rebuilt window. */
  paneIndex?: number;
}

interface MarksFile { engine: string; at: number; windows: Record<string, RestoredMark> }

const filePath = (): string => join(tmuxStateDir(), "restore", "restored.json");

let cache: MarksFile | null | undefined;
function read(): MarksFile | null {
  if (cache !== undefined) return cache;
  try {
    const raw = JSON.parse(readFileSync(filePath(), "utf8"));
    cache = raw && typeof raw.engine === "string" && raw.windows && typeof raw.windows === "object" ? raw : null;
  } catch { cache = null; }
  return cache ?? null;
}
function write(f: MarksFile | null): void {
  cache = f;
  try {
    mkdirSync(join(tmuxStateDir(), "restore"), { recursive: true });
    const tmp = `${filePath()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(f ?? { engine: "", at: 0, windows: {} }), { mode: 0o600 });
    renameSync(tmp, filePath());
  } catch { /* the in-memory record still holds for this run */ }
}

/** The agent a photographed pane was running, or null for a plain shell. */
function agentOf(p: CapturedPane): string | null {
  if (p.agentSession) return agentKind("claude")?.title ?? null;
  const head = basename(p.startArgv?.[0] ?? "");
  return AGENT_KINDS.find((k) => k.bin === head)?.title ?? null;
}

/** Pure: what each rebuilt window should be marked with. In `all` mode the
 *  restore started the agents itself, so nothing is "was running" there. */
export function restoredMarks(made: { id: string; window: CapturedWindow }[], mode: "lazy" | "all"): Record<string, RestoredMark> {
  const out: Record<string, RestoredMark> = {};
  for (const m of made) {
    if (!m.id) continue;
    const at = mode === "lazy" ? m.window.panes.findIndex((p) => agentOf(p)) : -1;
    const p = at >= 0 ? m.window.panes[at] : undefined;
    out[m.id] = p
      ? { was: agentOf(p)!, ...(p.agentSession ? { resume: p.agentSession } : {}), pane: p, paneIndex: at }
      : {};
  }
  return out;
}

export function noteRestored(made: { id: string; window: CapturedWindow }[], mode: "lazy" | "all", engine: string, now = Date.now()): void {
  const windows = restoredMarks(made, mode);
  /* A pass that built nothing leaves the last record alone: "Restore now" on a
     desk that is already whole must not take the banner away. */
  if (Object.keys(windows).length) write({ engine, at: now, windows });
}

/** A record for another tmux server names windows that no longer exist. */
export function dropStaleMarks(engine: string): void {
  const f = read();
  if (f && engine && f.engine !== engine) write(null);
}

/** The wire fields for one window, or null when the last restore did not build it. */
export function restoredFields(id: string): { restored: true; restoredAt: number; was?: string; resume?: string } | null {
  const f = read();
  const m = f?.windows[id];
  if (!f || !m) return null;
  return { restored: true, restoredAt: f.at, ...(m.was ? { was: m.was } : {}), ...(m.resume ? { resume: m.resume } : {}) };
}

export function restoredMark(id: string): RestoredMark | null {
  return read()?.windows[id] ?? null;
}

/** Ids of the windows still marked, for "all". */
export function restoredIds(): string[] {
  return Object.keys(read()?.windows ?? {});
}

/** Acting on a window (or "Not now") takes its mark away; with no ids, all of them. */
export function dismissRestored(ids?: string[]): void {
  const f = read();
  if (!f) return;
  if (!ids) { write(null); return; }
  const windows = { ...f.windows };
  for (const id of ids) delete windows[id];
  write(Object.keys(windows).length ? { ...f, windows } : null);
}

export function __forgetRestoredCache(): void { cache = undefined; }

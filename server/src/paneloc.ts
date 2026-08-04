/**
 * Which tmux pane an agent is actually sitting in.
 *
 * The bar can say "this session is waiting for your input" and, until now,
 * could not take you to it: an agent started by hand in a tmux window is not a
 * chat this app owns and not a gate it can approve, so the only thing left was
 * to open a read-only summary of what it had already done. The missing fact was
 * never in the app — it was one `list-panes` away.
 *
 * The obvious key is wrong, and measurably so. `pane_current_path` is the
 * SHELL's directory, and on a real machine several panes share it while the
 * agent inside one of them is somewhere else entirely — a worktree, typically,
 * which is exactly the case worth pointing at. Observed: three panes all
 * reporting `~/code/agentglass` with the session in question running in
 * `~/code/agentglass-dr`. Matching on the shell's directory would have offered
 * the wrong pane three times over and never the right one.
 *
 * So the key is the agent process itself. Every pane is a process tree; walk it
 * for a process the agent CLIs are named after and read `/proc/<pid>/cwd`,
 * which is the directory the agent is genuinely running in and the same one its
 * hook events report. That makes the join an equality test rather than a guess.
 *
 * Linux only, and that is stated rather than worked around: `/proc` is where
 * this answer lives. Elsewhere the pane list still comes back, every agent
 * reads as null, and the caller finds no match — which lands on the same
 * "nothing here can answer this" it showed before, rather than on a wrong pane.
 */
import { readFileSync, readlinkSync } from "node:fs";

export interface PaneRow {
  /** tmux session NAME, for display, and its id for addressing. */
  session: string;
  sessionId: string;
  windowId: string;
  windowIndex: string;
  windowName: string;
  paneId: string;
  /** The shell's directory. Kept for display; deliberately not the join key. */
  path: string;
  /** Every agent found under this pane, by the directory it is running in.
   *  A list because panes nest them: an agent that shells out to another, or a
   *  split running two. Taking only the first answered with the shallowest one,
   *  which on a real machine was a different session from the one asking. */
  agentCwds: string[];
}

/** Process names the agent CLIs run under. `comm` is capped at 15 chars by the
 *  kernel, so these are compared whole against what /proc actually reports. */
const AGENT_COMMS = new Set(["claude", "codex", "gemini", "amp", "opencode", "crush", "antigravity"]);

/** How far down a pane's tree to look. A shell, a wrapper or two, the agent —
 *  deeper than that and we are walking somebody's build. */
const MAX_DEPTH = 6;

const comm = (pid: number): string | null => {
  try { return readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch { return null; }
};

const cwdOf = (pid: number): string | null => {
  try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return null; }
};

const childrenOf = (pid: number): number[] => {
  try {
    // Needs CONFIG_PROC_CHILDREN; absent, this reads empty and the pane simply
    // reports no agent — the same shape as a pane that has none.
    return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
      .trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite);
  } catch { return []; }
};

/**
 * Every agent running under this pane, by working directory.
 *
 * All of them, not the first. Stopping at the shallowest hit was wrong on the
 * machine this was written against: a pane held one agent in the project and
 * the session actually asking for attention in a worktree beneath it, and the
 * shallow answer named the wrong directory every time. Walking on costs a few
 * more reads of /proc and removes a whole class of confident wrong answer.
 */
export function agentCwdsUnder(panePid: number, depth = MAX_DEPTH): string[] {
  if (process.platform !== "linux") return [];
  const found: string[] = [];
  let level = [panePid];
  for (let d = 0; d <= depth && level.length; d++) {
    const next: number[] = [];
    for (const pid of level) {
      const c = comm(pid);
      if (c && AGENT_COMMS.has(c)) {
        const cwd = cwdOf(pid);
        if (cwd && !found.includes(cwd)) found.push(cwd);
      }
      next.push(...childrenOf(pid));
    }
    level = next;
  }
  return found;
}

/**
 * Parse `list-panes -a` output.
 *
 * Split out from the tmux call so the shape can be tested without a tmux
 * server: the interesting failures here are a pane path containing the
 * delimiter, and a machine with no panes at all.
 */
export function parsePanes(out: string, agentsOf: (pid: number) => string[] = agentCwdsUnder): PaneRow[] {
  const rows: PaneRow[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    // Tab-separated with the path LAST but one and the pid last, so a path with
    // a tab in it cannot shift the fields that matter. Split from both ends.
    const f = line.split("\t");
    if (f.length < 8) continue;
    const pid = Number(f[f.length - 1]);
    const path = f.slice(6, f.length - 1).join("\t");
    if (!Number.isFinite(pid)) continue;
    rows.push({
      session: f[0]!, sessionId: f[1]!, windowId: f[2]!, windowIndex: f[3]!,
      windowName: f[4]!, paneId: f[5]!, path,
      agentCwds: agentsOf(pid),
    });
  }
  return rows;
}

/** The format string the parser above expects. One place, so they cannot drift. */
export const PANE_FORMAT =
  "#{session_name}\t#{session_id}\t#{window_id}\t#{window_index}\t#{window_name}\t#{pane_id}\t#{pane_current_path}\t#{pane_pid}";

/**
 * The pane an agent running in `cwd` is in.
 *
 * Exact directory equality, and only when exactly one pane answers to it. Two
 * agents in the same worktree is a real thing people do, and picking one of
 * them at random would send you to the wrong conversation with no way to tell —
 * strictly worse than the app admitting it cannot say which. Declining is the
 * honest answer and the caller already has a sentence for it.
 */
export function panesForCwd(rows: PaneRow[], cwd: string | null | undefined): PaneRow[] {
  return cwd ? rows.filter((r) => r.agentCwds.includes(cwd)) : [];
}

export function paneForCwd(rows: PaneRow[], cwd: string | null | undefined): PaneRow | null {
  const hits = panesForCwd(rows, cwd);
  return hits.length === 1 ? hits[0]! : null;
}

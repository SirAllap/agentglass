/*
 * Whose children are these — on Linux, and on a Mac.
 *
 * Two callers walk a process tree looking for tmux: `tmuxClientPid`, which
 * finds the client so its panes can be driven, and `tmuxRunning`, which asks
 * only whether one is there. Both read `/proc/<pid>/task/<pid>/children`, and
 * both opened with the same line:
 *
 *     if (process.platform !== "linux") return null;
 *
 * That was written for a question where "no" is a fine answer everywhere else.
 * Its caller was deciding whether the panel should hide its own tab strip
 * because tmux brings one, and a Mac keeping agentglass's own chrome is exactly
 * right — the comment says so, and it is correct.
 *
 * The line was then load-bearing for a second question with a different shape:
 * "may I dispatch this request", asked by the buttons that send a pull request
 * or a card to an agent. There, "no" is not a fallback — it is a press that
 * does nothing, on every Mac, for ever, with no message. Same value, two
 * questions, and it only answers one of them. (The panel-chrome caller keeps
 * its behaviour: it is asking about a tmux the user is looking at, and this
 * module answers that identically.)
 *
 * So the walk becomes portable and the platform check goes away. /proc where
 * there is one, `ps` where there is not.
 */
import { readFileSync } from "node:fs";

/**
 * Direct children of a pid.
 *
 * Empty for a pid with none, and empty for a pid we cannot ask about — the two
 * are not distinguished on purpose. Every caller is hunting for something in
 * the tree, so "not found" and "could not look" lead to the same place, and a
 * thrown error in a poll loop would not.
 */
export function childrenOf(pid: number): number[] {
  if (!Number.isInteger(pid) || pid <= 0) return [];
  return process.platform === "linux" ? fromProc(pid) : fromPs(pid);
}

/** The name a pid is running under, or "". */
export function commOf(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  if (process.platform === "linux") {
    try { return readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch { return ""; }
  }
  return snapshot().comm.get(pid) ?? "";
}

/**
 * `children` needs CONFIG_PROC_CHILDREN. Where the kernel was built without it
 * the file is simply absent, which reads here as "no children" — the same
 * answer this module gives for anything it cannot see.
 */
function fromProc(pid: number): number[] {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
      .trim().split(/\s+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } catch { return []; }
}

/*
 * The `ps` snapshot, and why it is cached.
 *
 * There is no per-process file to read on a Mac, so the whole table is read at
 * once and indexed. That is one spawn instead of one per node, which matters:
 * these walks recurse, and they run inside the terminal's poll — a spawn per
 * node per tick would put a process table's worth of forks on the same thread
 * that serves the PTY.
 *
 * Held for a second. Long enough that one walk is one spawn however deep it
 * goes, short enough that a tmux started while you watch shows up in the next
 * tick rather than the next minute.
 */
const TTL_MS = 1000;
let held: { at: number; kids: Map<number, number[]>; comm: Map<number, string> } | null = null;

/** Test seam: the snapshot is a fact about the machine, and a suite must be
 *  able to state one instead of having the developer's own. */
let stub: string | null = null;
export function __setPsSnapshot(text: string | null): void { stub = text; held = null; }

function snapshot(): { kids: Map<number, number[]>; comm: Map<number, string> } {
  if (held && Date.now() - held.at < TTL_MS) return held;
  const text = stub ?? runPs();
  const parsed = parsePs(text);
  held = { at: Date.now(), ...parsed };
  return held;
}

function runPs(): string {
  try {
    // `-o` with trailing `=` suppresses the header, so there is no first line to
    // skip and no locale-dependent column name to match.
    const p = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,comm="], { stdout: "pipe", stderr: "ignore" });
    return p.success ? new TextDecoder().decode(p.stdout) : "";
  } catch { return ""; }
}

/**
 * `ps` output into a child index.
 *
 * `comm` on macOS is the executable PATH, not a bare name — `/usr/local/bin/tmux`
 * rather than `tmux` — and it can contain spaces. So the line is split on the
 * first two runs of whitespace only, and everything after them is the command,
 * kept whole.
 */
export function parsePs(text: string): { kids: Map<number, number[]>; comm: Map<number, string> } {
  const kids = new Map<number, number[]>();
  const comm = new Map<number, string>();
  for (const line of (text || "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const name = m[3]!.trim();
    if (!Number.isInteger(pid) || pid <= 0) continue;
    comm.set(pid, name);
    // A process whose parent is itself would loop the walk. Real on nothing,
    // but this is parsing a table we do not own.
    if (ppid !== pid) (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)!).push(pid);
  }
  return { kids, comm };
}

function fromPs(pid: number): number[] {
  return snapshot().kids.get(pid) ?? [];
}

/**
 * Is this name tmux — given a bare comm on Linux and a full path on macOS.
 *
 * "tmux: client" and "tmux: server" both report as `tmux` in Linux's comm, and
 * the prefix test that has always been here keeps them. The basename is taken
 * first so `/opt/homebrew/bin/tmux` matches without `/usr/bin/tmuxinator`
 * matching by accident on the directory.
 */
export const isTmuxComm = (comm: string): boolean => {
  const base = (comm || "").split("/").pop() ?? "";
  return base === "tmux" || base.startsWith("tmux:") || base.startsWith("tmux ");
};

/**
 * Walk down from a pid looking for tmux, and answer with the pid running it.
 *
 * Depth-limited for the same reason it always was: this reads a table that can
 * contain a cycle, and a poll loop is the worst place to discover one.
 */
export function findTmuxBelow(pid: number, depth = 0): number | null {
  if (depth > 4) return null;
  for (const c of childrenOf(pid)) {
    if (isTmuxComm(commOf(c))) return c;
    const deeper = findTmuxBelow(c, depth + 1);
    if (deeper) return deeper;
  }
  return null;
}

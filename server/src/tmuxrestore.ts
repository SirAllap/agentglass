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
//   * what was RUNNING in each pane, as the argv it was running with — an
//     agent CLI, or whatever command the pane was born from. "all" mode brings
//     it back: a Claude conversation is resumed by its id, any other program is
//     started again with the same argv, and a prompt that was on a command
//     line is never sent a second time (see `runArgs`); "lazy" (default)
//     restores the tree and lets the chat reopen resume each session.
//
// Nothing here touches the user's tmux. Only the engine's own socket is read,
// and the data lands in the engine's state dir. The user's ~/.tmux/resurrect
// saves are nobody's business but theirs (see tmuxsnapshot.ts).
import { readFileSync, readlinkSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync, copyFileSync } from "node:fs";
import { failed } from "./refused.ts";
import { join } from "node:path";
import { tmuxStateDir } from "./tmuxbin.ts";
import { tmux, validSessionName, tmuxSocket, setCaptureHook } from "./tmuxpane.ts";
import { confPath } from "./tmuxconf.ts";
import { resolveTmuxBin } from "./tmuxbin.ts";
import { paneAgentNote } from "./panewt.ts";
import { wasPromptOf, wasPromptAnywhere, newestPromptId, promptedSince, firstPromptSince } from "./db.ts";
import { agentNamed } from "./paneloc.ts";
import { claudeCode } from "./agents/claudecode.ts";
import { LANTERN_PROMPT_MARK } from "./lanternmark.ts";
import { windowTree, LAYOUT_RE, type TmuxWindowDetail, type TmuxPaneRow } from "./tmuxlayout.ts";
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
  /** The flags the agent in this pane was actually started with — everything
   *  on its command line except the binary, the id and the prompt. See
   *  `agentArgsOf`. */
  agentArgs?: string[];
  /**
   * What was running in the pane, as its own argv, for a pane holding no
   * Claude conversation: another agent CLI with its prompt taken off, or the
   * command the pane was born from (`bash -c "…"`, `lazygit`). Replayed as
   * argv, so it comes back exactly and never one shell deeper — see
   * `startCommand` for why the string tmux reports cannot be.
   */
  startArgv?: string[];
}

export interface CapturedWindow extends TmuxWindowDetail {
  panes: CapturedPane[];
}

export interface CapturedSession {
  /** When this session was last seen alive. Only ever used to drop entries
   *  that are a fortnight stale — never to decide a session is gone. */
  lastSeen?: number;
  name: string;
  windows: CapturedWindow[];
}

export interface RestoreState {
  capturedAt: number;
  sessions: CapturedSession[];
  /** The tmux server this was photographed on (`liveSessions().engine`).
   *  The window and pane ids in the file are only that server's. */
  engine?: string;
}

/*
 * WHY THIS FILE NEVER SHRINKS AT BOOT.
 *
 * On the morning of 2026-08-25 the machine rebooted and Electron crash-looped
 * — six launches in twenty-three minutes, one of them a hard
 * `Failed to shutdown`. Every tmux session from the previous day was lost
 * except one. The tmux daemon itself never died: it is a separate process and
 * it survived every crash. What was lost was this bookkeeping.
 *
 * The mechanism, and it is worth stating because the fix follows from it
 * exactly: each restart ran `captureLayout()`, which photographed whatever
 * sessions happened to be alive at that instant and OVERWROTE this file with
 * that set. Mid-restore, that set was small. The next restart read the smaller
 * file, saw those sessions already existed, and did nothing. The recorded
 * state could only ever shrink, never grow back. The one that survived was
 * simply whichever session outlasted the final interruption.
 *
 * So the invariant is: a session missing from a live snapshot is NOT evidence
 * that it should be forgotten — until this process has put the desk back on
 * this engine. Before that it might be gone; it might be mid-restore; the
 * app might be in the middle of dying. After that, a session that leaves is
 * one somebody closed (see `writeMerged`), and an explicit close removes an
 * entry at any time — `forgetSession`.
 */

/** A session is remembered until somebody explicitly closes it. This is how
 *  long a merged-but-unseen entry is kept before it is treated as stale — long
 *  enough to survive a reboot, a crash-loop and a working day. */
/**
 * Sessions that must NEVER be restored, however faithfully everything else is.
 *
 * A phone mirror (`agx-phone-…`) belongs to a phone that was attached at that
 * instant. Restoring one recreates its windows and, in every pane, whatever the
 * pane was running — which for this user is `claude --resume`. It is a copy of
 * a desk, made for a screen that is no longer there.
 *
 * Measured, and the measurement is this file's own doing. The merge below was
 * written so a session could never be lost, and it worked: the nine mirrors a
 * phone had left behind were captured, kept, and faithfully rebuilt on EVERY
 * boot. Nine hours after a cold start that was 525 MCP processes and 13 GB of
 * memory, with swap at 27 of 31 GB — and killing them was useless, because the
 * next install brought all nine back by name within seconds.
 *
 * So the guarantee is narrowed rather than weakened: nothing the user made is
 * ever forgotten, and nothing the app made FOR A PHONE is ever rebuilt.
 */
function isEphemeralSession(name: string): boolean {
  return /^agx-phone-\d+-[a-z0-9]+$/.test(name);
}

const KEEP_UNSEEN_MS = 14 * 24 * 60 * 60 * 1000;

function restoreDir(): string {
  return join(tmuxStateDir(), "restore");
}
function layoutPath(): string {
  return join(restoreDir(), "layout.json");
}
/*
 * THE GENERATION BEFORE THIS ONE.
 *
 * One file, overwritten in place, is one bad write away from a desk nobody can
 * get back — and "one bad write" is not hypothetical here: the file has been
 * truncated by a crash mid-write (fixed with temp-and-rename) and photographed
 * from a half-restored desk (fixed with the merge). Both fixes are in, and
 * both were written after the loss they describe.
 *
 * So the previous generation is kept, and it costs one rename. Nothing reads
 * it in the ordinary case; it is read when the current one is missing or does
 * not parse, which is exactly the failure that used to be total.
 */
function previousLayoutPath(): string {
  return join(restoreDir(), "layout.prev.json");
}

/**
 * Replace layout.json with `tmp`, keeping the generation it replaces.
 *
 * `rename` inside one directory is atomic, so a reader sees the whole old file
 * or the whole new one. The copy aside happens first and its failure is not
 * fatal: a missing spare is worse than no spare only if it stops the write
 * that matters.
 */
function swapInLayout(tmp: string): void {
  try { if (existsSync(layoutPath())) copyFileSync(layoutPath(), previousLayoutPath()); } catch { /* the spare is a courtesy */ }
  renameSync(tmp, layoutPath());
}
/** The pane's born-with command. `#{pane_start_command}` is empty for a plain
 *  shell (tmux only records explicit commands), which is the right thing: a
 *  shell restores as a shell in the same directory. */
async function startCommandOf(name: string, windowId: string, paneId: string): Promise<string> {
  const r = await tmux(["display-message", "-t", `=${name}:${windowId}.${paneId}`, "-p", "#{pane_start_command}"]);
  return r.ok ? r.stdout.trim() : "";
}

/** The Claude CLI's own basename rather than a literal, so a machine whose
 *  binary is named otherwise is not silently excluded. */
const claudeName = (): string => (claudeCode.bin() || "claude").split("/").pop() || "claude";

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
/**
 * Flags NOT carried back into a restored pane, and why each one.
 *
 * `--resume` and `--session-id` are re-supplied from the id the capture
 * validated, and reusing `--session-id` on a conversation that already exists
 * is a hard error rather than a degradation. `-p`/`--print` runs one prompt
 * and exits: replaying it would re-run whatever was asked hours ago and then
 * take the window down with it.
 */
const NOT_REPLAYED = new Set(["--resume", "--session-id", "-p", "--print"]);

/**
 * The flags an agent is running with, taken off its real command line.
 *
 * THE FLAGS ARE PART OF THE DESK. This user opens every session with
 * `--dangerously-skip-permissions`; a restore that rebuilds them as a plain
 * `claude --resume <id>` hands back twelve panes that all behave differently
 * from the twelve he had, and he has to notice and fix each one. Worse, a desk
 * where some panes were started that way and some were not comes back with the
 * distinction flattened — the app decided something it was never asked to
 * decide. His words: it does not even consider it.
 *
 * Kept verbatim rather than filtered through an allow-list. A flag this does
 * not recognise is a flag the person chose, and dropping it silently is the
 * same mistake in a smaller box; the four in `NOT_REPLAYED` are removed
 * because replaying them is known to break the pane, not because they are
 * unfamiliar. Anything with a newline in it is dropped, because a command line
 * is one line.
 */
/*
 * AND THE PROMPT IS NOT A FLAG.
 *
 * A prompt typed on the command line — `claude --model opus 'Read the brief
 * and follow it'` — sits among the flags as one more positional argument,
 * and there is no list of flags that says which positional is a value and
 * which is a sentence somebody meant once. Kept, it is sent again on every
 * resume: measured on 2026-09-21, a finished session's brief re-ran itself
 * after a restart and the tokens went with it. Dropped by guess — "the last
 * argument with a space in it" — it takes `--disallowedTools 'Bash(x) Bash(y)'`
 * with it, which is the flattened-flags mistake this file has already made
 * once.
 *
 * So the caller says which arguments were prompts, and it can say so exactly:
 * a prompt on the command line arrives through the same UserPromptSubmit hook
 * as one typed at the box, and the events table remembers it (`wasPromptOf`).
 * Nothing is guessed; a session whose hooks never reported keeps its prompt
 * and replays it, which is the stated ceiling.
 */
export function agentArgsOf(argv: string[], isPrompt: (text: string) => boolean = () => false): string[] {
  const out: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a || /[\n\r\0]/.test(a)) continue;
    const bare = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (NOT_REPLAYED.has(bare)) {
      /* `--flag=value` carries its value; `--flag value` eats the next one. */
      if (!a.includes("=") && i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) i++;
      continue;
    }
    if (!a.startsWith("-") && isPrompt(a)) continue;
    out.push(a);
  }
  /* A command line this long is not a command line any more. */
  return out.slice(0, 32);
}

/**
 * How this module asks the machine about processes, as a seam.
 *
 * Two questions — "who are this pid's children" and "what argv is that child
 * running" — and the answer to both is spelled differently on Linux and on a
 * Mac. The Linux spelling is measured and exact and stays as it was. The Mac
 * one exists because the Linux one is not merely different there, it is
 * absent: `ps --ppid` is a GNU procps flag that BSD `ps` rejects outright, and
 * there is no /proc to read a cmdline from. So on a Mac every pane restored as
 * a plain shell — the agent's argv was never found, the `--resume` in it never
 * seen.
 *
 * The suite runs on Linux and states a Mac through this object; the default is
 * the machine the process is on.
 */
export interface ProcReader {
  platform: string;
  /** stdout of a command, or "" — a missing binary and an empty answer are the
   *  same thing to every caller here. */
  run: (argv: string[]) => string;
  /** A file's text; throws when it is not there. */
  read: (path: string) => string;
  /** A process's working directory, or "" when the machine cannot say. Linux
   *  reads the link in /proc; a Mac has no cheap answer and says nothing,
   *  which only means a pane's note is taken at its word there. */
  cwd?: (pid: number) => string;
  /** When a process started, as epoch milliseconds, or 0 when the machine
   *  cannot say. Linux: field 22 of /proc/<pid>/stat over the boot time in
   *  /proc/stat. A Mac says nothing, with the same consequence as `cwd`. */
  startedAt?: (pid: number) => number;
}

const machineProc: ProcReader = {
  platform: process.platform,
  run: (argv) => {
    try {
      const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
      return new TextDecoder().decode(p.stdout);
    } catch { return ""; }
  },
  read: (path) => readFileSync(path, "utf8"),
  cwd: (pid) => { try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return ""; } },
  startedAt: (pid) => startedAtOf(pid, machineProc),
};

/**
 * When a process started, from /proc.
 *
 * `/proc/<pid>/stat` field 22 is the start time in clock ticks since boot;
 * `/proc/stat`'s `btime` is the boot, in whole seconds. USER_HZ is 100 on
 * every Linux userspace ABI, so a tick is 10 ms and nothing is asked of
 * `getconf`. The comm in field 2 is in parentheses and may itself contain
 * spaces or a `)` — a process named `node (main)` is real — so the fields
 * are counted from the LAST `)`, never split on whitespace from the front.
 * Whole seconds on the boot time make the answer good to about a second;
 * callers that compare it with a millisecond clock leave that much slack.
 */
export function startedAtOf(pid: number, proc: ProcReader = machineProc): number {
  if (proc.platform !== "linux") return 0;
  try {
    const stat = proc.read(`/proc/${pid}/stat`);
    const rest = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    /* `rest[0]` is field 3 (state); field 22 is therefore rest[19]. */
    const ticks = Number(rest[19]);
    const btime = Number((/^btime (\d+)/m.exec(proc.read("/proc/stat")) ?? [])[1]);
    if (!Number.isFinite(ticks) || !Number.isFinite(btime) || !btime) return 0;
    return btime * 1000 + ticks * 10;
  } catch { return 0; }
}

/** Direct children of a pid, or an empty list. */
export function childPidsOf(pid: number, proc: ProcReader = machineProc): number[] {
  // `pgrep -P` is in BSD pgrep and procps alike, but the Linux branch keeps
  // the `ps` it was measured with rather than trading a known answer for a
  // portable one.
  //
  // Before the `ps`, the kernel's own list: `/proc/<pid>/task/<pid>/children`
  // is one read where `ps` is one process, and the walk below asks this once
  // per process on the desk every ten seconds. Absent (CONFIG_PROC_CHILDREN
  // off, or a test that states a machine without it) it throws, and the
  // measured `ps` answers as it always did.
  let listed: string | null = null;
  if (proc.platform === "linux") {
    try { listed = proc.read(`/proc/${pid}/task/${pid}/children`); } catch { listed = null; }
  }
  const out = listed !== null ? listed.replace(/\s+/g, "\n")
    : proc.platform === "linux"
    ? proc.run(["ps", "-o", "pid=", "--ppid", String(pid)])
    : proc.run(["pgrep", "-P", String(pid)]);
  const pids: number[] = [];
  for (const line of out.split("\n")) {
    const child = Number(line.trim());
    if (Number.isInteger(child) && child > 1) pids.push(child);
  }
  return pids;
}

/**
 * The argv of a process.
 *
 * Linux: `/proc/<pid>/cmdline`, exactly as the kernel holds it — NUL-separated,
 * so a flag whose value has a space in it survives. macOS: `ps -o args=`, which
 * is one string with the arguments joined by spaces and nothing quoted, so the
 * same flag comes back as two arguments. Accepted and named rather than
 * guessed around: a quote-aware split would invent quoting `ps` never wrote,
 * and the one value this file goes looking for (`--resume <uuid>`) has no
 * spaces to lose. `-ww` because BSD `ps` truncates to the terminal width
 * otherwise, and a long command line cut at column 80 loses the flags at its
 * end — which is where `--resume` is.
 */
export function argvOf(pid: number, proc: ProcReader = machineProc): string[] {
  if (proc.platform === "linux") {
    try { return proc.read(`/proc/${pid}/cmdline`).split("\0").filter(Boolean); }
    catch { return []; }
  }
  return proc.run(["ps", "-ww", "-o", "args=", "-p", String(pid)]).trim().split(/\s+/).filter(Boolean);
}

/** How far down a pane's process tree to look for the agent: a shell, a
 *  wrapper or two, the agent. Deeper than that is somebody's build. And a
 *  ceiling on processes visited, because a pane running a build is a tree
 *  with hundreds of leaves and this runs every ten seconds. */
const WALK_DEPTH = 6;
/* Lower on a Mac, where every process visited is a `ps` and a `pgrep` spawned
   on the event loop: a dev server's tree would stall the server every sweep. */
const WALK_MAX = process.platform === "darwin" ? 12 : 60;

/** What an agent CLI under a pane is: which one, its argv, where it runs. */
export interface AgentUnder { name: string; argv: string[]; cwd: string; startedAt: number }

/**
 * The agent running in a pane, or null.
 *
 * Breadth-first from the pane's own process, so the pane's agent is found
 * before anything it shelled out to. The pane's own pid is asked first, and
 * that is the measured half of this: a window born from
 * `tmux new-window "exec claude …"` has no shell left in it — `exec`
 * replaced it — so the agent IS the pane's process and a walk that started
 * at its children found nothing. Six windows on the owner's desk were
 * photographed that way with no flags and no way to resume.
 *
 * Named by `agentNamed` (paneloc.ts): the binary's basename, or the npm
 * package when the binary is `node` — which is how a qwen is told apart
 * from a build.
 */
export function agentUnder(panePid: number, proc: ProcReader = machineProc): AgentUnder | null {
  let level = [panePid];
  let seen = 0;
  for (let depth = 0; depth <= WALK_DEPTH && level.length; depth++) {
    const next: number[] = [];
    for (const pid of level) {
      if (++seen > WALK_MAX) return null;
      const argv = argvOf(pid, proc);
      const name = agentNamed(argv);
      if (name) return { name, argv, cwd: proc.cwd?.(pid) ?? "", startedAt: proc.startedAt?.(pid) ?? 0 };
      next.push(...childPidsOf(pid, proc));
    }
    level = next;
  }
  return null;
}

/**
 * Is the hook's note about THIS agent, or about one that had the pane id
 * before it, or about a pane of the same id on another tmux?
 *
 * The note is keyed by pane id alone, and a pane id is only one server's.
 * Hooks fire from every tmux on the machine, so a Claude in the person's own
 * tmux on `%2` writes the note of the engine's `%2`; and ids start at %0
 * again on the server that restores a desk, so a note from the server that
 * died can name a pane of this one. The hook says which server it fired in
 * (`notePaneFromHook`), and a note from another is never this pane's.
 *
 * Within one server, the question is when, not where. The first guard
 * compared the note's directory with the process's, and set aside the notes
 * of live agents by the dozen: the note's cwd is the hook payload's, which
 * follows the Bash tool's `cd` — one session reported thirteen directories
 * over its life — while the CLI never moves for it (`chdir` only at start and
 * on entering or leaving a worktree, read off the installed binary). A note
 * written after this process was born, on this server, was written by a hook
 * this process fired; one written before belongs to whatever had the pane
 * before it — a Claude somebody quit — even in the same directory, because
 * many agents share a checkout. The slack covers the boot time being whole
 * seconds.
 *
 * A note from a hook that does not name its server (installed before it
 * did) is taken by time only when its directory is inside the process's:
 * that cannot be told from another tmux's pane otherwise, and a `cd` out of
 * the checkout is the ceiling. A machine that cannot say when a process
 * started (a Mac) keeps the directory rule, and takes a note at its word when
 * it cannot say that either.
 *
 * Also a ceiling: a wall-clock step after the agent started (NTP correcting a
 * clock that was behind at boot) moves the computed start by the step, and
 * the agent's notes are set aside until its next hook.
 */
export const NOTE_SLACK_MS = 2_000;
const within = (dir: string, root: string): boolean =>
  !root || dir === root || dir.startsWith(root.endsWith("/") ? root : `${root}/`);
export function noteIsThisAgents(note: { cwd: string; at: number; server?: string }, under: { cwd: string; startedAt: number }, server = ""): boolean {
  if (note.server && server && note.server !== server) return false;
  const sameServer = !!note.server && !!server;
  if (under.startedAt) {
    if (note.at < under.startedAt - NOTE_SLACK_MS) return false;
    return sameServer || within(note.cwd, under.cwd);
  }
  if (sameServer) return true;
  return !under.cwd || note.cwd === under.cwd;
}

/** The `--resume <uuid>` on a command line, when it carries one. A pane
 *  that was itself restored has the id here before any hook has fired, and
 *  that is what lets a restored desk survive a SECOND reboot. */
export function resumeIdIn(argv: readonly string[]): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    const v = a.startsWith("--resume=") ? a.slice(9) : a === "--resume" ? argv[i + 1] : undefined;
    if (v && SESSION_ID_RE.test(v)) return v;
  }
  return undefined;
}

/**
 * The flags that carry a prompt on the command lines of the other CLIs this
 * machine runs, by CLI. Replaying one re-runs a task from hours ago, which
 * is the same mistake `NOT_REPLAYED` exists for, in another binary. Only
 * NAMED flags: a positional prompt (codex) cannot be told from a positional
 * value without knowing every flag, and is replayed — the stated ceiling.
 */
const PROMPT_FLAGS: Record<string, string[]> = {
  opencode: ["--prompt"],
  qwen: ["-p", "--prompt", "-i", "--prompt-interactive"],
  gemini: ["-p", "--prompt", "-i", "--prompt-interactive"],
};

/**
 * Invocations that run one job and exit. Replayed, the job runs again at
 * boot — the same mistake as a replayed prompt, by another door — and before
 * the argv was photographed such a pane came back as a shell. It still does.
 * A short known list, not a rule: a CLI's one-shot spelling is its own.
 */
const ONE_SHOT: Record<string, string[]> = {
  codex: ["exec"],
  opencode: ["run"],
  crush: ["run"],
  amp: ["-x", "--execute"],
};

export function withoutPromptFlags(name: string, argv: readonly string[]): string[] {
  if ((ONE_SHOT[name] ?? []).some((m) => argv.slice(1).includes(m))) return [];
  const drop = new Set(PROMPT_FLAGS[name] ?? []);
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (/[\n\r\0]/.test(a)) continue;
    const bare = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (drop.has(bare)) {
      if (!a.includes("=") && i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) i++;
      continue;
    }
    out.push(a);
  }
  return out.slice(0, 64);
}

/** A login shell with nothing to run is the pane's default, not a command
 *  to bring back: tmux gives a restored pane one anyway. `bash -c "…"` is a
 *  command. */
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "elvish", "xonsh", "pwsh"]);
export function isBareShell(argv: readonly string[]): boolean {
  const head = (argv[0] || "").replace(/^-/, "").split("/").pop() || "";
  /* `-c` on its own or folded into `-lc`, `-ec`, `-ic`: all of them run the
     next argument. */
  return SHELLS.has(head) && !argv.slice(1).some((a) => a === "--command" || /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
}

/**
 * Is the agent the walk found what the pane is actually running?
 *
 * The walk takes any descendant, and a pane whose program spawns workers — a
 * script running `claude -p`, a dev server with a helper — would be
 * photographed as a Claude pane holding a worker's conversation, and come
 * back as that worker instead of its program. `#{pane_current_command}` is
 * tmux's name for the foreground process, and it has to be the agent's own
 * binary: `claude` under a shell, `opencode`, the `node` a launcher is.
 */
export function isForeground(found: Omit<AgentUnder, "startedAt"> & { startedAt?: number }, paneCommand: string): boolean {
  const head = (found.argv[0] || "").split("/").pop() || "";
  return !!paneCommand && head === paneCommand;
}

/** The chat pane's own wrapper ends in `exec sleep 86400` once the CLI has
 *  exited, to keep the pane for reading (newSessionArgv, paneCommand). That
 *  sleep, by its exact spelling, is nothing to bring back. */
const isKeepAlive = (argv: readonly string[]): boolean =>
  argv.length === 2 && ((argv[0] || "").split("/").pop() || "") === "sleep" && argv[1] === "86400";

/** A pane forked a moment ago still carries the tmux server's own argv until
 *  it execs — measured: photographed right after `new-window`, the pane read
 *  as the tmux binary with the server's arguments. Not a command anybody
 *  ran, and the next sweep sees the real one. */
const bornYet = (argv: readonly string[]): boolean =>
  (argv[0] || "").split("/").pop() !== ((resolveTmuxBin() || "tmux").split("/").pop() || "tmux");

/**
 * Whether an argument of a running CLI was a prompt, remembered per process.
 *
 * Asked of the pane's own conversation first (an indexed lookup), then of
 * every session — after `/clear` the pane holds a new conversation and the
 * argument on its command line was submitted to the old one, which the note
 * no longer names. The argv of a process never changes, so a YES is kept for
 * the process's life.
 *
 * A NO IS ONLY AS GOOD AS THE PROMPTS SEEN SO FAR. The first photograph of a
 * new pane can run before the CLI has submitted its command-line prompt: the
 * sweep is every ten seconds and on every app window, and in interactive
 * mode the prompt goes in after the TUI is up — on a fresh worktree, after
 * the person has accepted the trust dialog, which can take minutes. A no
 * cached for good at that moment photographed the brief as a flag at every
 * later sweep, and the restore ran it again. Asked again at every sweep
 * instead, the no of every flag value of every pane was a scan of every
 * prompt ever recorded, every ten seconds, forever. So a no is kept against
 * the newest prompt row it was asked against (`newestPromptId`), and asked
 * again only when a newer one exists; and it is FINAL once one of the pane's
 * conversations has been sent any prompt since the process started — the
 * command-line prompt is always the first, so by then it has been seen.
 *
 * The maps die with this server, which is the stated ceiling: a prompt older
 * than the retention window reappears after an app restart.
 */
const promptVerdicts = new Set<string>();
/** A no, with the newest prompt row it was asked against, or `FINAL_NO`. */
const promptNos = new Map<string, number>();
const FINAL_NO = -1;
/** How many times the database was asked, for the test that holds the cache
 *  to its promise. */
const promptLookups = new Map<number, number>();
export function __promptLookups(pid: number): number { return promptLookups.get(pid) ?? 0; }
function wasPromptFor(pid: number, text: string, sessions: (string | undefined)[], bornAt: number, newest: number): boolean {
  const key = `${pid}\0${text}`;
  if (promptVerdicts.has(key)) return true;
  const no = promptNos.get(key);
  if (no !== undefined && (no === FINAL_NO || no >= newest)) return false;
  /* Only since this process was born, of its own conversations as of every
     other: a prompt on its command line was submitted after that, and a
     flag's value typed as a prompt last month — in another session, or in
     the very conversation a restored pane resumes — is not it. */
  const since = bornAt ? bornAt - NOTE_SLACK_MS : 0;
  if (promptLookups.size > 2000) promptLookups.clear();
  promptLookups.set(pid, (promptLookups.get(pid) ?? 0) + 1);
  const yes = sessions.some((id) => !!id && wasPromptOf(id, text, since)) || wasPromptAnywhere(text, since);
  if (promptVerdicts.size > 2000) promptVerdicts.clear();
  if (promptNos.size > 2000) promptNos.clear();
  if (yes) { promptVerdicts.add(key); promptNos.delete(key); return true; }
  const final = sessions.some((id) => !!id && promptedSince(id, since));
  promptNos.set(key, final ? FINAL_NO : newest);
  return false;
}

/**
 * The union of what was already recorded and what is alive now, written
 * atomically.
 *
 * MERGE, never replace. A live session updates its own entry — if somebody
 * closed a window, the fresh photograph is the truth for THAT session. A
 * session that is not in the live set keeps the entry it had: it may be gone,
 * or the app may be mid-restore, or mid-death, and none of those are
 * distinguishable from here. Guessing wrong in one direction leaves a stale
 * entry that `restoreLayout` skips harmlessly. Guessing wrong in the other
 * direction is what lost a day of sessions.
 *
 * TEMP-AND-RENAME, because a crash between `open` and the last byte used to be
 * able to leave this file truncated — and a truncated layout.json parses as
 * nothing at all, which is the same loss by a different route. `rename` within
 * one directory is atomic: a reader sees the old file or the new one.
 */
/*
 * THE SAME RULE, ONE FLOOR DOWN: A SESSION'S WINDOWS.
 *
 * "Merge, never replace" was written for sessions and applied only to
 * sessions, and the gap cost a morning of somebody's real work. What happened,
 * in order: the tmux server died; the engine made the session again, empty,
 * with one window; the ten second sweeper photographed one window; the merge
 * saw the session in the live set, let the fresh photograph win whole, and the
 * six windows that had been recorded were gone from the file before the
 * restore ever ran. Nothing in the loss was ambiguous to a person and every
 * step of it was correct at its own level.
 *
 * A window missing from the photograph is only AMBIGUOUS while this process
 * has not yet had its go at putting the desk back. After that, a person
 * closing a tab is exactly what a shrinking photograph means, and resurrecting
 * it would be its own bug. So the keep is bounded by `settled`, not by a
 * timer: it covers the boot, and it covers nothing else.
 *
 * Matched by name, then by the working directory of the first pane, because
 * the ids in the file belong to the tmux server that died.
 */
function mergeWindows(old: CapturedWindow[], freshWins: CapturedWindow[], whole: boolean): CapturedWindow[] {
  if (whole) return freshWins;
  const key = (w: CapturedWindow) => `${w.name ?? ""}\u0000${w.panes[0]?.path ?? ""}`;
  const have = new Set(freshWins.map(key));
  const missing = old.filter((w) => !have.has(key(w)));
  return missing.length ? [...freshWins, ...missing] : freshWins;
}

/*
 * AND THE SAME RULE FOR THE SESSION ITSELF, once the desk is whole.
 *
 * A session an orchestrator opened for one job finished and was killed on
 * purpose, and stayed in the file for a fortnight: every boot in "all" mode
 * rebuilt it as `claude --resume <id>`, an idle process on a conversation
 * that was over. "Merge, never replace" was written for the boot, where a
 * missing session is ambiguous, and it is bounded here exactly as the window
 * rule is: while this process has not put the desk back on THIS engine, a
 * missing session is kept; after that, a session that is not there is one
 * somebody closed. `whole` is false again the moment the engine is a
 * different server from the one the desk was put back on — the tmux server
 * dying and the engine remaking one session is the morning this file was
 * written for, and a photograph of that is not evidence of anything.
 */
function writeMerged(fresh: CapturedSession[], now: number, whole: boolean, engine: string, live: ReadonlySet<string>): RestoreState {
  const seenNow = new Map(fresh.map((s) => [s.name, s]));
  /* Read at write time, not when the capture began: what another writer put
     in the file meanwhile (`forgetSession`, a restore) is what this merges
     with. */
  const before = readRestoreState();
  const kept: CapturedSession[] = [];
  const carried = new Map<string, CapturedWindow[]>();
  for (const old of before?.sessions ?? []) {
    if (seenNow.has(old.name)) {
      /* The fresh photograph of a live session wins — except for the windows
         it has not had a chance to bring back yet. */
      const wins = mergeWindows(old.windows, seenNow.get(old.name)!.windows, whole);
      if (wins.length !== seenNow.get(old.name)!.windows.length) carried.set(old.name, wins);
      continue;
    }
    if (forgotten.has(old.name)) continue;    // explicitly closed
    /* Closed: the desk was whole and tmux no longer lists it. A session tmux
       still lists but this sweep could not photograph — its windows did not
       answer in time, or all it holds is left out of the picture — is kept
       as it was: only tmux saying it is gone is a close. */
    if (whole && !live.has(old.name)) continue;
    /* Nor carried forward: every file written before this rule still names the
       nine mirrors, and keeping them for fourteen days would mean fourteen days
       of a file that heals only if somebody edits it by hand. */
    if (isEphemeralSession(old.name)) continue;
    /* Not seen, not closed: keep it. The timestamp is only a floor for
       genuinely ancient entries — a fortnight, which no crash-loop reaches. */
    const lastSeen = old.lastSeen ?? before?.capturedAt ?? now;
    if (now - lastSeen > KEEP_UNSEEN_MS) continue;
    kept.push({ ...old, lastSeen });
  }
  const sessions = [...fresh.map((s) => ({ ...s, windows: carried.get(s.name) ?? s.windows, lastSeen: now })), ...kept];
  const state: RestoreState = { capturedAt: now, sessions, ...(engine ? { engine } : {}) };
  mkdirSync(restoreDir(), { recursive: true });
  const tmp = `${layoutPath()}.${process.pid}.tmp`;
  /* The person's own, and now with the arguments of what they were running
     in it — prompts included. Not for the other accounts on the machine. */
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  swapInLayout(tmp);
  return state;
}

/** Sessions a person explicitly closed. The one way an entry leaves the file
 *  BEFORE the desk is whole: until then everything else only ever adds. */
const forgotten = new Set<string>();

/**
 * Forget a session because somebody closed it — not because it stopped
 * answering.
 *
 * The one subtraction that takes an explicit call rather than being
 * inferred, and it is the only one that applies at boot: "it is not in the
 * live list" was exactly the inference that lost a day of work, and it is
 * trusted only once the desk has been put back (`writeMerged`).
 */
export function forgetSession(name: string): void {
  forgotten.add(name);
  const before = readRestoreState();
  if (!before) return;
  const sessions = before.sessions.filter((s) => s.name !== name);
  if (sessions.length === before.sessions.length) return;
  mkdirSync(restoreDir(), { recursive: true });
  const tmp = `${layoutPath()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...before, sessions }), { mode: 0o600 });
  swapInLayout(tmp);
}

/** Capture every session on the engine's socket into the state dir. Safe to
 *  call on a timer and safe to call twice — both are the same overwrite.
 *
 *  ONE AT A TIME. The ten second sweep, a new app window and the Settings
 *  button each start one, and now that a whole desk forgets what tmux no
 *  longer lists, a slow capture that listed the sessions before one was made
 *  would, finishing last, write its list over the capture that had it. The
 *  one that starts second photographs after the first has written. */
let captureInFlight: Promise<unknown> = Promise.resolve();
export function captureLayout(now?: number): Promise<RestoreState | null> {
  const run = captureInFlight.then(() => captureOnce(now ?? Date.now()), () => captureOnce(now ?? Date.now()));
  captureInFlight = run.catch(() => undefined);
  return run;
}

async function captureOnce(now: number): Promise<RestoreState | null> {
  /*
   * NOT WHILE A RESTORE IS RUNNING. This is the race that did the damage.
   *
   * `restoreLayout` recreates sessions one at a time, one tmux subprocess per
   * session, window and pane. In "all" mode that takes seconds. A capture
   * firing in the middle of it photographs a HALF-restored desk — three of six
   * sessions — and used to write that as the new truth. The next boot then
   * restored three, and the three that were still missing had already been
   * forgotten.
   *
   * The merge above makes that survivable on its own. This makes it not
   * happen: a capture asked for mid-restore is deferred, and one runs when the
   * restore finishes, against a desk that is whole.
   */
  if (restoring) { captureWanted = true; return null; }
  if (capturingHalted()) return null;
  const { names, engine, startedAt, server } = await liveSessions();
  /* A server this process has not put the desk back on (see `settledOn`):
     photographed as a desk that is not whole — nothing is forgotten — and put
     back once it has been seen on two sweeps. Not on the first: a server seen
     once may be one somebody is in the middle of killing and starting again
     (the conf reset, a script), and a pass racing that builds on the dying
     one. */
  let putBack = false;
  if (engine) {
    const on = settledOn.get(deskKey());
    if (on === "") settledOn.set(deskKey(), engine);
    else if (on && on !== engine && !putBackOn.has(engine)) {
      if (seenNew === engine) { putBackOn.add(engine); putBack = true; }
      else seenNew = engine;
    }
  }
  /*
   * An empty socket is not "no sessions" — it is far more often tmux not
   * answering yet, or the app racing its own engine at boot. Writing an empty
   * merge would be harmless now that nothing shrinks, but reading nothing and
   * concluding nothing is the habit that caused this, so it stops here too.
   */
  if (!names.length) return null;
  /* The last photograph, when its pane ids are this server's: a pane that
     has died since is still in it as it was alive. */
  const lastShot = readRestoreState();
  /* Read once per sweep: a prompt verdict can only change when this does. */
  const newestPrompt = newestPromptId();
  const previous = lastShot?.engine === engine ? lastShot : null;
  const sessions: CapturedSession[] = [];
  for (const name of names) {
    if (!validSessionName(name)) continue;
    if (isEphemeralSession(name)) continue;
    const windows = await windowTree(name);
    const out: CapturedWindow[] = [];
    for (const w of windows) {
      const panes: CapturedPane[] = [];
      for (const p of w.panes) {
        const startCommand = await startCommandOf(name, w.id, p.id);
        /*
         * THE OBSERVER IS NOT PHOTOGRAPHED.
         *
         * The Lantern's chat is opened for a look at the field as it is
         * NOW; a restart that brings it back brings back a Claude nobody
         * asked for, sitting in tmux with a field from before, on the very
         * board it was opened to read — and, replayed through `sh -c` each
         * time, one `sh -c` deeper per restart ("sh -c sh -c claude …",
         * measured). Its own prompt is on its command line, and that is the
         * mark: a pane started with it is left out of the picture, and a
         * window or session with nothing else in it is left out with it.
         */
        if (startCommand.includes(LANTERN_PROMPT_MARK)) continue;
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
        /*
         * A CORPSE IS PHOTOGRAPHED AS THE CONVERSATION IT HELD, OR AS A SHELL.
         *
         * The engine keeps a pane whose command failed (tmuxconf.ts), and tmux
         * still reports the command it was born with. Replaying that at the
         * next boot would run the failure again and hand back another corpse.
         * But a Claude that crashed mid-conversation had a conversation, and
         * a shell in its place after a reboot loses it. There is no process to
         * ask any more, so the answer comes from what was known while it
         * lived: the last photograph of this very pane, on this same server
         * (ids are only ever one server's), which has the id and the flags;
         * or, for a pane that died before a sweep ever saw it, the hook's
         * note — only for a pane BORN as the Claude CLI, and only a note from
         * this server since it started (`noteIsThisAgents`, with the server's
         * start for the process's). A pane born as a wrapper that Claude
         * once ran inside is that wrapper's corpse, and so is a pane last
         * photographed running something else: both come back as a shell;
         * so does a Claude that lived less than a sweep in a pane born as
         * something else, which is the ceiling.
         */
        if (p.dead) {
          /* By id, and by window name as well: while a desk is not whole,
             windows are carried with the ids of the server that died, and
             this one hands the same ids out again. The directory too, when
             tmux still says one — for a dead pane it says "" (measured), so
             the photograph's is the only one left, and the pane is given it
             back rather than restored wherever the server was started. */
          const was = previous?.sessions.find((s) => s.name === name)?.windows
            .find((x) => x.id === w.id && (x.name ?? "") === (w.name ?? ""))?.panes
            .find((x) => x.id === p.id && (!p.path || x.path === p.path));
          const bornClaude = startCommand.split(/[\s"']+/).some((t) => (t.split("/").pop() || "") === claudeName());
          const note = was || !bornClaude ? null : paneAgentNote(p.id);
          const noteFits = !!note && noteIsThisAgents(note, { cwd: p.path, startedAt }, server);
          const agentSession = was ? was.agentSession : noteFits ? note!.session_id : undefined;
          /* The flags of the last live photograph — which may have been
             taken before the command-line prompt's hook came in, when the
             prompt could not yet be told from a flag. It can now: the
             conversation's first prompt since this server started is the
             one a command line carries, so that is taken off. Only that one,
             and only exactly: a flag's value typed later as an answer stays
             a value. */
          const first = was?.agentArgs?.length && agentSession ? firstPromptSince(agentSession, startedAt - NOTE_SLACK_MS) : "";
          const agentArgs = was?.agentArgs ? agentArgsOf(["", ...was.agentArgs], (text) => !!first && text === first) : undefined;
          panes.push({ ...p, path: p.path || was?.path || "", startCommand: "", ...(agentSession ? { agentSession, ...(agentArgs?.length ? { agentArgs } : {}) } : {}) });
          continue;
        }
        /*
         * WHAT IS RUNNING NOW is the question, so ask what is running now.
         *
         * Not the pane's born-with command, which tmux reports as a string it
         * has already quoted for a shell — a window made from one string
         * comes back as `"exec claude --model …"`, quotes included, and
         * `sh -c` on that looks for a program called `exec claude --model …`
         * (measured: six windows back as shells). Not the note alone, which
         * outlives the agent: pane ids are reused, and two plain shells were
         * once photographed carrying conversation ids. The process tree under
         * the pane says what is there, which CLI it is, and with what flags.
         */
        const pid = p.pid ?? 0;
        /* No walk under a pane whose foreground is its shell: nothing is
           running in it, and a job a person backgrounded is not its agent. */
        const found = pid && !SHELLS.has(p.command) ? agentUnder(pid) : null;
        const under = found && isForeground(found, p.command) ? found : null;
        if (under && under.name === claudeName()) {
          /*
           * The id: the hook's note first, because it is the newer fact — a
           * `/clear` gives the pane a new conversation the argv knows nothing
           * about — but only a note this agent's own hooks wrote
           * (`noteIsThisAgents`): one from a previous life of the pane id is
           * not its. Then the argv's own `--resume`, which a restored pane
           * carries before any hook has fired.
           */
          const note = paneAgentNote(p.id);
          const noteFits = !!note && noteIsThisAgents(note, under, server);
          const resumed = resumeIdIn(under.argv);
          const agentSession = (noteFits ? note!.session_id : undefined) || resumed;
          /* The note's conversation only when the note is this agent's. */
          const agentArgs = agentArgsOf(under.argv, (text) => wasPromptFor(pid, text, [agentSession, resumed, noteFits ? note!.session_id : undefined], under.startedAt, newestPrompt));
          /* A conversation, or nothing: the born-with line is blanked so a
             pane whose id could not be found comes back as a shell rather
             than as its command line, prompt and all. */
          panes.push({ ...p, startCommand: "", agentSession, agentArgs: agentArgs.length ? agentArgs : undefined });
          continue;
        }
        /* Another CLI: itself, with its prompt taken off. Nothing else: the
           command the pane was born from, unless that is a login shell with
           nothing to run — which tmux gives a restored pane anyway. */
        const root = pid ? argvOf(pid).filter((a) => !/[\n\r\0]/.test(a)).slice(0, 64) : [];
        const startArgv = under ? withoutPromptFlags(under.name, under.argv)
          : bornYet(root) && !isBareShell(root) && !isKeepAlive(root) ? root : [];
        panes.push({ ...p, startCommand, ...(startArgv.length ? { startArgv } : {}) });
      }
      if (panes.length) out.push({ ...w, panes });
    }
    if (out.length) sessions.push({ name, windows: out });
  }
  const state = writeMerged(sessions, now, deskIsWhole(engine), engine, new Set(names));
  /* The pass photographs again when it is done (`captureWanted`). */
  if (putBack) { void restoreLayout(); captureWanted = true; }
  return state;
}

/**
 * The sessions on the engine, and which server that is.
 *
 * `#{pid}` and `#{start_time}` are the tmux server's own, the same on every
 * line; together they name a server for its life, and a different pair is a
 * server that died and was started again. That is what `deskIsWhole` asks.
 */
async function liveSessions(): Promise<{ names: string[]; engine: string; startedAt: number; server: string }> {
  const r = await tmux(["list-sessions", "-F", "#{session_name}\t#{pid}\t#{start_time}\t#{socket_path}"]);
  if (!r.ok) return { names: [], engine: "", startedAt: 0, server: "" }; // no server running yet is the common case, not an error
  const names: string[] = [];
  let engine = "";
  let startedAt = 0;
  let server = "";
  for (const line of r.stdout.split("\n")) {
    const [name = "", pid = "", started = "", socket = ""] = line.split("\t");
    if (!name.trim()) continue;
    names.push(name.trim());
    engine ||= `${pid.trim()}.${started.trim()}`;
    startedAt ||= Number(started.trim()) * 1000 || 0;
    /* The spelling the hook uses for the same server (`notePaneFromHook`). */
    server ||= socket.trim() && pid.trim() ? `${socket.trim()},${pid.trim()}` : "";
  }
  return { names, engine, startedAt, server };
}

/**
 * The same photograph, taken synchronously, for the moment the process is
 * leaving.
 *
 * `process.exit` does not wait for a promise, so the async capture in a signal
 * handler is a capture that mostly does not happen. This one blocks — a few
 * tmux calls — because a clean exit is the one moment the desk is certainly
 * whole, and that is worth a few milliseconds on the way out.
 *
 * It captures NAMES only, and merges. The window and pane detail of a session
 * that is already recorded is not worth the extra subprocesses here; a session
 * that is new since the last sweep would otherwise be lost entirely, and a
 * name is enough to bring it back as an empty session rather than not at all.
 */
export function captureLayoutSync(now = Date.now()): void {
  try {
    if (restoring || capturingHalted()) return;
    const bin = resolveTmuxBin();
    if (!bin) return;
    /* The server too, as `liveSessions` spells it: a photograph that does not
       say which server it was taken on leaves the next sweep without a
       previous one to read a dead pane from. */
    const r = Bun.spawnSync([bin, "-L", tmuxSocket(), "-f", confPath(), "list-sessions", "-F", "#{session_name}\t#{pid}\t#{start_time}"],
      { stdout: "pipe", stderr: "pipe", env: process.env });
    const rows = new TextDecoder().decode(r.stdout).split("\n").map((l) => l.split("\t"));
    const names = rows.map(([n = ""]) => n.trim()).filter((n) => n && validSessionName(n));
    const [, pid = "", started = ""] = rows[0] ?? [];
    const engine = pid.trim() && started.trim() ? `${pid.trim()}.${started.trim()}` : "";
    if (!names.length) return;
    const before = readRestoreState();
    const known = new Map((before?.sessions ?? []).map((s) => [s.name, s]));
    for (const name of names) {
      const had = known.get(name);
      known.set(name, had ? { ...had, lastSeen: now } : { name, windows: [], lastSeen: now });
    }
    mkdirSync(restoreDir(), { recursive: true });
    const tmp = `${layoutPath()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ capturedAt: now, sessions: [...known.values()], ...(engine ? { engine } : {}) }), { mode: 0o600 });
    swapInLayout(tmp);
  } catch { /* never block an exit on bookkeeping */ }
}

/** The last capture, without re-reading tmux. */
export function readRestoreState(): RestoreState | null {
  const read = (at: string): RestoreState | null => {
    try {
      if (!existsSync(at)) return null;
      const state = JSON.parse(readFileSync(at, "utf8")) as RestoreState;
      /* A file that parses but says nothing is the same loss as no file. */
      return Array.isArray(state?.sessions) && state.sessions.length ? state : null;
    } catch { return null; }
  };
  return read(layoutPath()) ?? read(previousLayoutPath());
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
 * "all" brings back what was running, in this order:
 *
 *   1. A CONVERSATION IS RESUMED, NEVER REPLAYED. A pane that held a Claude
 *      session comes back as `claude <its flags> --resume <id>`, whatever
 *      command line it was born from. The born-with line used to win here
 *      whenever there was one, and it carried the prompt: a session the
 *      orchestrator had opened with `claude … 'Read the brief and follow
 *      it'`, finished and closed, was rebuilt at the next restart and RAN THE
 *      BRIEF AGAIN — measured on 2026-09-21, tokens included. Worse, each
 *      restart wrapped the line in one more `sh -c`: eight deep by the time
 *      it was read. The id is the conversation; the flags are the desk; the
 *      prompt was said once.
 *   2. Any other program comes back as the argv it was running with
 *      (`startArgv`), passed to tmux as argv, so it is exact and never one
 *      level deeper. (tmux runs a ONE-word argv through the login shell —
 *      its own rule for a single argument — which for a bare program name
 *      is the same program.)
 *   3. A photograph from before `startArgv` existed still has the string tmux
 *      reported, and gets the old `sh -c` on it: right for a line tmux
 *      printed unquoted, a shell for one it quoted, and gone at the first
 *      sweep after boot.
 *
 * The id came from our own hook or from a running process's arguments, and
 * is still checked against a UUID before it can reach a command line.
 */
export function runArgs(mode: "lazy" | "all", pane: CapturedPane | undefined, bin: string | null = claudeCode.bin()): string[] {
  if (mode !== "all" || !pane) return [];
  /* A photograph from before the capture learned to leave the Lantern out:
     its chat comes back as a shell, never as the chat. */
  if (pane.startCommand.includes(LANTERN_PROMPT_MARK)) return [];
  const id = pane.agentSession;
  if (id && SESSION_ID_RE.test(id)) {
    /* A conversation with no CLI on this machine to resume it is a shell,
       not a replay of whatever line started it. */
    if (!bin) return [];
    /* The flags first, then the id: the id is the one part of this line this
       file built itself, and it goes last so nothing captured can displace it. */
    return [bin, ...(pane.agentArgs ?? []), "--resume", id];
  }
  if (pane.startArgv?.length) return [...pane.startArgv];
  if (pane.startCommand) return ["sh", "-c", pane.startCommand];
  return [];
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
/*
 * THE CRASH-LOOP GUARD.
 *
 * Six launches in twenty-three minutes is not a machine doing its job, and
 * every one of them ran the restore-then-capture cycle against a desk that was
 * never allowed to finish coming back. The merge means those cycles can no
 * longer destroy anything — but running them is still pointless and still
 * churns tmux, and a person deserves to be told rather than left to work it
 * out from what is missing.
 *
 * Six in twenty minutes was the real number. The threshold is four in ten:
 * comfortably above a person restarting the app twice to try something, and
 * comfortably below what a loop does.
 */
const LOOP_LAUNCHES = 4;
const LOOP_WINDOW_MS = 10 * 60 * 1000;

function launchesPath(): string { return join(restoreDir(), "launches.json"); }

/** Record this launch and say whether the app is in a crash-loop. Written
 *  atomically like everything else here: this file deciding whether to restore
 *  makes it worth as much as the layout. */
export function noteLaunch(now = Date.now()): { looping: boolean; recent: number } {
  let past: number[] = [];
  try {
    if (existsSync(launchesPath())) {
      const raw = JSON.parse(readFileSync(launchesPath(), "utf8")) as unknown;
      if (Array.isArray(raw)) past = raw.filter((n): n is number => typeof n === "number");
    }
  } catch { past = []; }
  const recent = [...past, now].filter((t) => now - t < LOOP_WINDOW_MS).slice(-20);
  try {
    mkdirSync(restoreDir(), { recursive: true });
    const tmp = `${launchesPath()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(recent));
    renameSync(tmp, launchesPath());
  } catch { /* the guard is advisory; never block a boot on it */ }
  return { looping: recent.length >= LOOP_LAUNCHES, recent: recent.length };
}

/** Set when a boot declined to restore because it looked like a crash loop.
 *  Read by the settings panel, so the reason is visible rather than being
 *  something a person works out from what is missing. */
let crashLoop: { at: number; launches: number } | null = null;
export function noteCrashLoop(launches: number): void {
  crashLoop = { at: Date.now(), launches };
}

/*
 * AND THE FILE IS ACTUALLY LEFT ALONE.
 *
 * The boot that declines to restore prints "Not restoring or re-capturing:
 * the saved session layout is left untouched" — and then started the ten
 * second sweeper anyway, which photographed the crash-loop desk and wrote it
 * over the good one. The half of the promise that mattered was the half the
 * code did not keep: a crash loop is precisely when the live desk is least
 * like the desk somebody wants back.
 */
const capturingHalted = (): boolean => crashLoop !== null;
export function crashLoopWarning(): { at: number; launches: number } | null { return crashLoop; }
/** For tests: this flag halts every capture in the process, so a suite that
 *  sets it has to put it back. */
export function __clearCrashLoop(): void { crashLoop = null; }

let restoring = false;
let captureWanted = false;
/*
 * WHETHER THIS PROCESS HAS HAD ITS GO AT PUTTING THE DESK BACK — ON THIS
 * ENGINE.
 *
 * Until it has, a photograph is not evidence that a window or a session is
 * gone — see `writeMerged`. After it has, the desk is whatever a person has
 * made of it and the camera is believed.
 *
 * Per engine, because the ids and the desk are one tmux server's: the value
 * is the server (`liveSessions().engine`) the desk was put back on, read at
 * the end of the pass. "" when no server was running then — the pass had
 * nothing to build, and whatever server starts next begins from this
 * process's desk, so the first one a capture sees is adopted. A DIFFERENT
 * server later — the last session closed and tmux exited, the conf was
 * reset, tmux crashed — is a desk this process has not had its go at, and
 * `captureLayout` runs one restore pass on it (`putBackOn`). Bound to the
 * first server alone, the desk was never whole again after either case, and
 * a tab closed after that was kept and rebuilt at the next boot (measured).
 *
 * Keyed by socket and state directory as well: every test file shares one
 * process, and a desk put back on one file's socket is not another's.
 */
const settledOn = new Map<string, string>();
const deskKey = (): string => `${tmuxSocket()}\u0000${restoreDir()}`;
/** Engines a pass has already been asked for, so a pass that fails is not
 *  asked for again every sweep. */
const putBackOn = new Set<string>();
/** A new server seen by one sweep, waiting for a second. */
let seenNew = "";
export function __resetRestoreSettled(): void { settledOn.delete(deskKey()); }
/** Whether the desk on THIS engine is the one this process put back. */
function deskIsWhole(engine: string): boolean {
  const on = settledOn.get(deskKey());
  return on !== undefined && !!engine && on === engine;
}

/** Whether a restore pass is in flight — a capture during one would be a
 *  photograph of a half-built desk. */
export function isRestoring(): boolean { return restoring; }

/*
 * ONE PASS AT A TIME. The boot, the Settings button and a new server
 * (`captureLayout`) can each ask for one; two at once would each see the
 * other's half-built sessions as missing windows and build them twice.
 */
let passInFlight: Promise<unknown> | null = null;
export async function restoreLayout(mode: "lazy" | "all" = tmuxResume()): Promise<{ ok: boolean; restored: number; error?: string }> {
  while (passInFlight) await passInFlight.catch(() => undefined);
  const pass = restoreOnce(mode);
  passInFlight = pass;
  try { return await pass; } finally { if (passInFlight === pass) passInFlight = null; }
}

async function restoreOnce(mode: "lazy" | "all"): Promise<{ ok: boolean; restored: number; error?: string }> {
  restoring = true;
  try {
    const r = await restorePass(mode);
    /*
     * SETTLED ONLY WHEN THE PASS ACTUALLY FINISHED, and that is why this line
     * is not in the `finally` below.
     *
     * `settled` is what stops a photograph from shrinking a session's window
     * list. Setting it in the `finally` set it after a pass that THREW —
     * halfway through rebuilding the desk, with the file still holding the six
     * windows and the desk holding two. The next sweep, ten seconds later, was
     * then believed, and the record shrank to what the broken pass had managed.
     * A restore that blew up is the one moment the record is most worth
     * keeping and it was the moment it was least protected.
     *
     * Left false, the only cost is a stale entry that a later restore skips
     * harmlessly — the trade this whole file already makes, in the direction
     * it already chose.
     */
    settledOn.set(deskKey(), (await liveSessions()).engine);
    return r;
  } catch (e: any) {
    /* And it comes back as an answer rather than an unhandled rejection: the
       boot calls this as `void restoreLayout().then(() => captureLayout())`,
       so a throw here used to skip that capture and print a rejection nobody
       reads. */
    return { ok: false, restored: 0, error: failed("tmux/restore", e, "the layout could not be restored — the server log has why") };
  } finally {
    restoring = false;
    /* Whatever asked for a capture while this was running gets one now,
       against a desk that is whole. */
    if (captureWanted) { captureWanted = false; void captureLayout(); }
  }
}

async function restorePass(mode: "lazy" | "all"): Promise<{ ok: boolean; restored: number; error?: string }> {
  const state = readRestoreState();
  if (!state || !state.sessions.length) return { ok: false, restored: 0, error: "nothing captured yet — no restore state" };
  /* Everything this pass built, so the sweep below can ask what survived. */
  const made: Made[] = [];
  const { engine } = await liveSessions();
  for (const s of state.sessions) {
    /*
     * A mirror in the file is a mirror this build must not rebuild.
     *
     * The capture side stopped writing them, and this is the other half: every
     * file written before that fix still names nine, and a capture-only fix
     * would keep restoring from those. Measured — killing the nine did nothing,
     * because the next install brought all nine back by name within seconds.
     */
    if (isEphemeralSession(s.name)) continue;
    if (!validSessionName(s.name)) continue;
    const have = await tmux(["has-session", "-t", `=${s.name}`]);
    if (have.ok) {
      /*
       * THE SESSION IS BACK AND STILL MISSING MOST OF ITSELF.
       *
       * "Already back" was read as "nothing to do", and that is the shape the
       * damage arrived in: the tmux server died, the engine made the session
       * again — empty, one window — and this loop then skipped it, because a
       * session by that name existed. Six windows of somebody's real work were
       * never asked for. `has-session` answers a question nobody was asking.
       *
       * So the missing windows are built, matched by name and by the working
       * directory of their first pane. Nothing is torn down and nothing is
       * reordered: a window that is there is left exactly as it is.
       */
      /*
       * ONLY WHILE THE DESK IS STILL COMING BACK.
       *
       * A live session in steady state is the owner's working desk, and this
       * file's oldest promise is that a restore only ever builds what is
       * missing from a desk nobody has yet — never adds a window to one
       * somebody is sitting at. `settled` is that line: false until this
       * process has finished its first pass, true forever after, so the repair
       * happens at boot and the promise holds every other minute of the day.
       */
      if (deskIsWhole(engine)) continue;
      const live = await windowTree(s.name).catch(() => [] as TmuxWindowDetail[]);
      const key = (n: string | undefined, path: string | undefined) => `${n ?? ""}\u0000${path ?? ""}`;
      const here = new Set(live.map((w) => key(w.name, w.panes[0]?.path)));
      /* Only when the desk is genuinely short of what was recorded. A session
         a person has since rearranged is not a session to rebuild. */
      for (const w of s.windows) {
        if (here.has(key(w.name, w.panes[0]?.path))) continue;
        const nw = await tmux(["new-window", "-d", "-P", "-F", "#{window_id}", "-t", `=${s.name}:`,
          ...(w.name ? ["-n", w.name] : []), "-c", w.panes[0]?.path || ".", ...runArgs(mode, w.panes[0])]);
        const wid = printed(nw);
        made.push({ session: s.name, window: w, id: wid });
        if (!wid) continue;
        await restorePanes(s.name, wid, w.panes.slice(1), mode);
      }
      continue;
    }
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
    /*
     * RECORDED EVEN WHEN IT COULD NOT BE MADE, and that is the case this
     * whole sweep exists for. A first window whose command exits takes the
     * session with it, and tmux — left with no sessions at all — exits too.
     * Every `new-window` after that answers "no server running" and returns
     * nothing. An empty id here means "asked for, never got it", which the
     * sweep below builds from scratch; skipping it is how four tabs went
     * missing with the count still reading five.
     */
    const firstWin = printed(mk);
    made.push({ session: s.name, window: first, id: firstWin });
    if (firstWin) {
      const firstPane = printed(await tmux(["display-message", "-p", "-t", `=${s.name}:${firstWin}`, "#{pane_id}"]));
      await restorePanes(s.name, firstWin, first.panes.slice(1), mode);
    }

    for (const w of s.windows.slice(1)) {
      const nw = await tmux(["new-window", "-d", "-P", "-F", "#{window_id}", "-t", `=${s.name}:`,
        ...(w.name ? ["-n", w.name] : []), "-c", w.panes[0]?.path || ".", ...runArgs(mode, w.panes[0])]);
      const wid = printed(nw);
      made.push({ session: s.name, window: w, id: wid });
      if (!wid) continue;
      const pid = printed(await tmux(["display-message", "-p", "-t", `=${s.name}:${wid}`, "#{pane_id}"]));
      await restorePanes(s.name, wid, w.panes.slice(1), mode);
    }
  }
  const restored = await keepTheDesk(made, mode);
  return { ok: true, restored };
}

type Made = { session: string; window: CapturedWindow; id: string };

/** The shell the engine gives a new pane — `default-shell`, which tmux takes
 *  from $SHELL at start. Asked once per process; `/bin/sh` if it will not say. */
let shellCache: string | null = null;
async function engineShell(): Promise<string> {
  if (shellCache) return shellCache;
  const r = await tmux(["show-options", "-gv", "default-shell"]);
  shellCache = r.ok && r.stdout.trim().startsWith("/") ? r.stdout.trim() : "/bin/sh";
  return shellCache;
}

/**
 * How long to wait before asking whether what was built is still standing.
 *
 * A window is created WITH its command inside it. tmux closes a window whose
 * command ended cleanly, and the engine keeps one whose command failed as a
 * dead pane (tmuxconf.ts) — either way it is not the pane that was asked for.
 *
 * So the failure is: `claude --resume <id>` cannot start — the conversation is
 * already open in another pane, the id is unknown to the CLI, the binary moved
 * — it exits, and the window goes with it. Measured on this user's machine
 * after a reboot: a session of five windows came back with one, the four whose
 * resume failed vanished in the same second they were made, and the count said
 * five. He rebuilt his desk by hand.
 *
 * Checking immediately proves nothing: `new-window` returns as soon as tmux has
 * forked, and a CLI that fails takes a few hundred milliseconds to say so. One
 * wait for the whole pass, not one per window, so a desk of ten windows pays it
 * once. A command that dies later than this still slips through, and that is
 * stated rather than pretended away — the sweeper that runs afterwards is what
 * covers the slow ones.
 */
const SETTLE_MS = Number(process.env.AGENTGLASS_RESTORE_SETTLE_MS || 2000);

/**
 * What survived, and a plain shell in the place of what did not.
 *
 * THE DESK IS THE THING WORTH SAVING. A pane that comes back as a shell in the
 * right directory has lost a conversation, which `claude --resume` can get back
 * in one line; a window that is not there has lost the tab, its name, its
 * splits and its place in the row, which is the expensive half and the half a
 * person notices. So a command that would not start must never cost the window
 * that was holding it.
 */
async function keepTheDesk(made: Made[], mode: "lazy" | "all"): Promise<number> {
  if (!made.length) return 0;
  /* In lazy mode nothing was started, so nothing can have exited — but a
     window can still be missing because the call to make it failed, and the
     sweep is what notices. Only the wait is skipped. */
  if (mode === "all") await new Promise((r) => setTimeout(r, SETTLE_MS));
  let standing = 0;
  for (const m of made) {
    const live = await tmux(["list-windows", "-t", `=${m.session}`, "-F", "#{window_id}"]);
    /* `filter(Boolean)`, and it is not tidiness: `list-windows` output ends in
       a newline, so the split leaves an empty string in the list — and an
       empty string is exactly the id of a window that was never made. Without
       it, `ids.includes("")` answers "that one is already up" for every window
       this pass could not create, which is the whole set this sweep exists
       for. Measured: three windows asked for, one built, `restored: 3`. */
    const ids = live.ok ? live.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
    const cwd = m.window.panes[0]?.path || ".";

    let id = m.id;
    if (!id || !ids.includes(id)) {
      /* The window is gone. If the session went with it — it does, when the
         window was its only one — the session has to come back first, and its
         name is free again because tmux removed it. */
      const alive = await tmux(["has-session", "-t", `=${m.session}`]);
      const back = alive.ok
        ? printed(await tmux(["new-window", "-d", "-P", "-F", "#{window_id}", "-t", `=${m.session}:`,
            ...(m.window.name ? ["-n", m.window.name] : []), "-c", cwd]))
        : printed(await tmux(["new-session", "-d", "-P", "-F", "#{window_id}", "-s", m.session,
            ...(m.window.name ? ["-n", m.window.name] : []), "-c", cwd]));
      if (!back) continue;
      id = back;
    }
    standing++;

    /*
     * And the splits, counted rather than assumed.
     *
     * A window can survive while a pane inside it does not — the split's own
     * command exited and tmux closed that pane alone. Nothing recorded those
     * ids, and nothing needs to: the capture says how many panes the window
     * had, so the shortfall is what has to come back. As shells, in the right
     * directory, which is `lazy`.
     */
    const want = m.window.panes.length;
    const now = await tmux(["list-panes", "-t", `=${m.session}:${id}`, "-F", "#{pane_id}\t#{pane_dead}"]);
    const rows = now.ok ? now.stdout.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => l.split("\t")) : [];
    /*
     * AND A PANE WHOSE COMMAND DIED IS GIVEN A SHELL.
     *
     * The engine keeps a pane whose command failed (`remain-on-exit failed`,
     * tmuxconf.ts), which is what saves a person's tab when a CLI crashes at
     * three in the afternoon. At boot it is the wrong thing to keep: a
     * `claude --resume` that would not start leaves "Pane is dead (status 1)"
     * where the desk promised a place to type. `respawn-pane -k` with the
     * engine's own shell turns the corpse back into that place, in the same
     * directory, with the window, its name and its position untouched.
     */
    for (const [paneId = "", dead = ""] of rows) {
      if (dead !== "1") continue;
      const at = m.window.panes[rows.findIndex((r) => r[0] === paneId)]?.path || cwd;
      /* Two arguments, so tmux execs the shell itself rather than wrapping
         one word in `default-shell -c`: a login shell, and not `fish -c fish`
         photographed as a command for ever. And the pane goes back to closing
         on exit, the way a plain tab does: it was born with a command, so the
         hook for shells (tmuxconf.ts) would not cover it. */
      await tmux(["respawn-pane", "-k", "-t", paneId, "-c", at, await engineShell(), "-l"]);
      await tmux(["set-option", "-p", "-t", paneId, "remain-on-exit", "off"]);
    }
    const have = rows.length;
    if (have < want) await restorePanes(m.session, id, m.window.panes.slice(have), "lazy");
    await applyLayout(m.session, id, m.window.layout, want);
  }
  return standing;
}

/*
 * THE GEOMETRY, LAST.
 *
 * The photograph had the windows and their panes and not how they were
 * split: `restorePanes` always splits top-to-bottom, so a window cut
 * left-to-right came back cut the other way (measured on a two-pane window
 * that was side by side). tmux describes a window's geometry in one string
 * (`#{window_layout}`, "4b44,268x66,0,0{132x66,0,0,11,135x66,133,0,16}") and
 * takes it back through `select-layout` — exactly, not as a sequence of
 * approximate splits.
 *
 * Only when the pane count matches: the string carries a count and a
 * checksum, and with fewer panes than it describes tmux refuses or leaves
 * the window odd. After the sweep, not before it: a pane that came back as
 * a shell is still a pane, and the geometry still holds. The old ids inside
 * the string belong to the server that died; tmux ignores them and assigns
 * by position, which is what a restore wants.
 */
export async function applyLayout(session: string, windowId: string, layout: string | undefined, want: number): Promise<boolean> {
  if (!layout || !LAYOUT_RE.test(layout) || want < 2) return false;
  const now = await tmux(["list-panes", "-t", `=${session}:${windowId}`, "-F", "#{pane_id}"]);
  const have = now.ok ? now.stdout.split("\n").filter((l) => l.trim()).length : 0;
  if (have !== want) return false;
  return (await tmux(["select-layout", "-t", `=${session}:${windowId}`, layout])).ok;
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
  /*
   * TEN SECONDS, not sixty.
   *
   * With the merge in place a late capture can no longer LOSE anything — the
   * worst it can do is not yet know about a session made in the last few
   * seconds. Sixty seconds of that was the window a reboot fell into; ten is
   * short enough that a session has to be seconds old to be missed, and a full
   * sweep is a handful of tmux calls against a socket that is already there.
   *
   * `captureNow()` below closes even that gap for the paths that know they
   * changed something.
   */
  captureTimer = setInterval(() => { if (enabled()) void captureLayout(); }, 10_000);
  (captureTimer as unknown as { unref?: () => void }).unref?.();
}
/**
 * Write the layout down now, because something just changed.
 *
 * For the paths that create, rename or close a session and therefore know
 * without asking. Coalesced: several changes in the same tick produce one
 * write, which matters when a project opens with four panes at once.
 *
 * Failure is deliberately silent. This is bookkeeping on top of a tmux daemon
 * that is already durable; it must never be able to fail a real operation.
 */
let coalescing: ReturnType<typeof setTimeout> | null = null;
export function captureNow(): void {
  if (coalescing) return;
  coalescing = setTimeout(() => {
    coalescing = null;
    void captureLayout().catch(() => { /* the sweeper will have another go */ });
  }, 150);
  (coalescing as unknown as { unref?: () => void }).unref?.();
}

/* The pane layer records a brand-new session the moment it is created, without
   importing this file: it holds a slot, and this is where we fill it. */
setCaptureHook(captureNow);

export function stopRestoreSweeper(): void {
  if (captureTimer) clearInterval(captureTimer);
  captureTimer = null;
}

/** Test seam: forget everything without touching any real tmux. */
export function __resetRestoreState(): void {
  stopRestoreSweeper();
  try { clearRestoreState(); } catch { /* gone */ }
}

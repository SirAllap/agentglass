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
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmuxStateDir } from "./tmuxbin.ts";
import { tmux, listPanes, validSessionName, tmuxSocket, setCaptureHook } from "./tmuxpane.ts";
import { confPath } from "./tmuxconf.ts";
import { resolveTmuxBin } from "./tmuxbin.ts";
import { paneAgentNote } from "./panewt.ts";
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
   *  on its command line except the binary and the id. See `agentArgsOf`. */
  agentArgs?: string[];
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
}

/*
 * WHY THIS FILE ONLY EVER GROWS.
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
 * that it should be forgotten. It might be gone; it might be mid-restore; the
 * app might be in the middle of dying. Only an explicit close removes an
 * entry — `forgetSession`, and nothing else.
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
export function agentArgsOf(argv: string[]): string[] {
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
};

/** Direct children of a pid, or an empty list. */
export function childPidsOf(pid: number, proc: ProcReader = machineProc): number[] {
  // `pgrep -P` is in BSD pgrep and procps alike, but the Linux branch keeps
  // the `ps` it was measured with rather than trading a known answer for a
  // portable one.
  const out = proc.platform === "linux"
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

/** Among a shell's children, the one running the agent CLI: its argv, or []. */
export function agentArgvAmong(children: number[], bin: string, proc: ProcReader = machineProc): string[] {
  for (const child of children) {
    const argv = argvOf(child, proc);
    const head = (argv[0] || "").split("/").pop();
    if (head === bin) return argv;
  }
  return [];
}

/** The agent under a pane: its argv, or an empty list. */
async function agentArgvOf(name: string, windowId: string, paneId: string): Promise<string[]> {
  const r = await tmux(["display-message", "-t", `=${name}:${windowId}.${paneId}`, "-p", "#{pane_pid}"]);
  const pid = Number(r.stdout.trim());
  if (!r.ok || !Number.isInteger(pid) || pid <= 1) return [];
  try {
    const bin = (claudeCode.bin() || "claude").split("/").pop() || "claude";
    return agentArgvAmong(childPidsOf(pid), bin);
  } catch { /* the process went away between asking and looking */ }
  return [];
}

/**
 * The `--resume <uuid>` under a shell, when one of its children carries it.
 *
 * The pane's process is a shell; the agent is its child. On Linux `ps` walks
 * that for us in one call — `-o args= --ppid` prints every child's command
 * line — rather than us reading /proc by hand for every pane on the desk. BSD
 * `ps` has no `--ppid`, so a Mac asks for the children first and then each
 * one's argv; the regex over the result is the same one.
 */
export function resumeIdUnder(pid: number, proc: ProcReader = machineProc): string | undefined {
  const lines = proc.platform === "linux"
    ? proc.run(["ps", "-o", "args=", "--ppid", String(pid)])
    : childPidsOf(pid, proc).map((c) => argvOf(c, proc).join(" ")).join("\n");
  const m = /--resume[= ]\s*([0-9a-fA-F-]{36})/.exec(lines);
  return m?.[1] && SESSION_ID_RE.test(m[1]) ? m[1] : undefined;
}

async function resumeIdOf(name: string, windowId: string, paneId: string): Promise<string | undefined> {
  const r = await tmux(["display-message", "-t", `=${name}:${windowId}.${paneId}`, "-p", "#{pane_pid}"]);
  const pid = Number(r.stdout.trim());
  if (!r.ok || !Number.isInteger(pid) || pid <= 1) return undefined;
  try { return resumeIdUnder(pid); } catch { return undefined; }
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
function writeMerged(fresh: CapturedSession[], now: number): RestoreState {
  const seenNow = new Map(fresh.map((s) => [s.name, s]));
  const before = readRestoreState();
  const kept: CapturedSession[] = [];
  for (const old of before?.sessions ?? []) {
    if (seenNow.has(old.name)) continue;      // the fresh one wins
    if (forgotten.has(old.name)) continue;    // explicitly closed
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
  const sessions = [...fresh.map((s) => ({ ...s, lastSeen: now })), ...kept];
  const state: RestoreState = { capturedAt: now, sessions };
  mkdirSync(restoreDir(), { recursive: true });
  const tmp = `${layoutPath()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, layoutPath());
  return state;
}

/** Sessions a person explicitly closed. The ONE way an entry leaves the file:
 *  everything else only ever adds. */
const forgotten = new Set<string>();

/**
 * Forget a session because somebody closed it — not because it stopped
 * answering.
 *
 * This is the only subtraction in the whole file, and it is deliberate that it
 * takes an explicit call rather than being inferred: "it is not in the live
 * list" was exactly the inference that lost a day of work.
 */
export function forgetSession(name: string): void {
  forgotten.add(name);
  const before = readRestoreState();
  if (!before) return;
  const sessions = before.sessions.filter((s) => s.name !== name);
  if (sessions.length === before.sessions.length) return;
  mkdirSync(restoreDir(), { recursive: true });
  const tmp = `${layoutPath()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...before, sessions }));
  renameSync(tmp, layoutPath());
}

/** Capture every session on the engine's socket into the state dir. Safe to
 *  call on a timer and safe to call twice — both are the same overwrite. */
export async function captureLayout(now = Date.now()): Promise<RestoreState | null> {
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
  const names = await listPanes();
  /*
   * An empty socket is not "no sessions" — it is far more often tmux not
   * answering yet, or the app racing its own engine at boot. Writing an empty
   * merge would be harmless now that nothing shrinks, but reading nothing and
   * concluding nothing is the habit that caused this, so it stops here too.
   */
  if (!names.length) return null;
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
        const agentSession = looksLikeAgent(p.command)
          ? (paneAgentNote(p.id)?.session_id || await resumeIdOf(name, w.id, p.id))
          : undefined;
        /* Only for a pane that is running one, same as the id: a shell has no
           flags to keep, and a stale note must not put flags on a plain
           prompt. */
        const agentArgs = looksLikeAgent(p.command)
          ? agentArgsOf(await agentArgvOf(name, w.id, p.id))
          : undefined;
        panes.push({ ...p, startCommand, agentSession, agentArgs: agentArgs?.length ? agentArgs : undefined });
      }
      if (panes.length) out.push({ ...w, panes });
    }
    if (out.length) sessions.push({ name, windows: out });
  }
  return writeMerged(sessions, now);
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
    if (restoring) return;
    const bin = resolveTmuxBin();
    if (!bin) return;
    const r = Bun.spawnSync([bin, "-L", tmuxSocket(), "-f", confPath(), "list-sessions", "-F", "#{session_name}"],
      { stdout: "pipe", stderr: "pipe", env: process.env });
    const names = new TextDecoder().decode(r.stdout).split("\n").map((n) => n.trim())
      .filter((n) => n && validSessionName(n));
    if (!names.length) return;
    const before = readRestoreState();
    const known = new Map((before?.sessions ?? []).map((s) => [s.name, s]));
    for (const name of names) {
      const had = known.get(name);
      known.set(name, had ? { ...had, lastSeen: now } : { name, windows: [], lastSeen: now });
    }
    mkdirSync(restoreDir(), { recursive: true });
    const tmp = `${layoutPath()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ capturedAt: now, sessions: [...known.values()] }));
    renameSync(tmp, layoutPath());
  } catch { /* never block an exit on bookkeeping */ }
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
export function runArgs(mode: "lazy" | "all", pane: CapturedPane | undefined): string[] {
  if (mode !== "all" || !pane) return [];
  /* A photograph from before the capture learned to leave the Lantern out:
     its chat comes back as a shell, never as the chat. */
  if (pane.startCommand.includes(LANTERN_PROMPT_MARK)) return [];
  if (pane.startCommand) return ["sh", "-c", pane.startCommand];
  const id = pane.agentSession;
  if (!id || !SESSION_ID_RE.test(id)) return [];
  const bin = claudeCode.bin();
  if (!bin) return [];
  /* The flags first, then the id: the id is the one part of this line this
     file built itself, and it goes last so nothing captured can displace it. */
  return [bin, ...(pane.agentArgs ?? []), "--resume", id];
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
export function crashLoopWarning(): { at: number; launches: number } | null { return crashLoop; }

let restoring = false;
let captureWanted = false;

/** Whether a restore pass is in flight — a capture during one would be a
 *  photograph of a half-built desk. */
export function isRestoring(): boolean { return restoring; }

export async function restoreLayout(mode: "lazy" | "all" = tmuxResume()): Promise<{ ok: boolean; restored: number; error?: string }> {
  restoring = true;
  try {
    return await restorePass(mode);
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

/**
 * How long to wait before asking whether what was built is still standing.
 *
 * A window is created WITH its command inside it, and tmux closes a window
 * whose command has exited — nothing here sets `remain-on-exit`, and it must
 * not: the understudy depends on a finished run's window closing itself.
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
    const now = await tmux(["list-panes", "-t", `=${m.session}:${id}`, "-F", "#{pane_id}"]);
    const have = now.ok ? now.stdout.split("\n").filter((l) => l.trim()).length : 0;
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

/*
 * One headless turn of a worker: the argv per engine, and the wrapper that
 * leaves the turn's answer on disk.
 *
 * A worker is a one-shot in a tmux window (not a TUI): it has an exit code, so
 * "done", "failed" and "died" are facts and not a guess from a screen. The
 * argv builders are the chat panels' own where one exists (`codexArgs`,
 * `hermesArgs`, `antigravityArgs`); Claude Code's and OpenCode's are here,
 * because the chat's Claude turn carries chat-only flags.
 *
 * A headless worker cannot be steered inside a turn, only stopped; a follow-up
 * is a new turn that resumes the engine's session.
 *
 * OpenCode's turn is JSON, and a pane of JSON says nothing to the person
 * watching it: the wrapper tees it into `out` and pipes the tab through
 * `opencodeview.py`, which reads the events as lines. The tee comes first, so
 * the raw stream is on disk whether or not the reading worked. Only OpenCode
 * is read this way; the other engines' frames still go to the tab as written.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentProvider } from "../../../shared/agentKinds.ts";
import type { Envelope, Policy } from "../../../shared/orchestration.ts";
import type { WorkerRole } from "../../../shared/workerRoles.ts";
import { antigravityArgs } from "../antigravity.ts";
import { codexArgs } from "../codex.ts";
import { hermesArgs } from "../hermes.ts";
import { redact } from "../agentprobe.ts";
import { recordOpenCodeTurn } from "../opencodeusage.ts";
import { compileEnvelope } from "./envelope.ts";
import viewScript from "./opencodeview.py" with { type: "file" };

export interface TurnSpec {
  engine: string;
  bin: string;
  model: string;
  role: WorkerRole;
  envelope: Envelope;
  limits: Policy["limits"];
  prompt: string;
  /** The engine's own session id, to continue it. */
  resume?: string;
}

export type Turn =
  | { ok: true; argv: string[]; env: Record<string, string>; stdin: "none" | "prompt"; sessionId?: string; partly?: string }
  | { ok: false; error: string };

/** Whether this engine can run a worker headless at all, and if not, why. */
export function headlessRefusal(engine: string): string | null {
  const p = agentProvider(engine);
  if (!p) return `${engine} is not an engine this app knows`;
  if (!p.headless) return `${p.title} has no headless form this app knows, so it cannot run as a worker yet`;
  if (!p.envelope) return `what ${p.title} will refuse has not been measured, so it is not offered as a worker yet`;
  return null;
}

export function headlessTurn(t: TurnSpec): Turn {
  const refused = headlessRefusal(t.engine);
  if (refused) return { ok: false, error: refused };
  const title = agentProvider(t.engine)!.title;
  const c = compileEnvelope(t.engine, t.role, t.envelope, t.model);
  if (!c.ok) return c;
  const sandbox = t.role.readOnly || t.envelope.write === "none" ? "read-only" : "workspace-write";
  const done = (argv: string[], stdin: "none" | "prompt", extra: { sessionId?: string } = {}): Turn =>
    ({ ok: true, argv, env: c.env, stdin, partly: c.partly, ...extra });

  switch (t.engine) {
    case "claude": {
      // The prompt arrives on stdin: a prompt that starts with `-` is then
      // never a flag. Scouts plan, the others edit inside the lock.
      const sessionId = t.resume ?? randomUUID();
      return done([
        t.bin, "-p", "--output-format", "stream-json", "--verbose", ...c.args,
        "--permission-mode", t.role.id === "scout" ? "plan" : "acceptEdits", "--permission-prompts", "none",
        ...(t.resume ? ["--resume", t.resume] : ["--session-id", sessionId]),
      ], "prompt", { sessionId });
    }
    case "opencode": {
      if (!t.model.includes("/")) return { ok: false, error: `OpenCode takes a model as provider/model (opencode/big-pickle), and "${t.model || "(none)"}" is not one` };
      return done([t.bin, "run", "--format", "json", ...c.args, ...(t.resume ? ["-s", t.resume] : []), "--", t.prompt], "none");
    }
    case "codex": {
      if (!t.model) return { ok: false, error: "Codex has to be given a model in the policy" };
      // `codexArgs` ends with `-`: the prompt is read from stdin.
      return done(codexArgs(t.bin, t.model, sandbox, t.resume ?? ""), "prompt");
    }
    case "hermes": {
      // `hermesArgs` never uses `--yolo` here, and `--run-budget` is the turn ceiling.
      return done([...hermesArgs(t.bin, t.model, t.resume ?? "", "default", t.prompt), "--run-budget", String(t.limits.turnMinutes * 60)], "none");
    }
    case "antigravity":
      return done(antigravityArgs(t.bin, t.model, sandbox === "read-only" ? "plan" : "accept-edits", t.resume ?? "", t.prompt), "none");
    default:
      return { ok: false, error: `${title} has no headless form this app knows, so it cannot run as a worker yet` };
  }
}

// ── the wrapper, and what it leaves behind ───────────────────────────────

/** The files one turn leaves: its prompt, what it printed, what it complained
 *  about, and how it ended. One folder per worker name; a new turn clears it.
 *  `view` is the reader the pane pipes through, written beside the turn so a
 *  compiled server never has to hand a spawnable process a /$bunfs path. */
export interface RunFiles { dir: string; input: string; prompt: string; out: string; err: string; rc: string; view: string }

export function runFiles(name: string, root = runsDir()): RunFiles {
  const dir = join(root, name);
  return { dir, input: join(dir, "in"), prompt: join(dir, "prompt"), out: join(dir, "out"), err: join(dir, "err"), rc: join(dir, "rc"), view: join(dir, "view.py") };
}

function runsDir(): string {
  const state = process.env.AGENTGLASS_STATE_DIR
    || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agentglass");
  return join(state, "worker-runs");
}

/**
 * Prepare the folder (owner-only: a prompt can hold anything) and the stdin.
 *
 * A folder that is already there is EMPTIED, never removed and made again.
 * The end of a turn is a watch on this folder (ceilings.ts), and a watch put
 * on a path that was deleted and recreated gets no events at all (measured: 0
 * of the statuses seen on the second turn of a name, 200 of 200 when the
 * folder itself stayed). Anything else under the name, a link included, goes.
 */
export function prepareRun(name: string, prompt: string, stdin: "none" | "prompt"): RunFiles {
  const f = runFiles(name);
  const there = lstatSync(f.dir, { throwIfNoEntry: false });
  if (there?.isDirectory()) for (const e of readdirSync(f.dir)) rmSync(join(f.dir, e), { recursive: true, force: true });
  else rmSync(f.dir, { recursive: true, force: true });
  mkdirSync(join(f.dir, "part"), { recursive: true, mode: 0o700 });
  chmodSync(f.dir, 0o700);
  writeFileSync(f.input, stdin === "prompt" ? prompt : "", { mode: 0o600 });
  // Kept for every engine, because a retry on another one needs the words again.
  writeFileSync(f.prompt, prompt, { mode: 0o600 });
  // Written from what the build embedded: a compiled server cannot hand a
  // spawned python a /$bunfs path. A build without it keeps the raw JSON.
  try { writeFileSync(f.view, readFileSync(viewScript), { mode: 0o600 }); } catch { /* the pane stays raw */ }
  return f;
}

/** Runs the engine with its stdin from a file, leaves its exit status where
 *  the server reads it (see below), and prints what it complained about last so the person
 *  watching the window sees it. This app's own credentials are dropped from
 *  the environment: a tmux window inherits the server's, not this process's. */
/* The status is written in `part/`, a folder the watch does not look into, and
   moved into place, so the file is whole whenever it is there. Measured over
   300 turns each, with the watch this server uses: written in place, the file
   is created empty and its filling makes no second event; written beside
   itself as `rc.tmp` and renamed, the watch tripped over the vanished name and
   72 statuses went unseen; moved in from `part/`, 0 (ceilings.ts reads on any
   event in the folder). */
const WRAPPER = [
  'in=$1; err=$2; rc=$3; out=$4; py=$5; view=$6; part=${rc%/*}/part/rc; shift 6',
  // The minted worker credential survives the unset that drops the person's
  // machine token: it rides under its own name, is re-exported as the one the
  // CLI reads, and is gone from the engine's environment by the time it starts.
  // The browser identity comes back only with it, so an off worker inherits none.
  'w=${AGENTGLASS_WORKER_TOKEN:-}; p=${AGENTGLASS_PROFILE:-}; a=${AGENTGLASS_BROWSER_AS:-}',
  'unset AGENTGLASS_TOKEN AGENTGLASS_WORKER_TOKEN AGENTGLASS_PROFILE AGENTGLASS_BROWSER_AS AGENTGLASS_SEAT HERMES_YOLO_MODE _HERMES_GATEWAY',
  'if [ -n "$w" ]; then AGENTGLASS_TOKEN=$w; AGENTGLASS_PROFILE=$p; AGENTGLASS_BROWSER_AS=$a; export AGENTGLASS_TOKEN AGENTGLASS_PROFILE AGENTGLASS_BROWSER_AS; fi',
  'for v in $(env | sed -n "s/^\\(HERMES_[A-Za-z0-9_]*_SESSION\\)=.*/\\1/p"); do unset "$v"; done',
  'TERMINAL_CWD=$PWD; export TERMINAL_CWD',
  // `tee` before the reader: the file keeps the events whatever the reading does.
  // The status is moved into place only once the tab has drained: a row reading
  // "ended" while the last lines are still being printed is the kind of race
  // that made one worker count against the next start's limit.
  // A reader that dies hands the rest to `cat`: a pipe with no reader would
  // SIGPIPE `tee`, and through it the worker, over a formatting bug.
  '{ "$@" <"$in" 2>"$err"; echo $? >"$part"; } | tee "$out" | { if [ -n "$py" ]; then "$py" "$view" "$part" "$out" || cat; else cat; fi; }',
  'mv "$part" "$rc"',
  // The private OpenCode server of this turn, by the pids recorded for it and only while they are still a `serve`.
  'for p in $AGX_SERVE_PIDS; do grep -qa serve "/proc/$p/cmdline" 2>/dev/null && kill "$p" 2>/dev/null; done',
  'cat "$err" >&2',
  'exit "$(cat "$rc" 2>/dev/null || echo 1)"',
].join("\n");

/** The interpreter and script the tab is piped through, or nothing when this
 *  engine writes no JSON a reader knows, or this machine has no python3. */
function viewCommand(f: RunFiles, engine: string | undefined): string[] {
  if (engine !== "opencode" || !existsSync(f.view)) return [];
  const python = Bun.which("python3") || Bun.which("python");
  return python ? [python, f.view] : [];
}

export const wrapped = (f: RunFiles, argv: string[], engine?: string): string[] => {
  const view = viewCommand(f, engine);
  return ["sh", "-c", WRAPPER, "agx-worker", f.input, f.err, f.rc, f.out, view[0] ?? "", view[1] ?? "", ...argv];
};

/** How the last turn ended, from what the wrapper left. Null while it runs. */
export function turnResult(f: RunFiles, engine: string): { exitCode: number; line: string; resumeId?: string } | null {
  const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
  const rc = read(f.rc);
  if (rc === null || !/^\d+\s*$/.test(rc)) return null;
  // The turn is over: its OpenCode steps are the local spend the plan panel
  // counts. Idempotent, so the ceiling watch reading this again adds nothing.
  if (engine === "opencode") recordOpenCodeTurn(f.out);
  const err = read(f.err) ?? "";
  const last = err.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  return { exitCode: Number(rc), line: redact(last).slice(0, 200), resumeId: sessionIdOf(engine, read(f.out) ?? "", err) ?? undefined };
}

/**
 * What the final report of a turn says, from the run's output file: Claude's
 * `result` frame, else the text the other engines stream (OpenCode, Codex,
 * Hermes), else the whole file when it is plain text. Null when nothing can be
 * read, which for a reviewer is not a pass. Here rather than with the plan,
 * because the ending path asks it too and must not import the start path.
 */
export function reportOf(out: string): string | null {
  let sawFrame = false, result: string | null = null;
  const said: string[] = [];
  for (const l of out.split("\n")) {
    if (!l.startsWith("{")) continue;
    try {
      const f = JSON.parse(l) as { type?: string; result?: unknown; text?: unknown; part?: { type?: string; text?: unknown }; item?: { type?: string; text?: unknown } };
      sawFrame = true;
      if (f.type === "result" && typeof f.result === "string") result = f.result;
      else if (f.part?.type === "text" && typeof f.part.text === "string") said.push(f.part.text);
      else if (f.item?.type === "agent_message" && typeof f.item.text === "string") said.push(f.item.text);
      else if (f.type === "text" && typeof f.text === "string") said.push(f.text);
    } catch { /* not a frame */ }
  }
  if (result !== null) return result;
  if (said.length) return said.join("\n");
  return !sawFrame && out.trim() ? out : null;
}

/** The session an engine says it ran in, so a later turn can resume it. */
export function sessionIdOf(engine: string, out: string, err: string): string | null {
  if (engine === "hermes") return /session_id:\s*(\S+)/.exec(err)?.[1] ?? null;
  for (const l of out.split("\n")) {
    if (!l.startsWith("{")) continue;
    try {
      const f = JSON.parse(l) as Record<string, unknown>;
      if (engine === "opencode" && typeof f.sessionID === "string") return f.sessionID;
      if (engine === "codex" && f.type === "thread.started" && typeof f.thread_id === "string") return f.thread_id;
    } catch { /* not a frame */ }
  }
  return null;
}

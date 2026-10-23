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
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentProvider } from "../../../shared/agentKinds.ts";
import type { Envelope, Policy } from "../../../shared/orchestration.ts";
import type { WorkerRole } from "../../../shared/workerRoles.ts";
import { antigravityArgs } from "../antigravity.ts";
import { codexArgs } from "../codex.ts";
import { hermesArgs } from "../hermes.ts";
import { redact } from "../agentprobe.ts";
import { compileEnvelope } from "./envelope.ts";

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
 *  about, and how it ended. One folder per worker name; a new turn clears it. */
export interface RunFiles { dir: string; input: string; out: string; err: string; rc: string }

export function runFiles(name: string, root = runsDir()): RunFiles {
  const dir = join(root, name);
  return { dir, input: join(dir, "in"), out: join(dir, "out"), err: join(dir, "err"), rc: join(dir, "rc") };
}

function runsDir(): string {
  const state = process.env.AGENTGLASS_STATE_DIR
    || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agentglass");
  return join(state, "worker-runs");
}

/** Prepare the folder (owner-only: a prompt can hold anything) and the stdin. */
export function prepareRun(name: string, prompt: string, stdin: "none" | "prompt"): RunFiles {
  const f = runFiles(name);
  rmSync(f.dir, { recursive: true, force: true });
  mkdirSync(f.dir, { recursive: true, mode: 0o700 });
  writeFileSync(f.input, stdin === "prompt" ? prompt : "", { mode: 0o600 });
  return f;
}

/** Runs the engine with its stdin from a file, writes its exit status where
 *  the server reads it, and prints what it complained about last so the person
 *  watching the window sees it. This app's own credentials are dropped from
 *  the environment: a tmux window inherits the server's, not this process's. */
const WRAPPER = [
  'in=$1; err=$2; rc=$3; out=$4; shift 4',
  'unset AGENTGLASS_TOKEN AGENTGLASS_SEAT HERMES_YOLO_MODE _HERMES_GATEWAY',
  'for v in $(env | sed -n "s/^\\(HERMES_[A-Za-z0-9_]*_SESSION\\)=.*/\\1/p"); do unset "$v"; done',
  'TERMINAL_CWD=$PWD; export TERMINAL_CWD',
  '{ "$@" <"$in" 2>"$err"; echo $? >"$rc"; } | tee "$out"',
  'cat "$err" >&2',
  'exit "$(cat "$rc" 2>/dev/null || echo 1)"',
].join("\n");

export const wrapped = (f: RunFiles, argv: string[]): string[] => ["sh", "-c", WRAPPER, "agx-worker", f.input, f.err, f.rc, f.out, ...argv];

/** How the last turn ended, from what the wrapper left. Null while it runs. */
export function turnResult(f: RunFiles, engine: string): { exitCode: number; line: string; resumeId?: string } | null {
  const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
  const rc = read(f.rc);
  if (rc === null || !/^\d+\s*$/.test(rc)) return null;
  const err = read(f.err) ?? "";
  const last = err.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  return { exitCode: Number(rc), line: redact(last).slice(0, 200), resumeId: sessionIdOf(engine, read(f.out) ?? "", err) ?? undefined };
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

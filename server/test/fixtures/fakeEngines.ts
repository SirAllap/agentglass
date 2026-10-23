/*
 * Stand-ins for the agent CLIs, so a test can "run" any engine without one.
 *
 * `installFakeEngines(dir, spec)` writes one executable shell stub per engine
 * (claude, codex, gemini, opencode, hermes, agy) into `dir`. The stub answers
 * three questions the way the real CLI does, from the spec baked into it:
 *
 *   --version        prints the spec's line and exits with its code
 *   <status command> the CLI's own read-only account check (`claude auth
 *                    status`, `codex login status`, ...), same shape
 *   <headless form>  prints frames in that engine's frame shape, or sleeps,
 *                    or never exits, or fails with a rate-limit line
 *
 * and records every call's argv and env, so a test asserts what was run, not
 * only that something answered. A test that needs the stub to be the one that
 * ran puts `dir` first on the PATH of a CHILD process (`Bun.which` resolves
 * with the PATH the process started with, so changing `process.env.PATH`
 * inside a test does nothing) and reads `readCalls` afterwards.
 *
 * Shell, not Bun: a stub has to start in a few milliseconds, survive a
 * `kill -TERM` of its process group, and work with a PATH that has no
 * interpreter on it but `/bin`. The spec is baked in at install time; to
 * change an engine's behaviour, install again.
 *
 * The frame shapes are the ones the server's own parsers read (`hermes.ts`,
 * `codex.ts`, `antigravity.ts`, `chat.ts`). OpenCode's and Gemini's are the
 * best known shape and are marked so: nothing in this repo parses them yet,
 * and the first slice that does should change them to what it measured.
 */
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FakeEngineId = "claude" | "codex" | "gemini" | "opencode" | "hermes" | "agy";

export const FAKE_ENGINES: FakeEngineId[] = ["claude", "codex", "gemini", "opencode", "hermes", "agy"];

/** One printed answer: what goes to each pipe and how it ends. */
export interface FakeAnswer {
  out?: string;
  stderr?: string;
  exit?: number;
}

export interface FakeHeadless extends FakeAnswer {
  /** Lines to print on stdout, one per frame. Default: `frames(engine)`. */
  frames?: string[];
  /** Sleep this long (ms) before the first frame. */
  delayMs?: number;
  /** After the frames, never exit (a stuck turn). */
  hang?: boolean;
  /** Refuse these flags the way a CLI with an old parser does: a stderr line
   *  and exit 2, before any frame. Hermes 0.21.0 does this to `--format`. */
  unknownFlags?: string[];
}

export interface FakeSpec {
  /** Default: a version line in the engine's own shape, exit 0. */
  version?: FakeAnswer;
  /** The read-only account check. Default: signed in, exit 0. */
  status?: FakeAnswer;
  headless?: FakeHeadless;
}

/** Which engines get a stub, with what behaviour. A missing key is "not
 *  installed": no file is written, so the engine is not on the PATH. */
export type FakeFleet = Partial<Record<FakeEngineId, FakeSpec>>;

/** What a stub recorded about one call. */
export interface FakeCall {
  engine: FakeEngineId;
  pid: number;
  argv: string[];
  env: Record<string, string>;
}

/** The argv that makes each CLI answer a status question, and the one that
 *  makes it run a prompt. Read off the installed binaries (research-cli.md);
 *  Gemini and Antigravity have no status command that was ever seen, so they
 *  answer `status` only if a test asks for it. */
export const SHAPE: Record<FakeEngineId, { status: string[]; headless: string[]; version: string }> = {
  claude: { status: ["auth", "status"], headless: ["-p", "--print"], version: "2.1.296 (Claude Code)" },
  codex: { status: ["login", "status"], headless: ["exec"], version: "codex-cli 0.157.1" },
  gemini: { status: ["status"], headless: ["-p"], version: "0.40.0" },
  opencode: { status: ["providers", "list"], headless: ["run"], version: "1.18.32" },
  hermes: { status: ["status"], headless: ["chat"], version: "Hermes Agent v0.21.5 (2026.9.21) · upstream 9a71d5a8" },
  agy: { status: ["status"], headless: ["-p"], version: "agy 1.4.0" },
};

export const STATUS_DEFAULT: Record<FakeEngineId, string> = {
  claude: '{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty"}',
  codex: "Logged in using ChatGPT",
  gemini: "Signed in",
  opencode: "Credentials: 1 credentials",
  hermes: "◆ Auth Providers\n  Nous Portal   ✓ logged in",
  agy: "Signed in",
};

const SID = "0b6c3f52-8a41-4f4e-9a52-7d3f1c2e9a10";
// Hermes names its sessions by date, not by uuid (SESSION_RE in hermes.ts).
const HERMES_SID = "20260917_104709_fdc54d";

/** A short successful turn in the engine's own frame shape. */
export function frames(engine: FakeEngineId, text = "ok"): string[] {
  const j = (o: unknown) => JSON.stringify(o);
  switch (engine) {
    case "claude":
      return [
        j({ type: "system", subtype: "init", session_id: SID, model: "claude-sonnet-5-5" }),
        j({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, session_id: SID }),
        j({ type: "result", subtype: "success", is_error: false, result: text, session_id: SID,
            usage: { input_tokens: 12, output_tokens: 3 } }),
      ];
    case "codex":
      return [
        j({ type: "thread.started", thread_id: SID }),
        j({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } }),
        j({ type: "turn.completed", usage: { input_tokens: 12, cached_input_tokens: 0, output_tokens: 3 } }),
      ];
    case "hermes":
      return [
        j({ type: "system", subtype: "init", session_id: HERMES_SID, model: "nous/space-bunny-alpha" }),
        j({ type: "text", text }),
        j({ type: "result", session_id: HERMES_SID, tokens: { input: 12, output: 3, cache_read: 0, cache_write: 0 } }),
      ];
    case "agy":
      return [
        j({ event: "init", conversation_id: SID, init: { model: "gemini-3.6-flash-medium", cwd: "/work/orbit" } }),
        j({ event: "step_update", step_update: { step_type: "model_response", step_index: 0, text_delta: text } }),
        j({ event: "result", result: { status: "done", usage: { input_tokens: 12, output_tokens: 3 } } }),
      ];
    // OpenCode 1.18.32, `run --format json`, measured: every event carries
    // `type`, `timestamp`, `sessionID` and a `part`; a tool call is one
    // `tool_use` whose `part.state.status` is already `completed` or `error`.
    case "opencode":
      return [
        j({ type: "step_start", timestamp: 1791655313013, sessionID: "ses_fake0001", part: { type: "step-start" } }),
        j({ type: "text", timestamp: 1791655313900, sessionID: "ses_fake0001", part: { type: "text", text } }),
        j({ type: "step_finish", timestamp: 1791655314100, sessionID: "ses_fake0001", part: { type: "step-finish" } }),
      ];
    // Not parsed anywhere in this repo and no binary to measure: the shape
    // Gemini's stream-json is remembered to have. Replace it with what a
    // measurement says the day one is available.
    case "gemini":
      return [
        j({ type: "init", session_id: SID, model: "gemini-3.6-flash" }),
        j({ type: "message", role: "assistant", content: text }),
        j({ type: "result", status: "success", stats: { total_tokens: 15 } }),
      ];
  }
}

/** The CLI is signed out, as measured on the laptop (2026-10-10). Claude says
 *  so on STDOUT and exits 1 with nothing on stderr; Codex starts a thread, then
 *  prints five "Reconnecting..." error frames carrying the 401 and exits 1. */
export const SIGNED_OUT: Partial<Record<FakeEngineId, FakeHeadless>> = {
  claude: { frames: ["Not logged in · Please run /login"], exit: 1 },
  codex: {
    frames: [
      JSON.stringify({ type: "thread.started", thread_id: SID }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "error", message: "Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses)" }),
    ],
    exit: 1,
  },
};

/** OpenCode given a model name with no `provider/`: one error frame, exit 0
 *  (measured on 1.18.32: the failure is in the frame, not the exit code). */
export const OPENCODE_BAD_MODEL: FakeHeadless = {
  frames: [JSON.stringify({ type: "error", timestamp: 1791655275901, sessionID: "ses_fake0001",
    error: { name: "UnknownError", data: { message: "Unexpected server error. Check server logs for details." } } })],
};

/** A rate-limit refusal as a one-shot prints it: nothing on stdout, one line
 *  on stderr, a non-zero exit. The exact words differ per CLI and are the
 *  engine's to say; this is the shape, not a quotation. */
export const RATE_LIMITED: FakeHeadless = {
  frames: [],
  stderr: "Error: rate limit reached, try again later",
  exit: 1,
};

// Single-quote a string for sh. The only character that needs care is `'`.
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// One printf per piece, never `echo`: a frame that starts with `-n` must not
// be taken for an option.
const printLines = (lines: string[]) => lines.map((l) => `printf '%s\\n' ${q(l)}`).join("\n");

function answer(a: FakeAnswer): string {
  const parts: string[] = [];
  if (a.out) parts.push(`printf '%s\\n' ${q(a.out)}`);
  if (a.stderr) parts.push(`printf '%s\\n' ${q(a.stderr)} >&2`);
  parts.push(`exit ${a.exit ?? 0}`);
  return parts.join("\n");
}

function stubSource(engine: FakeEngineId, dir: string, spec: FakeSpec): string {
  const shape = SHAPE[engine];
  const version = spec.version ?? { out: shape.version };
  const status = spec.status ?? { out: STATUS_DEFAULT[engine] };
  const h = spec.headless ?? {};
  const body = h.frames ?? frames(engine);
  const callsDir = join(dir, ".calls");

  // The headless form is the first word for `exec`, `run` and `chat`, and a
  // flag anywhere for the `-p` CLIs.
  const words = shape.headless.filter((w) => !w.startsWith("-"));
  const flags = shape.headless.filter((w) => w.startsWith("-"));
  const headlessTest = [
    ...words.map((w) => `[ "$1" = ${q(w)} ]`),
    ...flags.map((w) => `[ "$a" = ${q(w)} ]`),
  ].join(" || ");
  const statusTest = shape.status.map((w, i) => `[ "$${i + 1}" = ${q(w)} ]`).join(" && ");

  const refuse = (h.unknownFlags ?? [])
    .map((f) => `    ${q(f)}|${q(f)}=*) printf '%s\\n' ${q(`error: unrecognized arguments: ${f}`)} >&2; exit 2 ;;`)
    .join("\n");

  return `#!/bin/sh
# fake ${engine}, written by server/test/fixtures/fakeEngines.ts
d=${q(callsDir)}
mkdir -p "$d"
f="$d/${engine}-$(date +%s%N)-$$"
printf '%s\\0' "$@" > "$f.argv"
env -0 > "$f.env"
if [ "$1" = '--version' ] || [ "$1" = 'version' ]; then
${answer(version)}
fi
if ${statusTest}; then
${answer(status)}
fi
headless=0
for a in "$@"; do
  case "$a" in
${refuse ? refuse + "\n" : ""}    *) ;;
  esac
  if ${headlessTest}; then headless=1; fi
done
if [ "$headless" = 1 ]; then
${h.delayMs ? `  sleep ${(h.delayMs / 1000).toFixed(3)}\n` : ""}${printLines(body).split("\n").map((l) => "  " + l).join("\n")}
${h.stderr ? `  printf '%s\\n' ${q(h.stderr)} >&2\n` : ""}${h.hang ? "  while :; do sleep 1; done\n" : ""}  exit ${h.exit ?? 0}
fi
printf '%s\\n' ${q(`${engine}: unknown command`)} >&2
exit 2
`;
}

/**
 * Write the stubs. Returns the paths it wrote, by engine. `dir` must exist or
 * be creatable; a stub for an engine absent from `fleet` is not written, and
 * one left from an earlier install is not removed (use a fresh directory).
 */
export function installFakeEngines(dir: string, fleet: FakeFleet): Record<string, string> {
  mkdirSync(dir, { recursive: true });
  const written: Record<string, string> = {};
  for (const engine of FAKE_ENGINES) {
    const spec = fleet[engine];
    if (!spec) continue;
    const path = join(dir, engine);
    writeFileSync(path, stubSource(engine, dir, spec));
    chmodSync(path, 0o755);
    written[engine] = path;
  }
  return written;
}

function splitNul(buf: string): string[] {
  const parts = buf.split("\0");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** Every call the stubs in `dir` recorded, oldest first. */
export function readCalls(dir: string, engine?: FakeEngineId): FakeCall[] {
  const callsDir = join(dir, ".calls");
  let names: string[];
  try {
    // The engine leads the name, so a plain sort would group by engine; the
    // nanosecond stamp in the middle is the order the calls happened in.
    const stamp = (n: string) => BigInt(/-(\d+)-\d+\.argv$/.exec(n)?.[1] ?? "0");
    names = readdirSync(callsDir).filter((n) => n.endsWith(".argv"))
      .sort((a, b) => (stamp(a) < stamp(b) ? -1 : stamp(a) > stamp(b) ? 1 : 0));
  } catch {
    return [];
  }
  const calls: FakeCall[] = [];
  for (const n of names) {
    const base = n.slice(0, -".argv".length);
    const m = /^(\w+)-\d+-(\d+)$/.exec(base);
    if (!m) continue;
    if (engine && m[1] !== engine) continue;
    const env: Record<string, string> = {};
    for (const kv of splitNul(readFileSync(join(callsDir, `${base}.env`), "utf8"))) {
      const eq = kv.indexOf("=");
      if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    calls.push({
      engine: m[1] as FakeEngineId,
      pid: Number(m[2]),
      argv: splitNul(readFileSync(join(callsDir, n), "utf8")),
      env,
    });
  }
  return calls;
}

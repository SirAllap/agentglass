// Multi-chat, OpenAI Codex — the second agent the chat panel can drive.
//
// Same shape as chat.ts: the local server runs the CLI non-interactively in a
// chosen repo/worktree and streams its JSONL straight back for the web panel to
// parse. `codex exec --json` is Codex's equivalent of
// `claude -p --output-format stream-json`; the first turn mints a thread (its id
// arrives in the `thread.started` frame) and follow-ups go through
// `codex exec resume <thread_id>`.
//
// Frames are passed through untranslated, exactly as chat.ts passes Claude's
// through. Codex speaks a different vocabulary — `item.completed` with a typed
// item rather than Anthropic content blocks — and translating it here would put
// half a parser on the server and half in the browser. The whole translation
// lives in web/src/lib/codexFrames.ts instead, so there is one place to look
// when a frame renders wrong.
//
// Gated by AGENTGLASS_CODEX_DISABLED; cwd must be a git dir and inside the open
// project, the same boundary chat.ts and the terminal hold.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { safeAbs, repoRootOf, gitCapability } from "./git.ts";
import { inScope, chatBypassAllowed } from "./config.ts";
import { startKeepalive, MODEL_RE, SESSION_RE } from "./chat.ts";
import type { CodexModel, TimelineEntry } from "../../shared/types.ts";

const codexBin = () => Bun.which("codex");
export const CODEX_ENABLED = !!codexBin() && process.env.AGENTGLASS_CODEX_DISABLED !== "1";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

/**
 * How much the agent may do without being asked.
 *
 * Codex's own vocabulary, not Claude's four permission modes, because the two
 * do genuinely different things and mapping one onto the other would put a
 * label on this panel that describes a mechanism Codex has not got. Claude's
 * "Ask (denies un-allowed)" is a statement about an allowlist consulted per
 * tool call; Codex draws its line around the filesystem instead, so these are
 * the three lines it can actually draw.
 */
const SANDBOXES = new Set(["read-only", "workspace-write", "full-access"]);
export const DEFAULT_SANDBOX = "read-only";

/**
 * `full-access` runs `--dangerously-bypass-approvals-and-sandbox`: no sandbox,
 * no approvals, driven from a browser request. Same exposure as Claude's
 * `--dangerously-skip-permissions`, so it rides the same operator opt-in rather
 * than minting a second one — someone who has decided how much autonomy a
 * browser tab may hand out has decided it for both CLIs.
 */
export const CODEX_BYPASS_ALLOWED = chatBypassAllowed();

/** How long a turn may produce nothing before we assume the CLI is stuck on
 *  something it cannot ask us for. Only ever armed before the first byte. */
const STARTUP_TIMEOUT_MS = Number(process.env.AGENTGLASS_CODEX_STARTUP_TIMEOUT_MS ?? 20_000);

const err = (msg: string, status = 400) => new Response(msg + "\n", { status, headers: CORS });

// --- the model list ---------------------------------------------------------
// Read from Codex's own cache rather than hardcoded here.
//
// A model table checked into this repo is wrong the day OpenAI ships anything,
// and the failure is silent: the dropdown keeps offering an id the CLI no
// longer serves. Codex already maintains the list on disk — it refreshes
// `models_cache.json` itself — so the honest answer to "what can I pick?" is
// whatever that file currently says.

/** Where Codex keeps its state. `CODEX_HOME` is Codex's own override and is
 *  honoured here so an operator who moved it does not silently get an empty
 *  list. */
const codexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");

/**
 * A last resort, not the source of truth.
 *
 * Reached when the cache is missing (a fresh install that has not talked to the
 * API yet) or unreadable. Offering nothing at all would make the panel look
 * broken on a machine where Codex works fine, so this is deliberately a short
 * list of ids that have shipped rather than an attempt at completeness — the
 * cache takes over the moment it exists.
 */
const FALLBACK_MODELS: CodexModel[] = [
  { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
  { id: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
  { id: "gpt-5.5", label: "GPT-5.5" },
];

/**
 * The models the dropdown may offer.
 *
 * Exported for tests. Every entry is validated against MODEL_RE before it goes
 * out, because the same expression guards the spawn below — offering a choice
 * the send path would then refuse is the one outcome worth ruling out here.
 *
 * The cache is ~37KB, nearly all of it each model's `base_instructions`. Only
 * the id and the label cross the wire.
 */
export function parseModels(raw: string): CodexModel[] {
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { return []; }
  const models = (doc as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  const out: Array<CodexModel & { priority: number }> = [];
  for (const m of models) {
    if (!m || typeof m !== "object") continue;
    const { slug, display_name, visibility, priority } = m as Record<string, unknown>;
    // `visibility` is Codex's own answer to "should a human be offered this?" —
    // the cache also carries internal entries (a review model, service tiers)
    // that are not conversation models at all.
    if (visibility !== "list") continue;
    if (typeof slug !== "string" || !MODEL_RE.test(slug)) continue;
    out.push({
      id: slug,
      label: typeof display_name === "string" && display_name ? display_name : slug,
      priority: typeof priority === "number" ? priority : Number.MAX_SAFE_INTEGER,
    });
  }
  out.sort((a, b) => a.priority - b.priority);
  return out.map(({ id, label }) => ({ id, label }));
}

export function codexModels(): CodexModel[] {
  try {
    const found = parseModels(readFileSync(join(codexHome(), "models_cache.json"), "utf8"));
    if (found.length) return found;
  } catch { /* no cache yet, or unreadable */ }
  return FALLBACK_MODELS;
}

// --- replaying a thread -----------------------------------------------------
// What a Codex session actually said, for a chat that adopted it from the fleet.
//
// The fleet knows Codex sessions through OpenTelemetry, and those log records
// carry the *shape* of a turn but not its words — `logRecordToEvent` in otlp.ts
// can build a tool call out of them and has nothing to build a prompt or a reply
// from. So a resumed Codex chat opened as a blank panel while `codex` held the
// whole conversation, which reads as the resume having silently failed. It is
// the same problem `hydrate` already solves for Claude by replaying the stored
// transcript; Codex's equivalent is its own rollout on disk.

/** How much of a rollout is worth reading. These files grow for the life of a
 *  thread — a resumed turn appends to the same one — and this runs on the
 *  server's only thread. */
const MAX_ROLLOUT_BYTES = 16 * 1024 * 1024;
/** Tool output in a replayed row, matching what the live path keeps. */
const MAX_TOOL_OUTPUT = 20_000;
/** Directories under `sessions/` to look through before giving up. The layout
 *  is `YYYY/MM/DD`, so this is a large multiple of what any real lookup needs;
 *  it exists so a corrupted or symlinked tree cannot spin. */
const MAX_ROLLOUT_DIRS = 4_000;

/**
 * The rollout file for a thread id, if it is still on disk.
 *
 * Codex names these `rollout-<ISO timestamp>-<thread id>.jsonl`, so the id is
 * in the filename and the search is a name match rather than a read of every
 * file. Sessions older than the user's retention are simply gone, which is a
 * normal answer and not an error.
 */
export function rolloutPath(id: string, root = join(codexHome(), "sessions")): string | null {
  const suffix = `-${id}.jsonl`;
  let scanned = 0;
  const walk = (dir: string, depth: number): string | null => {
    if (depth > 4 || ++scanned > MAX_ROLLOUT_DIRS) return null;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return null; }
    // Newest first: the layout is date-partitioned, so the thread being resumed
    // is far more likely to be in a recent directory than an old one.
    for (const name of entries.sort().reverse()) {
      const full = join(dir, name);
      if (name.endsWith(suffix)) return full;
      // `statSync` rather than a Dirent type check because it follows symlinks
      // the same way the read below would, so what is tested is what is read.
      let dirent: ReturnType<typeof statSync>;
      try { dirent = statSync(full); } catch { continue; }
      if (!dirent.isDirectory()) continue;
      const hit = walk(full, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root, 0);
}

const asMs = (v: unknown): number => {
  const t = typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(t) ? t : 0;
};

/**
 * What a tool call acted on.
 *
 * Codex's `input` is a JavaScript snippet it wrote for its own sandbox —
 * `const r = await tools.exec_command({"cmd":"wc -l README.md", …})` — so the
 * command is in there but only as a JSON field inside a program. Pulling it out
 * is a best-effort read of generated code, hence the fallback: showing the
 * snippet is worse than showing the command and much better than showing
 * nothing.
 */
function callTarget(input: unknown): string | null {
  if (typeof input !== "string" || !input) return null;
  const cmd = /"cmd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(input);
  if (cmd) { try { return JSON.parse(cmd[1]); } catch { /* not the string we hoped for */ } }
  // An edit arrives as an apply_patch envelope rather than a command, and the
  // file it touched is the one thing worth reading out of it — otherwise every
  // edit in a replayed thread shows 200 characters of identical boilerplate.
  const patch = /\*\*\* (?:Update|Add|Delete) File: ([^\\"\n]+)/.exec(input);
  if (patch) return patch[1].trim();
  return input.slice(0, 200);
}

/**
 * Whether a replayed tool run actually failed.
 *
 * The call's own `status` is "completed" for a script that ran and reported a
 * failure — true of the call, not of the work — so a rejected patch replayed
 * looking exactly like an applied one. Codex's exec wrapper opens its report
 * with a fixed line, so that is what is read, anchored to the start: a command
 * whose output merely *contains* these words later has not failed, and matching
 * loosely would mark it as though it had.
 */
const outputFailed = (text: string | null): boolean => !!text && /^Script (?:failed|error)\b/.test(text);

/**
 * What a tool call printed.
 *
 * Codex writes a result as content blocks — `[{type:"text",text:"…"}, …]` — and
 * writes them *as an array*, not as a string holding one. Both are handled
 * because both turn up: the rollout carries the array inline, while the same
 * field arrives JSON-encoded elsewhere in Codex's own plumbing. Reading only
 * the string form is what made every replayed tool row show no output at all
 * while looking entirely healthy.
 *
 * Anything that is neither is stringified rather than dropped: an unfamiliar
 * shape is still evidence of what happened.
 */
function callOutput(output: unknown): string | null {
  const blocks = (v: unknown): string | null => {
    if (!Array.isArray(v)) return null;
    return v.map((b) => (b && typeof b === "object" && typeof (b as Record<string, unknown>).text === "string" ? (b as Record<string, string>).text : "")).join("");
  };
  let text = blocks(output);
  if (text === null) {
    if (typeof output !== "string" || !output) return null;
    // A string that is itself an encoded block array, else the text as written.
    try { text = blocks(JSON.parse(output)) ?? output; } catch { text = output; }
  }
  text = text.trimEnd();
  if (!text) return null;
  return text.length > MAX_TOOL_OUTPUT ? text.slice(0, MAX_TOOL_OUTPUT) + "\n[trimmed]" : text;
}

/**
 * A Codex thread's conversation and tool runs, in the shape the chat panel
 * already replays.
 *
 * Exported and taking the file's text so it can be pinned against a real
 * rollout in tests without one having to exist on the machine running them.
 */
export function parseRollout(text: string): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  const byCall = new Map<string, TimelineEntry>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec: { type?: unknown; timestamp?: unknown; payload?: unknown };
    try { rec = JSON.parse(line); } catch { continue; }
    const p = (rec.payload ?? {}) as Record<string, unknown>;
    const ts = asMs(rec.timestamp) || asMs(p.timestamp);
    const kind = typeof p.type === "string" ? p.type : "";

    if (rec.type === "event_msg" && (kind === "user_message" || kind === "agent_message")) {
      const message = p.message;
      if (typeof message !== "string" || !message) continue;
      out.push({ kind: "message", role: kind === "user_message" ? "user" : "assistant", text: message, ts });
      continue;
    }
    if (rec.type !== "response_item") continue;
    if (kind === "custom_tool_call" || kind === "function_call") {
      const callId = typeof p.call_id === "string" ? p.call_id : null;
      const row: TimelineEntry = {
        kind: "tool",
        ts,
        tool: typeof p.name === "string" && p.name ? p.name : "tool",
        target: callTarget(p.input ?? p.arguments),
        tool_use_id: callId,
        is_error: false,
        output: null,
      };
      if (callId) byCall.set(callId, row);
      out.push(row);
      continue;
    }
    if (kind === "custom_tool_call_output" || kind === "function_call_output") {
      const callId = typeof p.call_id === "string" ? p.call_id : "";
      const row = byCall.get(callId);
      if (!row) continue;
      row.output = callOutput(p.output);
      row.is_error = outputFailed(row.output);
    }
  }
  // A rollout is written in order, but a resumed thread appends to the same
  // file, so sort rather than assume — the panel renders these in array order.
  return out.sort((a, b) => a.ts - b.ts);
}

/** The replay for a thread, or an empty timeline when there is nothing on disk.
 *  Empty is a real answer: rollouts are retained for a while, not forever. */
export function codexTranscript(id: unknown): TimelineEntry[] {
  if (typeof id !== "string" || !SESSION_RE.test(id)) return [];
  const path = rolloutPath(id);
  if (!path) return [];
  try {
    if (statSync(path).size > MAX_ROLLOUT_BYTES) return [];
    return parseRollout(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

// --- driving a turn ---------------------------------------------------------

/**
 * The argv for one turn.
 *
 * Exported and pure so the flag mapping can be pinned in tests without
 * spawning a real `codex` — the same reason chat.ts exports `turnEnvelope`.
 *
 * Two things about this are worth writing down, because both were found the
 * hard way rather than read off the help output:
 *
 *  - The prompt goes in on stdin, via the trailing `-`. Passing it as an argv
 *    element would work until someone pastes something long enough to hit
 *    ARG_MAX, and it puts what the user typed into the process table.
 *  - The sandbox is set with `-c sandbox_mode=...` rather than `-s`, because
 *    `codex exec resume` does not accept `-s` at all ("unexpected argument
 *    '-s' found") while it does accept `-c`. Using the config override on both
 *    paths keeps one code path instead of a flag that changes shape depending
 *    on whether this is the first turn.
 *
 * The working directory is set on the spawn, not with `-C`, matching chat.ts —
 * and `codex exec resume` has no `-C` either.
 */
export function codexArgs(bin: string, model: string, sandbox: string, resumeId: string): string[] {
  const args = [bin, "exec"];
  if (resumeId) args.push("resume", resumeId);
  args.push("--json", "-m", model);
  if (sandbox === "full-access") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("-c", `sandbox_mode=${sandbox}`);
    // `codex exec` has no channel to ask down, so an approval policy that would
    // prompt can only stall or deny. Saying "never" up front makes the sandbox
    // the only thing deciding, which is what the mode label already claims.
    args.push("-c", "approval_policy=never");
  }
  args.push("-"); // read the prompt from stdin
  return args;
}

// --- where a codex thread is running -----------------------------------------
//
// Codex reaches the fleet over OpenTelemetry, and those records say everything
// about a turn except *where* it happened: the payload carries `message`,
// `event`, `prompt`, `tool_name`, `tool_use_id` and `usage`, and no working
// directory anywhere. So every Codex session landed with a NULL project_path,
// and a cockpit scoped to one project — which is the default — filtered all of
// them out. The symptom was that OpenAI never appeared in the provider list
// while 1225 Codex events sat in the database.
//
// The panel knows the directory, because it is the thing that launched the
// turn. So it is remembered here, keyed by thread, and stamped onto the OTel
// events as they arrive (see ingestBody in index.ts).
//
// Deliberately *not* the same treatment Antigravity gets. That agent reports to
// nobody, so its frames are turned into events wholesale. Codex already reports
// its own PreToolUse, PostToolUse and Turn complete — with the tokens — so
// doing that here would file a second copy of every turn against the same
// thread id and double the spend it shows.
const codexCwds = new Map<string, { cwd: string; root: string }>();
/** Bounded: a long-running server should not accumulate a row per thread it has
 *  ever driven. Oldest out first — a thread that has not been touched in that
 *  many turns is not one whose events are still arriving. */
const MAX_TRACKED_THREADS = 500;

export function noteCodexCwd(threadId: string, dir: string): void {
  if (!threadId || !SESSION_RE.test(threadId) || !dir) return;
  if (codexCwds.has(threadId)) return;
  if (codexCwds.size >= MAX_TRACKED_THREADS) {
    const oldest = codexCwds.keys().next().value;
    if (oldest) codexCwds.delete(oldest);
  }
  codexCwds.set(threadId, { cwd: dir, root: repoRootOf(dir) || dir });
}

/** Where this thread was launched from, if this server launched it. */
export const codexCwd = (sessionId: string) => codexCwds.get(sessionId) ?? null;

export function codexStream(cwd: unknown, message: unknown, model: unknown, resumeId: unknown, mode: unknown, images?: unknown): Response {
  const bin = codexBin();
  if (!bin) return err("no local `codex` CLI — install the Codex CLI to chat", 403);
  if (process.env.AGENTGLASS_CODEX_DISABLED === "1") return err("codex chat is disabled (AGENTGLASS_CODEX_DISABLED=1)", 403);
  const dir = safeAbs(cwd);
  if (!dir || !repoRootOf(dir)) {
    const cap = gitCapability();
    return err(cap.available ? "invalid or non-repo directory" : (cap.reason || "git is not installed"));
  }
  // A codex turn runs real tools in this directory, so it gets the same scope
  // boundary a claude turn does.
  if (!inScope(dir)) return err("outside the open project — open the parent folder to work across repos", 403);
  // `codex exec` attaches images as file paths (`-i <FILE>`), not as content
  // blocks, so there is nowhere for pasted bytes to go without staging them on
  // disk first. Refusing is the honest answer: quietly sending a turn written
  // about a screenshot, minus the screenshot, produces a confusing reply rather
  // than an error — the same reasoning behind chat.ts rejecting a bad
  // attachment instead of dropping it.
  if (Array.isArray(images) && images.length) return err("codex chats cannot take pasted images yet — send the turn without it, or use a Claude chat");
  if (typeof message !== "string" || !message.trim() || message.length > 100_000) return err("invalid message");
  const m = typeof model === "string" && MODEL_RE.test(model) ? model : (codexModels()[0]?.id ?? FALLBACK_MODELS[0].id);
  let sandbox = typeof mode === "string" && SANDBOXES.has(mode) ? mode : DEFAULT_SANDBOX;
  if (sandbox === "full-access" && !CODEX_BYPASS_ALLOWED) sandbox = DEFAULT_SANDBOX; // opt-in only
  const rid = typeof resumeId === "string" && SESSION_RE.test(resumeId) ? resumeId : "";

  const args = codexArgs(bin, m, sandbox, rid);
  // A resumed thread is already named; a new one names itself in the
  // `thread.started` frame below.
  if (rid) noteCodexCwd(rid, dir);

  // Its own process group, so stopping a turn reaches the whole job tree —
  // `codex` spawns shells of its own, and killing only the direct child would
  // leave a test run or a dev server behind still working.
  const setsid = Bun.which("setsid");
  const proc = Bun.spawn(setsid ? [setsid, ...args] : args, {
    cwd: dir,
    stdin: new TextEncoder().encode(message),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  // Drained from the start, not after exit: a full stderr pipe blocks the child
  // forever, and `codex` is talkative on stderr even on a clean run (it logs a
  // line per unloadable skill).
  const stderrText = new Response(proc.stderr as ReadableStream<Uint8Array>).text().catch(() => "");

  const enc = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const stopKeepalive = startKeepalive(controller);
      /*
       * A first-run watchdog, for the same failure chat.ts guards against: a
       * `codex` that has never been logged in waits on an interactive prompt
       * that can never arrive here, so it emits nothing and never exits, and
       * the panel sits on a spinner that reads as agentglass having hung.
       */
      let firstByte = false;
      const watchdog = setTimeout(async () => {
        if (firstByte || cancelled) return;
        const hint = (await Promise.race([stderrText, Promise.resolve("")])).trim();
        try {
          controller.enqueue(enc.encode(JSON.stringify({
            type: "agx_error",
            code: null,
            errorType: "first_run_setup_required",
            setupCommand: "codex login",
            error: hint
              || `codex produced no output in ${STARTUP_TIMEOUT_MS / 1000}s — it is probably waiting for a login it can't ask for here. Run \`codex login\` in a terminal, then try again.`,
          }) + "\n"));
        } catch { /* the client already went away */ }
        try {
          if (setsid) process.kill(-proc.pid, "SIGTERM");
          else proc.kill();
        } catch { /* gone */ }
      }, STARTUP_TIMEOUT_MS);
      /*
       * The only thing read out of this stream on the way past: the id Codex
       * mints for a new thread, so its OTel events can be told where they ran.
       * Everything else is forwarded untouched — this is not a second parser,
       * and the frames' meaning still lives entirely in codexFrames.ts.
       */
      const dec = new TextDecoder();
      let head = "";
      let named = !!rid;
      const catchThreadId = (chunk: Uint8Array) => {
        if (named) return;
        head += dec.decode(chunk, { stream: true });
        // `thread.started` is the first frame Codex sends, so this reads a line
        // or two and then stops looking rather than parsing the whole turn.
        for (const line of head.split("\n")) {
          if (!line.includes("thread.started")) continue;
          try {
            const o = JSON.parse(line) as { type?: string; thread_id?: unknown };
            if (o.type === "thread.started" && typeof o.thread_id === "string") {
              noteCodexCwd(o.thread_id, dir);
              named = true;
            }
          } catch { /* a partial line; the next chunk completes it */ }
        }
        if (named || head.length > 8192) head = "";
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) { firstByte = true; clearTimeout(watchdog); catchThreadId(value); controller.enqueue(value); }
        }
      } catch { /* closed */ }
      clearTimeout(watchdog);
      stopKeepalive();
      const code = await proc.exited;
      if (cancelled) return; // a cancelled controller throws on enqueue/close
      if (code !== 0) {
        const text = (await stderrText).trim();
        controller.enqueue(enc.encode(JSON.stringify({ type: "agx_error", code, error: text || `codex exited ${code}` }) + "\n"));
      }
      controller.close();
    },
    cancel() {
      cancelled = true;
      try {
        if (setsid) process.kill(-proc.pid, "SIGTERM"); // the group, not just codex
        else proc.kill();
      } catch { /* gone */ }
    },
  });

  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no", ...CORS } });
}

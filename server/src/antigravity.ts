// Multi-chat, Google Antigravity — the third agent the chat panel can drive.
//
// Same shape as chat.ts and codex.ts: the local server runs the CLI
// non-interactively in a chosen repo/worktree and streams its JSONL straight
// back for the web panel to parse. `agy -p <prompt> --output-format stream-json`
// is Antigravity's equivalent of `claude -p --output-format stream-json`; the
// first turn mints a conversation (its id arrives in the `init` frame) and
// follow-ups go through `--conversation <id>`.
//
// This is *not* the Gemini CLI. They are separate binaries with separate
// wiring, they keep separate state, and `agy models` offers Claude and
// gpt-oss models alongside Gemini ones — it is a multi-model harness that
// happens to be Google's. Gemini CLI keeps its own OpenTelemetry route onto the
// radar and is untouched by any of this.
//
// Frames are passed through untranslated, exactly as the other two are. The
// whole translation lives in web/src/lib/antigravityFrames.ts, so there is one
// place to look when a frame renders wrong.
//
// One thing here has no counterpart in the other two: `frameToEvent`. Claude
// reaches the fleet over hooks and Codex over OpenTelemetry, but Antigravity
// exports neither, so a chat started here would otherwise never appear on the
// radar at all. The frames it streams already carry everything an event needs,
// so they are mapped and handed to the same ingest path — see the comment on
// frameToEvent for what that does and does not cover.
//
// Gated by AGENTGLASS_ANTIGRAVITY_DISABLED; cwd must be a git dir and inside the
// open project, the same boundary chat.ts, codex.ts and the terminal hold.
import { safeAbs, repoRootOf, gitCapability } from "./git.ts";
import { inScope, chatBypassAllowed } from "./config.ts";
import { startKeepalive, MODEL_RE, SESSION_RE } from "./chat.ts";
import type { AgentModel, IngestBody } from "../../shared/types.ts";

const agyBin = () => Bun.which("agy");
export const ANTIGRAVITY_ENABLED = !!agyBin() && process.env.AGENTGLASS_ANTIGRAVITY_DISABLED !== "1";

/** What `source_app` every synthesized event carries.
 *
 *  Load-bearing rather than cosmetic. `agy` can run `claude-opus-4-6-thinking`,
 *  so `model_name` is an actively misleading signal for "which CLI is this?" —
 *  agentOf() in web/src/lib/derive.ts checks `source_app` first, and this is
 *  what stops an Antigravity session being misfiled as a Claude one. */
export const ANTIGRAVITY_APP = "antigravity";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

/**
 * How much the agent may do without being asked.
 *
 * Antigravity's own vocabulary. It lands almost exactly on Claude's four, which
 * is a property of the CLI rather than something forced here: it really does
 * decide per tool call, and it really does have a plan mode and an
 * accept-the-edits mode. Where Codex needed its own three because a sandbox is
 * not a permission policy, these four mean what their Claude-side labels say.
 *
 * `request-review` is the default and is spelled by passing no flag at all —
 * `--mode` only accepts the two middle values.
 */
const MODES = new Set(["request-review", "plan", "accept-edits", "always-proceed"]);
export const DEFAULT_MODE = "request-review";

/**
 * `always-proceed` runs `--dangerously-skip-permissions`: every tool approved
 * without asking, driven from a browser request. Same exposure as Claude's
 * `--dangerously-skip-permissions` and Codex's
 * `--dangerously-bypass-approvals-and-sandbox`, so it rides the same operator
 * opt-in rather than minting a third one — someone who has decided how much
 * autonomy a browser tab may hand out has decided it for all three CLIs.
 */
export const ANTIGRAVITY_BYPASS_ALLOWED = chatBypassAllowed();

/** How long a turn may produce nothing before we assume the CLI is stuck on
 *  something it cannot ask us for. Only ever armed before the first byte. */
const STARTUP_TIMEOUT_MS = Number(process.env.AGENTGLASS_ANTIGRAVITY_STARTUP_TIMEOUT_MS ?? 30_000);

const err = (msg: string, status = 400) => new Response(msg + "\n", { status, headers: CORS });

// --- the model list ---------------------------------------------------------
// Asked of the CLI rather than hardcoded here, for the same reason codex.ts
// reads Codex's cache: a table checked into this repo is wrong the day Google
// ships anything, and it fails silently by offering an id the CLI will refuse.
//
// `agy models` prints one id per line and nothing else, so there is no cache
// file to find and no JSON to parse — but it is a subprocess rather than a
// file read, so the answer is memoized for the life of the server.

/**
 * A last resort, not the source of truth.
 *
 * Reached when `agy models` fails — a fresh install that has not authenticated,
 * or a CLI too old for the subcommand. Offering nothing would make the panel
 * look broken on a machine where `agy` works fine, so this is deliberately a
 * short list of ids that have shipped rather than an attempt at completeness.
 */
const FALLBACK_MODELS: AgentModel[] = [
  { id: "gemini-3.6-flash-medium", label: "gemini-3.6-flash-medium" },
  { id: "gemini-3.1-pro-high", label: "gemini-3.1-pro-high" },
];

/**
 * The models the dropdown may offer.
 *
 * Exported for tests. Every entry is validated against MODEL_RE before it goes
 * out, because the same expression guards the spawn below — offering a choice
 * the send path would then refuse is the one outcome worth ruling out here.
 *
 * The id is used as its own label. Antigravity has no display name to offer,
 * and the ids are already readable (`gemini-3.1-pro-high`); inventing prettier
 * ones here would be this repo guessing at branding it does not own.
 */
export function parseModels(raw: string): AgentModel[] {
  const out: AgentModel[] = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const id = line.trim();
    // `agy models` prints a bare list, but a future version adding a header or
    // a "(default)" marker should narrow the list rather than corrupt it.
    if (!id || seen.has(id) || !MODEL_RE.test(id)) continue;
    seen.add(id);
    out.push({ id, label: id });
  }
  return out;
}

let modelCache: AgentModel[] | null = null;
export function antigravityModels(): AgentModel[] {
  if (modelCache) return modelCache;
  const bin = agyBin();
  if (!bin) return FALLBACK_MODELS;
  try {
    const r = Bun.spawnSync([bin, "models"], { stdout: "pipe", stderr: "pipe" });
    const found = r.exitCode === 0 ? parseModels(r.stdout.toString()) : [];
    if (found.length) { modelCache = found; return found; }
  } catch { /* not installed, or it refused */ }
  return FALLBACK_MODELS;
}

// --- putting a chat on the radar --------------------------------------------

/** What a run needs to remember between frames to describe itself. */
export type FrameContext = {
  /** Filled from the `init` frame; every event before it has nowhere to go. */
  sessionId: string;
  model: string;
  /** Where the turn ran, and the repo that directory belongs to.
   *
   *  On every event rather than only the first, because this is what scopes a
   *  session to a project: db.ts lifts `project_path` and `cwd_path` out of the
   *  payload JSON, and the fleet list filters on them. Without these an
   *  Antigravity chat lands in the store and then shows up nowhere, which is
   *  indistinguishable from it never having been recorded. */
  cwd: string;
  projectPath: string;
  /** step_index → tool name, so a DONE step can name the tool its ACTIVE half
   *  opened. The frames carry `tool_name` on both halves today; this keeps the
   *  pairing correct if a future one carries it only on the first. */
  tools: Map<number, string>;
};

export const newFrameContext = (cwd = ""): FrameContext => ({
  sessionId: "", model: "", cwd, projectPath: cwd ? (repoRootOf(cwd) || cwd) : "", tools: new Map(),
});

/** The fields every event of this turn carries, whatever else it says. */
const scope = (ctx: FrameContext) => ({
  source_app: ANTIGRAVITY_APP,
  session_id: ctx.sessionId,
  model_name: ctx.model || undefined,
});
const located = (ctx: FrameContext, payload: Record<string, unknown>) => ({
  ...payload,
  ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
  ...(ctx.projectPath ? { project_path: ctx.projectPath } : {}),
});

/**
 * One Antigravity frame as an event for the store, or null for the frames that
 * are not events.
 *
 * Pure, and exported for tests: the mapping is the whole of what makes an
 * Antigravity chat visible in the fleet, and it is much easier to pin down here
 * than through a spawned CLI.
 *
 * What this covers and what it does not:
 *
 *  - **Only chats started in this panel.** An `agy` you ran in a terminal emits
 *    nothing to anyone, so it stays invisible. That is a real gap and is said
 *    plainly in the README rather than implied away.
 *  - **The tool pair carries `step_index` as its `tool_use_id`.** Indices are
 *    unique within a conversation, which is the scope the pairing needs, and
 *    they are what the ACTIVE and DONE halves already share.
 *  - **Usage rides on `result`, once per turn.** Measured rather than assumed:
 *    turn 1 of a conversation reported 31789 input tokens and turn 2 reported
 *    16609, so these are per-turn figures and adding them across a thread is
 *    correct. Codex's are cumulative and must be assigned instead — the two
 *    look alike and mean opposite things.
 */
export function frameToEvent(frame: Record<string, unknown>, ctx: FrameContext): IngestBody | null {
  const kind = frame.event;

  if (kind === "init") {
    const init = (frame.init ?? {}) as Record<string, unknown>;
    const id = typeof frame.conversation_id === "string" ? frame.conversation_id : "";
    if (!id || !SESSION_RE.test(id)) return null;
    ctx.sessionId = id;
    if (typeof init.model === "string") ctx.model = init.model;
    // The CLI reports where it actually ran, which beats what the caller asked
    // for — `--add-dir` and a workspace can move it.
    if (typeof init.cwd === "string" && init.cwd) {
      ctx.cwd = init.cwd;
      ctx.projectPath = repoRootOf(init.cwd) || init.cwd;
    }
    return {
      ...scope(ctx),
      hook_event_type: "SessionStart",
      payload: located(ctx, { message: ctx.cwd }),
    };
  }

  if (kind === "result") {
    if (!ctx.sessionId) return null;
    const result = (frame.result ?? {}) as Record<string, unknown>;
    const u = (result.usage ?? {}) as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    return {
      ...scope(ctx),
      hook_event_type: "Turn complete",
      payload: located(ctx, {
        usage: {
          input_tokens: n(u.input_tokens),
          output_tokens: n(u.output_tokens),
          cache_read_tokens: n(u.cache_read_tokens),
          // Antigravity reports thinking tokens separately and counts them
          // inside `output_tokens` already, so they are not added again here.
          cache_creation_tokens: 0,
        },
        message: typeof result.status === "string" ? result.status : "",
      }),
    };
  }

  if (kind !== "step_update") return null;
  const step = (frame.step_update ?? {}) as Record<string, unknown>;
  if (!ctx.sessionId) return null;
  const type = step.step_type;
  const idx = typeof step.step_index === "number" ? step.step_index : -1;

  if (type === "user_input") {
    return {
      ...scope(ctx),
      hook_event_type: "UserPromptSubmit",
      payload: located(ctx, { prompt: typeof step.text_delta === "string" ? step.text_delta : "" }),
    };
  }

  if (type === "tool") {
    const info = (step.tool_info ?? {}) as Record<string, unknown>;
    const name = typeof step.tool_name === "string" ? step.tool_name
      : typeof info.name === "string" ? info.name
      : ctx.tools.get(idx) ?? "";
    if (!name) return null;
    const base = scope(ctx);
    if (step.state === "ACTIVE") {
      ctx.tools.set(idx, name);
      return { ...base, hook_event_type: "PreToolUse", payload: located(ctx, { tool_name: name, tool_use_id: String(idx) }) };
    }
    if (step.state === "DONE") {
      ctx.tools.delete(idx);
      const out = typeof info.output === "string" ? info.output : "";
      return {
        ...base,
        hook_event_type: "PostToolUse",
        // No duration is passed: insertEvent derives it from the Pre/Post pair
        // and ignores anything the payload claims. The two halves arrive
        // milliseconds apart in real time, so the paired figure is the same
        // number `duration_seconds` would have given.
        payload: located(ctx, { tool_name: name, tool_use_id: String(idx), tool_response: out }),
      };
    }
    return null;
  }

  // agent_response, thinking, checkpoint, subagent, browser_action, unknown:
  // real frames the panel draws, but not things the fleet counts. An
  // `error_message` step carries no payload in the stream — the failure it
  // stands for shows up on the tool that produced it.
  return null;
}

// --- driving a turn ---------------------------------------------------------

/**
 * The command line for one turn.
 *
 * Exported for tests, because the mode mapping is the part worth pinning: three
 * of the four modes are spelled as flags and the default is spelled by their
 * absence, so a regression here is silent rather than loud.
 *
 * The prompt goes in argv rather than on stdin. `--print` takes it as its
 * value, and there is no stdin form; the 100KB cap in antigravityStream keeps
 * that well inside ARG_MAX.
 *
 * The working directory is set on the spawn rather than with `--add-dir`,
 * matching chat.ts and codex.ts.
 */
export function antigravityArgs(bin: string, model: string, mode: string, resumeId: string, message: string): string[] {
  const args = [bin, "-p", message, "--output-format", "stream-json", "--model", model];
  if (resumeId) args.push("--conversation", resumeId);
  if (mode === "always-proceed") args.push("--dangerously-skip-permissions");
  else if (mode === "plan" || mode === "accept-edits") args.push("--mode", mode);
  // `request-review` is the default and has no flag: passing --mode with it is
  // rejected, since --mode only accepts the two middle values.
  return args;
}

export function antigravityStream(
  cwd: unknown,
  message: unknown,
  model: unknown,
  resumeId: unknown,
  mode: unknown,
  images?: unknown,
  emit?: (body: IngestBody) => void,
): Response {
  const bin = agyBin();
  if (!bin) return err("no local `agy` CLI — install the Antigravity CLI to chat", 403);
  if (process.env.AGENTGLASS_ANTIGRAVITY_DISABLED === "1") return err("antigravity chat is disabled (AGENTGLASS_ANTIGRAVITY_DISABLED=1)", 403);
  const dir = safeAbs(cwd);
  if (!dir || !repoRootOf(dir)) {
    const cap = gitCapability();
    return err(cap.available ? "invalid or non-repo directory" : (cap.reason || "git is not installed"));
  }
  // An antigravity turn runs real tools in this directory, so it gets the same
  // scope boundary a claude turn does.
  if (!inScope(dir)) return err("outside the open project — open the parent folder to work across repos", 403);
  // `agy` takes images as file paths, not as content blocks — same position
  // Codex is in, and refused for the same reason: a turn written about a
  // screenshot, sent without the screenshot, produces a confusing reply rather
  // than an error.
  if (Array.isArray(images) && images.length) return err("antigravity chats cannot take pasted images yet — send the turn without it, or use a Claude chat");
  if (typeof message !== "string" || !message.trim() || message.length > 100_000) return err("invalid message");
  const m = typeof model === "string" && MODEL_RE.test(model) ? model : (antigravityModels()[0]?.id ?? FALLBACK_MODELS[0].id);
  let mo = typeof mode === "string" && MODES.has(mode) ? mode : DEFAULT_MODE;
  if (mo === "always-proceed" && !ANTIGRAVITY_BYPASS_ALLOWED) mo = DEFAULT_MODE; // opt-in only
  const rid = typeof resumeId === "string" && SESSION_RE.test(resumeId) ? resumeId : "";

  const args = antigravityArgs(bin, m, mo, rid, message);

  // Its own process group, so stopping a turn reaches the whole job tree —
  // `agy` spawns shells of its own, and killing only the direct child would
  // leave a test run or a dev server behind still working.
  const setsid = Bun.which("setsid");
  const proc = Bun.spawn(setsid ? [setsid, ...args] : args, {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  // Drained from the start, not after exit: a full stderr pipe blocks the child
  // forever.
  const stderrText = new Response(proc.stderr as ReadableStream<Uint8Array>).text().catch(() => "");

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const ctx = newFrameContext(dir);
  let cancelled = false;

  /*
   * Frames go two places at once: out to the browser verbatim, and — split into
   * whole lines — through frameToEvent into the store.
   *
   * The tee is here rather than in the browser because what the fleet knows is
   * the server's business. A browser that parses its own frames for display is
   * one thing; a browser trusted to report what ran is another, and it would
   * put the store behind a client that can be closed, throttled or reloaded
   * mid-turn.
   */
  let pending = "";
  const feed = (chunk: Uint8Array | null) => {
    if (!emit) return;
    pending += chunk ? dec.decode(chunk, { stream: true }) : "\n";
    for (;;) {
      const nl = pending.indexOf("\n");
      if (nl < 0) break;
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (!line) continue;
      try {
        const ev = frameToEvent(JSON.parse(line) as Record<string, unknown>, ctx);
        if (ev) emit(ev);
      } catch { /* a partial or non-JSON line is the browser's problem, not the store's */ }
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const stopKeepalive = startKeepalive(controller);
      /*
       * A first-run watchdog, for the same failure chat.ts and codex.ts guard
       * against: an `agy` that has never been logged in waits on an interactive
       * prompt that can never arrive here, so it emits nothing and never exits,
       * and the panel sits on a spinner that reads as agentglass having hung.
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
            setupCommand: "agy",
            error: hint
              || `agy produced no output in ${STARTUP_TIMEOUT_MS / 1000}s — it is probably waiting for a login it can't ask for here. Run \`agy\` in a terminal and sign in, then try again.`,
          }) + "\n"));
        } catch { /* the client already went away */ }
        try {
          if (setsid) process.kill(-proc.pid, "SIGTERM");
          else proc.kill();
        } catch { /* gone */ }
      }, STARTUP_TIMEOUT_MS);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            firstByte = true;
            clearTimeout(watchdog);
            feed(value);
            controller.enqueue(value);
          }
        }
      } catch { /* closed */ }
      feed(null); // a last line with no trailing newline
      clearTimeout(watchdog);
      stopKeepalive();
      const code = await proc.exited;
      if (cancelled) return; // a cancelled controller throws on enqueue/close
      if (code !== 0) {
        const text = (await stderrText).trim();
        controller.enqueue(enc.encode(JSON.stringify({ type: "agx_error", code, error: text || `agy exited ${code}` }) + "\n"));
      }
      controller.close();
    },
    cancel() {
      cancelled = true;
      try {
        if (setsid) process.kill(-proc.pid, "SIGTERM"); // the group, not just agy
        else proc.kill();
      } catch { /* gone */ }
    },
  });

  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no", ...CORS } });
}

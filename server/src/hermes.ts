// Multi-chat, Hermes — the fourth agent the chat panel can drive.
//
// Same shape as chat.ts, codex.ts and antigravity.ts: the local server runs the
// CLI non-interactively in a chosen repo/worktree and streams its JSONL straight
// back for the web panel to parse. `hermes chat -q … --format stream-json` is
// Hermes's equivalent of `claude -p --output-format stream-json`; the first turn
// mints a session (its id arrives in the `system/init` frame) and follow-ups go
// through `--resume <id>`.
//
// Frames are passed through untranslated. The whole translation lives in
// web/src/lib/hermesFrames.ts, so there is one place to look when a frame
// renders wrong.
//
// Like Antigravity, Hermes exports neither hooks nor OpenTelemetry, so a chat
// started here would otherwise never appear on the radar. The frames it streams
// already carry everything an event needs, so they are mapped and handed to the
// same ingest path — see frameToEvent. A `hermes` you ran in a terminal still
// reports to nobody.
//
// Gated by AGENTGLASS_HERMES_DISABLED; cwd must be a git dir and inside the
// open project, the same boundary chat.ts, codex.ts and antigravity.ts hold.
// This module does not write ~/.hermes/config.yaml, open a pane, or touch ACP.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { safeAbs, repoRootOf, gitCapability } from "./git.ts";
import { inScope, chatBypassAllowed } from "./config.ts";
import { startKeepalive, drainStderr } from "./chat.ts";
import type { AgentModel, IngestBody } from "../../shared/types.ts";
import { stopTree } from "./proctree.ts";

const hermesBin = () => {
  const env = process.env.AGENTGLASS_HERMES;
  if (env && existsSync(env)) return env;
  return Bun.which("hermes");
};

/*
 * Resolved per call, not once at import — same trap antigravity.ts documents:
 * a binary installed while the server was running stayed invisible until a
 * restart, with nothing on screen to suggest why.
 */
export const HERMES_ENABLED = (): boolean => !!hermesBin() && process.env.AGENTGLASS_HERMES_DISABLED !== "1";

/** What `source_app` every synthesized event carries.
 *
 *  Load-bearing rather than cosmetic. Hermes can call Claude/OpenAI models, so
 *  `model_name` is an actively misleading signal for "which CLI is this?" —
 *  agentOf() in web/src/lib/derive.ts checks `source_app` first, and this is
 *  what stops a Hermes session being misfiled as Claude or Codex. */
export const HERMES_APP = "hermes";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

/**
 * Hermes's own vocabulary for the panel mode.
 *
 * `default` means no extra flag — single-query Hermes denies approval prompts
 * it cannot show. `yolo` is `--yolo`, and only when the operator opted in via
 * Settings `chatBypass` (same gate Claude / Codex / Antigravity ride).
 */
export const DEFAULT_MODE = "default";
export const HERMES_BYPASS_ALLOWED = chatBypassAllowed();

/** How long a turn may produce nothing before we assume the CLI is stuck on
 *  something it cannot ask us for. Only ever armed before the first byte. */
const STARTUP_TIMEOUT_MS = Number(process.env.AGENTGLASS_HERMES_STARTUP_TIMEOUT_MS ?? 30_000);

const err = (msg: string, status = 400) => new Response(msg + "\n", { status, headers: CORS });

// Hermes session ids are `YYYYMMDD_HHMMSS_<hex>` (underscores). Claude's
// SESSION_RE rejects underscores, so Hermes has its own validator rather than
// silently dropping resume ids. Shape matches hermes_state_ids.SESSION_ID_PATTERN
// plus a trailing hex-ish token.
export const SESSION_RE = /^\d{8}_\d{6}_[A-Za-z0-9]{4,32}$/;
// Model ids often carry a slash (`provider/model`). Claude's MODEL_RE rejects
// `/`, so Hermes has its own — closer to shared/workerRoles.ts MODEL_RE.
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9_./:@-]{0,127}$/;

export const hermesModel = (v: unknown): string =>
  typeof v === "string" && MODEL_RE.test(v) ? v : "";
export const hermesSession = (v: unknown): string =>
  typeof v === "string" && SESSION_RE.test(v) ? v : "";

/** `yolo` is `--yolo`. Anything else, including a bypass the operator has not
 *  opted into, is spelled by leaving the flag off. */
export function hermesMode(mode: unknown, bypassAllowed = HERMES_BYPASS_ALLOWED): "default" | "yolo" {
  return mode === "yolo" && bypassAllowed ? "yolo" : "default";
}

/**
 * A last resort, not the source of truth.
 *
 * Reached when Hermes's config is missing or unreadable. Offering nothing would
 * make the panel look broken on a machine where `hermes` works fine. The id
 * must pass MODEL_RE so the send path would accept it.
 */
const FALLBACK_MODELS: AgentModel[] = [
  { id: "anthropic/claude-sonnet-4", label: "anthropic/claude-sonnet-4" },
];

/** Hermes home (`HERMES_HOME` or `~/.hermes`). Read-only — this module never
 *  writes config.yaml. */
function hermesHome(): string {
  const env = process.env.AGENTGLASS_HERMES_HOME?.trim() || process.env.HERMES_HOME?.trim();
  if (env) return env;
  return join(process.env.HOME || homedir(), ".hermes");
}

/** The model `hermes` will use when a turn names none — `model.default` (or
 *  the `model.model` / `model.name` aliases some configs use), if present and
 *  valid. */
export function hermesConfiguredModel(path = join(hermesHome(), "config.yaml")): string {
  try {
    const raw = readFileSync(path, "utf8");
    const section = /^model:\s*\n((?:[ \t]+[^\n]*\n?)*)/m.exec(raw)?.[1] ?? "";
    // Prefer `default`, then the aliases Hermes configs have been seen to use.
    for (const key of ["default", "model", "name"] as const) {
      const re = new RegExp(`^\\s+${key}:\\s*['"]?([^'"#\\s]+)`, "m");
      const value = re.exec(section)?.[1] ?? "";
      const id = hermesModel(value);
      if (id) return id;
    }
    return "";
  } catch { return ""; }
}

/**
 * The models the dropdown may offer.
 *
 * Hermes has no `hermes models` list like `agy models`; its catalogue is an
 * interactive picker. The panel therefore offers the configured default (or
 * the short FALLBACK), validated against MODEL_RE so the send path would not
 * then refuse a choice it offered.
 */
export function hermesModels(path?: string): AgentModel[] {
  const id = path ? hermesConfiguredModel(path) : hermesConfiguredModel();
  if (id) return [{ id, label: id }];
  return FALLBACK_MODELS;
}

// --- putting a chat on the radar --------------------------------------------

/** What a run needs to remember between frames to describe itself. */
export type FrameContext = {
  /** Filled from the `system/init` frame; every event before it has nowhere to go. */
  sessionId: string;
  model: string;
  /** Where the turn ran, and the repo that directory belongs to.
   *
   *  On every event rather than only the first, because this is what scopes a
   *  session to a project: db.ts lifts `project_path` and `cwd_path` out of the
   *  payload JSON, and the fleet list filters on them. */
  cwd: string;
  projectPath: string;
  /** tool_call_id → name, so a result that omits the name still pairs. */
  tools: Map<string, string>;
};

export const newFrameContext = (cwd = ""): FrameContext => ({
  sessionId: "", model: "", cwd, projectPath: cwd ? (repoRootOf(cwd) || cwd) : "", tools: new Map(),
});

const scope = (ctx: FrameContext) => ({
  source_app: HERMES_APP,
  session_id: ctx.sessionId,
  model_name: ctx.model || undefined,
});
const located = (ctx: FrameContext, payload: Record<string, unknown>) => ({
  ...payload,
  ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
  ...(ctx.projectPath ? { project_path: ctx.projectPath } : {}),
});

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The prompt is not a frame. Emitted once, after the session id is known. */
export function promptEvent(ctx: FrameContext, message: string): IngestBody | null {
  if (!ctx.sessionId || !hermesSession(ctx.sessionId)) return null;
  return {
    ...scope(ctx),
    hook_event_type: "UserPromptSubmit",
    payload: located(ctx, { prompt: message.slice(0, 20_000) }),
  };
}

/**
 * One Hermes stream-json frame as an event for the store, or null for the
 * frames that are not events (text deltas, unknowns).
 *
 * Pure, and exported for tests: the mapping is the whole of what makes a
 * Hermes chat visible in the fleet, and it is much easier to pin down here
 * than through a spawned CLI.
 *
 * Usage on `result` is per turn — this process answered once — so the store
 * adds it (Hermes's `tokens` look per-turn; add like Antigravity unless proven
 * cumulative).
 */
export function frameToEvent(frame: Record<string, unknown>, ctx: FrameContext): IngestBody | null {
  if (frame.type === "system" && frame.subtype === "init") {
    const id = hermesSession(frame.session_id);
    if (!id) return null;
    ctx.sessionId = id;
    const model = hermesModel(frame.model);
    if (model) ctx.model = model;
    return {
      ...scope(ctx),
      hook_event_type: "SessionStart",
      payload: located(ctx, { message: ctx.cwd }),
    };
  }

  if (frame.type === "tool_use") {
    if (!ctx.sessionId) return null;
    const name = typeof frame.name === "string" && frame.name ? frame.name : "tool";
    const id = typeof frame.tool_call_id === "string" && frame.tool_call_id
      ? frame.tool_call_id
      : `h${ctx.tools.size}`;
    ctx.tools.set(id, name);
    const input = frame.input && typeof frame.input === "object" ? frame.input as Record<string, unknown> : {};
    return {
      ...scope(ctx),
      hook_event_type: "PreToolUse",
      payload: located(ctx, { tool_name: name, tool_use_id: id, tool_input: input }),
    };
  }

  if (frame.type === "tool_result") {
    if (!ctx.sessionId) return null;
    const id = typeof frame.tool_call_id === "string" ? frame.tool_call_id : "";
    const name = typeof frame.name === "string" && frame.name ? frame.name : ctx.tools.get(id) ?? "";
    if (!name) return null;
    const output = typeof frame.output === "string" ? frame.output.slice(0, 20_000) : "";
    return {
      ...scope(ctx),
      hook_event_type: frame.is_error === true ? "PostToolUseFailure" : "PostToolUse",
      payload: located(ctx, { tool_name: name, tool_use_id: id || null, tool_response: output }),
    };
  }

  if (frame.type === "result") {
    const id = hermesSession(frame.session_id);
    if (id) ctx.sessionId = ctx.sessionId || id;
    if (!ctx.sessionId) return null;
    const tokens = frame.tokens && typeof frame.tokens === "object" ? frame.tokens as Record<string, unknown> : {};
    return {
      ...scope(ctx),
      hook_event_type: "Turn complete",
      payload: located(ctx, {
        usage: {
          input_tokens: num(tokens.input),
          output_tokens: num(tokens.output),
          cache_read_tokens: num(tokens.cache_read),
          cache_creation_tokens: num(tokens.cache_write),
        },
        message: typeof frame.error === "string" ? frame.error : "",
      }),
    };
  }

  // text deltas, unknowns: real frames the panel draws, but not fleet events.
  return null;
}

// --- driving a turn ---------------------------------------------------------

/**
 * The command line for one turn.
 *
 * Exported for tests, because the mode / resume / model mapping is the part
 * worth pinning: a regression here is silent rather than loud.
 *
 * The prompt goes in argv as `-q`'s value (single element — never shell-split).
 * The working directory is set on the spawn rather than with `--in`, matching
 * chat.ts / codex.ts / antigravity.ts.
 */
export function hermesArgs(bin: string, model: string, resumeId: string, mode: "default" | "yolo", message: string): string[] {
  // `--no-restore-cwd` is load-bearing: `--resume` otherwise chdirs to the
  // session DB's recorded cwd, which can escape the panel's safeAbs /
  // repoRootOf / inScope check already applied to the spawn cwd.
  const args = [bin, "chat", "-q", message, "--format", "stream-json", "--no-restore-cwd"];
  if (model) args.push("-m", model);
  if (resumeId) args.push("--resume", resumeId);
  if (mode === "yolo") args.push("--yolo");
  return args;
}

export function hermesStream(
  cwd: unknown,
  message: unknown,
  model: unknown,
  resumeId: unknown,
  mode: unknown,
  images?: unknown,
  emit?: (body: IngestBody) => void,
): Response {
  const bin = hermesBin();
  if (!bin) return err("no local `hermes` CLI — install Hermes Agent to chat", 403);
  if (process.env.AGENTGLASS_HERMES_DISABLED === "1") return err("hermes chat is disabled (AGENTGLASS_HERMES_DISABLED=1)", 403);
  const dir = safeAbs(cwd);
  if (!dir || !repoRootOf(dir)) {
    const cap = gitCapability();
    return err(cap.available ? "invalid or non-repo directory" : (cap.reason || "git is not installed"));
  }
  // A hermes turn runs real tools in this directory, so it gets the same
  // scope boundary a claude turn does.
  if (!inScope(dir)) return err("outside the open project — open the parent folder to work across repos", 403);
  // Hermes takes images as `--image` paths, not paste-bytes — same position
  // Codex / Antigravity are in, and refused for the same reason.
  if (Array.isArray(images) && images.length) return err("hermes chats cannot take pasted images yet — send the turn without it, or use a Claude chat");
  if (typeof message !== "string" || !message.trim() || message.length > 100_000) return err("invalid message");
  if (resumeId && !hermesSession(resumeId)) return err("invalid Hermes session id");
  if (model && !hermesModel(model)) return err("invalid Hermes model id");
  // Only pass `-m` when the panel picked an explicit model. Forcing the
  // hardcoded FALLBACK (or re-asserting the configured default) would override
  // a working Hermes config default the operator already set — match the
  // empty-model path hermesArgs already pins: omit `-m` and let Hermes decide.
  const m = hermesModel(model);
  const mo = hermesMode(mode);
  const rid = hermesSession(resumeId);

  const args = hermesArgs(bin, m, rid, mo, message);

  // Its own process group, so stopping a turn reaches the whole job tree —
  // Hermes spawns shells of its own, and killing only the direct child would
  // leave a test run or a dev server behind still working.
  const setsid = Bun.which("setsid");
  const proc = Bun.spawn(setsid ? [setsid, ...args] : args, {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  // Drained from the start, not after exit: a full stderr pipe blocks the child
  // forever. Readable mid-flight too — see drainStderr.
  const stderr = drainStderr(proc.stderr as ReadableStream<Uint8Array>);

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const ctx = newFrameContext(dir);
  if (m) ctx.model = m;
  let cancelled = false;

  /*
   * Frames go two places at once: out to the browser verbatim, and — split into
   * whole lines — through frameToEvent into the store.
   *
   * The tee is here rather than in the browser because what the fleet knows is
   * the server's business. A browser that parses its own frames for display is
   * one thing; a browser trusted to report what ran is another.
   */
  let pending = "";
  let prompted = false;
  const prompt = message;
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
        const frame = JSON.parse(line) as Record<string, unknown>;
        const ev = frameToEvent(frame, ctx);
        if (ev) emit(ev);
        if (!prompted && ctx.sessionId) {
          prompted = true;
          const row = promptEvent(ctx, prompt);
          if (row) emit(row);
        }
      } catch { /* a partial or non-JSON line is the browser's problem, not the store's */ }
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const stopKeepalive = startKeepalive(controller);
      /*
       * A first-run watchdog, for the same failure chat.ts / codex.ts /
       * antigravity.ts guard against: a Hermes that has never been configured
       * waits on something it cannot ask for here, so it emits nothing and
       * never exits, and the panel sits on a spinner that reads as agentglass
       * having hung.
       */
      let firstByte = false;
      const watchdog = setTimeout(() => {
        if (firstByte || cancelled) return;
        const hint = stderr.soFar().trim();
        try {
          controller.enqueue(enc.encode(JSON.stringify({
            type: "agx_error",
            code: null,
            errorType: "first_run_setup_required",
            setupCommand: "hermes setup",
            error: hint
              || `hermes produced no output in ${STARTUP_TIMEOUT_MS / 1000}s — it is probably waiting for a login or provider it can't ask for here. Run \`hermes setup\` (or \`hermes model\`) in a terminal, then try again.`,
          }) + "\n"));
        } catch { /* the client already went away */ }
        stopTree(proc, !!setsid); // the tree, not just the CLI
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
        const text = (await stderr.all).trim();
        controller.enqueue(enc.encode(JSON.stringify({ type: "agx_error", code, error: text || `hermes exited ${code}` }) + "\n"));
      }
      controller.close();
    },
    cancel() {
      cancelled = true;
      stopTree(proc, !!setsid); // the tree, not just the CLI
    },
  });

  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no", ...CORS } });
}

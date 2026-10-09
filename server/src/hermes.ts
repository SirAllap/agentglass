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
// Gated by AGENTGLASS_HERMES_DISABLED and by the chat bypass opt-in (see
// DEFAULT_MODE); cwd must be a git dir and inside the open project, the same
// boundary chat.ts, codex.ts and antigravity.ts hold.
// This module does not write ~/.hermes/config.yaml, open a pane, or touch ACP.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
import { safeAbs, repoRootOf, gitCapability } from "./git.ts";
import { inScopeReal, chatBypassAllowed } from "./config.ts";
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
export const HERMES_ENABLED = (): boolean =>
  !!hermesBin() && process.env.AGENTGLASS_HERMES_DISABLED !== "1" && chatBypassAllowed();

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
 * Hermes's own vocabulary for the panel mode, and why the whole engine sits
 * behind the bypass opt-in rather than only its `yolo` mode.
 *
 * There is no mode in which single-query Hermes asks before running code. With
 * no flag (`default`), `hermes chat -q` approves `execute_code` on its own and
 * only refuses the commands on its dangerous-pattern list, because nobody is
 * there to answer a prompt. `yolo` is `--yolo`, which runs those as well. Both
 * are unattended execution, which is exactly what `chatBypass` in config.json
 * (or AGENTGLASS_CHAT_BYPASS=1) opts into for Claude, Codex and Antigravity, so
 * without it Hermes is neither offered (HERMES_ENABLED) nor run (hermesStream).
 *
 * Read per call, like HERMES_ENABLED: an import-time snapshot kept a config.json
 * change from reaching this engine until a restart.
 */
export const DEFAULT_MODE = "default";
export const hermesBypassAllowed = (): boolean => chatBypassAllowed();

/** How long a turn may produce nothing before we assume the CLI is stuck on
 *  something it cannot ask us for. Only ever armed before the first byte. */
const STARTUP_TIMEOUT_MS = Number(process.env.AGENTGLASS_HERMES_STARTUP_TIMEOUT_MS ?? 30_000);

/** Under MAX_ARG_STRLEN (128 KiB) with room for `--query=`. */
export const MAX_MESSAGE_BYTES = 120_000;

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
export function hermesMode(mode: unknown, bypassAllowed = hermesBypassAllowed()): "default" | "yolo" {
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

/**
 * The Hermes home a turn will use. Read-only — this module never writes in it.
 *
 * `AGENTGLASS_HERMES_HOME`, else `HERMES_HOME`, else `~/.hermes`; and then the
 * sticky profile, the way `hermes` itself resolves it at startup: a root (not
 * already a `profiles/<name>` dir) whose `active_profile` names another profile
 * means that profile's directory. The spawn pins the child's HERMES_HOME to
 * this value, so the state.db the resume check reads is the one Hermes opens.
 *
 * Which `active_profile` is read follows hermes_constants.get_default_hermes_root:
 * a home anywhere under `~/.hermes` takes the sticky profile of `~/.hermes`
 * itself, not its own; a home elsewhere takes its own.
 * Exported for tests.
 */
export function hermesHome(env: Record<string, string | undefined> = process.env): string {
  const native = join(env.HOME || homedir(), ".hermes");
  const root = env.AGENTGLASS_HERMES_HOME?.trim() || env.HERMES_HOME?.trim() || native;
  if (basename(dirname(root)) === "profiles") return root;
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const r = real(root), n = real(native);
  const base = r === n || r.startsWith(n + sep) ? native : root;
  try {
    const name = readFileSync(join(base, "active_profile"), "utf8").replace(/^\uFEFF/, "").trim();
    if (name && name !== "default" && /^[A-Za-z0-9_.-]{1,64}$/.test(name) && !name.startsWith(".")) {
      return join(base, "profiles", name);
    }
  } catch { /* no sticky profile */ }
  return root;
}

/**
 * Why a resume must not run as asked, or null when it may.
 *
 * Read in Hermes upstream at e0550c97bbd916cd5ff8fa0450e6291c31921b94
 * (hermes_cli/cli_agent_setup_mixin.py, `_load_resumed_history_late` →
 * `_restore_session_state`): `hermes chat -q … --resume <id>` restores two things from
 * the session's row in `<HERMES_HOME>/state.db`, whatever this turn asked for.
 *
 *  - The directory. `_restore_session_cwd` chdirs to the row's `cwd`, and
 *    `--no-restore-cwd` does not stop it — that flag only guards an earlier
 *    chdir in hermes_cli/main.py. A session id names a row; nothing ties it to
 *    the directory this server just checked, so a resume could run the turn
 *    in a repo outside the open project.
 *  - Bypass. A `--yolo` launch or a `/yolo` toggle stores `yolo_mode: true` in
 *    the row's `model_config`, and `_restore_session_yolo` turns it back on, so
 *    a chat switched back from Bypass would go on running everything.
 *
 * So the row is read first, with the compression continuations Hermes follows
 * to (`parent_session_id`), and the turn is refused when any of them recorded
 * another directory, or Bypass while this turn is not Bypass. A row it cannot
 * read is a refusal too: the check exists because the answer matters.
 *
 * `yolo_mode` is read the way Hermes reads it, `bool(...)` in Python, so `1`,
 * `"true"` and even `"false"` are Bypass too; and a row whose `cwd` is not an
 * absolute path is refused, because Hermes resolves it against the spawn
 * directory and this check could not see the same place.
 *
 * Ceiling: this checks the rows. Two settings in Hermes's own config.yaml also
 * decide what runs, and both are the operator's and are not overridden here:
 * `approvals.mode: off` is Bypass for every turn, and
 * `approvals.single_query_mode: approve` makes a default single-query turn run
 * the flagged commands it would otherwise refuse. Exported for tests.
 */
/** Python's `bool(v)` for a value that came out of `json.loads`. */
const pyTruthy = (v: unknown): boolean =>
  !(v == null || v === false || v === 0 || v === ""
    || (Array.isArray(v) ? !v.length : typeof v === "object" && !Object.keys(v as object).length));

export function hermesResumeRefusal(
  id: string, dir: string, mode: "default" | "yolo", dbPath = join(hermesHome(), "state.db"),
): string | null {
  type Row = { id: string; cwd: string | null; model_config: string | null };
  let rows: Row[];
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      rows = db.query(`
        WITH RECURSIVE chain(id) AS (
          SELECT id FROM sessions WHERE id = ?1
          UNION SELECT s.id FROM sessions s JOIN chain c ON s.parent_session_id = c.id
        )
        SELECT s.id, s.cwd, s.model_config FROM sessions s JOIN chain c ON s.id = c.id
      `).all(id) as Row[];
    } finally { db.close(); }
  } catch {
    return "cannot read Hermes's session store to confirm where this session would resume — start a new chat";
  }
  if (!rows.length) return "Hermes has no session with that id — start a new chat";
  const real = (p: string) => { try { return realpathSync(p); } catch { return null; } };
  const here = real(dir);
  for (const r of rows) {
    const cwd = (r.cwd ?? "").trim();
    if (cwd && (!isAbsolute(cwd) || !here || real(cwd) !== here)) {
      return "this Hermes session belongs to another directory, and resuming it would move the turn there — start a new chat here";
    }
    let yolo = false;
    // A config this side cannot parse counts as Bypass: Python's json also
    // reads NaN and Infinity, which JSON.parse refuses, so "unparseable here"
    // is not "off there" — the same fail-closed rule as an unreadable store.
    try { yolo = pyTruthy((JSON.parse(r.model_config || "{}") as { yolo_mode?: unknown })?.yolo_mode); } catch { yolo = true; }
    if (yolo && mode !== "yolo") {
      return "this Hermes session ran in Bypass, and Hermes turns that back on when it resumes — keep Bypass or start a new chat";
    }
  }
  return null;
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
 * The prompt goes in argv as one `--query=<text>` element, never shell-split
 * and never a separate element: argparse reads a separate value that starts
 * with `-` as the next flag, so a prompt like "-m evil" would have stopped
 * being the prompt.
 * The working directory is set on the spawn rather than with `--in`, matching
 * chat.ts / codex.ts / antigravity.ts.
 */
export function hermesArgs(bin: string, model: string, resumeId: string, mode: "default" | "yolo", message: string): string[] {
  // `--no-restore-cwd` stops the chdir hermes_cli/main.py makes before the
  // agent starts. It is not enough on its own: the resume path restores the
  // row's cwd again later, which is why hermesStream checks the row first —
  // see hermesResumeRefusal.
  const args = [bin, "chat", `--query=${message}`, "--format", "stream-json", "--no-restore-cwd"];
  if (model) args.push("-m", model);
  if (resumeId) args.push("--resume", resumeId);
  if (mode === "yolo") args.push("--yolo");
  return args;
}

/**
 * The environment a Hermes turn starts with.
 *
 * Hermes runs code unattended (see DEFAULT_MODE), so whatever is in this
 * environment is something that code can read. Two things are taken out:
 *
 *  - AGENTGLASS_TOKEN, the credential for this very server. Handed over, it
 *    would let code the model wrote drive the shell, git and every other route
 *    here. Ceiling: this removes the free copy, not the reach. The child runs
 *    as the same user, so it can read the token file, and on a tokenless
 *    loopback install it needs no token at all.
 *  - HERMES_YOLO_MODE, which Hermes reads at import as "--yolo for this
 *    process". Inherited from whoever started agentglass, it would turn every
 *    turn into Bypass whatever the panel says. It is set only when the turn is
 *    Bypass, and then --yolo says the same thing.
 *  - The markers of a Hermes gateway, cron or other session context
 *    (`_HERMES_GATEWAY`, `HERMES_*_SESSION`). With `_HERMES_GATEWAY=1` Hermes
 *    keeps an inherited TERMINAL_CWD instead of the process cwd, so an
 *    agentglass started from inside Hermes would run its tools outside the
 *    checked directory. The spawn also sets TERMINAL_CWD to that directory.
 *
 * Exported for tests.
 */
export function hermesEnv(base: Record<string, string | undefined>, mode: "default" | "yolo"): Record<string, string | undefined> {
  const { AGENTGLASS_TOKEN: _token, HERMES_YOLO_MODE: _yolo, _HERMES_GATEWAY: _gw, ...env } = base;
  for (const k of Object.keys(env)) if (/^HERMES_\w+_SESSION$/.test(k)) delete env[k];
  return mode === "yolo" ? { ...env, HERMES_YOLO_MODE: "1" } : env;
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
  // Not a nicety on top of HERMES_ENABLED: the route is reachable without the
  // panel, and the panel is not what decides whether code runs unattended.
  if (!hermesBypassAllowed()) return err("hermes chat runs code without asking, so it needs the chat bypass opt-in (`chatBypass` in config.json, or AGENTGLASS_CHAT_BYPASS=1)", 403);
  const dir = safeAbs(cwd);
  if (!dir || !repoRootOf(dir)) {
    const cap = gitCapability();
    return err(cap.available ? "invalid or non-repo directory" : (cap.reason || "git is not installed"));
  }
  // A hermes turn runs real tools in this directory, so it gets the same
  // scope boundary a claude turn does — inScopeReal, as /chat/send uses: a
  // symlink inside the project that points out of it is not inside it.
  if (!inScopeReal(dir)) return err("outside the open project — open the parent folder to work across repos", 403);
  // Hermes takes images as `--image` paths, not paste-bytes — same position
  // Codex / Antigravity are in, and refused for the same reason.
  if (Array.isArray(images) && images.length) return err("hermes chats cannot take pasted images yet — send the turn without it, or use a Claude chat");
  if (typeof message !== "string" || !message.trim()) return err("invalid message");
  // The prompt is one argv element, and the kernel refuses an element over
  // 128 KiB (MAX_ARG_STRLEN) or with a NUL in it: Bun.spawn would throw inside
  // the route and the panel would get a bare 500. Counted in UTF-8 bytes,
  // since that is what reaches the kernel — 100k CJK characters are ~300 KB.
  if (message.includes("\0")) return err("the message contains a NUL byte, which a command line cannot carry");
  if (Buffer.byteLength(message) > MAX_MESSAGE_BYTES) return err(`the message is over ${MAX_MESSAGE_BYTES / 1000} KB, more than one Hermes turn can take`, 413);
  if (resumeId && !hermesSession(resumeId)) return err("invalid Hermes session id");
  if (model && !hermesModel(model)) return err("invalid Hermes model id");
  // Only pass `-m` when the panel picked an explicit model. Forcing the
  // hardcoded FALLBACK (or re-asserting the configured default) would override
  // a working Hermes config default the operator already set — match the
  // empty-model path hermesArgs already pins: omit `-m` and let Hermes decide.
  const m = hermesModel(model);
  const mo = hermesMode(mode);
  const rid = hermesSession(resumeId);

  // Resolved once: the resume check and the child must agree on it.
  const home = hermesHome();
  if (rid) {
    const why = hermesResumeRefusal(rid, dir, mo, join(home, "state.db"));
    if (why) return err(why, 403);
  }

  const args = hermesArgs(bin, m, rid, mo, message);

  // Its own process group, so stopping a turn reaches the whole job tree —
  // Hermes spawns shells of its own, and killing only the direct child would
  // leave a test run or a dev server behind still working.
  const setsid = Bun.which("setsid");
  const proc = Bun.spawn(setsid ? [setsid, ...args] : args, {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    // HERMES_HOME pinned to the home hermesResumeRefusal read, so the check and
    // the resume look at the same state.db.
    env: { ...hermesEnv(process.env, mo), HERMES_HOME: home, TERMINAL_CWD: dir },
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

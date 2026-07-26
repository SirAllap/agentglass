// Multi-chat — drive Claude Code sessions from the browser. The local server
// runs `claude -p --output-format stream-json` in a chosen repo/worktree and
// streams the JSONL events straight back; the web ChatPanel parses them. First
// turn starts a new session (its id comes back in the `system/init` event);
// follow-ups pass `--resume <id>`. The permission mode is the user's choice —
// plan (no execution) → default/acceptEdits → bypass (runs everything). Unlike
// the walkthrough this is NOT marked internal: a chat you start SHOULD appear
// in the fleet. Gated by AGENTGLASS_CHAT_DISABLED; cwd must be a git dir.
//
// A turn is normally written to stdin as plain text. When the user has pasted
// images the turn goes out as `--input-format stream-json` instead — one JSON
// line carrying text and image content blocks together, which is the only
// channel structured content has into a `claude -p` run.
import { safeAbs, repoRootOf, gitCapability } from "./git.ts";
import { inScope, chatBypassAllowed } from "./config.ts";
import { paneTurnStream, paneEngineCapability } from "./chatpane.ts";
import type { ChatImage, ChatImageMediaType } from "../../shared/types.ts";

const claudeBin = () => Bun.which("claude");
export const CHAT_ENABLED = !!claudeBin();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};
const MODES = new Set(["default", "plan", "acceptEdits", "bypassPermissions"]);
// `bypassPermissions` launches `claude --dangerously-skip-permissions`: full
// unattended autonomy driven straight from a browser request. That is too much
// to hand out on the same-origin check alone, so it is off unless the operator
// explicitly opts in; otherwise the mode is downgraded to a prompting default.
// The opt-in lives in config.ts because it has to be reachable from both
// surfaces — a .env only reaches a server started from a checkout.
export const CHAT_BYPASS_ALLOWED = chatBypassAllowed();
const BYPASS_ALLOWED = CHAT_BYPASS_ALLOWED;
/** How long a turn may produce nothing at all before we assume the CLI is stuck
 *  on something it can't ask us for. Only ever armed before the first byte. */
const STARTUP_TIMEOUT_MS = Number(process.env.AGENTGLASS_CHAT_STARTUP_TIMEOUT_MS ?? 20_000);
// A model id, with the optional window suffix Claude Code uses to ask for the
// 1M context window: `claude-opus-4-8[1m]`. The suffix has to be allowed
// through rather than sanitised away, because stripping it silently downgraded
// the window a chat had asked for and the UI still measured against whatever
// the name implied.
//
// It buys less than it once did, and only in specific places. On the
// first-party API the Claude 5 family and Opus 4.7+ run at 1M unconditionally,
// so the suffix is a no-op there. It still decides the window behind an LLM
// gateway, on Bedrock / Vertex / Foundry, and for Opus 4.6 — which is why it
// survives here rather than being dropped now that `contextWindow.ts` knows
// the families outright.
const MODEL_RE = /^[a-z0-9][a-z0-9.-]{2,48}(\[[a-z0-9]{1,8}\])?$/;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,64}$/;

// A pre-approved tool spec, e.g. `Read`, `Edit`, `Bash(git status)`,
// `Bash(gh pr view:*)`. Deliberately narrow: letters for the tool name, and an
// optional parenthesised argument pattern built from the characters those specs
// actually use. Anything else is dropped rather than passed through, since this
// string ends up shaping what the agent may run unattended.
const TOOL_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}(\([^()\n]{1,120}\))?$/;
const MAX_ALLOWED = 40;

/** Tool specs the user has pre-approved for this chat.
 *
 *  `claude -p` has no terminal to prompt from, so a tool that would normally
 *  raise a permission dialog is simply refused — the chat reports "requires
 *  approval" and there is no way to grant it from inside. This is the way out:
 *  the caller says up front what may run without asking. */
export function allowList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((t): t is string => typeof t === "string" && TOOL_RE.test(t.trim())).map((t) => t.trim()).slice(0, MAX_ALLOWED);
}
// --- pasted images ----------------------------------------------------------
// These bounds exist because /chat/send accepts arbitrary binary from a browser
// request, and every byte is held in memory twice (base64 in the JSON body, and
// again in the stdin line handed to `claude`).
//
// Four images per turn covers what a person actually pastes — a screenshot, or
// a before/after pair, with room to spare — while keeping a single turn's worth
// of buffering bounded. Five megabytes per image matches the Anthropic API's own
// per-image ceiling, so a larger one could not be answered anyway. Ten megabytes
// total is the real backstop: it caps a turn at roughly 13MB of base64 regardless
// of how the per-image budget is spent.
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES_TOTAL_BYTES = 10 * 1024 * 1024;

// The media types `claude` accepts for an image block. A type outside this set
// is refused here rather than passed through, since the client's label is the
// only thing that would otherwise decide how the bytes get interpreted.
const MEDIA_TYPES = new Set<string>(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Sniff the real media type from the leading bytes.
 *
 *  The client's declared type is a label, not evidence — a `image/png` claim
 *  over a payload that is something else entirely would still be forwarded
 *  verbatim to the model. These signatures are a few bytes each, so checking is
 *  cheap enough to do unconditionally, and it is what makes the declared type
 *  trustworthy rather than merely allowlisted. */
export function sniffMediaType(b: Uint8Array): ChatImageMediaType | null {
  const at = (i: number) => b[i];
  if (b.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47
    && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return "image/png";
  if (b.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  // "GIF87a" / "GIF89a" — the version digit differs, the rest does not.
  if (b.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "image/gif";
  // WebP is a RIFF container: "RIFF" <4-byte size> "WEBP".
  if (b.length >= 12 && at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46
    && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return "image/webp";
  return null;
}

/** Images attached to this turn, or `null` if the payload is unusable.
 *
 *  Returning `null` rather than silently dropping matters here: quietly sending
 *  a turn without the screenshot it was written about produces a confusing
 *  answer, which is worse than an error saying the attachment was rejected. */
export function chatImages(v: unknown): ChatImage[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  if (v.length > MAX_IMAGES) return null;
  const out: ChatImage[] = [];
  let total = 0;
  for (const raw of v) {
    if (!raw || typeof raw !== "object") return null;
    const { mediaType, data } = raw as Record<string, unknown>;
    if (typeof mediaType !== "string" || !MEDIA_TYPES.has(mediaType)) return null;
    if (typeof data !== "string" || !data) return null;
    // Bound the encoded length before decoding — decoding first would mean
    // materialising whatever size the client chose to send just to discover it
    // was too big, which is the denial-of-service this cap exists to prevent.
    if (data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) return null;
    if (!BASE64_RE.test(data)) return null;
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0)); } catch { return null; }
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;
    total += bytes.length;
    if (total > MAX_IMAGES_TOTAL_BYTES) return null;
    // The declared type has to match the bytes, not merely be allowlisted.
    if (sniffMediaType(bytes) !== mediaType) return null;
    out.push({ mediaType: mediaType as ChatImageMediaType, data });
  }
  return out;
}

const err = (msg: string, status = 400) => new Response(msg + "\n", { status, headers: CORS });

// --- keepalive --------------------------------------------------------------
// How often a turn that is producing nothing still writes something.
//
// A turn goes quiet for as long as the model thinks or a tool runs, and both the
// server's own idleTimeout (255s, its ceiling) and any proxy in front of it drop
// a connection that has been silent too long. A blank line is the cheapest thing
// that resets those timers: the ndjson framing makes it a no-op, and both this
// server's client and any other line reader skip an empty line already, so it
// costs one byte and needs no handling on the far end.
const KEEPALIVE_MS = 20_000;

/** Write a blank ndjson line to `controller` every `ms` until the returned
 *  function is called.
 *
 *  Exported for tests: the surrounding turn cannot be exercised without spawning
 *  a real `claude`, so the keepalive is pinned on its own. `enqueue` throws once
 *  the stream is closed or cancelled, which is a race the timer cannot avoid —
 *  losing that race simply means the stream is over, so it stops rather than
 *  surfacing an unhandled rejection. */
export function startKeepalive(controller: { enqueue: (c: Uint8Array) => void }, ms = KEEPALIVE_MS): () => void {
  const nl = new TextEncoder().encode("\n");
  const timer = setInterval(() => {
    try { controller.enqueue(nl); } catch { clearInterval(timer); }
  }, ms);
  return () => clearInterval(timer);
}

/** The stdin line for a turn that carries image blocks.
 *
 *  This envelope is not guesswork: it is the shape `claude` itself writes when
 *  it injects a user message into its own structured-input stream, and the shape
 *  its stdin reader validates on the way back in — the reader accepts a line
 *  whose `type` is `user` and whose `message.role` is `user`, and rejects
 *  anything else with "Expected message role 'user'". `content` is passed
 *  through to the API untouched, which is what lets it be an array of blocks
 *  rather than a bare string.
 *
 *  Exported for tests: this is the one part of the feature that cannot be
 *  checked without spending money on a real turn, so it is pinned here instead. */
export function turnEnvelope(text: string, images: ChatImage[]): string {
  const content: Array<Record<string, unknown>> = [];
  if (text) content.push({ type: "text", text });
  for (const img of images) {
    content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
  }
  return JSON.stringify({
    type: "user",
    session_id: "",
    message: { role: "user", content },
    parent_tool_use_id: null,
  }) + "\n";
}

/** A turn that passed every check, or the refusal to send back instead.
 *
 *  Extracted so both engines validate identically. The scope boundary in
 *  particular is not something a second engine may reimplement and drift on: a
 *  chat runs a real `claude` with tools in that directory, so the check below is
 *  the whole of what keeps "open project" from being decorative. */
export type TurnPlan =
  | { ok: false; response: Response }
  | { ok: true; dir: string; text: string; model: string; mode: string; resumeId: string; images: ChatImage[]; allow: string[] };

export function planTurn(cwd: unknown, message: unknown, model: unknown, resumeId: unknown, mode: unknown, allowedTools?: unknown, images?: unknown): TurnPlan {
  const no = (r: Response): TurnPlan => ({ ok: false, response: r });
  if (!claudeBin()) return no(err("no local `claude` CLI: install Claude Code to chat (Settings ▸ Requirements lists it, with the install guide)", 403));
  if (process.env.AGENTGLASS_CHAT_DISABLED === "1") return no(err("chat is disabled (AGENTGLASS_CHAT_DISABLED=1)", 403));
  const dir = safeAbs(cwd);
  if (!dir || !repoRootOf(dir)) {
    // With no git, repoRootOf fails for every directory — name the real cause
    // rather than blaming the folder.
    const cap = gitCapability();
    return no(err(cap.available ? "invalid or non-repo directory" : (cap.reason || "git is not installed")));
  }
  // The last write path still outside the scope boundary (#67 covered git and
  // the terminal). A chat runs a real `claude` with tools in that directory, so
  // it can change anything a shell could — leaving it machine-wide would have
  // made the boundary decorative in exactly the place it matters most.
  if (!inScope(dir)) return no(err("outside the open project — open the parent folder to work across repos", 403));
  const imgs = chatImages(images);
  if (!imgs) return no(err("invalid image attachment"));
  if (typeof message !== "string" || message.length > 100_000) return no(err("invalid message"));
  // An image on its own is a complete thought ("what's wrong with this?"), so a
  // turn only needs text when it carries nothing else.
  if (!message.trim() && !imgs.length) return no(err("invalid message"));
  // Keep in step with DEFAULT_MODEL in web/src/lib/chatStore.ts — this is the
  // same default, reached when a caller sends no model or a malformed one.
  const m = typeof model === "string" && MODEL_RE.test(model) ? model : "claude-opus-5";
  let pm = typeof mode === "string" && MODES.has(mode) ? mode : "default";
  if (pm === "bypassPermissions" && !BYPASS_ALLOWED) pm = "default"; // opt-in only
  const rid = typeof resumeId === "string" && SESSION_RE.test(resumeId) ? resumeId : "";
  const allow = pm === "bypassPermissions" ? [] : allowList(allowedTools);
  return { ok: true, dir, text: message, model: m, mode: pm, resumeId: rid, images: imgs, allow };
}

/** Which engine a chat uses when the request does not say.
 *
 *  `process` — the original: one `claude -p` per turn, nothing left running.
 *  `tmux`    — one interactive `claude` per chat, alive in a pane of our own
 *              tmux server, resumable from the user's terminal.
 *
 *  The default stays `process` because the pane engine trades memory for
 *  latency (a warm CLI is ~380MB and climbs), and that is a bargain the operator
 *  should strike deliberately rather than discover. */
export const CHAT_ENGINE_DEFAULT = process.env.AGENTGLASS_CHAT_ENGINE === "tmux" ? "tmux" : "process";

/** Route one turn to the engine it asked for.
 *
 *  Validation happens once, before the split, so neither engine can be reached
 *  with a directory the other would have refused. */
export function chatSend(b: Record<string, unknown>): Response {
  const plan = planTurn(b.cwd, b.message, b.model, b.resumeId, b.mode, b.allowedTools, b.images);
  if (!plan.ok) return plan.response;
  const want = b.engine === "tmux" || b.engine === "process" ? b.engine : CHAT_ENGINE_DEFAULT;
  if (want !== "tmux") return chatStreamPlanned(plan);
  const cap = paneEngineCapability();
  // Falling back silently would be the wrong kindness: the whole point of the
  // pane engine is that the session is attachable from a terminal, and a chat
  // that quietly is not would be discovered at the worst moment. Say so.
  if (!cap.available) return err(`tmux chat panes unavailable — ${cap.reason}`, 409);
  return paneTurnStream({
    cwd: plan.dir,
    message: plan.text,
    model: plan.model,
    mode: plan.mode,
    // A chat with no session yet gets its id decided here rather than discovered
    // from the CLI: the pane has to be named something before it is launched,
    // and `--session-id` is what makes the two agree.
    sessionId: plan.resumeId || crypto.randomUUID(),
    images: plan.images,
  });
}

export function chatStream(cwd: unknown, message: unknown, model: unknown, resumeId: unknown, mode: unknown, allowedTools?: unknown, images?: unknown): Response {
  const plan = planTurn(cwd, message, model, resumeId, mode, allowedTools, images);
  if (!plan.ok) return plan.response;
  return chatStreamPlanned(plan);
}

function chatStreamPlanned(plan: Extract<TurnPlan, { ok: true }>): Response {
  const bin = claudeBin()!;
  const { dir, text: msgText, model: m, mode: pm, resumeId: rid, images: imgs } = plan;

  const args = [bin, "-p", "--output-format", "stream-json", "--verbose", "--model", m];
  // Structured input is only switched on for a turn that actually needs it.
  // Plain text is the overwhelmingly common case and its path through `claude`
  // is the well-trodden one; `--input-format stream-json` is comparatively
  // undocumented, so a turn with nothing to gain from it keeps the old
  // behaviour byte for byte rather than riding a newer code path for free.
  if (imgs.length) args.push("--input-format", "stream-json");
  if (pm === "bypassPermissions") args.push("--dangerously-skip-permissions");
  else args.push("--permission-mode", pm);
  // Only meaningful for the prompting modes — bypass already allows everything.
  if (plan.allow.length) args.push("--allowedTools", ...plan.allow);
  if (rid) args.push("--resume", rid);

  // Its own process group, so stopping a turn reaches the whole job tree.
  // `claude` spawns tools of its own — a test run, a dev server — and killing
  // only the direct child would leave those behind still doing work.
  const setsid = Bun.which("setsid");
  const proc = Bun.spawn(setsid ? [setsid, ...args] : args, {
    cwd: dir,
    stdin: new TextEncoder().encode(imgs.length ? turnEnvelope(msgText.trim(), imgs) : msgText),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  // Drain stderr from the start rather than after the process exits. A pipe
  // holds ~64KB; once it's full the child blocks on write and never exits, so
  // waiting on exit first is a deadlock the moment claude gets talkative
  // (an MCP warning, a stack trace). It also has to be consumed on the success
  // path or the fd leaks for every turn.
  const stderrText = new Response(proc.stderr as ReadableStream<Uint8Array>).text().catch(() => "");

  const enc = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const stopKeepalive = startKeepalive(controller);
      /*
       * A first-run watchdog.
       *
       * A `claude` that has never been logged in blocks on an interactive
       * auth prompt it can never receive — there is no terminal here. It emits
       * nothing, exits never, and the panel sits on a spinner forever, which
       * reads as agentglass having hung rather than as a CLI waiting for a
       * login. Same shape for an unaccepted EULA or a broken install.
       *
       * So: if the process hasn't said a single word within the window, stop
       * waiting and say what to do about it. Armed only until the first byte —
       * a turn that takes ten minutes of thinking is fine, and common.
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
            setupCommand: "claude",
            error: hint
              || `claude produced no output in ${STARTUP_TIMEOUT_MS / 1000}s — it is probably waiting for a login it can't ask for here. Run \`claude\` once in a terminal to sign in, then try again.`,
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
          if (value) { firstByte = true; clearTimeout(watchdog); controller.enqueue(value); }
        }
      } catch { /* closed */ }
      clearTimeout(watchdog);
      stopKeepalive();
      const code = await proc.exited;
      // The reader loop ends on cancel too, and a cancelled controller throws
      // on enqueue/close — which would surface as an unhandled rejection on
      // every "stop" the user presses.
      if (cancelled) return;
      if (code !== 0) {
        const text = (await stderrText).trim();
        controller.enqueue(enc.encode(JSON.stringify({ type: "agx_error", code, error: text || `claude exited ${code}` }) + "\n"));
      }
      controller.close();
    },
    cancel() {
      cancelled = true;
      try {
        if (setsid) process.kill(-proc.pid, "SIGTERM"); // the group, not just claude
        else proc.kill();
      } catch { /* gone */ }
    },
  });

  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no", ...CORS } });
}

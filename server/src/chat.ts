// Multi-chat — drive Claude Code sessions from the browser. The local server
// runs `claude -p --output-format stream-json` in a chosen repo/worktree and
// streams the JSONL events straight back; the web ChatPanel parses them. First
// turn starts a new session (its id comes back in the `system/init` event);
// follow-ups pass `--resume <id>`. The permission mode is the user's choice —
// plan (no execution) → default/acceptEdits → bypass (runs everything). Unlike
// the walkthrough this is NOT marked internal: a chat you start SHOULD appear
// in the fleet. Gated by AGENTGLASS_CHAT_DISABLED; cwd must be a git dir.
import { safeAbs, repoRootOf } from "./git.ts";

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
export const CHAT_BYPASS_ALLOWED = process.env.AGENTGLASS_CHAT_BYPASS === "1";
const BYPASS_ALLOWED = CHAT_BYPASS_ALLOWED;
const MODEL_RE = /^[a-z0-9][a-z0-9.-]{2,48}$/;
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
const err = (msg: string, status = 400) => new Response(msg + "\n", { status, headers: CORS });

export function chatStream(cwd: unknown, message: unknown, model: unknown, resumeId: unknown, mode: unknown, allowedTools?: unknown): Response {
  const bin = claudeBin();
  if (!bin) return err("no local `claude` CLI — install Claude Code to chat", 403);
  if (process.env.AGENTGLASS_CHAT_DISABLED === "1") return err("chat is disabled (AGENTGLASS_CHAT_DISABLED=1)", 403);
  const dir = safeAbs(cwd);
  if (!dir || !repoRootOf(dir)) return err("invalid or non-repo directory");
  if (typeof message !== "string" || !message.trim() || message.length > 100_000) return err("invalid message");
  const m = typeof model === "string" && MODEL_RE.test(model) ? model : "claude-opus-4-8";
  let pm = typeof mode === "string" && MODES.has(mode) ? mode : "default";
  if (pm === "bypassPermissions" && !BYPASS_ALLOWED) pm = "default"; // opt-in only
  const rid = typeof resumeId === "string" && SESSION_RE.test(resumeId) ? resumeId : "";

  const args = [bin, "-p", "--output-format", "stream-json", "--verbose", "--model", m];
  if (pm === "bypassPermissions") args.push("--dangerously-skip-permissions");
  else args.push("--permission-mode", pm);
  // Only meaningful for the prompting modes — bypass already allows everything.
  const allow = pm === "bypassPermissions" ? [] : allowList(allowedTools);
  if (allow.length) args.push("--allowedTools", ...allow);
  if (rid) args.push("--resume", rid);

  // Its own process group, so stopping a turn reaches the whole job tree.
  // `claude` spawns tools of its own — a test run, a dev server — and killing
  // only the direct child would leave those behind still doing work.
  const setsid = Bun.which("setsid");
  const proc = Bun.spawn(setsid ? [setsid, ...args] : args, {
    cwd: dir,
    stdin: new TextEncoder().encode(message),
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
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) controller.enqueue(value);
        }
      } catch { /* closed */ }
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

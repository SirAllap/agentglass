// Antigravity's wire vocabulary, folded into the same conversation the Claude
// and Codex paths build.
//
// `agy -p … --output-format stream-json` streams a JSONL whose envelope names
// itself with `event` rather than `type`: an `init` naming the conversation, a
// run of `step_update` frames each carrying one typed step, and a `result`
// closing the turn. Nothing about that shape resembles either of the other two,
// but everything it says maps onto fields `ChatMsg` / `ChatTool` / `ChatUsage`
// already have — which is what lets one panel render all three without a branch
// anywhere below the store.
//
// This is the whole translation. The server passes the frames through untouched
// (server/src/antigravity.ts) precisely so it lives in one file.
import type { Chat, ChatTool, ChatUsage } from "./chatStore.ts";

const strv = (v: unknown) => (typeof v === "string" && v ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Tool output is rendered in a chip; a `cat` of a large file is not worth
 *  holding in memory, let alone drawing. Matches codexFrames.ts and the
 *  transcript clipping in chatPersist.ts. */
const MAX_OUTPUT = 20_000;
const clip = (s: string) => (s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n[trimmed]" : s);

/**
 * What to call an Antigravity tool in the tool strip.
 *
 * Deliberately Claude's names where one exists, exactly as codexFrames.ts does:
 * the chip renderer, the tool mix chart and the session timeline all key off
 * these, and a `view_file` drawing as its own category would split "reads" into
 * two columns that mean the same thing. Anything without a counterpart keeps
 * Antigravity's own name rather than being forced into an approximate one.
 */
const TOOL_ALIASES: Record<string, string> = {
  view_file: "Read",
  read_url_content: "WebFetch",
  write_to_file: "Write",
  replace_file_content: "Edit",
  multi_replace_file_content: "Edit",
  sed_file: "Edit",
  run_command: "Bash",
  grep_search: "Grep",
  find_by_name: "Glob",
  list_dir: "Glob",
  search_web: "WebSearch",
  manage_task: "TodoWrite",
  invoke_subagent: "Task",
  browser_subagent: "Task",
};
const toolName = (raw: string): string => TOOL_ALIASES[raw] ?? raw;

/**
 * What a step acted on — the thing the chip shows next to the name.
 *
 * `tool_info.parameters` is Antigravity's argument bag, and its keys are
 * PascalCase (`DirectoryPath`, `AbsolutePath`). Rather than enumerate every
 * tool's schema, the first plausibly path-or-command-shaped value wins, which
 * is what the chip needs and degrades to "no target" rather than to a wrong one.
 */
function toolTarget(params: Record<string, unknown>): string | null {
  const PREFERRED = ["AbsolutePath", "TargetFile", "FilePath", "DirectoryPath", "Command", "Query", "SearchTerm", "Url"];
  for (const k of PREFERRED) {
    const v = strv(params[k]);
    if (v) return v.slice(0, 300);
  }
  for (const v of Object.values(params)) {
    const s = strv(v);
    if (s) return s.slice(0, 300);
  }
  return null;
}

/**
 * What the thread has spent.
 *
 * The important difference from the Codex path, and the one that bites if you
 * assume otherwise: **these figures are per turn, not cumulative for the
 * thread.** Measured rather than inferred — turn 1 of a conversation reported
 * 31789 input tokens and turn 2 reported 16609, which cannot be a running
 * total. So they are added, exactly as the Claude path adds, where Codex's
 * must be assigned. The two streams look alike here and mean opposite things.
 *
 * `contextTokens` stays zero, which suppresses the context meter for an
 * Antigravity chat. The stream reports no window, and `ctxLimitOf` does not
 * know the Gemini 3.x families — so a bar drawn here would fall back to a
 * default ceiling and state a fullness nobody measured. contextWindow.ts is
 * explicit that over-reading is the unrecoverable direction. No meter is better
 * than a wrong one.
 */
export function antigravityUsage(usage: Record<string, unknown>, prev: ChatUsage | undefined): ChatUsage {
  return {
    input: (prev?.input ?? 0) + num(usage.input_tokens),
    // `thinking_tokens` is reported separately but is already counted inside
    // `output_tokens`, so adding it here would bill reasoning twice.
    output: (prev?.output ?? 0) + num(usage.output_tokens),
    cacheRead: (prev?.cacheRead ?? 0) + num(usage.cache_read_tokens),
    cacheWrite: prev?.cacheWrite ?? 0,
    contextTokens: 0,
    // No price on this stream, and no table in this repo for Antigravity's
    // model mix — which spans Google, Anthropic and open-weight models at
    // whatever the harness charges. Left at zero, hiding the cost row rather
    // than filling it with a guess.
    costUsd: prev?.costUsd ?? 0,
  };
}

/** Append to the assistant turn in progress, creating one if a frame somehow
 *  arrives before it.
 *
 *  Antigravity streams prose as `text_delta` on successive `agent_response`
 *  steps, so unlike the Codex path these really are deltas of one sentence and
 *  are concatenated bare — inserting paragraph breaks between them would chop
 *  a reply mid-word. */
function say(c: Chat, text: string, field: "text" | "thinking") {
  const last = c.messages[c.messages.length - 1];
  if (!last || last.role !== "assistant") {
    c.messages.push({ role: "assistant", text: field === "text" ? text : "", tools: [], ts: Date.now(), ...(field === "thinking" ? { thinking: text } : {}) });
    return;
  }
  if (field === "text") last.text = (last.text ?? "") + text;
  else last.thinking = (last.thinking ?? "") + text;
}

/** The tool row for this step index, creating it on the turn in progress if
 *  this is the first frame to mention it. The ACTIVE and DONE halves carry the
 *  same `step_index` and describe one call, so this is an upsert — exactly how
 *  the Claude path keys on `tool_use_id`. */
function toolRow(c: Chat, id: string): ChatTool {
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const found = c.messages[i].tools.find((t) => t.id === id);
    if (found) return found;
  }
  const row: ChatTool = { id, name: "tool", target: null, output: null, error: false, ts: Date.now(), note: null };
  const last = c.messages[c.messages.length - 1];
  if (last && last.role === "assistant") last.tools.push(row);
  else c.messages.push({ role: "assistant", text: "", tools: [row], ts: Date.now() });
  return row;
}

/**
 * Fold one Antigravity frame into the chat it belongs to.
 *
 * Mutates `c` in place, because that is the shape `chatStore.update` hands out.
 * Everything not specific to this vocabulary — `sending`, the queue, unread,
 * `agx_error`, abort — stays in the store and is shared with the other two.
 *
 * Unrecognised frames and step types are ignored rather than surfaced, for the
 * same reason the Codex path ignores them: a chat that printed `[unknown frame]`
 * at the user every time the CLI shipped a new step type would be worse than one
 * that simply does not draw it yet.
 */
export function applyAntigravityFrame(c: Chat, frame: Record<string, unknown>): void {
  switch (frame.event) {
    case "init": {
      // The id `--conversation` wants for every turn after this one. Stable
      // across a resume, like Codex's thread id and unlike `claude --resume`,
      // which forks a fresh session id each time.
      const id = strv(frame.conversation_id);
      if (!id) return;
      c.sessionId = id;
      c.liveFrom = Date.now();
      // Unlike Codex, this stream *does* name the model it actually ran, which
      // is the better answer than the one we asked for — `agy` resolves aliases
      // and can fall back.
      const init = (frame.init ?? {}) as Record<string, unknown>;
      c.resolvedModel = strv(init.model) ?? c.model;
      return;
    }
    case "step_update": {
      const step = (frame.step_update ?? {}) as Record<string, unknown>;
      const type = step.step_type;
      const delta = strv(step.text_delta);

      if (type === "tool") {
        const idx = typeof step.step_index === "number" ? String(step.step_index) : null;
        if (!idx) return;
        const info = (step.tool_info ?? {}) as Record<string, unknown>;
        const raw = strv(step.tool_name) ?? strv(info.name);
        const row = toolRow(c, idx);
        if (raw) row.name = toolName(raw);
        const params = (info.parameters ?? {}) as Record<string, unknown>;
        const target = toolTarget(params);
        if (target) row.target = target;
        const out = strv(info.output);
        if (out) row.output = clip(out.trimEnd());
        return;
      }

      // `agent_response` carries the reply, `thinking` the reasoning. Both
      // arrive as deltas across several steps.
      if (type === "agent_response" && delta) { say(c, delta, "text"); return; }
      if (type === "thinking" && delta) { say(c, delta, "thinking"); return; }

      // The stream reports that something went wrong without saying what — the
      // step carries no message. Rather than print an empty error, mark the tool
      // it followed as failed, which is where the detail actually is.
      if (type === "error_message") {
        for (let i = c.messages.length - 1; i >= 0; i--) {
          const tools = c.messages[i].tools;
          if (tools.length) { tools[tools.length - 1].error = true; return; }
        }
      }
      return;
    }
    case "result": {
      const result = (frame.result ?? {}) as Record<string, unknown>;
      c.usage = antigravityUsage((result.usage ?? {}) as Record<string, unknown>, c.usage);
      // A turn that ended badly says so. `status` is SUCCESS on a clean run.
      const status = strv(result.status);
      if (status && status !== "SUCCESS") {
        say(c, `\n[error] the turn ended ${status.toLowerCase()}`, "text");
        c.attention = "blocked";
      }
      return;
    }
  }
}

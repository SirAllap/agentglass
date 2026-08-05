// Codex's wire vocabulary, folded into the same conversation the Claude path
// builds.
//
// `codex exec --json` streams a typed JSONL: a `thread.started` naming the
// thread, a `turn.started`, a run of `item.started` / `item.updated` /
// `item.completed` carrying one typed item each, and a `turn.completed` (or
// `turn.failed`) closing it out. Nothing about that shape resembles Claude's
// stream-json, but everything it says maps onto fields `ChatMsg` / `ChatTool` /
// `ChatUsage` already have — which is what lets one panel render both without
// a branch anywhere below the store.
//
// This is the whole translation. The server passes Codex's frames through
// untouched (server/src/codex.ts) precisely so it lives in one file.
import type { Chat, ChatTool, ChatUsage } from "./chatStore.ts";

const strv = (v: unknown) => (typeof v === "string" && v ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Tool output is rendered in a chip; a `cat` of a large file is not worth
 *  holding in memory, let alone drawing. Matches the spirit of the transcript
 *  clipping in chatPersist.ts. */
const MAX_OUTPUT = 20_000;
const clip = (s: string) => (s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n[trimmed]" : s);

/** The item types that read as *work done* rather than as speech. Each becomes
 *  a tool chip, the same as a Claude `tool_use` block. */
const TOOL_ITEMS = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search", "todo_list"]);

/**
 * What to call a Codex item in the tool strip.
 *
 * Deliberately Claude's names rather than Codex's: the chip renderer, the tool
 * mix chart and the session timeline all key off these, and a `file_change`
 * that drew as its own category would split "edits" into two columns that mean
 * the same thing. The user is looking at what happened, not at which CLI's noun
 * for it.
 */
function toolName(item: Record<string, unknown>): string {
  switch (item.type) {
    case "command_execution": return "Bash";
    case "file_change": return "Edit";
    case "web_search": return "WebSearch";
    case "todo_list": return "TodoWrite";
    case "mcp_tool_call": {
      // Field names here are the least pinned-down of the set — the item is
      // rare enough that it did not turn up in the capture this file was
      // written against, so both plausible spellings are read before falling
      // back to something that still says what happened.
      const server = strv(item.server) ?? strv(item.server_name);
      const tool = strv(item.tool) ?? strv(item.tool_name) ?? strv(item.name);
      return server && tool ? `${server}.${tool}` : tool ?? "mcp";
    }
    default: return String(item.type ?? "tool");
  }
}

/** The paths a `file_change` touched, and what it did to them. */
function fileChange(item: Record<string, unknown>): { target: string | null; note: string | null } {
  const changes = Array.isArray(item.changes) ? (item.changes as Array<Record<string, unknown>>) : [];
  const paths = changes.map((c) => strv(c.path)).filter((p): p is string => !!p);
  const kinds = [...new Set(changes.map((c) => strv(c.kind)).filter((k): k is string => !!k))];
  return { target: paths.join(", ") || null, note: kinds.join(", ") || null };
}

/** What a Codex item acted on — the counterpart of `toolTarget` for the Claude
 *  path, and the thing the chip actually shows next to the name. */
function toolTarget(item: Record<string, unknown>): { target: string | null; note: string | null } {
  switch (item.type) {
    case "command_execution": return { target: strv(item.command), note: null };
    case "file_change": return fileChange(item);
    case "web_search": return { target: strv(item.query), note: null };
    case "todo_list": {
      const items = Array.isArray(item.items) ? item.items : [];
      return { target: items.length ? `${items.length} item${items.length > 1 ? "s" : ""}` : null, note: null };
    }
    case "mcp_tool_call": {
      const args = item.arguments;
      if (typeof args === "string") return { target: args.slice(0, 200), note: null };
      if (args && typeof args === "object") { try { return { target: JSON.stringify(args).slice(0, 200), note: null }; } catch { /* cyclic */ } }
      return { target: null, note: null };
    }
    default: return { target: null, note: null };
  }
}

/** What a Codex item produced, once it has finished producing it. */
function toolOutput(item: Record<string, unknown>): string | null {
  const raw = strv(item.aggregated_output) ?? strv(item.result) ?? strv(item.output);
  return raw ? clip(raw.trimEnd()) : null;
}

/**
 * Whether the item failed.
 *
 * `exit_code` is only meaningful once the command has finished — it is `null`
 * while `status` is `in_progress`, and reading that as zero would mark every
 * running command green before it had done anything.
 */
function toolFailed(item: Record<string, unknown>): boolean {
  if (item.status === "failed") return true;
  const code = item.exit_code;
  return typeof code === "number" && code !== 0;
}

/**
 * What the thread has spent.
 *
 * Two differences from the Claude path, both of which bite if you assume
 * otherwise:
 *
 *  - **The numbers are cumulative for the whole thread, not for the turn.**
 *    Measured, not guessed: a one-word third turn moved `output_tokens` from
 *    258 to 263. So these are assigned, never added — summing them would
 *    report several times what was actually spent within a handful of turns.
 *  - **`input_tokens` includes the cached part.** Also measured: the rollout's
 *    own `total_tokens` equals the input and output counts added together, with
 *    `cached_input_tokens` nowhere in the sum. Claude's `input_tokens` excludes
 *    its cache, so the cached portion is subtracted out here — otherwise the
 *    "In" row would mean one thing for a Claude chat and another for a Codex
 *    one, in the same column of the same panel.
 *
 * `contextTokens` stays zero, which is what suppresses the context meter for a
 * Codex chat. The exec stream reports no per-turn prompt size and no window,
 * and the cumulative delta is not a stand-in: a turn makes one API call per
 * tool round-trip, so the delta over-reads a turn that ran three commands.
 * contextWindow.ts is explicit that over-reading is the unrecoverable
 * direction — it draws a session as nearly compacted when it has plenty of
 * room. No meter is better than a wrong one.
 */
export function codexUsage(usage: Record<string, unknown>, prev: ChatUsage | undefined): ChatUsage {
  const input = num(usage.input_tokens);
  const cacheRead = num(usage.cached_input_tokens);
  return {
    input: Math.max(0, input - cacheRead),
    output: num(usage.output_tokens),
    cacheRead,
    cacheWrite: num(usage.cache_write_input_tokens),
    contextTokens: 0,
    // Codex reports tokens, never dollars — there is no `total_cost_usd`
    // equivalent on this stream. Left at zero, which hides the cost row rather
    // than filling it from a price table in this repo that would drift. The
    // fleet view prices Codex turns server-side off the OTel stream, where the
    // table is actually maintained.
    costUsd: prev?.costUsd ?? 0,
  };
}

/** Append to the assistant turn in progress, creating one if a frame somehow
 *  arrives before it.
 *
 *  Codex says a turn's prose in several complete items rather than as deltas of
 *  one — a preamble naming what it is about to do, then the answer once it has
 *  done it. Concatenated bare they read as a single sentence that changes tense
 *  half way through ("I'll check the line count…This is a scratch repository"),
 *  so they get the paragraph break they were written with. Anything already
 *  carrying its own newline — the `[error]` lines below — is left alone. */
function say(c: Chat, text: string, field: "text" | "thinking") {
  const last = c.messages[c.messages.length - 1];
  if (!last || last.role !== "assistant") {
    c.messages.push({ role: "assistant", text: field === "text" ? text : "", tools: [], ts: Date.now(), ...(field === "thinking" ? { thinking: text } : {}) });
    return;
  }
  const prev = (field === "text" ? last.text : last.thinking) ?? "";
  const sep = prev && !prev.endsWith("\n") && !text.startsWith("\n") ? "\n\n" : "";
  if (field === "text") last.text = prev + sep + text;
  else last.thinking = prev + sep + text;
}

/** The tool row for this item id, creating it on the turn in progress if this
 *  is the first frame to mention it. `item.started` and `item.completed` carry
 *  the same id and describe one call, so this is an upsert — exactly how the
 *  Claude path keys on `tool_use_id`. */
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
 * Fold one Codex frame into the chat it belongs to.
 *
 * Mutates `c` in place, because that is the shape `chatStore.update` hands out.
 * Everything not specific to Codex's vocabulary — `sending`, the queue, unread,
 * `agx_error`, abort — stays in the store and is shared with the Claude path.
 *
 * Unrecognised frames are ignored rather than surfaced. Codex ships new item
 * types regularly, and a chat that printed `[unknown frame]` at the user every
 * time one appeared would be worse than one that simply does not draw it yet.
 */
export function applyCodexFrame(c: Chat, frame: Record<string, unknown>): void {
  switch (frame.type) {
    case "thread.started": {
      // The id `codex exec resume` wants for every turn after this one. Codex
      // keeps it stable across a resume — unlike `claude --resume`, which forks
      // a fresh session id each time — so this normally reports the same value
      // the chat already had.
      const id = strv(frame.thread_id);
      if (!id) return;
      c.sessionId = id;
      c.liveFrom = Date.now();
      // The exec stream never names the model it ran, so the one we asked for
      // is the best answer there is. Recorded anyway, so a chat restored from
      // storage measures against something rather than nothing.
      c.resolvedModel = c.model;
      return;
    }
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = (frame.item ?? {}) as Record<string, unknown>;
      const id = strv(item.id);
      const kind = strv(item.type);
      if (!kind) return;

      if (TOOL_ITEMS.has(kind)) {
        if (!id) return;
        const row = toolRow(c, id);
        const { target, note } = toolTarget(item);
        row.name = toolName(item);
        if (target) row.target = target;
        if (note) row.note = note;
        const out = toolOutput(item);
        if (out) row.output = out;
        row.error = toolFailed(item);
        return;
      }

      // Speech and reasoning are taken only from the terminal frame. Codex 0.146
      // emits each exactly once, as `item.completed`; folding `item.updated` in
      // as well would double the text the day it starts streaming deltas. The
      // cost of choosing this way round is that a Codex reply lands whole
      // instead of typing itself out — which is what it does today regardless.
      if (frame.type !== "item.completed") return;

      if (kind === "agent_message") {
        const text = strv(item.text) ?? strv(item.message);
        if (text) say(c, text, "text");
        return;
      }
      if (kind === "reasoning") {
        const text = strv(item.text) ?? strv(item.summary) ?? strv(item.content);
        if (text) say(c, text, "thinking");
        return;
      }
      if (kind === "error") {
        const text = strv(item.message) ?? strv(item.text) ?? "codex reported an error";
        say(c, `\n[error] ${text}`, "text");
        c.attention = "blocked";
      }
      return;
    }
    case "turn.completed": {
      const usage = (frame.usage ?? {}) as Record<string, unknown>;
      c.usage = codexUsage(usage, c.usage);
      return;
    }
    case "turn.failed": {
      const e = frame.error;
      const text = strv(e) ?? strv((e as Record<string, unknown> | undefined)?.message) ?? "the turn failed";
      say(c, `\n[error] ${text}`, "text");
      // A failed turn will fail the same way again until something changes, so
      // it asks for you by name rather than going quiet.
      c.attention = "blocked";
      return;
    }
  }
}

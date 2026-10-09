// Hermes's wire vocabulary, folded into the same conversation the Claude /
// Codex / Antigravity paths build.
//
// `hermes chat -q … --format stream-json` streams a JSONL whose envelope names
// itself with `type`: a `system`/`init` naming the session, a run of `text` /
// `tool_use` / `tool_result` frames, and a `result` closing the turn. Nothing
// about that shape resembles the other three, but everything it says maps onto
// fields `ChatMsg` / `ChatTool` / `ChatUsage` already have — which is what lets
// one panel render all four without a branch anywhere below the store.
//
// The field names are upstream's, from hermes_cli/stream_json.py in
// NousResearch/hermes-agent at aa75d3724f8fa8e4b21cb77057af73bfe2e35213 (the
// revision docs/CONFIG.md links): `session_id`/`model` on init, `name`,
// `tool_call_id`, `input` on tool_use, `output`/`is_error` on tool_result, and
// `tokens.{input,output,cache_read,cache_write}` plus `error` on result.
//
// This is the whole translation. The server passes the frames through untouched
// (server/src/hermes.ts) precisely so it lives in one file.
import type { Chat, ChatTool, ChatUsage } from "./chatStore.ts";

const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Tool output is rendered in a chip; a `cat` of a large file is not worth
 *  holding in memory, let alone drawing. Matches antigravityFrames.ts /
 *  codexFrames.ts and the transcript clipping in chatPersist.ts. */
const MAX_OUTPUT = 20_000;
const clip = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const text = typeof v === "string" ? v : JSON.stringify(v);
  return text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + "\n[trimmed]" : text;
};

function inputOf(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object") return v as Record<string, unknown>;
  if (typeof v === "string") {
    try {
      const o: unknown = JSON.parse(v);
      if (o && typeof o === "object") return o as Record<string, unknown>;
    } catch { return { command: v }; }
  }
  return {};
}

function targetOf(input: Record<string, unknown>): string | null {
  for (const key of ["command", "cmd", "file_path", "path", "url", "query", "pattern"]) {
    const value = str(input[key]);
    if (value) return value.slice(0, 300);
  }
  return null;
}

function reply(c: Chat) {
  const last = c.messages[c.messages.length - 1];
  if (last?.role === "assistant") return last;
  const next = { role: "assistant" as const, text: "", tools: [] as ChatTool[], ts: Date.now() };
  c.messages.push(next);
  return next;
}

/**
 * What the thread has spent.
 *
 * Hermes's `tokens` on `result` are per turn (this process answered once), so
 * they are added — the same decision Antigravity made after measuring, and the
 * opposite of Codex's cumulative totals. Getting it backwards over-reports
 * spend severalfold and nothing fails loudly.
 *
 * No price rides on this stream. Left at zero, hiding the cost row rather than
 * filling it with a guess from a table that usually misses Hermes model ids.
 */
export function hermesUsage(tokens: Record<string, unknown>, prev: ChatUsage | undefined): ChatUsage {
  const input = num(tokens.input);
  const output = num(tokens.output);
  const cacheRead = num(tokens.cache_read);
  const cacheWrite = num(tokens.cache_write);
  return {
    input: (prev?.input ?? 0) + input,
    output: (prev?.output ?? 0) + output,
    cacheRead: (prev?.cacheRead ?? 0) + cacheRead,
    cacheWrite: (prev?.cacheWrite ?? 0) + cacheWrite,
    // The latest prompt size is the context, not the sum of every turn's.
    contextTokens: input + cacheRead + cacheWrite,
    costUsd: prev?.costUsd ?? 0,
  };
}

/**
 * Fold one Hermes frame into the chat it belongs to.
 *
 * Mutates `c` in place, because that is the shape `chatStore.update` hands out.
 * Everything not specific to this vocabulary — `sending`, the queue, unread,
 * `agx_error`, abort — stays in the store and is shared with the other three.
 *
 * Unrecognised frames are ignored rather than surfaced, for the same reason the
 * Antigravity / Codex paths ignore them.
 */
export function applyHermesFrame(c: Chat, frame: Record<string, unknown>): void {
  switch (frame.type) {
    case "system": {
      if (frame.subtype !== "init") return;
      const id = str(frame.session_id);
      if (id) { c.sessionId = id; c.liveFrom = Date.now(); }
      const model = str(frame.model);
      if (model) c.resolvedModel = model;
      return;
    }
    case "text": {
      const delta = str(frame.text);
      if (delta) reply(c).text += delta;
      return;
    }
    case "tool_use": {
      const name = str(frame.name) ?? "tool";
      const input = inputOf(frame.input);
      const row: ChatTool = {
        id: str(frame.tool_call_id) ?? str(frame.id) ?? `hermes-${Date.now()}-${reply(c).tools.length}`,
        name, target: targetOf(input), output: null, error: false, ts: Date.now(), note: null,
      };
      reply(c).tools.push(row);
      return;
    }
    case "tool_result": {
      const rows = reply(c).tools;
      const id = str(frame.tool_call_id) ?? str(frame.id);
      const name = str(frame.name);
      const row = [...rows].reverse().find((r) => r.output === null && (id ? r.id === id : !name || r.name === name));
      if (!row) return;
      row.output = clip(frame.output);
      row.error = frame.is_error === true;
      return;
    }
    case "result": {
      const id = str(frame.session_id);
      if (id && !c.sessionId) c.sessionId = id;
      const last = reply(c);
      // The result's `text` is used only when no delta arrived — streaming
      // deltas already built the answer; duplicating would double the reply.
      if (!last.text && str(frame.text)) last.text = String(frame.text);
      const tokens = frame.tokens && typeof frame.tokens === "object" ? frame.tokens as Record<string, unknown> : {};
      c.usage = hermesUsage(tokens, c.usage);
      if (num(frame.exit_code) !== 0) {
        const why = str(frame.error) ?? "Hermes ended without completing the turn";
        last.text += `${last.text ? "\n" : ""}[error] ${why}`;
        c.attention = "blocked";
      }
      return;
    }
  }
}

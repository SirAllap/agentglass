// Normalize a raw hook POST body into structured, storable fields.
import type { IngestBody } from "../../shared/types.ts";
import type { TokenUsage } from "./pricing.ts";

export interface NormalizedEvent {
  source_app: string;
  session_id: string;
  hook_event_type: string;
  tool_name: string | null;
  tool_use_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  model_name: string | null;
  is_error: number;
  error_text: string | null;
  /** Raw token usage from this event (see usage_is_cumulative). */
  usage: TokenUsage;
  /**
   * True when `usage` is a cumulative session total (parsed from a full
   * transcript) rather than a per-turn delta. The DB converts cumulative
   * usage into a per-event delta so timeline sums stay correct.
   */
  usage_is_cumulative: boolean;
  summary: string | null;
  session_name: string | null;
  timestamp: number;
  payload: Record<string, unknown>;
  chat: unknown[] | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length ? v : null;
}

/** Read a nested key from an object safely. */
function pick(obj: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  if (!obj) return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

/** Extract token usage from a single message/usage-like object (tolerant of shapes). */
function usageFrom(u: Record<string, unknown> | undefined): TokenUsage {
  if (!u || typeof u !== "object") return {};
  return {
    input_tokens: num(pick(u, "input_tokens", "prompt_tokens", "llm.token_count.prompt")),
    output_tokens: num(pick(u, "output_tokens", "completion_tokens", "llm.token_count.completion")),
    cache_creation_tokens: num(pick(u, "cache_creation_input_tokens", "cache_creation_tokens")),
    cache_read_tokens: num(pick(u, "cache_read_input_tokens", "cache_read_tokens", "cached_prompt_tokens")),
  };
}

// A single turn's token count has a real ceiling (context windows are in the
// low millions); anything past this is a forged or corrupt event. Clamping
// keeps one bad /ingest from writing a $750k row that skews every cost chart —
// it also rejects negatives, which cost math should never see.
const MAX_TOKENS = 20_000_000;
function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : 0;
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_TOKENS);
}

// Strong shell-failure markers — chosen to rarely appear in successful output
// (so a command that merely greps for "error" isn't flagged).
const FAIL_MARKERS = [
  "command not found",
  "no such file or directory",
  "traceback (most recent call last)",
  "fatal:",
  "permission denied",
  "segmentation fault",
  "cannot access",
];
function firstMarker(s: unknown): string | null {
  if (typeof s !== "string" || !s) return null;
  const low = s.toLowerCase();
  return FAIL_MARKERS.find((m) => low.includes(m)) ?? null;
}

export function detectError(type: string, payload: Record<string, unknown>): { is_error: number; error_text: string | null } {
  const err = (text: unknown): { is_error: number; error_text: string | null } => ({
    is_error: 1,
    error_text: typeof text === "string" && text.trim() ? text.slice(0, 2000) : "tool reported a failure",
  });

  if (type === "PostToolUseFailure") return err(pick(payload, "error", "stderr", "message"));
  if (pick(payload, "is_error", "isError") === true) return err(pick(payload, "error", "error_text", "message"));

  const top = pick(payload, "error", "error_text", "stderr");
  if (typeof top === "string" && top.trim()) return err(top);

  const tr = pick(payload, "tool_response");
  if (tr && typeof tr === "object" && !Array.isArray(tr)) {
    const r = tr as Record<string, unknown>;
    if (r.is_error === true || r.success === false || r.interrupted === true) {
      return err((r.stderr as string) || (r.error as string) || (r.returnCodeInterpretation as string));
    }
    const rci = typeof r.returnCodeInterpretation === "string" ? r.returnCodeInterpretation.toLowerCase() : "";
    if (rci && /(error|fail|non-?zero)/.test(rci)) return err((r.stderr as string) || (r.returnCodeInterpretation as string));
    const marker = firstMarker(r.stderr) || firstMarker(r.stdout);
    if (marker) return err((r.stderr as string) || (r.stdout as string));
  }
  return { is_error: 0, error_text: null };
}

/**
 * Sum token usage across a transcript array. Claude Code transcripts store
 * `{ type: 'assistant', message: { usage: {...} } }` per turn; we tolerate a
 * few shapes and sum every usage object we can find.
 */
export function sumTranscriptTokens(chat: unknown[] | undefined): TokenUsage {
  const acc: Required<TokenUsage> = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
  };
  if (!Array.isArray(chat)) return acc;
  for (const line of chat) {
    if (!line || typeof line !== "object") continue;
    const o = line as Record<string, unknown>;
    const msg = (o.message ?? o) as Record<string, unknown>;
    const usage = (msg?.usage ?? o.usage) as Record<string, unknown> | undefined;
    if (usage) {
      const u = usageFrom(usage);
      acc.input_tokens += u.input_tokens ?? 0;
      acc.output_tokens += u.output_tokens ?? 0;
      acc.cache_creation_tokens += u.cache_creation_tokens ?? 0;
      acc.cache_read_tokens += u.cache_read_tokens ?? 0;
    }
  }
  return acc;
}

const MAX_FIELD = 64 * 1024;
function cap(v: unknown): unknown {
  return typeof v === "string" && v.length > MAX_FIELD ? v.slice(0, MAX_FIELD) + "…[truncated]" : v;
}
/** Bound the large free-text fields in a payload in place. */
function capPayload(p: Record<string, unknown>): void {
  for (const k of ["prompt", "message", "last_assistant_message", "error", "error_text", "stderr", "stdout"]) {
    if (k in p) p[k] = cap(p[k]);
  }
  const ti = p.tool_input as Record<string, unknown> | undefined;
  if (ti && typeof ti === "object") for (const k of ["content", "old_string", "new_string", "command"]) if (k in ti) ti[k] = cap(ti[k]);
  const tr = p.tool_response as Record<string, unknown> | undefined;
  if (tr && typeof tr === "object") for (const k of ["content", "stdout", "stderr"]) if (k in tr) tr[k] = cap(tr[k]);
}

let lastClampWarn = 0;

export function normalize(body: IngestBody, opts?: { skipClockClamp?: boolean }): NormalizedEvent {
  const payload = (body.payload ?? {}) as Record<string, unknown>;
  const type = String(body.hook_event_type ?? "Unknown");

  // Structured field extraction — many hooks bury these in payload.
  const tool_name = str(pick(payload, "tool_name")) ?? null;
  const tool_use_id =
    str(pick(payload, "tool_use_id", "toolUseId", "id")) ?? null;
  const agent_id = str(pick(payload, "agent_id", "agentId")) ?? null;
  const agent_type = str(pick(payload, "agent_type", "agentType", "subagent_type")) ?? null;

  // Error detection. Failures don't come as a PostToolUseFailure hook (that
  // never fires) — they live inside tool_response: Bash stderr/interrupted,
  // a tool's success:false, or a return-code interpretation. Detect all three
  // plus a curated set of strong shell-failure markers.
  const { is_error, error_text } = detectError(type, payload);

  // Token usage: prefer explicit payload.usage, else sum the transcript.
  const chat = Array.isArray(body.chat) ? body.chat : null;
  const payloadUsage = usageFrom(pick(payload, "usage") as Record<string, unknown> | undefined);
  const hasPayloadUsage =
    (payloadUsage.input_tokens ?? 0) + (payloadUsage.output_tokens ?? 0) > 0;
  const usage: TokenUsage = hasPayloadUsage ? payloadUsage : sumTranscriptTokens(chat ?? undefined);

  const model_name = str(body.model_name) ?? str(pick(payload, "model", "model_name"));

  // A single field arriving over /ingest is untrusted and unbounded; a 100MB
  // prompt becomes a 100MB DB row, a 100MB FTS entry, and a 100MB frame to
  // every dashboard. Cap the free-text fields that a hostile or broken sender
  // can inflate before any of that happens.
  capPayload(payload);

  return {
    source_app: String(body.source_app ?? "unknown"),
    session_id: String(body.session_id ?? "unknown"),
    hook_event_type: type,
    tool_name,
    tool_use_id,
    agent_id,
    agent_type,
    model_name,
    is_error,
    error_text,
    usage,
    usage_is_cumulative: !hasPayloadUsage,
    summary: str(body.summary),
    session_name: str(body.session_name),
    timestamp: clampTimestamp(body.timestamp, opts?.skipClockClamp),
    payload,
    chat,
  };
}

// Live events with a clock more than 5 minutes off get clamped to server time;
// backfill (skipClockClamp) keeps original timestamps so history stays intact.
function clampTimestamp(ts: unknown, skipClockClamp?: boolean): number {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return Date.now();
  if (skipClockClamp) return ts;
  if (Math.abs(ts - Date.now()) > 300_000) {
    const now = Date.now();
    if (now - lastClampWarn > 60_000) {
      lastClampWarn = now;
      console.warn(`[ingest] clamped event timestamp ${ts} (>5min from server clock)`);
    }
    return now;
  }
  return ts;
}

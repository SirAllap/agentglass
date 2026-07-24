// Normalize a raw hook POST body into structured, storable fields.
import type { IngestBody } from "../../shared/types.ts";
import { costUsd, type TokenUsage } from "./pricing.ts";

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
  /**
   * When `usage_is_cumulative`, the cost of the whole transcript priced per
   * message at its own model. The DB charges the difference of this against what
   * the session already recorded, so a mid-session model switch is billed at the
   * right rates rather than the whole delta at the current model. Null otherwise.
   */
  cost_cumulative: number | null;
  summary: string | null;
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
    input_tokens: num(pick(u, "input_tokens", "prompt_tokens")),
    output_tokens: num(pick(u, "output_tokens", "completion_tokens")),
    cache_creation_tokens: num(pick(u, "cache_creation_input_tokens", "cache_creation_tokens")),
    cache_read_tokens: num(pick(u, "cache_read_input_tokens", "cache_read_tokens")),
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

// The per-turn clamp above bounds one entry, but a transcript carries as many
// entries as the sender cares to include — a forged one with thousands of turns
// each at the per-turn max sums to a multi-billion-token, six-figure-dollar row
// that skews every cost chart the clamp exists to protect. A whole session has a
// real ceiling too, just a larger one: even a marathon run is on the order of a
// few hundred million cache-read tokens, so a billion is comfortably above any
// genuine session and still finite. Anything past it is corrupt or forged.
const MAX_SESSION_TOKENS = 1_000_000_000;

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
  // A ceiling on the accumulated total, not just on each entry: without it the
  // per-entry clamp is trivially defeated by sending more entries.
  acc.input_tokens = Math.min(acc.input_tokens, MAX_SESSION_TOKENS);
  acc.output_tokens = Math.min(acc.output_tokens, MAX_SESSION_TOKENS);
  acc.cache_creation_tokens = Math.min(acc.cache_creation_tokens, MAX_SESSION_TOKENS);
  acc.cache_read_tokens = Math.min(acc.cache_read_tokens, MAX_SESSION_TOKENS);
  return acc;
}

/**
 * Cost of a whole cumulative transcript, priced per message at that message's
 * OWN model.
 *
 * sumTranscriptTokens() collapses every turn into one token total, and the DB
 * used to price the delta of that total at a single model — the current event's.
 * A session that switched models mid-run (an Opus session that hands a turn to a
 * Haiku subagent, or any change) then had the whole delta billed at the latest
 * model's rate, so session and total cost were wrong. Each transcript line
 * carries its own `message.model`, so the honest total is the per-model sum;
 * pricing the difference of these totals across events attributes each turn's
 * tokens at the rate that actually produced them. A line with usage but no model
 * falls back to the event's own model.
 */
export function sumTranscriptCost(chat: unknown[] | undefined, fallbackModel: string | null): number {
  if (!Array.isArray(chat)) return 0;
  let cost = 0;
  for (const line of chat) {
    if (!line || typeof line !== "object") continue;
    const o = line as Record<string, unknown>;
    const msg = (o.message ?? o) as Record<string, unknown>;
    const usage = (msg?.usage ?? o.usage) as Record<string, unknown> | undefined;
    if (usage) cost += costUsd(usageFrom(usage), str(msg?.model) ?? fallbackModel);
  }
  return cost;
}

const MAX_FIELD = 64 * 1024;
// Deep enough for the nested shapes hooks actually send (tool_input.content,
// tool_response.stdout, a chat turn's content blocks) without letting a
// pathological payload recurse without end.
const MAX_CAP_DEPTH = 8;
function cap(v: unknown): unknown {
  return typeof v === "string" && v.length > MAX_FIELD ? v.slice(0, MAX_FIELD) + "…[truncated]" : v;
}
/** Same bound, typed, for the top-level string columns that never pass through
 *  capPayload — a 32MB source_app or summary is a 32MB row and frame too. */
function capField<T extends string | null>(v: T): T {
  return cap(v) as T;
}
/**
 * Bound EVERY string anywhere in the payload, in place — not just a known
 * allowlist of keys.
 *
 * A single field arriving over the unauthenticated /ingest is untrusted and
 * unbounded, and the old allowlist only truncated the handful of keys we
 * happened to name: a 32MB blob under any *other* key (or nested one level
 * deeper than the two hand-unwrapped objects) sailed through and became a 32MB
 * DB row, a 32MB FTS entry and a 32MB frame to every dashboard. The bound has to
 * be structural — every string, wherever it sits — rather than a list of the
 * fields we thought of.
 */
function capPayload(p: Record<string, unknown>, depth = 0): void {
  for (const k in p) {
    const v = p[k];
    if (typeof v === "string") p[k] = cap(v);
    else if (depth < MAX_CAP_DEPTH && v && typeof v === "object") capDeep(v, depth + 1);
  }
}
function capDeep(v: object, depth: number): void {
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const el = v[i];
      if (typeof el === "string") v[i] = cap(el);
      else if (depth < MAX_CAP_DEPTH && el && typeof el === "object") capDeep(el, depth + 1);
    }
  } else {
    capPayload(v as Record<string, unknown>, depth);
  }
}

// A live event's client timestamp drives every windowed number (last-15m burn,
// insights, retention pruning, tool-latency deltas), all of which compare it
// against the server's own Date.now(). A sender whose clock is off — the named
// failure is a host running two hours fast — would place its events outside
// every "last N minutes" window and have them pruned on the wrong schedule,
// silently corrupting the per-source metrics with no signal that anything is
// wrong. A live event arrives within seconds of happening, so its timestamp
// belongs in a small band around the server clock; anything outside that band
// is clock skew, not a real time, so pin it to now. In-band timestamps are kept
// exactly, because tool-latency deltas depend on them.
//
// This is applied only at the live ingest seam (ingestBody). Transcript backfill
// carries genuinely historical timestamps and inserts without passing through
// here, so those are left untouched.
const FUTURE_SKEW_MS = 60_000; // 1 min: nothing legitimate arrives from the future
const PAST_SKEW_MS = 5 * 60_000; // 5 min: covers real send/queue delay, catches skew beyond
export function clampIngestTimestamp(ts: number, now: number): number {
  if (!Number.isFinite(ts)) return now;
  if (ts > now + FUTURE_SKEW_MS) return now;
  if (ts < now - PAST_SKEW_MS) return now;
  return ts;
}

export function normalize(body: IngestBody): NormalizedEvent {
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
  // All four token kinds count as "usage present". Summing only input+output
  // dropped a usage object carrying only cache tokens (a cache-read-only reply):
  // its cache tokens were discarded and the event was mislabeled cumulative,
  // then re-summed from the transcript.
  const hasPayloadUsage =
    (payloadUsage.input_tokens ?? 0) + (payloadUsage.output_tokens ?? 0)
    + (payloadUsage.cache_creation_tokens ?? 0) + (payloadUsage.cache_read_tokens ?? 0) > 0;
  const usage: TokenUsage = hasPayloadUsage ? payloadUsage : sumTranscriptTokens(chat ?? undefined);

  const model_name = str(body.model_name) ?? str(pick(payload, "model", "model_name"));

  // A single field arriving over /ingest is untrusted and unbounded; a 100MB
  // prompt becomes a 100MB DB row, a 100MB FTS entry, and a 100MB frame to
  // every dashboard. Cap the free-text fields that a hostile or broken sender
  // can inflate before any of that happens.
  capPayload(payload);

  // Every string that becomes its own column is bounded too: these do NOT pass
  // through capPayload, so an unbounded top-level `summary` (the field this most
  // obviously affected) — or source_app, session_id, a tool name — was a full
  // uncapped row and websocket frame, sidestepping the very bound the payload
  // fields get. error_text is already clipped to 2000 in detectError.
  return {
    source_app: capField(String(body.source_app ?? "unknown")),
    session_id: capField(String(body.session_id ?? "unknown")),
    hook_event_type: capField(type),
    tool_name: capField(tool_name),
    tool_use_id: capField(tool_use_id),
    agent_id: capField(agent_id),
    agent_type: capField(agent_type),
    model_name: capField(model_name),
    is_error,
    error_text,
    usage,
    usage_is_cumulative: !hasPayloadUsage,
    // Only the cumulative (transcript-summed) path can span models; the per-turn
    // payload path is already one turn at one model, so it prices as before.
    cost_cumulative: hasPayloadUsage ? null : sumTranscriptCost(chat ?? undefined, model_name),
    summary: capField(str(body.summary)),
    timestamp: typeof body.timestamp === "number" ? body.timestamp : Date.now(),
    payload,
    chat,
  };
}

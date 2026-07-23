// OpenTelemetry → agentglass.
//
// A minimal OTLP/HTTP *JSON* trace receiver that maps OpenTelemetry GenAI spans
// (the `gen_ai.*` semantic conventions) into agentglass ingest events. This is
// what makes agentglass provider-agnostic: anything that emits OTel GenAI spans
// — the OpenAI / Google / Bedrock SDK instrumentations, LangChain, LiteLLM,
// OpenLLMetry, even Claude Code's own OTel export — can feed the dashboard.
//
// Mapping strategy:
//   • a TOOL span (operation "execute_tool" or carrying gen_ai.tool.name) becomes
//     TWO events — PreToolUse at span start + PostToolUse at span end, sharing the
//     span id as tool_use_id — so the existing pre→post pairing yields real p50/p95.
//   • an LLM span (chat / completion / …) becomes one "Turn complete" event that
//     carries per-call token usage in payload.usage, so cost math just works.
// Spans with no gen_ai.* signal are ignored (this is not a general trace store).
//
// JSON only: point your exporter with OTEL_EXPORTER_OTLP_PROTOCOL=http/json.
import type { IngestBody } from "../../shared/types.ts";

interface AnyVal {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: AnyVal[] };
  kvlistValue?: { values?: KeyValue[] };
}
interface KeyValue { key?: string; value?: AnyVal }
interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  name?: string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: KeyValue[];
  status?: { code?: number; message?: string };
}

function attrValue(v: AnyVal | undefined): unknown {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return typeof v.intValue === "string" ? Number(v.intValue) : v.intValue;
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(attrValue);
  if (v.kvlistValue) return flatten(v.kvlistValue.values);
  return undefined;
}
function flatten(list: KeyValue[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (Array.isArray(list)) for (const kv of list) if (kv?.key) out[kv.key] = attrValue(kv.value);
  return out;
}

/** OTLP times are unsigned nanoseconds since epoch as a decimal string. */
function nanoToMs(n: string | number | undefined): number | null {
  if (n === undefined || n === null) return null;
  try {
    const whole = String(n).split(".")[0].replace(/[^0-9]/g, "");
    if (!whole) return null;
    return Number(BigInt(whole) / 1_000_000n);
  } catch {
    return null;
  }
}

function firstNum(a: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    const v = a[k];
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return 0;
}
function firstStr(a: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = a[k];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

const TOOL_OPS = new Set(["execute_tool", "invoke_tool", "tool"]);
const LLM_OPS = new Set(["chat", "text_completion", "completion", "generate_content", "responses", "embeddings"]);

// A single OTLP request must not be able to schedule unbounded synchronous work
// on the server's one thread: every event produced here becomes one SQLite
// insert back in index.ts, so an export carrying millions of spans/records would
// freeze the terminal for the length of that write. /v1/traces and /v1/logs are
// unauthenticated (auth.ts exempts them), so the input is not trusted. Cap the
// events one request may yield — well above any honest batch, since an OTLP
// exporter flushes on the order of 512 spans at a time — and drop the excess
// with a warning rather than block. The cap is on the produced array, here,
// because index.ts must stay out of this batch's shape.
export const MAX_OTLP_EVENTS_PER_REQUEST = 10_000;

function spanToEvents(span: OtlpSpan, resAttrs: Record<string, unknown>): IngestBody[] {
  const a = flatten(span.attributes);
  const isGenAI =
    Object.keys(a).some((k) => k.startsWith("gen_ai.") || k.startsWith("llm.")) ||
    a["gen_ai.system"] !== undefined;
  if (!isGenAI) return []; // not a GenAI span — ignore

  const op = String(a["gen_ai.operation.name"] ?? "").toLowerCase();
  const system = firstStr(a, ["gen_ai.system", "gen_ai.provider.name"]);
  const model = firstStr(a, ["gen_ai.response.model", "gen_ai.request.model", "gen_ai.model", "llm.model_name"]);
  const source_app = String(resAttrs["service.name"] ?? system ?? "otel");
  const session_id = String(a["gen_ai.conversation.id"] ?? a["session.id"] ?? span.traceId ?? "otel-session");
  const startMs = nanoToMs(span.startTimeUnixNano) ?? Date.now();
  const endMs = nanoToMs(span.endTimeUnixNano) ?? startMs;
  const isError = span.status?.code === 2; // STATUS_CODE_ERROR
  const errMsg = span.status?.message ? String(span.status.message) : "gen_ai span errored";
  const base = { source_app, session_id, model_name: model } as const;

  const toolName = firstStr(a, ["gen_ai.tool.name", "tool.name"]);
  const isTool = TOOL_OPS.has(op) || (!!toolName && !LLM_OPS.has(op));

  if (isTool) {
    const tool_use_id = String(a["gen_ai.tool.call.id"] ?? a["gen_ai.tool.id"] ?? span.spanId ?? `${startMs}`);
    const tool_name = toolName ?? "tool";
    return [
      { ...base, hook_event_type: "PreToolUse", timestamp: startMs, payload: { tool_name, tool_use_id } },
      {
        ...base,
        hook_event_type: "PostToolUse",
        timestamp: endMs,
        payload: { tool_name, tool_use_id, ...(isError ? { is_error: true, error: errMsg } : {}) },
      },
    ];
  }

  // LLM inference — one event carrying per-call token usage.
  const usage = {
    input_tokens: firstNum(a, ["gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens", "llm.usage.prompt_tokens"]),
    output_tokens: firstNum(a, ["gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens", "llm.usage.completion_tokens"]),
    cache_read_tokens: firstNum(a, ["gen_ai.usage.cache_read_input_tokens", "gen_ai.usage.cache_read_tokens"]),
    cache_creation_tokens: firstNum(a, ["gen_ai.usage.cache_creation_input_tokens", "gen_ai.usage.cache_creation_tokens"]),
  };
  return [
    {
      ...base,
      hook_event_type: "Turn complete",
      timestamp: endMs,
      payload: {
        usage,
        gen_ai_system: system,
        operation: op || undefined,
        span_name: span.name,
        ...(isError ? { is_error: true, error: errMsg } : {}),
      },
    },
  ];
}

/** Parse an OTLP/HTTP JSON ExportTraceServiceRequest into ingest events. */
export function otlpTracesToEvents(body: unknown): IngestBody[] {
  const out: IngestBody[] = [];
  const rs = (body as { resourceSpans?: unknown[] })?.resourceSpans;
  if (Array.isArray(rs)) {
    let capped = false;
    for (const r of rs as Array<Record<string, unknown>>) {
      if (capped) break;
      const resAttrs = flatten((r?.resource as { attributes?: KeyValue[] })?.attributes);
      const scopeSpans = (r?.scopeSpans ?? r?.instrumentationLibrarySpans ?? []) as Array<{ spans?: OtlpSpan[] }>;
      for (const ss of scopeSpans) {
        if (capped) break;
        for (const span of ss?.spans ?? []) {
          try {
            out.push(...spanToEvents(span, resAttrs));
          } catch {
            /* skip a malformed span rather than fail the whole batch */
          }
          // A tool span yields two events, so this can overshoot by one before
          // the check; the trim below makes the returned array exact.
          if (out.length >= MAX_OTLP_EVENTS_PER_REQUEST) { capped = true; break; }
        }
      }
    }
    if (capped) {
      out.length = MAX_OTLP_EVENTS_PER_REQUEST;
      console.warn(`[otlp] traces request hit the ${MAX_OTLP_EVENTS_PER_REQUEST}-event cap — dropping the rest to keep the single ingest thread responsive`);
    }
  }
  // Insert oldest-first so a tool span's PreToolUse lands before its PostToolUse
  // (the DB pairs them by id and derives latency from the timestamp delta).
  out.sort((x, y) => (x.timestamp ?? 0) - (y.timestamp ?? 0));
  return out;
}

// --- OTLP LOGS -------------------------------------------------------------
// Some agents (OpenAI Codex CLI) export OpenTelemetry *logs* rather than traces:
// one log record per API request / tool decision / tool result / prompt. Map
// each record to an event by whatever GenAI-ish signal it carries. Tolerant by
// design — a record with no recognizable signal is ignored.
interface OtlpLogRecord {
  timeUnixNano?: string | number;
  observedTimeUnixNano?: string | number;
  severityNumber?: number;
  body?: AnyVal;
  attributes?: KeyValue[];
  traceId?: string;
  eventName?: string;
}

function bodyToString(body: AnyVal | undefined): string {
  const v = attrValue(body);
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v).slice(0, 500);
  } catch {
    return String(v);
  }
}

function logRecordToEvent(rec: OtlpLogRecord, resAttrs: Record<string, unknown>): IngestBody | null {
  const a = flatten(rec.attributes);
  const isGenAI =
    Object.keys(a).some((k) => k.startsWith("gen_ai.") || k.startsWith("codex.") || k.startsWith("llm.")) ||
    a["gen_ai.system"] !== undefined || a["event.name"] !== undefined || rec.eventName !== undefined;
  if (!isGenAI) return null;

  const system = firstStr(a, ["gen_ai.system", "gen_ai.provider.name"]);
  const model = firstStr(a, ["gen_ai.response.model", "gen_ai.request.model", "gen_ai.model", "model", "llm.model_name"]);
  const source_app = String(resAttrs["service.name"] ?? system ?? "codex");
  const session_id = String(
    a["gen_ai.conversation.id"] ?? a["session.id"] ?? a["conversation.id"] ?? a["thread.id"] ?? rec.traceId ?? "codex-session"
  );
  const ms = nanoToMs(rec.timeUnixNano) ?? nanoToMs(rec.observedTimeUnixNano) ?? Date.now();
  const isError = typeof rec.severityNumber === "number" && rec.severityNumber >= 17; // ERROR range
  const eventName = String(a["event.name"] ?? rec.eventName ?? "").toLowerCase();
  const bodyText = bodyToString(rec.body);
  const base = { source_app, session_id, model_name: model, timestamp: ms } as const;

  const toolName = firstStr(a, ["gen_ai.tool.name", "tool.name", "tool_name"]);
  const toolCallId = firstStr(a, ["gen_ai.tool.call.id", "tool.call.id", "tool_call_id", "call_id"]);
  const input = firstNum(a, ["gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens", "input_tokens", "prompt_tokens"]);
  const output = firstNum(a, ["gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens", "output_tokens", "completion_tokens"]);

  // Tool decision/result → a tool event (Pre if a call, else Post so it counts).
  if (toolName || eventName.includes("tool")) {
    const tool_name = toolName ?? "tool";
    const tool_use_id = toolCallId ?? `${session_id}:${ms}`;
    const isCall = /call|request|decision|invoke|begin|start/.test(eventName) && !/result|output|complete|finish|end|response/.test(eventName);
    if (isCall) return { ...base, hook_event_type: "PreToolUse", payload: { tool_name, tool_use_id } };
    return { ...base, hook_event_type: "PostToolUse", payload: { tool_name, tool_use_id, ...(isError ? { is_error: true, error: bodyText } : {}) } };
  }
  // Token-bearing record → a costed turn.
  if (input + output > 0) {
    return {
      ...base,
      hook_event_type: "Turn complete",
      payload: {
        usage: {
          input_tokens: input,
          output_tokens: output,
          cache_read_tokens: firstNum(a, ["gen_ai.usage.cache_read_input_tokens", "gen_ai.usage.cache_read_tokens"]),
          cache_creation_tokens: firstNum(a, ["gen_ai.usage.cache_creation_input_tokens", "gen_ai.usage.cache_creation_tokens"]),
        },
        gen_ai_system: system,
        event: eventName || undefined,
        ...(isError ? { is_error: true, error: bodyText } : {}),
      },
    };
  }
  // Recognizable lifecycle events.
  if (/prompt|user.?message|user.?input/.test(eventName)) return { ...base, hook_event_type: "UserPromptSubmit", payload: { prompt: bodyText } };
  if (/session.?start|thread.?init|conversation.?start/.test(eventName)) return { ...base, hook_event_type: "SessionStart", payload: { message: bodyText } };
  if (/session.?end|thread.?end|turn.?complete|response.?complete/.test(eventName)) return { ...base, hook_event_type: "Turn complete", payload: { message: bodyText } };
  // Any other GenAI-tagged record → a notification carrying its body.
  if (bodyText || eventName) return { ...base, hook_event_type: "Notification", payload: { message: bodyText || eventName, event: eventName || undefined } };
  return null;
}

/** Parse an OTLP/HTTP JSON ExportLogsServiceRequest into ingest events. */
export function otlpLogsToEvents(body: unknown): IngestBody[] {
  const out: IngestBody[] = [];
  const rl = (body as { resourceLogs?: unknown[] })?.resourceLogs;
  if (Array.isArray(rl)) {
    let capped = false;
    for (const r of rl as Array<Record<string, unknown>>) {
      if (capped) break;
      const resAttrs = flatten((r?.resource as { attributes?: KeyValue[] })?.attributes);
      const scopeLogs = (r?.scopeLogs ?? r?.instrumentationLibraryLogs ?? []) as Array<{ logRecords?: OtlpLogRecord[] }>;
      for (const sl of scopeLogs) {
        if (capped) break;
        for (const rec of sl?.logRecords ?? []) {
          try {
            const ev = logRecordToEvent(rec, resAttrs);
            if (ev) out.push(ev);
          } catch {
            /* skip a malformed record */
          }
          if (out.length >= MAX_OTLP_EVENTS_PER_REQUEST) { capped = true; break; }
        }
      }
    }
    if (capped) {
      out.length = MAX_OTLP_EVENTS_PER_REQUEST;
      console.warn(`[otlp] logs request hit the ${MAX_OTLP_EVENTS_PER_REQUEST}-event cap — dropping the rest to keep the single ingest thread responsive`);
    }
  }
  out.sort((x, y) => (x.timestamp ?? 0) - (y.timestamp ?? 0));
  return out;
}

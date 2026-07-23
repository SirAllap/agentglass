// A single OTLP request must not schedule unbounded synchronous work on the
// server's one thread. /v1/traces and /v1/logs are unauthenticated (auth.ts
// exempts them), so an anonymous export with millions of spans/records would map
// to millions of events, each a synchronous SQLite insert on the ingest thread —
// a freeze, not a slowdown. These pin that the mappers cap what one request can
// produce, and that an honest batch is untouched.
import { test, expect } from "bun:test";
import { otlpTracesToEvents, otlpLogsToEvents, MAX_OTLP_EVENTS_PER_REQUEST } from "../src/otlp.ts";

// A minimal GenAI LLM span → one "Turn complete" event.
const llmSpan = (i: number) => ({
  spanId: `s${i}`,
  name: "chat",
  startTimeUnixNano: "1000000",
  endTimeUnixNano: "2000000",
  attributes: [
    { key: "gen_ai.system", value: { stringValue: "openai" } },
    { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
  ],
});

// A minimal GenAI log record → one event.
const llmLog = (i: number) => ({
  timeUnixNano: String(1000000 + i),
  attributes: [
    { key: "gen_ai.system", value: { stringValue: "codex" } },
    { key: "event.name", value: { stringValue: "gen_ai.user.message" } },
  ],
  body: { stringValue: `m${i}` },
});

test("traces mapper caps the events one request can produce", () => {
  const spans = Array.from({ length: MAX_OTLP_EVENTS_PER_REQUEST + 5_000 }, (_, i) => llmSpan(i));
  const body = { resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans }] }] };
  const out = otlpTracesToEvents(body);
  expect(out.length).toBe(MAX_OTLP_EVENTS_PER_REQUEST);
});

test("the cap holds even when spread across many resource/scope groups", () => {
  // 300 groups × 100 spans = 30k spans, well over the cap, but split up so the
  // break has to survive all three nested loops rather than one flat array.
  const resourceSpans = Array.from({ length: 300 }, () => ({
    resource: { attributes: [] },
    scopeSpans: [{ spans: Array.from({ length: 100 }, (_, i) => llmSpan(i)) }],
  }));
  const out = otlpTracesToEvents({ resourceSpans });
  expect(out.length).toBe(MAX_OTLP_EVENTS_PER_REQUEST);
});

test("logs mapper caps the events one request can produce", () => {
  const logRecords = Array.from({ length: MAX_OTLP_EVENTS_PER_REQUEST + 5_000 }, (_, i) => llmLog(i));
  const body = { resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ logRecords }] }] };
  const out = otlpLogsToEvents(body);
  expect(out.length).toBe(MAX_OTLP_EVENTS_PER_REQUEST);
});

test("an honest batch passes through untouched", () => {
  const spans = Array.from({ length: 50 }, (_, i) => llmSpan(i));
  const out = otlpTracesToEvents({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans }] }] });
  expect(out.length).toBe(50);
  expect(out.length).toBeLessThan(MAX_OTLP_EVENTS_PER_REQUEST);
});

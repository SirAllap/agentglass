/*
 * A cache creation is ordinary until the same model/agent lineage had already
 * established a cache and then sat beyond the five-minute window. These cases
 * pin both sides of that inference so the insight cannot price a model switch,
 * another subagent's work, or normal within-window churn as avoidable spend.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-cache-rebuild-"));
process.env.AGENTGLASS_DB = join(dir, "cache-rebuild.db");
delete process.env.AGENTGLASS_ROOT;
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");
let insights: typeof import("../src/insights.ts");
const now = Date.now();

const event = (
  session_id: string,
  at: number,
  cache_creation_tokens: number,
  over: Record<string, unknown> = {},
) => ({
  source_app: "orbit",
  session_id,
  hook_event_type: "Stop",
  tool_name: null,
  tool_use_id: null,
  agent_id: null,
  agent_type: null,
  model_name: "claude-opus-4-8",
  is_error: 0,
  error_text: null,
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_tokens, cache_read_tokens: 0 },
  usage_is_cumulative: false,
  summary: "",
  timestamp: at,
  payload: { project_path: "/work/orbit" },
  chat: null,
  ...over,
});

const pair = (
  session: string,
  gapMs: number,
  previous: Record<string, unknown> = {},
  current: Record<string, unknown> = {},
) => {
  db.insertEvent(event(session, now - gapMs - 60_000, 100_000, previous) as any);
  db.insertEvent(event(session, now - 60_000, 100_000, current) as any);
};

beforeAll(async () => {
  db = await import("../src/db.ts");
  insights = await import("../src/insights.ts");

  pair("expired-main", 9 * 60_000);
  db.insertEvent(event("repeated", now - 15 * 60_000, 100_000) as any);
  db.insertEvent(event("repeated", now - 8 * 60_000, 100_000) as any);
  db.insertEvent(event("repeated", now - 60_000, 100_000) as any);
  pair("still-live", 4 * 60_000);
  pair("model-switch", 9 * 60_000, {}, { model_name: "claude-sonnet-4-8" });
  pair("agent-switch", 9 * 60_000, {}, { agent_id: "agent-a", agent_type: "subagent" });
  pair("same-agent", 9 * 60_000,
    { agent_id: "agent-a", agent_type: "subagent" },
    { agent_id: "agent-a", agent_type: "subagent" });
  pair("different-agent", 9 * 60_000,
    { agent_id: "agent-a", agent_type: "subagent" },
    { agent_id: "agent-b", agent_type: "subagent" });
  pair("small-rebuild", 9 * 60_000, {}, {
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 9_999, cache_read_tokens: 0 },
  });
  pair("unknown-model", 9 * 60_000,
    { model_name: "private-model" },
    { model_name: "private-model" });
  db.insertEvent(event("prior-read", now - 10 * 60_000, 0, {
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 100_000 },
  }) as any);
  db.insertEvent(event("prior-read", now - 60_000, 100_000) as any);
});

const caches = () => insights.getInsights().filter((i) => i.kind === "cache");
const cache = (session: string) => caches().find((i) => i.id === `cache:orbit:${session}`);

describe("expired prompt cache insight", () => {
  test("prices the write/read premium after the five-minute window", () => {
    const i = cache("expired-main");
    expect(i?.title).toBe("Rebuilt expired cache · 1× · $0.58");
    expect(i?.detail).toBe("100k tokens paid at cache-write instead of cache-read rates");
  });

  test("accepts a prior cache read as evidence that the prefix existed", () => {
    expect(cache("prior-read")).toBeDefined();
  });

  test("aggregates repeated rebuilds and their write premium", () => {
    expect(cache("repeated")?.title).toBe("Rebuilt expired cache · 2× · $1.15");
  });

  test("does not flag ordinary within-window cache creation", () => {
    expect(cache("still-live")).toBeUndefined();
  });

  test("keeps model and agent lineages separate", () => {
    expect(cache("model-switch")).toBeUndefined();
    expect(cache("agent-switch")).toBeUndefined();
    expect(cache("different-agent")).toBeUndefined();
    expect(cache("same-agent")).toBeDefined();
  });

  test("ignores creations below the useful-signal floor", () => {
    expect(cache("small-rebuild")).toBeUndefined();
  });

  test("does not invent a penalty for an unpriced model", () => {
    expect(cache("unknown-model")).toBeUndefined();
  });
});

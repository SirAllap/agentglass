// External harnesses retry when a POST times out, and some already know the
// exact provider charge. The ingest seam must make retries safe and prefer an
// authoritative per-event cost without changing the existing token counters.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-reliable-ingest-"));
const root = join(dir, "project");
mkdirSync(root, { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "events.db");
process.env.AGENTGLASS_ROOT = root;
process.env.XDG_CONFIG_HOME = dir;

const ingest = await import("../src/ingest.ts");
const db = await import("../src/db.ts");
const pricing = await import("../src/pricing.ts");

const body = (over: Record<string, unknown> = {}) => ({
  source_app: "external-harness",
  session_id: "reliable-session",
  hook_event_type: "Notification",
  model_name: "gpt-5.1",
  timestamp: Date.now(),
  payload: {
    project_path: root,
    usage: { input_tokens: 1_000, output_tokens: 100 },
    message: "firstwriteuniquemarker",
  },
  ...over,
});

describe("external ingest extensions", () => {
  test("accepts an opaque event id and a zero reported cost", () => {
    expect(ingest.externalIngestError(body({ event_id: "  opaque id  ", reported_cost_usd: 0 }) as any)).toBeNull();
    const normalized = ingest.normalize(body({ event_id: "  opaque id  ", reported_cost_usd: 0 }) as any);
    expect(normalized.event_id).toBe("  opaque id  ");
    expect(normalized.reported_cost_usd).toBe(0);
  });

  test("rejects malformed ids and costs at the HTTP boundary", () => {
    expect(ingest.externalIngestError(body({ event_id: "" }) as any)).toContain("event_id");
    expect(ingest.externalIngestError(body({ event_id: "x".repeat(513) }) as any)).toContain("event_id");
    expect(ingest.externalIngestError(body({ event_id: 42 }) as any)).toContain("event_id");
    expect(ingest.externalIngestError(body({ reported_cost_usd: -1 }) as any)).toContain("reported_cost_usd");
    expect(ingest.externalIngestError(body({ reported_cost_usd: Infinity }) as any)).toContain("reported_cost_usd");
    expect(ingest.externalIngestError(body({ reported_cost_usd: "0.12" }) as any)).toContain("reported_cost_usd");
  });
});

describe("idempotent event writes", () => {
  test("keeps the first write and returns it on retry without changing rollups or FTS", () => {
    const first = db.insertEvent(ingest.normalize(body({
      event_id: "retry-safe-1",
      reported_cost_usd: 0.1234,
    }) as any));
    const retry = db.insertEvent(ingest.normalize(body({
      event_id: "retry-safe-1",
      reported_cost_usd: 99,
      summary: "retry-should-not-replace-first",
      payload: {
        project_path: root,
        usage: { input_tokens: 999_999, output_tokens: 999_999 },
        message: "retryonlyuniquemarker",
      },
    }) as any));

    expect(first.inserted).toBe(true);
    expect(retry.inserted).toBe(false);
    expect(retry.event.id).toBe(first.event.id);
    expect(retry.event.cost_usd).toBeCloseTo(0.1234, 10);
    const session = db.getSession("reliable-session")!;
    expect(session.events).toBe(1);
    expect(session.input_tokens).toBe(1_000);
    expect(session.output_tokens).toBe(100);
    expect(session.cost_usd).toBeCloseTo(0.1234, 10);
    expect(db.getRecent(100).filter((e) => e.event_id === "retry-safe-1")).toHaveLength(1);
    expect(db.searchEvents("firstwriteuniquemarker")).toHaveLength(1);
    expect(db.searchEvents("retryonlyuniquemarker")).toHaveLength(0);
  });

  test("scopes an event id to its source and session", () => {
    const sameId = "shared-id";
    const a = db.insertEvent(ingest.normalize(body({
      event_id: sameId,
      session_id: "scope-a",
      reported_cost_usd: 0,
    }) as any));
    const b = db.insertEvent(ingest.normalize(body({
      event_id: sameId,
      session_id: "scope-b",
      reported_cost_usd: 0,
    }) as any));
    const c = db.insertEvent(ingest.normalize(body({
      event_id: sameId,
      source_app: "another-harness",
      session_id: "scope-a",
      reported_cost_usd: 0,
    }) as any));

    expect([a.inserted, b.inserted, c.inserted]).toEqual([true, true, true]);
  });

  test("keeps the existing append-only behavior when event_id is absent", () => {
    const first = db.insertEvent(ingest.normalize(body({ session_id: "append-only" }) as any));
    const second = db.insertEvent(ingest.normalize(body({ session_id: "append-only" }) as any));
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(true);
    expect(second.event.id).not.toBe(first.event.id);
    expect(second.session.event_count).toBe(2);
  });
});

describe("reported cost precedence", () => {
  test("keeps pricing-table estimation when reported_cost_usd is absent", () => {
    const result = db.insertEvent(ingest.normalize(body({ session_id: "estimated-cost" }) as any));
    expect(result.event.cost_usd).toBeCloseTo(
      pricing.costUsd({ input_tokens: 1_000, output_tokens: 100 }, "gpt-5.1"),
      10,
    );
  });

  test("zero and non-zero reported costs override pricing while tokens still accumulate", () => {
    const zero = db.insertEvent(ingest.normalize(body({
      event_id: "reported-zero",
      session_id: "reported-cost-session",
      reported_cost_usd: 0,
    }) as any));
    const exact = db.insertEvent(ingest.normalize(body({
      event_id: "reported-exact",
      session_id: "reported-cost-session",
      reported_cost_usd: 0.456789,
    }) as any));

    expect(zero.event.cost_usd).toBe(0);
    expect(exact.event.cost_usd).toBeCloseTo(0.456789, 10);
    expect(exact.session.input_tokens).toBe(2_000);
    expect(exact.session.output_tokens).toBe(200);
    expect(exact.session.cost_usd).toBeCloseTo(0.456789, 10);
  });
});

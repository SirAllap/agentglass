// The open-tool list drives the 4 s fleet tick, and the loop that tick blocks
// is the one the PTY rides. The list is memoized with write-driven invalidation:
// an empty result stays cached until a tool event, so an idle machine stops
// re-running the scoped scan on every tick; a tool opening or closing
// invalidates it so the card updates on the very next read. These tests assert
// that contract by reference identity, so they say nothing about timing and
// cannot go flaky.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set before the dynamic import: db.ts opens its Database at module load.
const dir = mkdtempSync(join(tmpdir(), "agx-opentool-"));
process.env.AGENTGLASS_DB = join(dir, "opentool.db");
process.env.XDG_CONFIG_HOME = dir;
// Unscoped on purpose: the memo's behaviour is what's under test, not scoping.
delete process.env.AGENTGLASS_ROOT;

let db: typeof import("../src/db.ts");

const base = {
  source_app: "app",
  tool_name: "Bash",
  tool_use_id: null as string | null,
  agent_id: null,
  agent_type: null,
  model_name: "claude-opus-4-8",
  is_error: 0,
  error_text: null,
  usage: { input_tokens: 1, output_tokens: 1, cache_creation_tokens: 0, cache_read_tokens: 0 },
  usage_is_cumulative: false,
  summary: "x",
  payload: {},
  chat: null,
};
// Pre and Post share a tool_use_id so the Post pairs (closes) the Pre.
const pre = (session: string) => ({ ...base, session_id: session, hook_event_type: "PreToolUse", tool_use_id: session + "-t", timestamp: Date.now() });
const post = (session: string) => ({ ...base, session_id: session, hook_event_type: "PostToolUse", tool_use_id: session + "-t", timestamp: Date.now() });
// The legacy path: no tool_use_id, so a Post closes a Pre by session + tool +
// a later timestamp instead. Guards the split-OR rewrite of openToolSql.
const preNoId = (session: string, at: number) => ({ ...base, session_id: session, hook_event_type: "PreToolUse", tool_name: "Bash", tool_use_id: null, timestamp: at });
const postNoId = (session: string, at: number) => ({ ...base, session_id: session, hook_event_type: "PostToolUse", tool_name: "Bash", tool_use_id: null, timestamp: at });

beforeAll(async () => {
  db = await import("../src/db.ts");
});

describe("open-tool memo", () => {
  test("an unchanged read is served from the memo (same array reference)", () => {
    const a = db.openToolCalls();
    expect(db.openToolCalls()).toBe(a); // no write in between → memoized
  });

  test("a PreToolUse write invalidates it and the tool shows on the next read", () => {
    const before = db.openToolCalls();
    db.insertEvent(pre("s-open") as any);
    const after = db.openToolCalls();
    expect(after).not.toBe(before); // recomputed, not the stale memo
    expect(after.some((c) => c.session_id === "s-open")).toBe(true);
  });

  test("a PostToolUse write invalidates it and the tool closes", () => {
    db.insertEvent(post("s-open") as any); // pairs the Pre → no longer open
    expect(db.openToolCalls().some((c) => c.session_id === "s-open")).toBe(false);
  });

  test("invalidateOpenTools() forces a fresh read", () => {
    const a = db.openToolCalls();
    db.invalidateOpenTools();
    expect(db.openToolCalls()).not.toBe(a);
  });
});

describe("open-tool pairing without a tool_use_id (legacy path)", () => {
  test("a Post closes a Pre by session + tool + a later timestamp", () => {
    const s = "s-legacy";
    const t0 = Date.now();
    db.insertEvent(preNoId(s, t0) as any);
    db.invalidateOpenTools();
    expect(db.openToolCalls().some((c) => c.session_id === s)).toBe(true); // open

    db.insertEvent(postNoId(s, t0 + 1000) as any); // same session+tool, later → closes it
    db.invalidateOpenTools();
    expect(db.openToolCalls().some((c) => c.session_id === s)).toBe(false); // closed
  });

  test("a Post for a DIFFERENT tool does not close it", () => {
    const s = "s-legacy-2";
    const t0 = Date.now();
    db.insertEvent(preNoId(s, t0) as any); // tool_name Bash
    db.insertEvent({ ...postNoId(s, t0 + 1000), tool_name: "Read" } as any); // different tool
    db.invalidateOpenTools();
    expect(db.openToolCalls().some((c) => c.session_id === s)).toBe(true); // still open
  });
});

describe("sessions memo", () => {
  test("an unchanged read of the same key is served from the memo", () => {
    const a = db.getSessions(50);
    expect(db.getSessions(50)).toBe(a); // same (limit, provider, scope) within the TTL
  });
});

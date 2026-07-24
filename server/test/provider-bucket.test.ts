// Provider filtering must never make sessions vanish (#246).
//
// `provider` is a single column on `sessions`, and a session whose model never
// resolved is stored as NULL. Filtering with `provider = ?` matched no such
// row, so those sessions disappeared from every provider-scoped view and the
// sum of the per-provider numbers came out below the unfiltered total, with no
// signal that anything was missing.
//
// The fix gives NULL a home: the "unknown" bucket (the same string the web's
// providerOf(null) returns) scopes to `provider IS NULL`, so per-provider reads
// reconcile with the total. These drive the real query layer against a throwaway
// DB. It is scoped to a private project root so the counts are exactly this
// test's events even though bun shares one DB across the suite, and the session
// assertions are restricted to this test's ids as a second guard.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-provider-"));
const PROJ = join(dir, "proj");
mkdirSync(PROJ, { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "provider.db");
process.env.AGENTGLASS_ROOT = PROJ; // scope every read to this test's own project
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");

const MINE = ["pb-anthropic", "pb-openai", "pb-null-1", "pb-null-2"];
const mineOf = (rows: { session_id: string }[]) =>
  rows.map((s) => s.session_id).filter((id) => MINE.includes(id)).sort();

const event = (session: string, model: string | null) => ({
  source_app: "app",
  session_id: session,
  hook_event_type: "PostToolUse",
  tool_name: "Bash",
  tool_use_id: null,
  agent_id: null,
  agent_type: null,
  model_name: model,
  is_error: 0,
  error_text: null,
  usage: { input_tokens: 10, output_tokens: 20, cache_creation_tokens: 0, cache_read_tokens: 0 },
  usage_is_cumulative: false,
  summary: "did a thing",
  timestamp: Date.now(),
  payload: { project_path: PROJ },
  chat: null,
});

beforeAll(async () => {
  db = await import("../src/db.ts");
  db.insertEvent(event("pb-anthropic", "claude-opus-4-8") as any); // → Anthropic
  db.insertEvent(event("pb-openai", "gpt-4o") as any); // → OpenAI
  db.insertEvent(event("pb-null-1", null) as any); // → provider NULL (unknown)
  db.insertEvent(event("pb-null-2", null) as any); // → provider NULL (unknown)
});

describe("provider filtering keeps NULL-provider sessions reachable", () => {
  test("getSessions('unknown') returns exactly the NULL-provider sessions", () => {
    expect(mineOf(db.getSessions(100, "unknown"))).toEqual(["pb-null-1", "pb-null-2"]);
  });

  test("a real provider filter still excludes the NULL sessions", () => {
    expect(mineOf(db.getSessions(100, "Anthropic"))).toEqual(["pb-anthropic"]);
  });

  test("the per-provider session views sum to the unfiltered total (nothing lost)", () => {
    const all = mineOf(db.getSessions(100));
    const anthropic = mineOf(db.getSessions(100, "Anthropic"));
    const openai = mineOf(db.getSessions(100, "OpenAI"));
    const unknown = mineOf(db.getSessions(100, "unknown"));
    expect(all.length).toBe(4);
    expect(anthropic.length + openai.length + unknown.length).toBe(all.length);
  });

  test("statsSummary reconciles: per-provider event counts sum to the total", () => {
    const events = (p?: string) => (db.statsSummary(24 * 3600 * 1000, p) as any).totals.events;
    // Scoped to this test's project, so these are exactly its four events.
    expect(events()).toBe(4);
    expect(events("Anthropic") + events("OpenAI") + events("unknown")).toBe(events());
    expect(events("unknown")).toBe(2); // the two NULL-provider sessions are no longer lost
  });
});

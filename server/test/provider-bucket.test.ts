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

const MINE = ["pb-anthropic", "pb-openai", "pb-null-1", "pb-null-2", "pb-multi"];
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
  // One session that ran under TWO providers — the case that used to be latched
  // to whichever was seen first. Its Opus event belongs to Anthropic, its GPT
  // event to OpenAI.
  db.insertEvent(event("pb-multi", "claude-opus-4-8") as any);
  db.insertEvent(event("pb-multi", "gpt-4o") as any);
});

describe("provider filtering keeps NULL-provider sessions reachable", () => {
  test("getSessions('unknown') returns exactly the NULL-provider sessions", () => {
    expect(mineOf(db.getSessions(100, "unknown"))).toEqual(["pb-null-1", "pb-null-2"]);
  });

  test("a real provider filter excludes the NULL sessions", () => {
    const anthropic = mineOf(db.getSessions(100, "Anthropic"));
    expect(anthropic).not.toContain("pb-null-1");
    expect(anthropic).not.toContain("pb-null-2");
  });

  test("every session appears in at least one provider view (nothing lost)", () => {
    const all = new Set(mineOf(db.getSessions(100)));
    const covered = new Set([
      ...mineOf(db.getSessions(100, "Anthropic")),
      ...mineOf(db.getSessions(100, "OpenAI")),
      ...mineOf(db.getSessions(100, "unknown")),
    ]);
    expect(all.size).toBe(5);
    expect(covered).toEqual(all); // union of the buckets == the whole set
  });

  test("statsSummary reconciles at the EVENT level: per-provider counts sum to the total", () => {
    const events = (p?: string) => (db.statsSummary(24 * 3600 * 1000, p) as any).totals.events;
    // Five sessions, six events (pb-multi ran two). Each event is counted under
    // exactly its own model's provider, so the buckets partition the events even
    // though pb-multi's session shows in two of them.
    expect(events()).toBe(6);
    expect(events("Anthropic") + events("OpenAI") + events("unknown")).toBe(events());
    expect(events("unknown")).toBe(2);
  });
});

describe("a multi-provider session is attributed per event, not latched to one", () => {
  test("the session appears under BOTH providers it used", () => {
    expect(mineOf(db.getSessions(100, "Anthropic"))).toContain("pb-multi");
    expect(mineOf(db.getSessions(100, "OpenAI"))).toContain("pb-multi");
  });

  test("its events split across providers by their own model, not the first-seen one", () => {
    const events = (p: string) => (db.statsSummary(24 * 3600 * 1000, p) as any).totals.events;
    // pb-anthropic + pb-multi's Opus event = 2 under Anthropic;
    // pb-openai + pb-multi's GPT event = 2 under OpenAI. The GPT event is NOT
    // billed to Anthropic just because the session was seen as Anthropic first.
    expect(events("Anthropic")).toBe(2);
    expect(events("OpenAI")).toBe(2);
  });
});

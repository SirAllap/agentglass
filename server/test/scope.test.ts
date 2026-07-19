// Project scoping is a *read* filter, not just an ingest filter.
//
// The bug this guards: scope used to be applied only when the scanner decided
// what to ingest, so a cockpit opened for one project still served every other
// project's events, sessions, spend and search hits from history collected
// earlier. Nothing failed loudly — the numbers were simply someone else's.
//
// These tests drive the real query layer against a throwaway DB, because the
// regression is "the WHERE clause isn't there at all": asserting on a SQL
// fragment would happily pass while the rows stayed unfiltered.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Both are read once at module load inside db.ts / config.ts, so they have to
// be set before the dynamic import below — not at the top of a normal import.
const dir = mkdtempSync(join(tmpdir(), "agx-scope-"));

// Real directories: config.ts resolves a scope against the filesystem and
// discards one that doesn't exist, so string-only paths would silently leave
// the instance unscoped and every assertion below would test nothing.
const SCOPED = join(dir, "scoped");
const OTHER = join(dir, "other");
// A repo whose root sits outside the scope while the turn itself ran *inside*
// it — the monorepo-subdir / linked-worktree case. Given its own name so the
// assertions can tell "in scope via cwd" apart from "out of scope entirely".
const MONO = join(dir, "mono");
for (const p of [SCOPED, OTHER, MONO]) mkdirSync(p, { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "scope.db");
process.env.AGENTGLASS_ROOT = SCOPED;
// Keep config.json out of it — the scope under test must come from this file,
// not from the developer's own open project.
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");

const event = (project: string, session: string, over: Record<string, unknown> = {}) => ({
  source_app: project.split("/").pop()!,
  session_id: session,
  hook_event_type: "PostToolUse",
  tool_name: "Bash",
  tool_use_id: null,
  agent_id: null,
  agent_type: null,
  model_name: "claude-opus-4-8",
  is_error: 0,
  error_text: null,
  usage: { input_tokens: 10, output_tokens: 20, cache_creation_tokens: 0, cache_read_tokens: 0 },
  usage_is_cumulative: false,
  summary: "did a thing",
  timestamp: Date.now(),
  payload: { project_path: project, ...over },
  chat: null,
});

beforeAll(async () => {
  db = await import("../src/db.ts");
  db.insertEvent(event(SCOPED, "s-in-1") as any);
  db.insertEvent(event(SCOPED, "s-in-2") as any);
  db.insertEvent(event(OTHER, "s-out-1") as any);
  db.insertEvent(event(OTHER, "s-out-2") as any);
  // project_path is outside the scope, but the turn ran inside it — must count.
  db.insertEvent(event(MONO, "s-worktree", { cwd: SCOPED + "/wt/feature" }) as any);
});

describe("scoped reads", () => {
  test("getRecent returns only the scoped project", () => {
    const apps = new Set(db.getRecent(500).map((e) => e.source_app));
    expect(apps.has("scoped")).toBe(true);
    expect(apps.has("other")).toBe(false);
  });

  test("getSessions excludes other projects", () => {
    const ids = db.getSessions(100).map((s) => s.session_id);
    expect(ids).toContain("s-in-1");
    expect(ids).not.toContain("s-out-1");
  });

  test("filter options only offer apps the feed can actually show", () => {
    // The dropdown and the feed must agree, or picking an app empties the panel.
    // mono earns its place: its turn ran inside the scope.
    expect(db.getFilterOptions().source_apps.sort()).toEqual(["mono", "scoped"]);
  });

  test("stats count the scoped project alone", () => {
    const s = db.statsSummary(24 * 3600 * 1000) as any;
    // 2 scoped events + the worktree turn; the two out-of-scope ones are gone.
    expect(s.totals.events).toBe(3);
  });

  test("a worktree of the scoped repo is in scope via cwd", () => {
    expect(db.getRecent(500).some((e) => e.session_id === "s-worktree")).toBe(true);
  });

  test("export carries the scope too", () => {
    const rows = db.exportRows(1000);
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.source_app !== "other")).toBe(true);
    expect(rows.some((r) => r.source_app === "mono")).toBe(true);
  });
});

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
// A sibling whose path starts with the scope's — `scoped-backup` vs `scoped`.
// The old SQL matched with LIKE 'scoped/%'; the rule is now a JS `startsWith`
// on the same trailing slash, and it has to keep drawing the line in the same
// place.
const SIBLING = join(dir, "scoped-backup");
// A repo whose root sits outside the scope while the turn itself ran *inside*
// it — the monorepo-subdir / linked-worktree case. Given its own name so the
// assertions can tell "in scope via cwd" apart from "out of scope entirely".
const MONO = join(dir, "mono");
for (const p of [SCOPED, OTHER, MONO, SIBLING]) mkdirSync(p, { recursive: true });
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
  // Shares the scope's name as a prefix and is a different project.
  db.insertEvent(event(SIBLING, "s-sibling") as any);
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

  test("the filter is an indexed equality test, not a per-row prefix scan", () => {
    // The shape is the fix. This used to be one four-way OR group per checkout
    // — seventy-two predicates on an eighteen-worktree repo, half of them LIKE,
    // against every row, which no index survives and which got worse with every
    // worktree added. Measured on a real database: 194ms → 9ms for the same
    // answer.
    const { clause, args } = db.scopeClause();
    expect(clause).toContain("project_path IN");
    expect(clause).toContain("cwd_path IN");
    expect(clause).not.toContain("LIKE");
    expect(args.length).toBeGreaterThan(0);
  });

  test("a sibling that merely shares the scope's prefix is out", () => {
    // `~/code/scoped-backup` must not be dragged in by `~/code/scoped`. The
    // test that used to guard this asserted the SQL said `LIKE 'x/%'`; the rule
    // is JS now, so it is checked where it is actually applied — against rows.
    const apps = new Set(db.getRecent(500).map((e) => e.source_app));
    expect(apps.has("scoped")).toBe(true);
    expect(apps.has("scoped-backup")).toBe(false);
  });

  test("export carries the scope too", () => {
    const rows = db.exportRows(1000);
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.source_app !== "other")).toBe(true);
    expect(rows.some((r) => r.source_app === "mono")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The live seam.
//
// Everything above proves the *reads* are filtered. The WebSocket push was not,
// which made the same window disagree with itself: a reload showed the open
// project and the next event from anywhere on the machine put a stranger back on
// the fleet. It showed up on the top bar, which interrupts for exactly this.
// ---------------------------------------------------------------------------
describe("what is pushed live is what a reload would show", () => {
  let cfg: typeof import("../src/config.ts");
  beforeAll(async () => { cfg = await import("../src/config.ts"); });

  test("a session in the open project is pushed", () => {
    expect(cfg.sessionInScope({ project_path: SCOPED, cwd_path: SCOPED })).toBe(true);
  });

  test("a session in another project is not", () => {
    expect(cfg.sessionInScope({ project_path: OTHER, cwd_path: OTHER })).toBe(false);
  });

  test("a sibling whose path merely starts the same is not", () => {
    expect(cfg.sessionInScope({ project_path: SIBLING, cwd_path: SIBLING })).toBe(false);
  });

  // The monorepo / linked-worktree case: the repo root is elsewhere but the turn
  // ran inside the project. The SQL accepts either column and so must this, or
  // a scoped cockpit would go blind to the work actually happening in it.
  test("either column is enough, exactly as the SQL has it", () => {
    expect(cfg.sessionInScope({ project_path: MONO, cwd_path: SCOPED })).toBe(true);
    expect(cfg.sessionInScope({ project_path: SCOPED, cwd_path: MONO })).toBe(true);
  });

  test("a session that says nothing about where it is, is not in the project", () => {
    expect(cfg.sessionInScope({ project_path: null, cwd_path: null })).toBe(false);
  });

  // Unscoped is the machine-wide default and must stay unfiltered — this is the
  // guard against "fixing" the leak by scoping a cockpit nobody scoped.
  test("with no project open, everything is pushed", () => {
    expect(cfg.sessionInScope({ project_path: OTHER, cwd_path: OTHER }, null)).toBe(true);
    expect(cfg.sessionInScope({ project_path: null, cwd_path: null }, null)).toBe(true);
  });
});

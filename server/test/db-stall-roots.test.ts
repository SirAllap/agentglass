/*
 * Three loop stalls, one cause each (measured on a 785k-row copy):
 *  - scoped filter dropdowns: OR over two path indexes fetched every matching table row, 355 ms x3; now an
 *    in-memory facet set, filled in yielding slices, with no index and no scan in the route;
 *  - the recorded-path set: DISTINCT walked the whole column index, 143 ms; a skip scan is 7 ms;
 *  - the newest-changes list: the payload of every Edit in history went through the sorter.
 * Each is asserted on the plan, and on giving the same answer as before.
 *
 * `bun test` runs every file in one process, so the facet set, its timer and the shared db outlive a file.
 * Each test here builds its own rows and a fresh facet set in beforeEach (the order is shuffled by --seed), and afterAll puts the process back.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-stall-"));
const PROJ = join(dir, "orbit");
mkdirSync(PROJ, { recursive: true });
process.env.AGENTGLASS_DB ??= join(dir, "stall.db");
const prevRoot = process.env.AGENTGLASS_ROOT;

const { db, getFilterOptions, getChanges, scopeClause, whenFacetsFilled, facetStats, facetTest, insertEvent, eraseHistory, pruneOldRows, __resetFacets, __risksWarming } = await import("../src/db.ts");

const ins = db.prepare(
  `INSERT INTO events (source_app, session_id, hook_event_type, tool_name, model_name, payload, timestamp) VALUES (?,?,?,?,?,?,?)`);
const row = (app: string, type: string, tool: string | null, model: string | null, payload: object, ts: number) =>
  ins.run(app, "s1", type, tool, model, JSON.stringify(payload), ts);

// Before EVERY test, not once: --seed shuffles the order, and several tests insert, erase or fill.
beforeEach(() => {
  process.env.AGENTGLASS_ROOT = PROJ;
  eraseHistory(); // rows other db-* files (or the test before) left in the shared db would change every count below
  facetStats.slices = 0; facetStats.maxMs = 0; facetStats.fills = 0; facetStats.errors = 0;
  row("orbit-app", "PreToolUse", "Read", "model-a", { project_path: PROJ }, 1);
  row("orbit-app", "Stop", null, null, { cwd: join(PROJ, "sub"), project_path: PROJ }, 2);
  row("other-app", "Notification", null, "model-z", { project_path: join(dir, "elsewhere") }, 3);
  for (let i = 0; i < 400; i++) {
    row("orbit-app", "PostToolUse", i % 2 ? "Edit" : "Write", "model-b",
      { project_path: PROJ, tool_input: { file_path: join(PROJ, `f${i}.ts`) }, tool_response: { filePath: join(PROJ, `f${i}.ts`), structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }] } }, 100 + i);
  }
  db.transaction(() => { for (let i = 0; i < 3000; i++) row("orbit-app", "PreToolUse", "Read", "model-a", { project_path: PROJ }, 1000 + i); })();
  __resetFacets(60_000); // as at boot: the first fill has not run yet, whatever ran before
});
afterAll(async () => {
  if (prevRoot === undefined) delete process.env.AGENTGLASS_ROOT; else process.env.AGENTGLASS_ROOT = prevRoot;
  eraseHistory();
  __resetFacets(0); // default backoff, no failing slices, a settled fill for the next file
  await whenFacetsFilled();
  while (__risksWarming()) await Bun.sleep(5); // background risk warming from the inserts must not run into the next file
});

describe("stall fixes", () => {
  test("before the first fill the route answers from what it has, flagged partial, without a scan", () => {
    const o = getFilterOptions();
    expect(o.partial).toBe(true);
  });

  test("after the fill, scoped options list only the open project's values", async () => {
    __resetFacets(0);
    await whenFacetsFilled();
    const o = getFilterOptions();
    expect(o.partial).toBeUndefined();
    expect(o.source_apps).toEqual(["orbit-app"]);
    expect(o.hook_event_types).toEqual(["PostToolUse", "PreToolUse", "Stop"]);
    expect(o.models).toEqual(["model-a", "model-b"]);
  });

  test("the fill yields: many slices, each short", async () => {
    __resetFacets(0);
    await whenFacetsFilled();
    expect(facetStats.fills).toBeGreaterThanOrEqual(1);
    expect(facetStats.slices).toBeGreaterThanOrEqual(2);
    expect(facetStats.maxMs).toBeLessThan(50);
  });

  test("no index is created for the facets, and the route reads no table", () => {
    const idx = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
    expect(idx).not.toContain("idx_events_project_facets");
    expect(idx).not.toContain("idx_events_cwd_facets");
    const src = readFileSync(join(import.meta.dir, "../src/db.ts"), "utf8");
    expect(src).not.toMatch(/CREATE INDEX[^\n]*_facets/);
    const fn = src.slice(src.indexOf("export function getFilterOptions"), src.indexOf("export function getFilterOptions") + 900);
    expect(fn).not.toContain("db.query");
    expect(fn).not.toContain("SELECT");
  });

  test("an insert adds its values at once", () => {
    insertEvent({
      source_app: "new-app", session_id: "s2", event_id: null, hook_event_type: "UserPromptSubmit", tool_name: null,
      tool_use_id: null, agent_id: null, agent_type: null, model_name: "model-new", is_error: 0, error_text: null,
      usage: {}, usage_is_cumulative: false, payload: { project_path: PROJ }, timestamp: 9_000,
    } as never);
    const o = getFilterOptions();
    expect(o.source_apps).toContain("new-app");
    expect(o.models).toContain("model-new");
  });

  test("the recorded paths are found by skip scan and are complete", () => {
    const { args } = scopeClause();
    const paths = args.slice(0, args.length / 2);
    expect(paths).toContain(PROJ);
    expect(paths).not.toContain(join(dir, "elsewhere"));
  });

  test("newest changes: same newest-first list, limit respected", () => {
    const c = getChanges(300, undefined, false);
    expect(c.length).toBe(300);
    expect(c[0]!.file_path.endsWith("f399.ts")).toBe(true);
    expect(c[299]!.file_path.endsWith("f100.ts")).toBe(true);
  });

  test("newest changes: the payload is read only for the picked ids", () => {
    const src = Bun.file(join(import.meta.dir, "../src/db.ts"));
    return src.text().then((t) => {
      expect(t).toContain("WHERE id IN (SELECT id FROM events\n           WHERE hook_event_type='PostToolUse'");
    });
  });

  test("a slice that throws does not wedge the fill: it retries and finishes", async () => {
    facetTest.backoffMs = 5; facetTest.failSlices = 2;
    const e0 = facetStats.errors, f0 = facetStats.fills;
    insertEvent({
      source_app: "retry-app", session_id: "s3", event_id: null, hook_event_type: "Stop", tool_name: null,
      tool_use_id: null, agent_id: null, agent_type: null, model_name: null, is_error: 0, error_text: null,
      usage: {}, usage_is_cumulative: false, payload: { project_path: PROJ }, timestamp: 9_100,
    } as never);
    eraseHistory(); // starts a fresh fill; its first two slices throw
    await whenFacetsFilled();
    expect(facetStats.errors - e0).toBe(2);
    expect(facetStats.fills).toBeGreaterThan(f0);
    expect(getFilterOptions().partial).toBeUndefined();
  });

  test("no fill slice reads more than 4000 rows, however many there are", async () => {
    db.transaction(() => { for (let i = 0; i < 20_000; i++) row("orbit-app", "PreToolUse", "Read", "model-a", { project_path: PROJ }, 50_000 + i); })();
    facetStats.maxRows = 0;
    __resetFacets(0);
    await whenFacetsFilled();
    expect(facetStats.slices).toBeGreaterThan(5); // 23k rows: one slice cannot have taken them
    expect(facetStats.maxRows).toBeGreaterThan(0);
    expect(facetStats.maxRows).toBeLessThanOrEqual(4000);
  });

  test("retention deleting rows during the first fill still gets recounted", async () => {
    delete process.env.AGENTGLASS_ROOT; // unscoped: the lists are the plain sets
    __resetFacets(0);
    const s0 = facetStats.slices;
    while (facetStats.slices === s0) await new Promise((r) => setTimeout(r, 2)); // first slice read "other-app" (ts 3)
    const f0 = facetStats.fills;
    pruneOldRows(); // deletes the ts=1..3 rows; the fill is mid-way and cannot see it
    expect(getFilterOptions().partial).toBe(true); // still the first fill
    const until = Date.now() + 3000; // the fill that ends first read the rows before the delete: a second one must follow
    while (facetStats.fills < f0 + 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    expect(facetStats.fills).toBeGreaterThanOrEqual(f0 + 2);
    expect(getFilterOptions().source_apps).not.toContain("other-app");
  });

  test("erase during a fill cancels it: pre-erase values never come back", async () => {
    eraseHistory(); // fill F1 scheduled on an empty table
    db.transaction(() => { for (let i = 0; i < 3000; i++) row("ghost-app", "PreToolUse", "Read", "ghost-model", { project_path: PROJ }, 20_000 + i); })();
    const s0 = facetStats.slices;
    while (facetStats.slices === s0) await new Promise((r) => setTimeout(r, 2)); // F1 ran one slice and holds ghost values
    eraseHistory(); // must drop F1 and start over
    await whenFacetsFilled();
    await new Promise((r) => setTimeout(r, 50));
    const o = getFilterOptions();
    expect(o.source_apps).not.toContain("ghost-app");
    expect(o.models).not.toContain("ghost-model");
  });
});

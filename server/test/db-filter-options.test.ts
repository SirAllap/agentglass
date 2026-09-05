/*
 * The filter dropdowns are rebuilt when a new value arrives, not on a clock.
 *
 * They were behind a 30-second memo, so an idle machine ran three scoped
 * SELECT DISTINCTs about once every forty seconds for ever, to produce the same
 * list it produced last time. What actually changes them is one thing: an event
 * carrying a `source_app`, `hook_event_type` or `model_name` nobody has seen.
 *
 * So this is cheaper AND better, and both halves are asserted here — the second
 * one matters more. A new agent or model now appears in the dropdown on its
 * FIRST event instead of up to thirty seconds later.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-filter-"));
const PROJ = join(dir, "proj");
mkdirSync(PROJ, { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "filter.db");
process.env.AGENTGLASS_ROOT = PROJ;

const { db, getFilterOptions, insertEvent } = await import("../src/db.ts");
const { normalize } = await import("../src/ingest.ts");

/** Count how often the memo actually recomputes, by watching the queries it
 *  makes rather than by trusting the shape of the code. */
function countingDistincts<T>(fn: () => T): { value: T; queries: number } {
  const real = db.query.bind(db);
  let queries = 0;
  (db as unknown as { query: unknown }).query = (sql: string) => {
    if (sql.includes("SELECT DISTINCT")) queries++;
    return real(sql);
  };
  try { return { value: fn(), queries }; } finally { (db as unknown as { query: unknown }).query = real; }
}

const ingest = (app: string, type: string, model: string | null) =>
  insertEvent(normalize({
    source_app: app,
    session_id: `s-filter-${app}`,
    hook_event_type: type,
    timestamp: Date.now(),
    model_name: model,
    payload: { cwd: PROJ, project_path: PROJ },
  } as unknown as Parameters<typeof normalize>[0]));

describe("the filter dropdowns", () => {
  test("an idle machine does not recompute them", () => {
    ingest("probe-app", "PreToolUse", "probe-model");
    getFilterOptions(); // build the memo

    // Nothing has been ingested since, so nothing can have changed — however
    // many times the panel asks, and however long it waits.
    const { queries } = countingDistincts(() => { getFilterOptions(); getFilterOptions(); getFilterOptions(); });
    expect(queries).toBe(0);
  });

  test("an event carrying a value they already list does not either", () => {
    getFilterOptions();
    ingest("probe-app", "PreToolUse", "probe-model");
    const { queries } = countingDistincts(() => getFilterOptions());
    expect(queries).toBe(0);
  });

  test("a source_app nobody has seen shows up immediately", () => {
    getFilterOptions();
    ingest("probe-newcomer", "PreToolUse", "probe-model");
    const { value, queries } = countingDistincts(() => getFilterOptions());
    expect(queries).toBeGreaterThan(0);
    expect(value.source_apps).toContain("probe-newcomer");
  });

  test("so does a model nobody has seen", () => {
    getFilterOptions();
    ingest("probe-app", "PreToolUse", "probe-new-model");
    const { value, queries } = countingDistincts(() => getFilterOptions());
    expect(queries).toBeGreaterThan(0);
    expect(value.models).toContain("probe-new-model");
  });

  test("and a hook type nobody has seen", () => {
    getFilterOptions();
    ingest("probe-app", "ProbeNewHook", "probe-model");
    const { value, queries } = countingDistincts(() => getFilterOptions());
    expect(queries).toBeGreaterThan(0);
    expect(value.hook_event_types).toContain("ProbeNewHook");
  });
});

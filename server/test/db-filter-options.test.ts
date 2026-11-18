/*
 * The filter dropdowns list what the person's events carry, and a new value shows on its FIRST event.
 *
 * They answer from an in-memory facet set (filled in the background after boot), never from a query on
 * the request. So this asserts what the person SEES, not how it is computed: after events with a given
 * project / cwd / source_app / hook type / model go in, the options hold exactly those values, the scope
 * still narrows them, and that holds both before the first fill has finished (`partial: true`, values
 * inserted since boot present) and after it (partial gone).
 *
 * `bun test` runs every file in one process: the facet set and the shared db outlive a file, so this one
 * starts from an empty db and a fresh facet set, and puts the process back when it is done.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-filter-"));
const PROJ = join(dir, "proj");
const ELSEWHERE = join(dir, "elsewhere");
mkdirSync(PROJ, { recursive: true });
process.env.AGENTGLASS_DB ??= join(dir, "filter.db");
const prevRoot = process.env.AGENTGLASS_ROOT;

const { db, eraseHistory, facetStats, getFilterOptions, insertEvent, whenFacetsFilled, __resetFacets, __risksWarming } = await import("../src/db.ts");
const { timerFires } = await import("../src/loopwatch.ts");
const { normalize } = await import("../src/ingest.ts");

const ingest = (app: string, type: string, model: string | null, project = PROJ, cwd = project) =>
  insertEvent(normalize({
    source_app: app,
    session_id: `s-filter-${app}`,
    hook_event_type: type,
    timestamp: Date.now(),
    model_name: model,
    payload: { cwd, project_path: project },
  } as unknown as Parameters<typeof normalize>[0]));

const fillNow = async () => { __resetFacets(0); await whenFacetsFilled(); };

beforeEach(() => {
  process.env.AGENTGLASS_ROOT = PROJ;
  eraseHistory(); // other db-* files and the test before share this process and this db
});
afterAll(async () => {
  if (prevRoot === undefined) delete process.env.AGENTGLASS_ROOT; else process.env.AGENTGLASS_ROOT = prevRoot;
  eraseHistory();
  await fillNow();
  while (__risksWarming()) await Bun.sleep(5); // background risk warming from the inserts must not run into the next file
});

describe("the filter dropdowns, before the first fill finishes", () => {
  beforeEach(() => {
    __resetFacets(60_000); // a boot whose first fill has not run: only inserts since boot are known
    ingest("probe-app", "PreToolUse", "probe-model", PROJ, join(PROJ, "sub"));
    ingest("probe-other", "Notification", "probe-other-model", ELSEWHERE);
  });

  test("are flagged partial and list the values inserted since boot, narrowed to the open project", () => {
    const o = getFilterOptions();
    expect(o.partial).toBe(true);
    expect(o.source_apps).toEqual(["probe-app"]);
    expect(o.hook_event_types).toEqual(["PreToolUse"]);
    expect(o.models).toEqual(["probe-model"]);
  });

  test("a source_app nobody has seen shows up immediately", () => {
    ingest("probe-newcomer", "PreToolUse", "probe-model");
    const o = getFilterOptions();
    expect(o.partial).toBe(true);
    expect(o.source_apps).toEqual(["probe-app", "probe-newcomer"]);
  });

  test("so does a model nobody has seen", () => {
    ingest("probe-app", "PreToolUse", "probe-new-model");
    expect(getFilterOptions().models).toEqual(["probe-model", "probe-new-model"]);
  });

  test("and a hook type nobody has seen", () => {
    ingest("probe-app", "ProbeNewHook", "probe-model");
    expect(getFilterOptions().hook_event_types).toEqual(["PreToolUse", "ProbeNewHook"]);
  });
});

describe("the filter dropdowns, after the fill", () => {
  beforeEach(async () => {
    ingest("probe-app", "PreToolUse", "probe-model", PROJ, join(PROJ, "sub"));
    ingest("probe-newcomer", "ProbeNewHook", "probe-new-model");
    ingest("probe-other", "Notification", "probe-other-model", ELSEWHERE);
    await fillNow();
  });

  test("are no longer partial and hold exactly the open project's values", () => {
    const o = getFilterOptions();
    expect(o.partial).toBeUndefined();
    expect(o.source_apps).toEqual(["probe-app", "probe-newcomer"]);
    expect(o.hook_event_types).toEqual(["PreToolUse", "ProbeNewHook"]);
    expect(o.models).toEqual(["probe-model", "probe-new-model"]);
  });

  test("an event carrying values they already list changes nothing", () => {
    ingest("probe-app", "PreToolUse", "probe-model");
    const o = getFilterOptions();
    expect(o.source_apps).toEqual(["probe-app", "probe-newcomer"]);
    expect(o.hook_event_types).toEqual(["PreToolUse", "ProbeNewHook"]);
    expect(o.models).toEqual(["probe-model", "probe-new-model"]);
  });

  test("a value nobody has seen shows up on its first event: app, model and hook type", () => {
    ingest("probe-late", "ProbeLateHook", "probe-late-model");
    const o = getFilterOptions();
    expect(o.source_apps).toContain("probe-late");
    expect(o.hook_event_types).toContain("ProbeLateHook");
    expect(o.models).toContain("probe-late-model");
    expect(o.partial).toBeUndefined();
  });

  test("a value seen only outside the open project never shows", () => {
    const o = getFilterOptions();
    expect(o.source_apps).not.toContain("probe-other");
    expect(o.hook_event_types).not.toContain("Notification");
    expect(o.models).not.toContain("probe-other-model");
  });
});

describe("the fill over sparse ids", () => {
  test("steps over the rows, not the id range: a 40-million-id gap is a handful of slices", async () => {
    ingest("gap-app", "PreToolUse", "gap-model");
    // Retention leaves ids like this; stepping ids from 0 took ~10,000 slices of CPU for 300k rows.
    db.run("UPDATE events SET id = id + 40000000");
    const before = { ...facetStats }, timers = timerFires()["boot:facets:slice"] ?? 0;
    await fillNow();
    expect(getFilterOptions().source_apps).toContain("gap-app");
    expect(facetStats.slices - before.slices).toBeLessThanOrEqual(3);
    // and the labelled timer fired a bounded number of times for it, not once per 4000 ids
    expect((timerFires()["boot:facets:slice"] ?? 0) - timers).toBeLessThanOrEqual(3);
  });
});

// Upgrading from the build that kept presets in localStorage. The three stored
// strings are written the way that build wrote them (PrPanel's saveMap and
// useFilterPresets' write: JSON.stringify of a map keyed by the panel's
// "host/owner/name" key), with invented values. After the upgrade Main and QA
// must keep exactly the pull requests they kept, the active view and the live
// filter must survive, and the old keys must be byte-identical.
import { beforeAll, describe, expect, test } from "bun:test";
import type { PrSummary } from "../../shared/types.ts";
import { applyWith, readFilterSet } from "../src/components/tasks/filters.ts";
import { evalLanes } from "../src/lib/prFilterEval.ts";
import { readPrField, readPrFieldAt } from "../src/lib/prFilter.ts";
import { ACTIVE_KEY, PRESETS_KEY, readPresetMap } from "../src/lib/filterPresets.ts";
import { globalStubs } from "./stubGlobal.ts";

const stubGlobal = globalStubs();
const store = new Map<string, string>();
const fake = {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear(), key: () => null, get length() { return store.size; },
} as unknown as Storage;
stubGlobal("window", new EventTarget());

const F = await import("../src/lib/prBoardFilterStore.ts");
const V = await import("../src/lib/prViewsStore.ts");

const FILTERS_KEY = "agentglass.pr.filters";
const REPO = "acme/orbit";
const PANEL_KEY = "github.com/acme/orbit";

const stored = {
  [PRESETS_KEY]: JSON.stringify({
    [PANEL_KEY]: [
      { id: "fpm1x9ab", name: "Main", join: "and", order: 0, rules: [
        { field: "cardstatus", op: "is", values: ["Ready for QA", "Testing"] },
        { field: "cardassignee", op: "not", values: ["Ben Ortiz"] },
        { field: "author", op: "not", values: ["dependabot"] },
        { field: "label", op: "unset", values: [] },
      ] },
      { id: "fpq2k4cd", name: "QA", join: "or", order: 1, rules: [
        { field: "cardstatus", op: "is", values: ["Ready for QA"] },
        { field: "cardassignee", op: "not", values: ["Ben Ortiz", "Cy Lund", "Di Park"] },
        { field: "label", op: "is", values: ["needs work"] },
      ] },
    ],
    "github.com/acme/relay": [{ id: "fpz", name: "Other repo", join: "and", order: 0, rules: [{ field: "is", op: "is", values: ["draft"] }] }],
  }),
  [ACTIVE_KEY]: JSON.stringify({ [PANEL_KEY]: "fpq2k4cd" }),
  [FILTERS_KEY]: JSON.stringify({
    [PANEL_KEY]: { join: "and", rules: [
      { id: "r3", field: "cardstatus", op: "not", values: ["Done"] },
      { id: "r4", field: "is", op: "not", values: ["draft"] },
      { id: "r5", field: "cardassignee", op: "set", values: [] },
    ] },
  }),
};

const NOW = Date.parse("2026-10-27T12:00:00Z");
const read = (p: PrSummary, k: string) => readPrFieldAt(p, k, NOW);
const green = { total: 3, success: 3, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green" as const, failing: [] };
const red = { ...green, success: 2, failure: 1, verdict: "red" as const };
const card = (status: string, people: string[]) => ({ id: "c" + status, customId: "ORBIT-1042", title: "t", status, priority: null, people: people.map((name) => ({ name })) }) as unknown as PrSummary["card"];
function pr(number: number, over: Partial<PrSummary> = {}): PrSummary {
  return {
    number, mergeable: "MERGEABLE", title: "a pull request", author: "ana", state: "OPEN", isDraft: false,
    headRefName: "feature", baseRefName: "main", url: "", updatedAt: new Date(NOW - 86_400_000).toISOString(), reviewDecision: null,
    additions: 0, deletions: 0, changedFiles: 0, labels: [], assignees: [], milestone: null, checks: green, checksLoaded: true, ...over,
  };
}
const lbl = (n: string) => ({ name: n, color: "" }) as PrSummary["labels"][number];
const rows: PrSummary[] = [
  pr(1, { card: card("Ready for QA", ["Cy Lund"]) }),
  pr(2, { card: card("Ready for QA", ["Ben Ortiz"]), author: "bo" }),
  pr(3, { card: card("Testing", []), author: "cy" }),
  pr(4, { card: card("Done", ["Cy Lund"]), author: "cy" }),
  pr(5, { author: "dependabot", labels: [lbl("deps")] }),
  pr(6, { author: "bo", isDraft: true, card: card("In progress", ["Ben Ortiz"]) }),
  pr(7, { author: "ana", checks: red, card: card("Ready for QA", []) }),
  pr(8, { author: "cy", labels: [lbl("needs work")], card: card("Testing", ["Di Park"]) }),
  pr(9, { author: "bo", checksLoaded: false, card: card("Testing", ["Di Park"]) }),
  pr(10, { author: "ana", assignees: ["bo"] }),
  pr(11, { author: "dependabot", card: card("Ready for QA", ["Cy Lund"]) }),
  pr(12, { author: "di", card: card("Backlog", []), isDraft: true }),
];
/** What the old board evaluated for a preset: its rules as the builder held them. */
const oldSet = (p: { join: "and" | "or"; rules: { field: string; op: string; values: string[] }[] }) => ({ join: p.join, rules: p.rules.map((r, i) => ({ id: `r${i}`, field: r.field, op: r.op as "is", values: r.values })) });
const nums = (l: PrSummary[]) => l.map((p) => p.number);

describe("after the upgrade", () => {
  // Files share one process: this file's storage is put in place when its tests start, not when it loads.
  beforeAll(() => {
    stubGlobal("localStorage", fake);
    store.clear();
    for (const [k, v] of Object.entries(stored)) store.set(k, v);
    V.__resetViewsStore();
    F.__resetPrFilterStore();
  });
  type PrView = import("../../shared/prFilter.ts").PrView;
  const views: PrView[] = [];
  const puts: PrView[][] = [];
  let activeAtLoad: string | null = null, putsAtLoad = 0;
  // The upgrade happens once, as it does for a person; the tests only read what it left (they may be shuffled).
  beforeAll(async () => {
    V.__setViewsBackend({
      get: async () => ({ ok: true, views: [], saved: false }),
      put: async (_r, v) => { puts.push(v); return { ok: true, views: v }; },
    });
    await V.loadViews(REPO);
    views.push(...V.viewsState(REPO).views);
    activeAtLoad = V.activeViewId(REPO);
    putsAtLoad = puts.length;
  });

  test("Main and QA keep their names, order and exactly the pull requests they kept", () => {
    expect(views.map((v) => [v.name, v.order, v.id])).toEqual([["Main", 0, "fpm1x9ab"], ["QA", 1, "fpq2k4cd"]]);
    expect(putsAtLoad).toBe(1);
    const old = readPresetMap(JSON.parse(stored[PRESETS_KEY]))[PANEL_KEY]!;
    for (const [i, p] of old.entries()) {
      const before = nums(applyWith(rows, oldSet(p), readPrField));
      expect(before.length, `${p.name} must keep some and drop some`).toBeGreaterThan(0);
      expect(before.length).toBeLessThan(rows.length);
      expect(nums(evalLanes(rows, views[i]!.filter, read).kept), p.name).toEqual(before);
    }
  });

  test("the active view survives and points at a view that exists", () => {
    expect(activeAtLoad).toBe("fpq2k4cd");
    expect(views.find((v) => v.id === activeAtLoad)?.name).toBe("QA");
  });

  test("the live filter survives and keeps the same pull requests", () => {
    const flat = readFilterSet(JSON.parse(stored[FILTERS_KEY])[PANEL_KEY]);
    const before = nums(applyWith(rows, flat, readPrField));
    expect(before.length).toBeGreaterThan(0);
    expect(before.length).toBeLessThan(rows.length);
    expect(nums(evalLanes(rows, F.getPrFilter(REPO), read).kept)).toEqual(before);
  });

  test("the old keys are byte-identical after reading, editing, saving, moving and deleting", async () => {
    V.setActiveViewId(REPO, "fpm1x9ab");
    V.setActiveViewId(REPO, null);
    expect(F.setPrFilter(REPO, F.getPrFilter(REPO))).toBeNull();
    const list = V.viewsState(REPO).views;
    await V.commitViews(REPO, V.moveView(list, "fpq2k4cd", -1));
    await V.commitViews(REPO, V.removeView(V.viewsState(REPO).views, "fpm1x9ab")!.list);
    await V.commitViews(REPO, []);
    for (const k of [PRESETS_KEY, ACTIVE_KEY, FILTERS_KEY] as const) expect(store.get(k), k).toBe(stored[k]);
  });
});

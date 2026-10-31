// The board's saved views and live filter outside React: the one-time import
// from the old presets, the list's edits, and the doors an agent uses. The
// fixtures are the shape of a real board with invented names.
import { beforeEach, describe, expect, test } from "bun:test";
import type { PrSummary } from "../../shared/types.ts";
import { emptyLanes, VIEW_LIMITS, type PrView } from "../../shared/prFilter.ts";
import { applyWith } from "../src/components/tasks/filters.ts";
import { evalLanes } from "../src/lib/prFilterEval.ts";
import { readPrField, readPrFieldAt } from "../src/lib/prFilter.ts";
import { lanesToText } from "../src/lib/prFilterSyntax.ts";
import { ACTIVE_KEY, PRESETS_KEY, type Preset } from "../src/lib/filterPresets.ts";
import { globalStubs } from "./stubGlobal.ts";

const stubGlobal = globalStubs();
const store = new Map<string, string>();
const fake = {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear(), key: () => null, get length() { return store.size; },
} as unknown as Storage;
stubGlobal("window", new EventTarget());

const { LEGACY_FILTERS_KEY, PR_LANES_KEY, __resetPrFilterStore, getPrFilter, setPrFilter, subscribePrFilter } = await import("../src/lib/prBoardFilterStore.ts");
const V = await import("../src/lib/prViewsStore.ts");
const D = await import("../src/lib/prFilterDoor.ts");

const NOW = Date.parse("2026-10-27T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const read = (p: PrSummary, k: string) => readPrFieldAt(p, k, NOW);
function pr(number: number, over: Partial<PrSummary> = {}): PrSummary {
  return {
    number, mergeable: "MERGEABLE", title: "a pull request", author: "ana", state: "OPEN", isDraft: false,
    headRefName: "feature", baseRefName: "main", url: "", updatedAt: daysAgo(1), reviewDecision: null,
    additions: 0, deletions: 0, changedFiles: 0, labels: [], assignees: [], milestone: null,
    checks: { total: 0, success: 0, failure: 0, skipped: 0, pending: 0, allDone: false, verdict: null, failing: [] },
    checksLoaded: true, ...over,
  };
}
const card = (status: string) => ({ id: "c" + status, customId: "ORBIT-1042", title: "t", status, priority: null, people: [] }) as unknown as PrSummary["card"];
const rows: PrSummary[] = [
  pr(1, { author: "ana", card: card("Ready for QA") }),
  pr(2, { author: "bot", isDraft: true }),
  pr(3, { author: "cy", card: card("Done"), baseRefName: "release" }),
  pr(4, { author: "ana", isDraft: true, card: card("Ready for QA") }),
  pr(5, { author: "bot", labels: [{ name: "needs work", color: "" }] as PrSummary["labels"] }),
];

// "Main" is an AND set with a negation and an unset; "QA" is an OR set holding a `not`.
const presets: Preset[] = [
  { id: "fp1", name: "Main", join: "and", order: 0, rules: [
    { field: "author", op: "is", values: ["ana", "cy"] }, { field: "is", op: "not", values: ["draft"] }, { field: "label", op: "unset", values: [] },
  ] },
  { id: "fp2", name: "QA", join: "or", order: 1, rules: [
    { field: "cardstatus", op: "is", values: ["Ready for QA"] }, { field: "author", op: "not", values: ["ana"] },
  ] },
];

/** What the old board evaluated for a preset: its rules as the builder held them. */
const oldSet = (p: Preset) => ({ join: p.join, rules: p.rules.map((r, i) => ({ id: `r${i}`, field: r.field, op: r.op, values: r.values })) });

function backend(initial: { views: PrView[]; saved: boolean }) {
  const calls: PrView[][] = [];
  const state = { ...initial, refuse: null as string | null, down: false };
  V.__setViewsBackend({
    get: async () => (state.down ? Promise.reject(new Error("down")) : { ok: true, views: state.views, saved: state.saved }),
    put: async (_r, views) => {
      calls.push(views);
      if (state.refuse) return { ok: false, error: state.refuse };
      state.views = views; state.saved = true;
      return { ok: true, views };
    },
  });
  return { calls, state };
}

beforeEach(() => {
  stubGlobal("localStorage", fake); // files share one process: put this file's storage in place per test
  store.clear();
  V.__resetViewsStore();
  __resetPrFilterStore();
  V.__setViewsBackend(null);
});

describe("the one-time import of the old presets", () => {
  test("Main and QA keep their names, order and exactly the same pull requests", async () => {
    store.set(PRESETS_KEY, JSON.stringify({ "github.com/acme/orbit": presets }));
    const b = backend({ views: [], saved: false });
    await V.loadViews("acme/orbit");
    expect(b.calls).toHaveLength(1);
    const got = V.viewsState("acme/orbit").views;
    expect(got.map((v) => [v.id, v.name, v.order])).toEqual([["fp1", "Main", 0], ["fp2", "QA", 1]]);
    for (const [i, p] of presets.entries()) {
      const old = applyWith(rows, oldSet(p), readPrField).map((r) => r.number);
      expect(old.length, "the fixture must tell the sets apart").toBeGreaterThan(0);
      expect(evalLanes(rows, got[i]!.filter, read).kept.map((r) => r.number), p.name).toEqual(old);
    }
    expect(store.get(PRESETS_KEY)).toBe(JSON.stringify({ "github.com/acme/orbit": presets }));
  });

  test("it happens once: edits never write the old key, and a later empty server list is not refilled", async () => {
    store.set(PRESETS_KEY, JSON.stringify({ "github.com/acme/orbit": presets }));
    const old = store.get(PRESETS_KEY);
    const b = backend({ views: [], saved: false });
    await V.loadViews("acme/orbit");
    await V.commitViews("acme/orbit", []);
    expect(store.get(PRESETS_KEY)).toBe(old);
    V.__resetViewsStore();
    b.state.saved = false; // a server that lost its file: the mark, not the server, says it was imported
    b.calls.length = 0;
    await V.loadViews("acme/orbit");
    expect(b.calls).toHaveLength(0);
    expect(V.viewsState("acme/orbit").views).toEqual([]);
  });

  test("a server that already has a list keeps it; the old presets are ignored", async () => {
    store.set(PRESETS_KEY, JSON.stringify({ "github.com/acme/orbit": presets }));
    const mine: PrView = { id: "pv1", name: "Mine", filter: emptyLanes(), order: 0 };
    const b = backend({ views: [mine], saved: true });
    await V.loadViews("acme/orbit");
    expect(b.calls).toHaveLength(0);
    expect(V.viewsState("acme/orbit").views).toEqual([mine]);
  });

  test("another repository's presets are not imported, and a server that is down imports nothing", async () => {
    store.set(PRESETS_KEY, JSON.stringify({ "github.com/acme/other": presets }));
    const b = backend({ views: [], saved: false });
    await V.loadViews("acme/orbit");
    expect(b.calls).toHaveLength(0);
    store.set(PRESETS_KEY, JSON.stringify({ "github.com/acme/orbit": presets }));
    V.__resetViewsStore();
    store.delete(V.IMPORTED_KEY);
    b.state.down = true;
    await V.loadViews("acme/orbit");
    expect(b.calls).toHaveLength(0);
    expect(store.has(V.IMPORTED_KEY)).toBe(false);
  });

  test("the old active id still points at its view; none is stored for the new key until set", () => {
    store.set(ACTIVE_KEY, JSON.stringify({ "github.com/acme/orbit": "fp2" }));
    expect(V.activeViewId("acme/orbit")).toBe("fp2");
    V.setActiveViewId("acme/orbit", "fp1");
    expect(V.activeViewId("acme/orbit")).toBe("fp1");
    V.setActiveViewId("acme/orbit", null);
    expect(V.activeViewId("acme/orbit")).toBeNull();
  });
});

describe("the list's edits", () => {
  const f = emptyLanes();
  const two = (): PrView[] => [{ id: "a", name: "Main", filter: f, order: 0 }, { id: "b", name: "QA", filter: f, order: 1 }];

  test("add, rename and the names that are refused", () => {
    expect(V.addView(two(), " Mine  ", f, "c")).toMatchObject({ ok: true, view: { name: "Mine", order: 2 } });
    expect(V.addView(two(), "main", f, "c")).toEqual({ ok: false, reason: "taken" });
    expect(V.addView(two(), "  ", f, "c")).toEqual({ ok: false, reason: "empty" });
    expect(V.addView(two(), "x".repeat(VIEW_LIMITS.name + 1), f, "c")).toEqual({ ok: false, reason: "long" });
    const full = Array.from({ length: VIEW_LIMITS.views }, (_, i) => ({ id: "v" + i, name: "n" + i, filter: f, order: i }));
    expect(V.addView(full, "one more", f, "z")).toEqual({ ok: false, reason: "full" });
    expect(V.renameView(two(), "a", "Main")).toMatchObject({ ok: true });
    expect(V.renameView(two(), "a", "qa")).toEqual({ ok: false, reason: "taken" });
    expect(V.renameView(two(), "zz", "x")).toEqual({ ok: false, reason: "missing" });
  });

  test("move, delete and take the delete back into the same place", () => {
    expect(V.moveView(two(), "b", -1).map((v) => [v.id, v.order])).toEqual([["b", 0], ["a", 1]]);
    const l = two();
    expect(V.moveView(l, "a", -1)).toBe(l);
    const d = V.removeView(three(), "b")!;
    expect(d.list.map((v) => [v.id, v.order])).toEqual([["a", 0], ["c", 1]]);
    expect(V.restoreView(d.list, d.removed)!.map((v) => v.id)).toEqual(["a", "b", "c"]);
    expect(V.restoreView([...d.list, { id: "q", name: "QA", filter: f, order: 2 }], d.removed)!.find((v) => v.id === "b")!.name).toBe("QA 2");
  });
  const three = (): PrView[] => [...two(), { id: "c", name: "Mine", filter: f, order: 2 }];

  test("a refusal from the server puts the list back, and writes go in order", async () => {
    const b = backend({ views: two(), saved: true });
    await V.loadViews("acme/orbit");
    b.state.refuse = "nope";
    expect(await V.commitViews("acme/orbit", [])).toBe("nope");
    expect(V.viewsState("acme/orbit").views).toHaveLength(2);
    b.state.refuse = null;
    const first = V.commitViews("acme/orbit", three());
    const second = V.commitViews("acme/orbit", two());
    await Promise.all([first, second]);
    expect(b.calls.at(-1)).toHaveLength(2);
    expect(b.calls.at(-2)).toHaveLength(3);
  });
});

describe("the live filter", () => {
  test("the old flat value is imported once, keeps the same pull requests, and the old key is left alone", () => {
    const flat = { join: "and", rules: [{ id: "r1", field: "author", op: "not", values: ["bot"] }, { id: "r2", field: "is", op: "not", values: ["draft"] }] };
    store.set(LEGACY_FILTERS_KEY, JSON.stringify({ "github.com/acme/orbit": flat }));
    const f = getPrFilter("acme/orbit");
    expect(evalLanes(rows, f, read).kept.map((r) => r.number)).toEqual(applyWith(rows, flat as never, readPrField).map((r) => r.number));
    expect(JSON.parse(store.get(PR_LANES_KEY)!)["acme/orbit"]).toEqual(f);
    expect(store.get(LEGACY_FILTERS_KEY)).toBe(JSON.stringify({ "github.com/acme/orbit": flat }));
    // The mark is the entry: clearing the filter is not refilled from the old key.
    expect(setPrFilter("acme/orbit", emptyLanes())).toBeNull();
    __resetPrFilterStore();
    expect(lanesToText(getPrFilter("acme/orbit"))).toBe("");
  });

  test("set persists, notifies, keeps identity until the next set, and keeps repositories apart", () => {
    let seen = 0;
    const off = subscribePrFilter("acme/orbit", () => { seen++; });
    expect(getPrFilter("acme/orbit")).toBe(getPrFilter("acme/orbit"));
    const next = emptyLanes();
    next.hide.children.push({ id: "r1", field: "author", op: "is", values: ["bot"] });
    expect(setPrFilter("acme/orbit", next)).toBeNull();
    expect(seen).toBe(1);
    expect(getPrFilter("acme/orbit")).toEqual(next);
    expect(getPrFilter("acme/relay")).toEqual(emptyLanes());
    __resetPrFilterStore();
    expect(getPrFilter("acme/orbit")).toEqual(next); // read back from storage
    off();
    setPrFilter("acme/orbit", emptyLanes());
    expect(seen).toBe(1);
  });

  test("a filter that does not validate is refused and changes nothing", () => {
    const bad = emptyLanes();
    bad.show.children.push({ id: "r1", field: "text", op: "matches", values: ["("] });
    expect(typeof setPrFilter("acme/orbit", bad)).toBe("string");
    expect(getPrFilter("acme/orbit")).toEqual(emptyLanes());
    store.set(PR_LANES_KEY, JSON.stringify({ "acme/orbit": { show: 1 } }));
    __resetPrFilterStore();
    expect(getPrFilter("acme/orbit")).toEqual(emptyLanes());
  });
});

describe("the agent doors", () => {
  test("filter.set applies text; text that does not parse is the answer and nothing is applied", () => {
    expect(D.filterSet("acme/orbit", { text: "-BETA ci:failing" })).toEqual({ repo: "acme/orbit", text: "ci:failing -BETA" });
    expect(D.filterGet("acme/orbit").text).toBe("ci:failing -BETA");
    expect(() => D.filterSet("acme/orbit", { text: "/(/" })).toThrow(/./);
    expect(() => D.filterSet("acme/orbit", { text: "bogus:thing" })).toThrow(/./);
    expect(D.filterGet("acme/orbit").text).toBe("ci:failing -BETA");
    D.filterSet("acme/orbit", { clear: true });
    expect(D.filterGet("acme/orbit").text).toBe("");
  });

  test("views: save adds, the same name replaces, the live filter is the default, delete removes", async () => {
    backend({ views: [], saved: true });
    D.filterSet("acme/orbit", { text: "author:ana" });
    expect(await D.viewsSave("acme/orbit", "Mine")).toMatchObject({ name: "Mine", text: "author:ana", replaced: false });
    expect(await D.viewsSave("acme/orbit", " mine ", "-BETA")).toMatchObject({ name: "Mine", text: "-BETA", replaced: true });
    V.setActiveViewId("acme/orbit", V.viewsState("acme/orbit").views[0]!.id);
    expect((await D.viewsList("acme/orbit")).views).toEqual([{ name: "Mine", text: "-BETA", active: true }]);
    await expect(D.viewsSave("acme/orbit", "Bad", "/(/")).rejects.toThrow();
    expect(await D.viewsDelete("acme/orbit", "MINE")).toMatchObject({ deleted: "Mine" });
    await expect(D.viewsDelete("acme/orbit", "Mine")).rejects.toThrow(/no view/);
    expect((await D.viewsList("acme/orbit")).views).toEqual([]);
  });

  test("a server refusal surfaces as the error", async () => {
    const b = backend({ views: [], saved: true });
    b.state.refuse = "the server refused";
    await expect(D.viewsSave("acme/orbit", "Mine", "-BETA")).rejects.toThrow("the server refused");
    expect(V.viewsState("acme/orbit").views).toEqual([]);
  });
});

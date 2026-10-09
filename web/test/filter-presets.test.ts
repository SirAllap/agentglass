/*
 * Saved filter sets, the data half: reading what storage holds, comparing the
 * live filter with a saved one, the list's edits and its limits, and finding a
 * value the board no longer offers. Pure, so none of it needs a renderer.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_NAME, MAX_PRESETS, addPreset, canonical, checkName, deletePreset, dropGone, freeName, goneValues, isModified,
  movePreset, nthPreset, presetCounts, presetToFilterSet, readActiveMap, readPresetList, readPresetMap, renamePreset,
  restorePreset, rulesToPreset, summarizeRules, updatePreset, type Preset,
} from "../src/lib/filterPresets.ts";
import type { FieldSpec, FilterSet } from "../src/components/tasks/filters.ts";

const live = (rules: FilterSet["rules"], join: FilterSet["join"] = "and"): FilterSet => ({ join, rules });
const rule = (field: string, op: FilterSet["rules"][number]["op"], values: string[], id = "r1") => ({ id, field, op, values });

const preqa = live([rule("cardStatus", "is", ["Pre QA"])]);

function seed(...names: string[]): Preset[] {
  let list: Preset[] = [];
  names.forEach((n, i) => {
    const r = addPreset(list, n, preqa, `p${i}`);
    if (!r.ok) throw new Error(`seed ${n}: ${r.reason}`);
    list = r.list;
  });
  return list;
}

describe("reading storage", () => {
  const good = { id: "a", name: "Mine", join: "and", rules: [{ field: "cardAssignee", op: "is", values: ["Ada Lin"] }], order: 0 };

  test("a well-formed preset survives and order is renumbered from the array", () => {
    const [p] = readPresetList([{ ...good, order: 7 }]);
    expect(p).toEqual({ ...good, order: 0 } as Preset);
  });

  test("a malformed preset is dropped and its neighbours kept", () => {
    const list = readPresetList([
      good,
      { ...good, id: "b", join: "xor" },
      { ...good, id: "c", name: 4 },
      { ...good, id: "d", rules: "no" },
      null,
      { ...good, id: "e", name: "Other" },
    ]);
    expect(list.map((p) => p.id)).toEqual(["a", "e"]);
  });

  test("a bad rule inside a good preset is dropped, not the preset", () => {
    const [p] = readPresetList([{ ...good, rules: [good.rules[0], { field: "x", op: "contains", values: [] }, { field: "y", op: "is", values: [3] }] }]);
    expect(p.rules).toHaveLength(1);
  });

  test("a preset whose every rule is malformed is dropped: it would apply as no filter", () => {
    expect(readPresetList([{ ...good, rules: [{ field: "x", op: "contains", values: [] }] }, { ...good, id: "z", name: "Kept" }]).map((p) => p.id)).toEqual(["z"]);
    expect(readPresetList([{ ...good, rules: [] }])).toEqual([]);
  });

  test("a repeated id or a name that differs only in case keeps the first", () => {
    const list = readPresetList([good, { ...good }, { ...good, id: "b", name: "mine" }]);
    expect(list.map((p) => p.id)).toEqual(["a"]);
  });

  test("a name past the limit is not a preset", () => {
    expect(readPresetList([{ ...good, name: "x".repeat(MAX_NAME + 1) }])).toEqual([]);
  });

  test("past the cap the rest are dropped", () => {
    const many = Array.from({ length: MAX_PRESETS + 3 }, (_, i) => ({ ...good, id: `i${i}`, name: `N${i}` }));
    expect(readPresetList(many)).toHaveLength(MAX_PRESETS);
  });

  test("anything that is not a list is no presets; a map keeps good repositories", () => {
    expect(readPresetList({})).toEqual([]);
    expect(readPresetList("x")).toEqual([]);
    expect(readPresetMap(null)).toEqual({});
    expect(readPresetMap([])).toEqual({});
    const m = readPresetMap({ "acme/orbit": [good], "acme/bad": 3 });
    expect(m["acme/orbit"]).toHaveLength(1);
    expect(m["acme/bad"]).toEqual([]);
  });

  test("the active map keeps strings only", () => {
    expect(readActiveMap({ a: "p1", b: 3, c: "" })).toEqual({ a: "p1" });
    expect(readActiveMap([])).toEqual({});
  });
});

describe("modified is derived by a canonical compare", () => {
  const [p] = seed("Mixed");
  const withRules = (rules: FilterSet["rules"], join: FilterSet["join"] = "and") => live(rules, join);

  test("the very rules it was saved from are not modified", () => {
    expect(isModified(p, preqa)).toBe(false);
  });

  test("rule ids do not count", () => {
    expect(isModified(p, withRules([rule("cardStatus", "is", ["Pre QA"], "zzz")]))).toBe(false);
  });

  test("the order of values does not count, a duplicate neither", () => {
    expect(canonical("and", [{ field: "s", op: "is", values: ["b", "a", "a"] }])).toBe(canonical("and", [{ field: "s", op: "is", values: ["a", "b"] }]));
  });

  test("the order of rules does not count", () => {
    const a = [rule("s", "is", ["x"], "1"), rule("p", "not", ["y"], "2")];
    expect(canonical("and", a)).toBe(canonical("and", [a[1], a[0]]));
  });

  test("a half-written row is not a filter", () => {
    expect(isModified(p, withRules([rule("cardStatus", "is", ["Pre QA"]), rule("cardAssignee", "is", [], "r2")]))).toBe(false);
  });

  test("the join only counts with two rules or more", () => {
    expect(isModified(p, withRules(preqa.rules, "or"))).toBe(false);
    const two = [rule("s", "is", ["x"], "1"), rule("p", "is", ["y"], "2")];
    expect(canonical("and", two)).not.toBe(canonical("or", two));
  });

  test("a different value, a different op, an extra rule: modified; editing back clears it", () => {
    expect(isModified(p, withRules([rule("cardStatus", "is", ["Code review"])]))).toBe(true);
    expect(isModified(p, withRules([rule("cardStatus", "not", ["Pre QA"])]))).toBe(true);
    const more = withRules([...preqa.rules, rule("cardAssignee", "is", ["Ben Ortiz"], "r2")]);
    expect(isModified(p, more)).toBe(true);
    expect(isModified(p, withRules(preqa.rules))).toBe(false);
  });

  test("set / unset ignore stray values", () => {
    expect(canonical("and", [{ field: "s", op: "set", values: ["a"] }])).toBe(canonical("and", [{ field: "s", op: "set", values: [] }]));
  });
});

describe("apply gives the builder fresh ids and a copy", () => {
  test("ids are made by the caller and the values are not shared", () => {
    const [p] = seed("Mine");
    let n = 0;
    const f = presetToFilterSet(p, () => `n${++n}`);
    expect(f.rules[0].id).toBe("n1");
    f.rules[0].values.push("extra");
    expect(p.rules[0].values).toEqual(["Pre QA"]);
  });
});

describe("names", () => {
  test("trimmed, collapsed, 1 to 24 characters", () => {
    expect(checkName("  Pre   QA ", [])).toEqual({ ok: true, name: "Pre QA" });
    expect(checkName("   ", [])).toMatchObject({ ok: false, reason: "empty" });
    expect(checkName("x".repeat(MAX_NAME), []).ok).toBe(true);
    expect(checkName("x".repeat(MAX_NAME + 1), [])).toMatchObject({ ok: false, reason: "long" });
  });

  test("a duplicate is refused whatever its case, but a preset may keep its own name", () => {
    const list = seed("Mine", "Pre-QA");
    expect(checkName("mine", list)).toMatchObject({ ok: false, reason: "taken" });
    expect(checkName("MINE", list, list[0].id).ok).toBe(true);
  });

  test("Save as new proposes Name 2, and keeps the suffix inside the limit", () => {
    const list = seed("Mine");
    expect(freeName("Mine", list)).toBe("Mine 2");
    const long = "y".repeat(MAX_NAME);
    const next = freeName(long, seed(long));
    expect(next.length).toBeLessThanOrEqual(MAX_NAME);
    expect(next.endsWith(" 2")).toBe(true);
  });
});

describe("the list's edits and limits", () => {
  test("add appends, with the live filter's live rules only", () => {
    const r = addPreset([], "Mine", live([rule("a", "is", ["x"]), rule("b", "is", [], "r2")]), "p1");
    expect(r.ok && r.preset.rules).toEqual([{ field: "a", op: "is", values: ["x"] }]);
  });

  test("nothing to keep, a taken name and a full list are each refused with a reason", () => {
    expect(addPreset([], "Mine", live([]), "p")).toMatchObject({ ok: false, reason: "empty" });
    expect(addPreset(seed("Mine"), "mine", preqa, "p")).toMatchObject({ ok: false, reason: "taken" });
    const full = seed(...Array.from({ length: MAX_PRESETS }, (_, i) => `N${i}`));
    expect(addPreset(full, "One more", preqa, "p")).toMatchObject({ ok: false, reason: "full" });
  });

  test("update keeps name and place, and replaces rules and join", () => {
    const list = seed("A", "B");
    const r = updatePreset(list, "p0", live([rule("s", "is", ["z"])], "or"));
    expect(r.ok && r.list[0]).toMatchObject({ name: "A", join: "or", rules: [{ field: "s", op: "is", values: ["z"] }], order: 0 });
    expect(updatePreset(list, "nope", preqa)).toMatchObject({ ok: false, reason: "missing" });
    expect(updatePreset(list, "p0", live([]))).toMatchObject({ ok: false, reason: "empty" });
  });

  test("rename refuses a taken name and leaves the list alone", () => {
    const list = seed("A", "B");
    expect(renamePreset(list, "p1", "a")).toMatchObject({ ok: false, reason: "taken" });
    const ok = renamePreset(list, "p1", "C");
    expect(ok.ok && ok.list.map((p) => p.name)).toEqual(["A", "C"]);
  });

  test("move swaps one step, stops at the ends, and renumbers", () => {
    const list = seed("A", "B", "C");
    expect(movePreset(list, "p2", -1).map((p) => p.name)).toEqual(["A", "C", "B"]);
    expect(movePreset(list, "p0", -1)).toBe(list);
    expect(movePreset(list, "p2", 1)).toBe(list);
    expect(movePreset(list, "p0", 1).map((p) => p.order)).toEqual([0, 1, 2]);
  });

  test("delete then undo puts it back in the same place", () => {
    const list = seed("A", "B", "C");
    const d = deletePreset(list, "p1")!;
    expect(d.list.map((p) => p.name)).toEqual(["A", "C"]);
    const back = restorePreset(d.list, d.removed)!;
    expect(back.map((p) => p.name)).toEqual(["A", "B", "C"]);
    expect(back.map((p) => p.order)).toEqual([0, 1, 2]);
    expect(deletePreset(list, "nope")).toBeNull();
  });

  test("undo into a list where the name was taken meanwhile comes back as Name 2; a full list refuses", () => {
    const list = seed("A", "B");
    const d = deletePreset(list, "p1")!;
    const taken = addPreset(d.list, "B", preqa, "q")!;
    expect(taken.ok && restorePreset(taken.list, d.removed)!.map((p) => p.name)).toEqual(["A", "B 2", "B"]);
    const full = seed(...Array.from({ length: MAX_PRESETS }, (_, i) => `N${i}`));
    expect(restorePreset(full, { preset: { ...full[0], id: "gone", name: "Gone" }, index: 0 })).toBeNull();
  });

  test("Alt+n is the nth preset, from one", () => {
    const list = seed("A", "B");
    expect(nthPreset(list, 2)?.name).toBe("B");
    expect(nthPreset(list, 3)).toBeUndefined();
  });

  test("rulesToPreset drops half-written rows and the values of set/unset", () => {
    expect(rulesToPreset(live([rule("a", "set", ["stray"]), rule("b", "is", [], "r2")]))).toEqual([{ field: "a", op: "set", values: [] }]);
  });
});

describe("a value the board no longer offers", () => {
  const fields: FieldSpec[] = [
    { key: "cardStatus", label: "Card status", options: [{ value: "Pre QA", label: "Pre QA" }, { value: "Code review", label: "Code review" }] },
    { key: "cardAssignee", label: "Card assignee", options: [{ value: "Ada Lin", label: "Ada Lin" }] },
  ];
  const rules = [
    { field: "cardStatus", op: "is" as const, values: ["Ready to land", "Pre QA"] },
    { field: "cardAssignee", op: "not" as const, values: ["Ben Ortiz"] },
    { field: "cardStatus", op: "unset" as const, values: [] },
  ];

  test("each missing value is named with its field's label and rule", () => {
    expect(goneValues(rules, fields)).toEqual([
      { ruleIndex: 0, field: "cardStatus", fieldLabel: "Card status", value: "Ready to land" },
      { ruleIndex: 1, field: "cardAssignee", fieldLabel: "Card assignee", value: "Ben Ortiz" },
    ]);
  });

  test("a board that offers no fields yet flags nothing", () => {
    expect(goneValues(rules, [])).toEqual([]);
  });

  test("removing the missing value keeps the rest, and drops a rule left with none", () => {
    expect(dropGone(rules, fields)).toEqual([
      { field: "cardStatus", op: "is", values: ["Pre QA"] },
      { field: "cardStatus", op: "unset", values: [] },
    ]);
  });

  test("nothing missing, nothing changes", () => {
    const clean = [{ field: "cardStatus", op: "is" as const, values: ["Pre QA"] }];
    expect(dropGone(clean, fields)).toEqual(clean);
  });
});

describe("counts follow the board's own filter", () => {
  type Row = { n: number; st: string };
  const mine: Row[] = [{ n: 1, st: "Pre QA" }, { n: 2, st: "Code review" }];
  const asked: Row[] = [{ n: 2, st: "Code review" }, { n: 3, st: "Pre QA" }];
  const read = (r: Row) => [r.st];
  const rowsOf = (pool: readonly Row[], f: FilterSet) => pool.filter((r) => f.rules.every((q) => q.values.includes(read(r)[0])));

  test("a pull request that is in both lanes counts once", () => {
    const list = seed("Pre QA");
    const [qa] = list;
    const review: Preset = { ...qa, id: "rv", name: "Review", rules: [{ field: "cardStatus", op: "is", values: ["Code review"] }] };
    const out = presetCounts([qa, review], [mine, asked], rowsOf, (r) => r.n);
    expect(out).toEqual({ [qa.id]: 2, rv: 1 });
  });
});

describe("the line that says what a save keeps", () => {
  const fields: FieldSpec[] = [{ key: "cardStatus", label: "Card status", options: [] }];
  test("labels from the board, ops in words, values joined", () => {
    expect(summarizeRules("and", [{ field: "cardStatus", op: "not", values: ["Blocked", "Stale"] }, { field: "mystery", op: "unset", values: [] }], fields))
      .toBe("Card status is not Blocked, Stale \u00b7 mystery is not set");
  });
  test("an or join is said as or", () => {
    expect(summarizeRules("or", [{ field: "a", op: "set", values: [] }, { field: "b", op: "set", values: [] }], [])).toBe("a is set or b is set");
  });
});

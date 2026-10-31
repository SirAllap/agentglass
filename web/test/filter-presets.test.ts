/*
 * The old local presets, read-only: what storage held, and the name rules a
 * view shares with them. Pure, so none of it needs a renderer.
 */
import { describe, expect, test } from "bun:test";
import { MAX_NAME, MAX_PRESETS, checkName, freeName, readActiveMap, readPresetList, readPresetMap, type Preset } from "../src/lib/filterPresets.ts";

const rule = (field: string, op: Preset["rules"][number]["op"], values: string[]) => ({ field, op, values });
const preqa = [rule("cardStatus", "is", ["Pre QA"])];

function seed(...names: string[]): Preset[] {
  return names.map((name, order) => ({ id: `p${order}`, name, join: "and" as const, rules: preqa, order }));
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


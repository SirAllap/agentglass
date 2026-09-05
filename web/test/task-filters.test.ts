/*
 * A filter you BUILD, over the fields the board actually has.
 *
 * The chips along the top are the tags the loaded cards carry, plus `mine`,
 * plus a status picker. That answers "show me the cards tagged X" and cannot
 * answer "show me one squad's cards" — a squad is a custom field, so it had a
 * column and no chip: the board could say which squad every card belonged to
 * and could not show you one squad's.
 */
import { describe, expect, test } from "bun:test";
import { apply, fieldsOf, liveCount, takesValues, valuesOf, EMPTY, type FilterSet } from "../src/components/tasks/filters.ts";
import type { ProviderTask } from "../../shared/providers.ts";

const card = (over: Partial<ProviderTask>): ProviderTask => ({
  id: "1", title: "t", url: "", status: "open", statusKind: "open",
  priority: null, due: null, updated: 0, tags: [], list: null, assignees: [],
  ...over,
} as ProviderTask);

const squad = (name: string, color?: string) => ({ name: "Squad", value: name, ...(color ? { color } : {}) });

describe("fields are discovered, never listed", () => {
  test("a board with no custom fields offers none", () => {
    const f = fieldsOf([card({ status: "open" })]);
    expect(f.map((x) => x.key)).toContain("status");
    expect(f.some((x) => x.key.startsWith("cf:"))).toBe(false);
  });

  test("a custom field becomes a field, named as the workspace names it", () => {
    const f = fieldsOf([card({ custom: [squad("Crimson", "#a")] } as Partial<ProviderTask>)]);
    const s = f.find((x) => x.key === "cf:Squad");
    expect(s?.label).toBe("Squad");
    expect(s?.options[0]).toEqual({ value: "Crimson", label: "Crimson", color: "#a" });
  });

  test("a maintainer's aside is not part of the name", () => {
    /* "(DO NOT EDIT!!!)" is a note to whoever maintains the field. A menu that
       repeats it reads as shouting. */
    const f = fieldsOf([card({ custom: [{ name: "Squad (DO NOT TOUCH)", value: "Teal" }] } as Partial<ProviderTask>)]);
    expect(f.find((x) => x.key.startsWith("cf:"))?.label).toBe("Squad");
  });

  test("values are ordered by how many OPEN cards carry them", () => {
    /* A value on three cards is a more useful thing to offer than one on none,
       and alphabetical is unreadable on a board with forty statuses. */
    const f = fieldsOf([
      card({ tags: ["rare"] }),
      card({ tags: ["common"] }),
      card({ tags: ["common"] }),
    ]);
    expect(f.find((x) => x.key === "tags")?.options.map((o) => o.value)).toEqual(["common", "rare"]);
  });
});

describe("a rule keeps or drops a card", () => {
  const crimson = card({ custom: [squad("Crimson")] } as Partial<ProviderTask>);
  const olive = card({ id: "2", custom: [squad("Olive")] } as Partial<ProviderTask>);
  const rule = (over: object): FilterSet => ({ join: "and", rules: [{ id: "r", field: "cf:Squad", op: "is", values: [], ...over }] });

  test("is keeps only what matches", () => {
    expect(apply([crimson, olive], rule({ values: ["Crimson"] })).map((t) => t.id)).toEqual(["1"]);
  });

  test("is not keeps everything else", () => {
    expect(apply([crimson, olive], rule({ op: "not", values: ["Crimson"] })).map((t) => t.id)).toEqual(["2"]);
  });

  test("several values are an OR within the row", () => {
    expect(apply([crimson, olive], rule({ values: ["Crimson", "Olive"] })).length).toBe(2);
  });

  test("a half-written row filters nothing", () => {
    /* Otherwise the board empties the moment you press Add filter, before you
       have said what you want — which reads as the filter being broken. */
    expect(apply([crimson, olive], rule({ values: [] })).length).toBe(2);
    expect(apply([crimson, olive], { join: "and", rules: [{ id: "r", field: "", op: "is", values: ["x"] }] }).length).toBe(2);
    expect(liveCount(rule({ values: [] }))).toBe(0);
  });
});

describe("is set / is not set — the ones the other two cannot answer", () => {
  /* Which cards have nobody assigned, which have no squad, which never got a
     due date. On a board being triaged that is most of the work, and with only
     is/is-not the closest you could get was picking every value and inverting
     — which stops being true the moment somebody adds a value. */
  const has = card({ custom: [squad("Crimson")] } as Partial<ProviderTask>);
  const without = card({ id: "2" });
  const rule = (op: "set" | "unset"): FilterSet => ({ join: "and", rules: [{ id: "r", field: "cf:Squad", op, values: [] }] });

  test("is set keeps the ones that have any value", () => {
    expect(apply([has, without], rule("set")).map((t) => t.id)).toEqual(["1"]);
  });

  test("is not set keeps the ones that have none", () => {
    expect(apply([has, without], rule("unset")).map((t) => t.id)).toEqual(["2"]);
  });

  test("they count as live with no values — that is the point of them", () => {
    /* `liveCount` gates the badge on the button and `apply` gates whether the
       rule runs at all. If either demanded values, these two operators would
       be inert and the button would say the filter is off while it is on. */
    expect(liveCount(rule("set"))).toBe(1);
    expect(liveCount(rule("unset"))).toBe(1);
  });

  test("takesValues says which operators need them", () => {
    expect([takesValues("is"), takesValues("not"), takesValues("set"), takesValues("unset")])
      .toEqual([true, true, false, false]);
  });
});

describe("the join is one switch for the whole set", () => {
  const a = card({ tags: ["x"] });
  const b = card({ id: "2", status: "done", statusKind: "done" });
  const two = (join: "and" | "or"): FilterSet => ({
    join,
    rules: [
      { id: "1", field: "tags", op: "is", values: ["x"] },
      { id: "2", field: "status", op: "is", values: ["done"] },
    ],
  });

  test("AND needs every rule", () => { expect(apply([a, b], two("and")).length).toBe(0); });
  test("OR needs one", () => { expect(apply([a, b], two("or")).length).toBe(2); });
  test("no rules is no filter", () => { expect(apply([a, b], EMPTY).length).toBe(2); });
});

describe("multi-valued fields mean 'has'", () => {
  test("a card with three tags matches a rule naming one of them", () => {
    expect(valuesOf(card({ tags: ["a", "b", "c"] }), "tags")).toEqual(["a", "b", "c"]);
    expect(apply([card({ tags: ["a", "b"] })], { join: "and", rules: [{ id: "r", field: "tags", op: "is", values: ["b"] }] }).length).toBe(1);
  });
});

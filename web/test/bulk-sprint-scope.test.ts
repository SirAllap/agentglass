import { describe, expect, test } from "bun:test";
import { resolveBulkSprints, sharedSprints, withTimeout, type ScopeReads } from "../src/components/jira/list/bulkSprintScope.ts";

const sp = (id: string) => ({ id, name: `Orbit ${id}`, dates: "", tag: "" as const });
const ctx = (active: string | null, futures: string[]) => ({ ok: true, ...(active ? { sprint: { id: active, name: `S${active}`, state: "active", start: 0, end: 0 } } : {}), futures: futures.map((id) => ({ id, name: `S${id}`, start: 0, end: 0 })) }) as never;
const reads = (boards: Record<string, Array<[string, unknown]>>): ScopeReads => {
  const by = new Map(Object.values(boards).flat() as Array<[string, never]>);
  return { projectBoards: async (k) => ({ ok: !!boards[k], boards: (boards[k] ?? []).map(([id]) => ({ id, name: `B${id}` })) }), boardContext: async (v) => by.get(v.replace("board:", "")) ?? ({ ok: false } as never) };
};
const card = (id: string, sprintId?: string) => ({ id, customId: id, ...(sprintId ? { sprintId } : {}) }) as never;

describe("bulk sprint scope", () => {
  test("shared: intersection, note only across several board sets", () => {
    const r = sharedSprints([{ boardIds: ["1"], sprints: [sp("a"), sp("b")] }, { boardIds: ["2"], sprints: [sp("b"), sp("c")] }]);
    expect(r.choices.map((x) => x.id)).toEqual(["b"]);
    expect(r.note).toBe("Cards from 2 boards: only shared sprints shown");
    expect(sharedSprints([{ boardIds: ["1"], sprints: [sp("a")] }, { boardIds: ["1"], sprints: [sp("a")] }]).note).toBeNull();
  });
  test("the view's board wins, no reads", async () => {
    const r = await resolveBulkSprints([card("ORBIT-1")], ctx("1", ["2"]), { projectBoards: () => { throw new Error("no"); }, boardContext: () => { throw new Error("no"); } });
    expect(r.ok && r.choices.map((x) => x.id)).toEqual(["1", "2"]);
  });
  test("no view: union over the project's scrum boards, kanban skipped", async () => {
    const r = await resolveBulkSprints([card("ORBIT-1")], null, reads({ ORBIT: [["10", ctx("1", [])], ["11", ctx(null, ["2"])], ["12", ctx(null, [])]] }));
    expect(r.ok && r.choices.map((x) => x.id)).toEqual(["1", "2"]);
  });
  test("a card in a sprint uses the board that holds it", async () => {
    const r = await resolveBulkSprints([card("ORBIT-1", "2")], null, reads({ ORBIT: [["10", ctx("1", [])], ["11", ctx(null, ["2", "3"])]] }));
    expect(r.ok && r.choices.map((x) => x.id)).toEqual(["2", "3"]);
  });
  test("two projects: only shared sprints, with the note", async () => {
    const r = await resolveBulkSprints([card("ORBIT-1"), card("COMET-2")], null, reads({ ORBIT: [["10", ctx("1", ["2"])]], COMET: [["20", ctx("9", ["2"])]] }));
    expect(r.ok && r.choices.map((x) => x.id)).toEqual(["2"]);
    expect(r.ok && r.note).toBe("Cards from 2 boards: only shared sprints shown");
  });
  test("a failed read is an error, a hang times out", async () => {
    const bad = await resolveBulkSprints([card("ORBIT-1")], null, reads({}));
    expect(bad.ok).toBe(false);
    const slow = await resolveBulkSprints([card("ORBIT-1")], null, { projectBoards: () => new Promise(() => {}), boardContext: async () => ctx(null, []) }, 20);
    expect(!slow.ok && slow.error).toBe("Jira took too long to answer");
    await expect(withTimeout(new Promise(() => {}), 5)).rejects.toThrow("too long");
  });
});

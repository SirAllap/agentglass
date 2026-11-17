/* The order a person sees never changes on its own: the stored order paints first, the workflow answer re-sorts only if the workflow changed. */
import { describe, expect, test } from "bun:test";
import { settleOrder, readOrder, writeOrder } from "../src/lib/workflowOrder.ts";
import { groupByStatus } from "../src/lib/boardGroups.ts";

const st = (status: string, i: number) => ({ status, type: "open", orderindex: i }) as never;
const card = (status: string) => ({ id: status, status, statusKind: "open", assignees: [], tags: [] }) as never;
const stored = ["BACKLOG", "PRE QA", "IN QA", "READY FOR QA", "DONE"];
const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };

describe("stable column order", () => {
  test("the same statuses in another order keep the stored order: no reorder", () => {
    const answer = ["BACKLOG", "READY FOR QA", "PRE QA", "IN QA", "DONE"].map(st);
    expect(settleOrder(stored, answer).map((s) => s.status)).toEqual(stored);
  });
  test("paint with the stored order, deliver the same statuses: lane order identical", () => {
    const first = groupByStatus([card("READY FOR QA")], settleOrder(stored, stored.map(st))).map((g) => g.status);
    const answer = ["BACKLOG", "READY FOR QA", "PRE QA", "IN QA", "DONE"].map(st);
    const after = groupByStatus([card("READY FOR QA")], settleOrder(stored, answer)).map((g) => g.status);
    expect(after).toEqual(first);
  });
  test("a changed workflow (status added or removed) takes the answer's order", () => {
    const answer = ["BACKLOG", "SHAPING", "PRE QA", "DONE"].map(st);
    expect(settleOrder(stored, answer).map((s) => s.status)).toEqual(["BACKLOG", "SHAPING", "PRE QA", "DONE"]);
  });
  test("no stored order: the answer as it is", () => {
    expect(settleOrder(null, stored.map(st)).map((s) => s.status)).toEqual(stored);
  });
  test("stored per view, read back; a broken store reads as none", () => {
    const s = mem();
    writeOrder("assigned", stored, s);
    expect(readOrder("assigned", s)).toEqual(stored);
    expect(readOrder("other", s)).toBeNull();
    expect(readOrder("x", { getItem: () => { throw new Error("no"); }, setItem: () => {} })).toBeNull();
  });
});

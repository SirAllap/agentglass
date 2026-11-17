/* The first paint is the final column set: a stored order never paints on its own, and never keeps a status the workflow dropped. */
import { beforeEach, describe, expect, test } from "bun:test";
import { columnStatuses } from "../src/lib/useJiraList.ts";
import { globalStubs } from "./stubGlobal.ts";
import { writeOrder } from "../src/lib/workflowOrder.ts";

const mem = new Map<string, string>();
globalStubs()("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) });
const st = (status: string, orderindex: number) => ({ status, type: "custom", orderindex });
// Invented: an earlier build stored WORK IN PROGRESS (Epic-only) in the "Assigned to me" order.
const stored = ["BACKLOG", "SHAPING", "WORK IN PROGRESS", "IN DEVELOPMENT", "CODE REVIEW"];
beforeEach(() => { mem.clear(); writeOrder("assigned", stored); });

describe("columnStatuses", () => {
  test("no answer yet: no columns, not the stored guess", () => {
    expect(columnStatuses("assigned", undefined)).toEqual([]);
    expect(columnStatuses("assigned", [])).toEqual([]);
  });
  test("no answer but cards on screen: the statuses the cards wear, stored order first, then first-seen", () => {
    const card = (status: string) => ({ status, statusKind: "other" as const });
    // Invented: the workflow read failed; the cards still carry their statuses.
    const cards = [card("Code review"), card("Pre QA"), card("Backlog"), card("Code review"), card("Blocked")];
    for (const answer of [undefined, []]) {
      const names = columnStatuses("assigned", answer, cards).map((x) => x.status);
      expect(names).toEqual(["Backlog", "Code review", "Pre QA", "Blocked"]);
      expect(names).not.toContain("WORK IN PROGRESS");
    }
  });
  test("no answer, no stored order: first-seen", () => {
    mem.clear();
    const names = columnStatuses("assigned", [], [{ status: "QA", statusKind: "open" }, { status: "Done", statusKind: "done" }]).map((x) => x.status);
    expect(names).toEqual(["QA", "Done"]);
  });
  test("a stored status the workflow dropped never shows", () => {
    const answer = [st("BACKLOG", 0), st("SHAPING", 1), st("IN DEVELOPMENT", 2), st("CODE REVIEW", 3), st("PRE QA", 4)];
    const names = columnStatuses("assigned", answer).map((x) => x.status);
    expect(names).not.toContain("WORK IN PROGRESS");
    expect(names).toEqual(["BACKLOG", "SHAPING", "IN DEVELOPMENT", "CODE REVIEW", "PRE QA"]);
  });
});

describe("first paint equals the fresh answer", () => {
  test("a stale 14-status answer, then the fresh 15: board order and set from the first answer on", () => {
    const fresh = ["BACKLOG", "IN DEVELOPMENT", "CODE REVIEW", "BLOCKED", "DONE"].map((n, i) => st(n, i));
    writeOrder("assigned", ["DONE", "CODE REVIEW", "IN DEVELOPMENT", "BACKLOG"]);
    expect(columnStatuses("assigned", fresh).map((x) => x.status)).toEqual(fresh.map((x) => x.status));
  });
  test("same set, another stored order: the board's order wins", () => {
    const fresh = ["BACKLOG", "IN DEVELOPMENT", "DONE"].map((n, i) => st(n, i));
    writeOrder("assigned", ["DONE", "BACKLOG", "IN DEVELOPMENT"]);
    expect(columnStatuses("assigned", fresh).map((x) => x.status)).toEqual(["BACKLOG", "IN DEVELOPMENT", "DONE"]);
  });
});

/* Columns = the union of the workflow statuses of the spaces in scope, in workflow order, the same on every load. */
import { describe, expect, test } from "bun:test";
import { groupByStatus } from "../src/lib/boardGroups.ts";

const st = (status: string, orderindex: number, spaces: string[], type = "custom") => ({ status, type, orderindex, spaces });
// Three invented spaces; one status only ORBIT-less space "VR" has.
const listed = [
  st("TO DO", 0, ["INF", "AIR", "VR"], "open"),
  st("IN DEVELOPMENT", 1, ["INF", "AIR", "VR"]),
  st("WORK IN PROGRESS", 2, ["VR"]),
  st("CODE REVIEW", 3, ["INF", "AIR", "VR"]),
  st("DONE", 4, ["INF", "AIR", "VR"], "done"),
];
const card = (status: string, space = "INF") => ({ id: `${space}-${status}`, status, listId: space, statusKind: "open", assignees: [], tags: [] }) as never;
const names = (rows: unknown[], scope?: string[]) => groupByStatus(rows as never, listed as never, undefined, scope).map((g) => g.status);

describe("columns of the spaces in scope", () => {
  test("a status only an out-of-scope space has is not a column, a card or not", () => {
    expect(names([card("TO DO", "INF")], ["INF", "AIR"])).toEqual(["TO DO", "IN DEVELOPMENT", "CODE REVIEW", "DONE"]);
  });
  test("no scope is every space: the union, in workflow order", () => {
    expect(names([])).toEqual(["TO DO", "IN DEVELOPMENT", "WORK IN PROGRESS", "CODE REVIEW", "DONE"]);
  });
  test("an unlisted status is a column only while a shown card wears it, after the workflow columns", () => {
    expect(names([card("TRIAGE")], ["INF"])).toEqual(["TO DO", "IN DEVELOPMENT", "CODE REVIEW", "DONE", "TRIAGE"]);
    expect(names([card("TO DO")], ["INF"])).not.toContain("TRIAGE");
  });
  test("the same order on two loads with different cards", () => {
    const a = names([card("DONE"), card("TRIAGE"), card("TO DO", "AIR")], ["INF", "AIR"]);
    const b = names([card("CODE REVIEW"), card("TO DO")], ["INF", "AIR"]);
    expect(a.filter((n) => n !== "TRIAGE")).toEqual(b);
  });
});

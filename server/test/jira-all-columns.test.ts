/* Every status of the board's workflow is a column, with a card or not; order is the workflow's, not the load's. */
import { describe, expect, test } from "bun:test";
import { missingColumns } from "../src/jiraboards.ts";
import { groupByStatus } from "../../web/src/lib/boardGroups.ts";

const st = (id: string, name: string, category = "indeterminate") => ({ id, name, category, color: "", projects: ["ORB"] });
const flow = [st("1", "TO DO", "new"), st("2", "IN PROGRESS"), st("3", "QA COMPLETE"), st("4", "DONE", "done")];

describe("missingColumns", () => {
  test("a workflow status no loaded card wears is returned", () => {
    const out = missingColumns([st("1", "TO DO", "new")], ["1", "2", "3", "4"], flow, "ORB");
    expect(out.map((x) => x.name)).toEqual(["IN PROGRESS", "QA COMPLETE", "DONE"]);
  });
  test("statuses the board does not name, or cards already wear, are not added", () => {
    expect(missingColumns(flow, ["1", "2"], flow, "ORB")).toEqual([]);
    expect(missingColumns([], ["2"], flow, "ORB").map((x) => x.id)).toEqual(["2"]);
  });
});

describe("column list", () => {
  const statuses = flow.map((x, i) => ({ status: x.name, type: x.category === "done" ? "done" : "open", orderindex: i }));
  const card = (status: string) => ({ status, statusKind: "open", assignees: [], tags: [] }) as never;
  test("a status with no card is still a column, in workflow order, whatever the cards", () => {
    const a = groupByStatus([card("DONE"), card("TO DO")], statuses).map((g) => g.status);
    const b = groupByStatus([card("TO DO"), card("DONE")], statuses).map((g) => g.status);
    expect(a).toEqual(["TO DO", "IN PROGRESS", "QA COMPLETE", "DONE"]);
    expect(b).toEqual(a);
  });
});

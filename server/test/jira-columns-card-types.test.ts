/* Columns = statuses of the project's issue types of level 0 or -1, never of the cards loaded. */
import { describe, expect, test } from "bun:test";
import { statusesOfIssueTypes } from "../src/jiraboards.ts";

const ws = (id: string, name: string, types: string[], levels: number[]) => ({ id, name, kind: "open" as const, category: "indeterminate", color: "", types, levels });
// Invented space ORBIT: Task and Bug share a workflow, Bug alone has NEEDS TRIAGE, Epic alone has WORK IN PROGRESS.
const orbit = [ws("1", "Backlog", ["Task", "Bug", "Epic"], [0, 0, 1]), ws("2", "NEEDS TRIAGE", ["Bug"], [0]), ws("3", "WORK IN PROGRESS", ["Epic"], [1]), ws("4", "Subtask open", ["Sub-task"], [-1]), ws("5", "Done", ["Task", "Bug", "Epic"], [0, 0, 1])];

describe("statusesOfIssueTypes", () => {
  test("a Bug-only status is a column with no Bug loaded", () => {
    expect(statusesOfIssueTypes(orbit).map((x) => x.name)).toContain("NEEDS TRIAGE");
  });
  test("an Epic-only status is not a column; sub-task statuses are", () => {
    const names = statusesOfIssueTypes(orbit).map((x) => x.name);
    expect(names).not.toContain("WORK IN PROGRESS");
    expect(names).toEqual(["Backlog", "NEEDS TRIAGE", "Subtask open", "Done"]);
  });
  test("the set takes no cards: the same list whatever is loaded", () => {
    expect(statusesOfIssueTypes(orbit).map((x) => x.id)).toEqual(statusesOfIssueTypes([...orbit]).map((x) => x.id));
  });
  test("a view showing epics keeps epic-level statuses", () => {
    expect(statusesOfIssueTypes(orbit, true).map((x) => x.name)).toContain("WORK IN PROGRESS");
  });
  test("no level info on a status: nothing is dropped", () => {
    expect(statusesOfIssueTypes([{ ...orbit[2]!, levels: undefined }])).toHaveLength(1);
  });
});

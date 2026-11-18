/* "Assigned to me" spans spaces: an Epic-only status (WORK IN PROGRESS) must never become a column, even when an Epic card wears it. */
import { describe, expect, test } from "bun:test";
import { statusesOfIssueTypes, withoutEpicOnly } from "../src/jiraboards.ts";

const ws = (id: string, name: string, types: string[], levels: number[]) => ({ id, name, kind: "open" as const, category: "indeterminate", color: "", types, levels });
const std = ["Story", "Task", "Bug", "Spike", "Sub-task"];
const lv = [0, 0, 0, 0, -1];
// Invented space ORBIT, shaped like the real site: Epic has Shaping/Done/Work in progress/Backlog/Warranty.
const orbit = [
  ws("1", "Backlog", [...std, "Epic"], [...lv, 1]), ws("2", "Shaping", [...std, "Epic"], [...lv, 1]),
  ws("3", "In development", std, lv), ws("4", "Work in progress", ["Epic"], [1]), ws("5", "Warranty", ["Epic"], [1]),
];
const seen = (id: string, name: string) => ({ id, name, category: "indeterminate", color: "", projects: ["ORBIT"] });

describe("me-view columns", () => {
  test("a status only Epics have, worn by a loaded Epic card, is not a column", () => {
    const epicOnly = new Set(orbit.filter((x) => !statusesOfIssueTypes(orbit).includes(x)).map((x) => `ORBIT|${x.id}`));
    const out = withoutEpicOnly([seen("2", "Shaping"), seen("4", "Work in progress"), seen("5", "Warranty")], epicOnly);
    expect(out.map((x) => x.name)).toEqual(["Shaping"]);
  });
  test("no workflow read: nothing is dropped", () => {
    expect(withoutEpicOnly([seen("4", "Work in progress")], new Set())).toHaveLength(1);
  });
});

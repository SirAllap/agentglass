/* A sub-task sits in the lane of its story's epic, with or without the story on the board. Invented cards. */
import { describe, expect, test } from "bun:test";
import { laneOf } from "../src/components/jira/list/boardModel.ts";
import type { ProviderTask } from "../../shared/providers.ts";

const card = (key: string, issueType: string, parent?: ProviderTask["parent"], epic?: ProviderTask["epic"]): ProviderTask =>
  ({ id: key, customId: key, title: key, status: "To Do", assignees: [], tags: [], issueType, ...(parent ? { parent } : {}), ...(epic ? { epic } : {}) }) as unknown as ProviderTask;
const EPIC = { key: "ORBIT-122", title: "Orbit RBAC", type: "Epic" };
const STORY = { key: "ORBIT-123", title: "Reporting & exports", type: "Story" };

describe("epic lanes", () => {
  test("sub-task follows its story into the epic's lane when the story is on the board", () => {
    const rows = laneOf([card("ORBIT-123", "Story", EPIC), card("ORBIT-131", "Sub-task", STORY)], "epic");
    expect(rows.map((r) => r.label)).toEqual(["Orbit RBAC"]);
    expect(rows[0]!.cards).toHaveLength(2);
  });
  test("sub-task lands in the epic's lane with the story filtered out, from the server's epic", () => {
    const rows = laneOf([card("ORBIT-131", "Sub-task", STORY, { key: "ORBIT-122", title: "Orbit RBAC" })], "epic");
    expect(rows.map((r) => r.label)).toEqual(["Orbit RBAC"]);
  });
  test("sub-task with no known epic is in No epic, never a lane named after the story", () => {
    expect(laneOf([card("ORBIT-131", "Sub-task", STORY)], "epic").map((r) => r.label)).toEqual(["No epic"]);
  });
});

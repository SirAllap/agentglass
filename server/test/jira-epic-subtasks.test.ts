/*
 * An epic's page holds the sub-tasks of its cards: they belong to the parent's epic, are marked with it, are never doubled,
 * and only cards that say they have sub-tasks are asked for. Fixtures are invented.
 */
import { describe, expect, test } from "bun:test";
import { parentsWithSubtasks, withEpicSubtasks } from "../src/jiraboards.ts";
import type { ProviderTask } from "../../shared/providers.ts";

const card = (key: string, o: Partial<ProviderTask> = {}): ProviderTask => ({ id: key, customId: key, title: key, status: "To Do", ...o }) as unknown as ProviderTask;
const EPIC = { key: "ORBIT-122", title: "Orbit RBAC" };

describe("an epic page with sub-tasks", () => {
  test("asks only for parents that have sub-tasks", () => {
    const cards = [card("ORBIT-123", { subtasks: 5 } as never), card("ORBIT-124"), card("ORBIT-125", { subtasks: 0 } as never)];
    expect(parentsWithSubtasks(cards)).toEqual(["ORBIT-123"]);
  });
  test("adds ORBIT-131..135 under the epic, once, in their own status", () => {
    const cards = [card("ORBIT-123", { subtasks: 5 } as never), card("ORBIT-124")];
    const subs = [131, 132, 133, 134, 135].map((n) => card(`ORBIT-${n}`, { issueType: "Sub-task", status: n > 133 ? "Done" : "In Progress", parent: { key: "ORBIT-123", title: "Story", type: "Story" } } as never));
    const out = withEpicSubtasks(cards, [...subs, subs[0]!], EPIC);
    expect(out).toHaveLength(7);
    expect(out.filter((t) => t.epic?.key === "ORBIT-122").map((t) => t.customId)).toEqual(["ORBIT-131", "ORBIT-132", "ORBIT-133", "ORBIT-134", "ORBIT-135"]);
    expect(out.find((t) => t.customId === "ORBIT-134")?.status).toBe("Done");
  });
});

import { describe, expect, test } from "bun:test";
import { noSprintChip } from "../src/components/jira/list/toolbarModel.ts";
import { sprintTab } from "../src/components/jira/list/tabsModel.ts";

const NOV18 = Date.UTC(2026, 10, 18, 9);
describe("the sprint chip", () => {
  test("an active sprint keeps the mockup's label", () => {
    const now = Date.UTC(2026, 10, 2, 9);
    expect(sprintTab({ id: "1", name: "Sprint 14", state: "active", start: now - 8 * 864e5, end: now + 6 * 864e5 }, now)!.label).toBe("S14 · 6 days left");
  });
  test("no active sprint but a planned one says when it starts", () => {
    const c = noSprintChip({ name: "Sprint 15", start: NOV18 }, "scrum");
    expect(c.label).toBe("No sprint · S15 starts Nov 18");
    expect(c.tip).toContain("Sprint 15 starts Nov 18");
  });
  test("a planned sprint with no date is still named", () => {
    expect(noSprintChip({ name: "Sprint 15", start: 0 }, "scrum").label).toBe("No sprint · S15 is planned");
  });
  test("a kanban board says so; a scrum board, or one whose kind did not load, has not started its first sprint", () => {
    expect(noSprintChip(undefined, "kanban").label).toBe("Kanban · no sprints");
    for (const t of ["scrum", undefined, ""]) {
      const c = noSprintChip(undefined, t);
      expect(c.label).toBe("No sprints yet");
      expect(c.tip).toBe("This board has not started its first sprint.");
    }
  });
  test("no case is the bare box", () => {
    for (const next of [undefined, { name: "Sprint 2", start: NOV18 }]) for (const t of ["scrum", "kanban", undefined]) expect(noSprintChip(next, t).label).not.toBe("No active sprint");
  });
});

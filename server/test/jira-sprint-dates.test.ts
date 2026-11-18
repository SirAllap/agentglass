import { describe, expect, test } from "bun:test";
import { cardExtras, sprintRead } from "../src/jirafields.ts";

const END = "2026-11-16T09:00:00.000Z";
describe("the sprint a card carries brings its own dates and goal", () => {
  test("a Cloud sprint object", () => {
    const s = sprintRead([{ id: 41, name: "ORBIT S4", state: "active", startDate: "2026-11-02T09:00:00.000Z", endDate: END, goal: "Ship the checklist" }]);
    expect(s).toMatchObject({ name: "ORBIT S4", active: true, id: "41", end: Date.parse(END), start: Date.parse("2026-11-02T09:00:00.000Z"), goal: "Ship the checklist" });
  });
  test("a Data Center bean text", () => {
    const s = sprintRead(["com.atlassian.greenhopper.service.sprint.Sprint@1b2c3d[id=41,rapidViewId=3,state=ACTIVE,name=ORBIT S4,startDate=2026-11-02T09:00:00.000Z,endDate=" + END + ",completeDate=<null>,sequence=41]"]);
    expect(s?.end).toBe(Date.parse(END));
  });
  test("no dates on the field: none invented", () => {
    expect(sprintRead([{ id: 5, name: "ORBIT S5", state: "future" }])).toEqual({ name: "ORBIT S5", active: false, id: "5" });
  });
  test("the card keeps the end and goal of its active sprint", () => {
    const c = cardExtras({ customfield_10020: [{ id: 41, name: "ORBIT S4", state: "active", startDate: "2026-11-02T09:00:00.000Z", endDate: END, goal: "Ship the checklist" }] }, { sprint: "customfield_10020" });
    expect(c).toMatchObject({ sprintStart: Date.parse("2026-11-02T09:00:00.000Z"), sprintEnd: Date.parse(END), sprintGoal: "Ship the checklist" });
  });
});

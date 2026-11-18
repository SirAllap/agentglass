/*
 * "Current sprint" keeps every card whose sprint is running, in every space at once. It used to keep one sprint by
 * name, so a view mixing two spaces, each with its own running sprint, dropped the smaller one's cards. The server
 * marks the running sprint on each card; this pins that mark.
 */
import { describe, expect, test } from "bun:test";
import { cardExtras, sprintRead } from "../src/jirafields.ts";

describe("running sprint mark", () => {
  test("an active sprint wins over a closed one and is marked running", () => {
    expect(sprintRead([{ id: 3, name: "Orbit 11", state: "closed" }, { id: 4, name: "Orbit 12", state: "active" }])).toEqual({ name: "Orbit 12", active: true, id: "4" });
  });
  test("a future sprint wins over a closed one with a higher id: the card is really in the future one", () => {
    expect(sprintRead([{ id: 103, name: "Orbit 13", state: "closed" }, { id: 102, name: "Orbit 14", state: "future" }])).toEqual({ name: "Orbit 14", active: false, id: "102" });
  });
  test("a card only in closed or future sprints is not running", () => {
    expect(sprintRead([{ id: 5, name: "Acme 3", state: "future" }])).toEqual({ name: "Acme 3", active: false, id: "5" });
    expect(cardExtras({ s: [{ id: 5, name: "Acme 3", state: "future" }] }, { sprint: "s" }).sprintActive).toBeUndefined();
  });
  test("a card only in closed sprints says its sprint is closed; an open one does not", () => {
    expect(cardExtras({ s: [{ id: 7, name: "Acme 2", state: "closed" }] }, { sprint: "s" })).toMatchObject({ sprintId: "7", sprintState: "closed" });
    expect(cardExtras({ s: ["com.atlassian.greenhopper.service.sprint.Sprint@1[id=7,rapidViewId=3,state=CLOSED,name=Acme 2,startDate=<null>,endDate=<null>,completeDate=<null>,sequence=7]"] }, { sprint: "s" }).sprintState).toBe("closed");
    expect(cardExtras({ s: [{ id: 7, name: "Acme 2", state: "closed" }, { id: 8, name: "Acme 3", state: "future" }] }, { sprint: "s" }).sprintState).toBeUndefined();
  });
  test("the card carries the mark next to the name", () => {
    expect(cardExtras({ s: [{ id: 9, name: "Acme 4", state: "active" }] }, { sprint: "s" })).toMatchObject({ sprint: "Acme 4", sprintActive: true, sprintId: "9" });
  });
});

/*
 * A tab's narrowings do not follow into the next place. Measured: Team, then Flagged and Show done, then another tab
 * or the board again: both chips were still on, under a tab that never set them.
 */
import { expect, test } from "bun:test";
import { leaveTab, tabStart } from "../src/components/jira/list/viewsModel.ts";
import { NO_FILTERS } from "../src/components/jira/list/model.ts";

test("leaving a tab drops Flagged, Mine only, Show done, a built rule and a sprint", () => {
  const left = leaveTab(["ORBIT"]);
  for (const k of ["mineOnly", "readyOnly", "flaggedOnly", "blockedOnly", "dueOnly", "quietOnly", "liveOnly", "needsOnly"] as const) expect(left[k]).toBe(false);
  expect(left.sprintOnly).toBeNull();
  expect(left.quick).toEqual([]);
  expect(left.built).toBe(NO_FILTERS.built);
  expect(left.showDone).toBe(false);
});
test("picking a tab starts from the same clean slate", () => {
  expect(tabStart()).toMatchObject({ mineOnly: false, flaggedOnly: false, sprintOnly: null, quick: [], showDone: false });
});

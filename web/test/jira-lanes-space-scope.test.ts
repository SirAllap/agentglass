/* "Assigned to me" with Spaces: INF shows exactly INF's workflow columns: the space filter reaches the columns. */
import { describe, expect, test } from "bun:test";
import { buildLanes } from "../src/components/jira/list/laneModel.ts";
import { lanesOf } from "../src/components/jira/list/model.ts";

const st = (status: string, orderindex: number, spaces: string[], type = "custom") => ({ status, type, orderindex, spaces });
const statuses = [
  st("TO DO", 0, ["INF", "AIR", "VR"], "open"),
  st("IN DEVELOPMENT", 1, ["INF", "AIR", "VR"]),
  st("WORK IN PROGRESS", 2, ["VR"]),
  st("DONE", 3, ["INF", "AIR", "VR"], "done"),
];
const card = (status: string, space: string) => ({ id: `${space}-1`, customId: `${space}-1`, status, listId: space, statusKind: "open", assignees: [], tags: [], title: "t" }) as never;
const base = { cards: [card("TO DO", "INF")], statuses, group: "status" as const, thenGroup: "none" as const, epics: [] };

describe("the space filter reaches the columns", () => {
  test("Assigned to me with Spaces: INF is exactly INF's workflow", () => {
    const lanes = buildLanes({ ...base, assigned: true, spaces: ["INF"] } as never);
    // (an empty done lane is left out of lanes, as before)
    expect(lanes.map((l) => l.status)).toEqual(["TO DO", "IN DEVELOPMENT"]);
  });
  test("no space filter is every space's workflow", () => {
    expect(buildLanes({ ...base, assigned: true } as never).map((l) => l.status)).toEqual(["TO DO", "IN DEVELOPMENT", "WORK IN PROGRESS"]);
  });
  test("the board's own columns take the same scope", () => {
    expect(lanesOf(base.cards, statuses, ["INF"]).map((l) => l.status)).toEqual(["TO DO", "IN DEVELOPMENT", "DONE"]);
  });
});

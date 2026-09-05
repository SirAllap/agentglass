/*
 * The Cards tab's local half — what `/tasks/list` becomes on screen.
 *
 * The tab assumed ClickUp; a machine that tracks work in its own local store
 * got an empty board. The rows for the local list are built from these two
 * functions, and this checks the two decisions in them that a reader would
 * notice being wrong: what "Open" means for a store that exports its whole
 * history, and what the second line of a row says.
 */
import { describe, expect, test } from "bun:test";
import type { LocalTask } from "../../shared/types.ts";
import { localMeta, visibleLocal } from "../src/model/localTasks.ts";

const task = (over: Partial<LocalTask>): LocalTask => ({
  uuid: "u", description: "Write the thing", status: "pending", project: null, priority: null,
  tags: [], due: null, created: null, completed: null, urgency: 0, notes: [], urls: [],
  ...over,
});

describe("visibleLocal", () => {
  const all = [
    task({ uuid: "1", status: "pending" }),
    task({ uuid: "2", status: "completed" }),
    task({ uuid: "3", status: "deleted" }),
  ];

  test("Open is pending, and only pending", () => {
    expect(visibleLocal(all, true).map((t) => t.uuid)).toEqual(["1"]);
  });

  test("All keeps completed — 'did I close that?' — and still drops deleted", () => {
    expect(visibleLocal(all, false).map((t) => t.uuid)).toEqual(["1", "2"]);
  });

  test("not loaded yet is an empty list, not a crash", () => {
    expect(visibleLocal(null, true)).toEqual([]);
  });
});

describe("localMeta", () => {
  test("project, priority as a word, tags with their plus", () => {
    expect(localMeta(task({ project: "orbit", priority: "H", tags: ["next", "phone"] })))
      .toEqual(["orbit", "high", "+next", "+phone"]);
  });

  test("a task with nothing to say says nothing", () => {
    // No "none", no "no project": most tasks have no priority, and a row of
    // placeholders is a row nobody reads.
    expect(localMeta(task({}))).toEqual([]);
  });

  test("the letters map to the words a person would use", () => {
    expect(localMeta(task({ priority: "M" }))).toEqual(["medium"]);
    expect(localMeta(task({ priority: "L" }))).toEqual(["low"]);
  });
});

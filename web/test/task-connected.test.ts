// Which task sources are set up, and what the tab bar does about it.
//
// The rule being pinned here is the one with a hinge in it. Hiding an
// unconnected source is right for somebody who has set their machine up, and
// wrong on a fresh install, where the bar is the only place these features are
// advertised at all. So "nothing set up" is not "hide everything" — it is the
// case where all of them show.
import { describe, expect, test } from "bun:test";
import { visibleTaskSources, type TaskConnected } from "../src/lib/taskConnected.ts";
import type { TaskSourceId } from "../src/lib/taskSources.ts";

const ALL: TaskSourceId[] = ["github", "local", "clickup"];

const set = (...on: TaskSourceId[]): TaskConnected =>
  ({ github: on.includes("github"), local: on.includes("local"), clickup: on.includes("clickup") });

describe("which sources reach the bar", () => {
  test("only the ones that are set up", () => {
    expect(visibleTaskSources(ALL, set("github", "local"))).toEqual(["github", "local"]);
  });

  test("everything, when nothing is set up", () => {
    // A fresh install. Hiding all three would leave the view as its own header,
    // and the features would exist only for somebody who already knew.
    expect(visibleTaskSources(ALL, set())).toEqual(ALL);
  });

  test("everything, while the answer is still unknown", () => {
    // Null is "not asked yet". Drawing the preference and then only ever losing
    // tabs is what stops the bar rearranging itself a beat after it appears.
    expect(visibleTaskSources(ALL, null)).toEqual(ALL);
  });

  test("the preference's order is kept, never re-sorted", () => {
    const reordered: TaskSourceId[] = ["clickup", "local", "github"];
    expect(visibleTaskSources(reordered, set("clickup", "github"))).toEqual(["clickup", "github"]);
  });

  test("a source switched off stays off even when it is connected", () => {
    // This only ever removes. What the preference already dropped is not ours
    // to put back.
    expect(visibleTaskSources(["github"], set("github", "clickup"))).toEqual(["github"]);
  });

  test("one connected source is a bar of one, not a fallback to all", () => {
    expect(visibleTaskSources(ALL, set("clickup"))).toEqual(["clickup"]);
  });
});

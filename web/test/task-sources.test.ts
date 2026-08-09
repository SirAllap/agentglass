// Which task sources the Tasks view offers.
//
// Two rules carry this, and both are about not leaving somebody stranded: the
// last visible source cannot be hidden, and the snapshot handed to React has to
// keep its identity between changes — a fresh array every read is an infinite
// re-render, which is a white window rather than a warning.
import { beforeEach, describe, expect, test } from "bun:test";
import {
  TASK_SOURCES, shownTaskSources, taskSourceShown, setTaskSourceShown, subscribeTaskSources,
  orderedTaskSources, moveTaskSource, resetTaskSourceOrder, __forgetTaskSources,
} from "../src/lib/taskSources.ts";

// bun's test environment has no DOM; the module only ever touches these three.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

beforeEach(() => {
  store.clear();
  // Drop the cached snapshot the same way a real change does.
  setTaskSourceShown("github", true);
});

describe("what the Tasks view offers", () => {
  test("everything, until somebody says otherwise", () => {
    expect(shownTaskSources()).toEqual(TASK_SOURCES.map((s) => s.id));
  });

  test("hiding one takes it out and leaves the rest", () => {
    setTaskSourceShown("clickup", false);
    expect(taskSourceShown("clickup")).toBe(false);
    expect(shownTaskSources()).toEqual(["github", "local"]);
  });

  test("the last one cannot be hidden", () => {
    // Otherwise the view is its own header and nothing else, with no way back
    // except finding this page again.
    setTaskSourceShown("clickup", false);
    setTaskSourceShown("local", false);
    expect(setTaskSourceShown("github", false)).toBe(true);
    expect(shownTaskSources()).toEqual(["github"]);
  });

  test("the snapshot keeps its identity until something changes", () => {
    // useSyncExternalStore compares by identity: a new array every read is an
    // infinite render loop.
    expect(shownTaskSources()).toBe(shownTaskSources());
    const before = shownTaskSources();
    setTaskSourceShown("local", false);
    expect(shownTaskSources()).not.toBe(before);
  });

  test("subscribers hear a change, and stop when they leave", () => {
    let beats = 0;
    const off = subscribeTaskSources(() => { beats++; });
    setTaskSourceShown("local", false);
    off();
    setTaskSourceShown("local", true);
    expect(beats).toBe(1);
  });
});

describe("the order they sit in", () => {
  test("is the catalogue's own until somebody moves something", () => {
    expect(orderedTaskSources()).toEqual(TASK_SOURCES.map((s) => s.id));
  });

  test("a move is one step, and the ends do not wrap", () => {
    expect(moveTaskSource("clickup", -1)).toBe(true);
    expect(orderedTaskSources()).toEqual(["github", "clickup", "local"]);
    // Already last after two moves up would be first — check the real end.
    expect(moveTaskSource("github", -1)).toBe(false);
    expect(moveTaskSource("local", 1)).toBe(false);
    expect(orderedTaskSources()).toEqual(["github", "clickup", "local"]);
  });

  test("the bar follows the order, hidden ones dropped", () => {
    moveTaskSource("clickup", -1);
    moveTaskSource("clickup", -1);
    setTaskSourceShown("github", false);
    expect(orderedTaskSources()).toEqual(["clickup", "github", "local"]);
    expect(shownTaskSources()).toEqual(["clickup", "local"]);
  });

  test("moving steps over a hidden source rather than past it invisibly", () => {
    // The move happens in the full list. Stepping over something you cannot see
    // would look like a press that did nothing, and turning that source back on
    // later would reveal an order nobody asked for.
    setTaskSourceShown("local", false);
    expect(moveTaskSource("clickup", -1)).toBe(true);
    expect(orderedTaskSources()).toEqual(["github", "clickup", "local"]);
    expect(shownTaskSources()).toEqual(["github", "clickup"]);
  });

  test("a stored order from another version is reconciled, not trusted", () => {
    // An id that no longer exists is dropped; one it has never heard of is
    // appended, which is what lets a new source ship with no migration. A
    // duplicate is collapsed — React would render the same key twice.
    store.set("agentglass.tasks.order", JSON.stringify(["clickup", "gone", "clickup"]));
    __forgetTaskSources();
    expect(orderedTaskSources()).toEqual(["clickup", "github", "local"]);
  });

  test("rubbish on disk is ignored rather than fatal", () => {
    store.set("agentglass.tasks.order", "{not json");
    __forgetTaskSources();
    expect(orderedTaskSources()).toEqual(TASK_SOURCES.map((s) => s.id));
  });

  test("reset puts the catalogue's order back", () => {
    moveTaskSource("clickup", -1);
    resetTaskSourceOrder();
    expect(orderedTaskSources()).toEqual(TASK_SOURCES.map((s) => s.id));
  });

  test("the ordered snapshot keeps its identity until something changes", () => {
    expect(orderedTaskSources()).toBe(orderedTaskSources());
    const before = orderedTaskSources();
    moveTaskSource("clickup", -1);
    expect(orderedTaskSources()).not.toBe(before);
  });
});

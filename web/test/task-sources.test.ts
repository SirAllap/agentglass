// Which task sources the Tasks view offers.
//
// Two rules carry this, and both are about not leaving somebody stranded: the
// last visible source cannot be hidden, and the snapshot handed to React has to
// keep its identity between changes — a fresh array every read is an infinite
// re-render, which is a white window rather than a warning.
import { beforeEach, describe, expect, test } from "bun:test";
import {
  TASK_SOURCES, shownTaskSources, taskSourceShown, setTaskSourceShown, subscribeTaskSources,
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

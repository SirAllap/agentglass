// Which tab the Tasks view opens on.
//
// There was no default here before, there was a constant: the source was
// component state initialised to "all", so every visit started over — on the
// one view that does not include your ClickUp cards. Everything below is about
// the same failure mode in different clothes: landing on a tab that is not on
// the bar, which draws an empty view with no way to tell why.
import { beforeEach, describe, expect, test } from "bun:test";
import {
  landingSource, taskLanding, setTaskLanding, lastTaskSource, rememberTaskSource,
} from "../src/lib/taskLanding.ts";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

const BAR = ["all", "github", "local", "clickup"];

beforeEach(() => { store.clear(); });

describe("the stored preference", () => {
  test("is last-used until somebody chooses otherwise", () => {
    expect(taskLanding()).toBe("last");
  });

  test("survives a round trip", () => {
    setTaskLanding("clickup");
    expect(taskLanding()).toBe("clickup");
  });

  test("ignores a value it does not recognise", () => {
    // Written by a future version, or by hand. Falling back beats landing on a
    // tab that does not exist.
    store.set("agentglass.tasks.landing", "jira");
    expect(taskLanding()).toBe("last");
  });
});

describe("where it actually lands", () => {
  test("on last-used, the tab you left", () => {
    rememberTaskSource("clickup");
    expect(landingSource(BAR)).toBe("clickup");
  });

  test("on last-used with nothing remembered, the first tab", () => {
    expect(landingSource(BAR)).toBe("all");
  });

  test("on a pinned source, that source whatever you did last", () => {
    setTaskLanding("clickup");
    rememberTaskSource("github");
    expect(landingSource(BAR)).toBe("clickup");
  });

  test("a remembered tab that is no longer on the bar is not landed on", () => {
    // ClickUp switched off, or its token removed since you were last here.
    rememberTaskSource("clickup");
    expect(landingSource(["all", "github", "local"])).toBe("all");
  });

  test("a pinned tab that is no longer on the bar is not landed on either", () => {
    setTaskLanding("clickup");
    expect(landingSource(["all", "github"])).toBe("all");
  });

  test("falls back to the first tab, not to “all”", () => {
    // The whole reason this takes the bar as an argument: with one source there
    // IS no "all", and landing on it draws a view that is not there.
    setTaskLanding("clickup");
    expect(landingSource(["github"])).toBe("github");
    expect(landingSource([])).toBe("all");
  });
});

describe("what gets remembered", () => {
  test("nothing, until something is", () => {
    expect(lastTaskSource()).toBe(null);
  });

  test("the last thing written wins", () => {
    rememberTaskSource("local");
    rememberTaskSource("clickup");
    expect(lastTaskSource()).toBe("clickup");
  });
});

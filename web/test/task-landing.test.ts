// Which tab the Tasks view opens on.
//
// There was no default here before, there was a constant: the source was
// component state initialised to "all", so every visit started over — on the
// one view that does not include your ClickUp cards. Everything below is about
// the same failure mode in different clothes: landing on a tab that is not on
// the bar, which draws an empty view with no way to tell why.
import { beforeEach, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal";
import {
  landingSource, openTaskSource, taskLanding, setTaskLanding, lastTaskSource, rememberTaskSource,
} from "../src/lib/taskLanding.ts";
const stubGlobal = globalStubs();

const store = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
});

const BAR = ["all", "github", "local", "clickup"];
const BAR_WITH_JIRA = ["all", "jira", "clickup", "local", "github"];

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
    store.set("agentglass.tasks.landing", "gone");
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

describe("what wins when the view opens", () => {
  // The order is explicit target > saved landing > nothing else. The last tab
  // is where "last used" lands, never something that outranks a saved choice.
  test("the saved landing, over a stale last-visited tab", () => {
    setTaskLanding("jira");
    rememberTaskSource("clickup");
    expect(openTaskSource({ available: BAR_WITH_JIRA, landing: "jira" })).toBe("jira");
  });

  test("a landing held while the bar is still being read, not stepped off", () => {
    // The sources the server has not answered about yet are left off the bar
    // for a frame. Falling back then is how a pinned Jira opened on All.
    expect(openTaskSource({ available: ["all", "local", "github"], landing: "jira", settled: false })).toBe("jira");
  });

  test("the tab you left, on last used", () => {
    rememberTaskSource("clickup");
    expect(openTaskSource({ available: BAR, landing: "last" })).toBe("clickup");
  });

  test("the current tab on last used, while the view stays open", () => {
    rememberTaskSource("clickup");
    expect(openTaskSource({ available: BAR, landing: "last", current: "github" })).toBe("github");
  });

  test("an explicit target over the saved landing", () => {
    // A card chip is an errand, not a change of mind about where you live.
    expect(openTaskSource({ available: BAR, landing: "jira", explicit: "clickup" })).toBe("clickup");
  });

  test("a landing that never arrives still leaves you on a tab that exists", () => {
    expect(openTaskSource({ available: ["all", "github"], landing: "jira", settled: true })).toBe("all");
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

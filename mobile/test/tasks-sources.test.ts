/*
 * Which sources the Tasks tab offers, and what it opens on.
 *
 * The tab used to be one thing (the tracker's board) and then two (plus a
 * separate Issues destination). It is one tab over two sources now, and this
 * locks the rule that decides what the pill says:
 *
 *   - GitHub issues is always there: it needs no provider, only a checkout.
 *   - The tracker is there when one is set up, named after ITSELF (Taskwarrior
 *     is not ClickUp), with `error` counting as set up — a refused token is
 *     something somebody configured.
 *   - No answer is unknown, never "none": the pill waits rather than claiming a
 *     machine has no sources.
 *   - Jira is its own source when it is set up: the phone reads its board, so
 *     it is offered first and opens on it. It is not "the tracker" because what
 *     the tab draws for it is a four-lane board, not `/tasks/list`.
 *   - Which one opens is not "the first on the bar": it is the source last
 *     used, with the desk's precedence (model/tasksLanding.ts).
 */
import { beforeAll, afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { ProviderId, ProviderState, ProviderStatus } from "../../shared/providers.ts";
import { taskSources } from "../src/model/taskProviders.ts";
import {
  __resetTaskSources, __useKeystore, lastTaskSource, openTaskSource, readTaskSource, rememberTaskSource,
} from "../src/model/tasksLanding.ts";

const at = (id: ProviderId, state: ProviderState): ProviderStatus => ({ id, state });

describe("the sources the Tasks tab offers", () => {
  test("a ClickUp machine is offered its board and GitHub issues", () => {
    const got = taskSources([at("clickup", "connected")]);
    expect(got?.map((s) => s.id)).toEqual(["tracker", "issues"]);
    expect(got?.[0]?.title).toBe("ClickUp");
    expect(got?.[0]?.provider).toBe("clickup");
  });

  test("Taskwarrior is offered as itself, not as somebody else's product", () => {
    const got = taskSources([at("taskwarrior", "connected"), at("clickup", "needs-auth")]);
    expect(got?.[0]?.title).toBe("Taskwarrior");
    expect(got?.[0]?.provider).toBe("taskwarrior");
  });

  test("a refused token is still a source", () => {
    // "ClickUp refused this token" is not "you do not use ClickUp", and the
    // screen that reads it is where the error is shown.
    expect(taskSources([at("clickup", "error")])?.[0]?.title).toBe("ClickUp");
  });

  test("an answer with no tracker still offers GitHub issues", () => {
    expect(taskSources([at("clickup", "needs-auth")])?.map((s) => s.id)).toEqual(["issues"]);
    expect(taskSources([])?.map((s) => s.id)).toEqual(["issues"]);
  });

  test("no answer is unknown, not none", () => {
    // `undefined` and `[]` are different answers: the first has no pill to draw
    // yet, the second is a real offer with only issues in it.
    expect(taskSources(null)).toBeUndefined();
    expect(taskSources(undefined)).toBeUndefined();
  });

  test("Jira is offered as itself, first", () => {
    const got = taskSources([at("jira", "connected")]);
    expect(got?.map((s) => s.id)).toEqual(["jira", "issues"]);
    expect(got?.[0]?.title).toBe("Jira");
    expect(got?.[0]?.provider).toBe("jira");
  });

  test("a Jira and a ClickUp are two sources, not one winner", () => {
    const got = taskSources([at("clickup", "connected"), at("jira", "connected")]);
    expect(got?.map((s) => s.id)).toEqual(["jira", "tracker", "issues"]);
    expect(got?.[1]).toMatchObject({ title: "ClickUp", provider: "clickup" });
  });

  test("the tab opens on the tracker, and on issues when there is no tracker", () => {
    expect(taskSources([at("clickup", "connected")])?.[0]?.id).toBe("tracker");
    expect(taskSources([at("clickup", "needs-auth")])?.[0]?.id).toBe("issues");
  });

  test("with Jira and ClickUp both set up, both are offered and the remembered one opens", () => {
    const got = taskSources([at("clickup", "connected"), at("jira", "connected")]);
    const available = got!.map((s) => s.id);
    expect(available).toEqual(["jira", "tracker", "issues"]);
    expect(got!.find((s) => s.id === "tracker")?.title).toBe("ClickUp");
    expect(openTaskSource({ available, last: "tracker" })).toBe("tracker");
  });

  test("a tracker nobody set up is not offered, so the picker lists only connected ones", () => {
    const got = taskSources([at("jira", "connected"), at("clickup", "needs-auth"), at("taskwarrior", "missing-tool")]);
    expect(got?.map((s) => s.id)).toEqual(["jira", "issues"]);
  });

  test("the landing rule lives in one place: no second 'default source' export", async () => {
    // `defaultTaskSource` was this file's ranking before the tab learned to
    // remember; its doc then named Jira as the answer, which the screen no
    // longer gives.
    const mod = await import("../src/model/taskProviders.ts");
    expect("defaultTaskSource" in mod).toBe(false);
  });
});

describe("where the tab opens", () => {
  const bar = ["jira", "tracker", "issues"];

  test("an explicit jump wins: somebody asked for that card", () => {
    expect(openTaskSource({ available: bar, explicit: "tracker", last: "jira" })).toBe("tracker");
  });

  test("a jump this machine cannot honour falls through to the landing", () => {
    // A notification about a Jira card, followed on a phone re-paired to a
    // machine with no Jira: a tab that is not on the bar is a blank screen.
    expect(openTaskSource({ available: ["tracker", "issues"], explicit: "jira", last: "tracker" })).toBe("tracker");
  });

  test("the tab on screen now beats the store, so a visit never jumps backwards", () => {
    expect(openTaskSource({ available: bar, current: "issues", last: "tracker" })).toBe("issues");
  });

  test("otherwise the source last used opens, ahead of the bar's own order", () => {
    expect(openTaskSource({ available: bar, last: "tracker" })).toBe("tracker");
  });

  test("a remembered source the machine no longer offers is not drawn", () => {
    expect(openTaskSource({ available: ["issues"], last: "tracker" })).toBe("issues");
  });

  test("nothing remembered opens on the first source offered", () => {
    expect(openTaskSource({ available: bar })).toBe("jira");
    expect(openTaskSource({ available: ["issues"] })).toBe("issues");
  });

  test("no bar yet is nothing to open, not 'issues'", () => {
    expect(openTaskSource({ available: [] })).toBeNull();
  });

  test("the memory is per computer: 'tracker' is another product on the next one", () => {
    __resetTaskSources();
    rememberTaskSource("c0ffee", "tracker");
    expect(lastTaskSource("c0ffee")).toBe("tracker");
    expect(lastTaskSource("beef01")).toBeNull();
    __resetTaskSources();
    expect(lastTaskSource("c0ffee")).toBeNull();
  });
});

describe("the memory outlives the app", () => {
  /* The keystore is a Map here, injected through `__useKeystore` and not
     `mock.module`, which is process-wide and clobbers the other file that fakes
     the same module (test/hosts-store.test.ts). */
  const store = new Map<string, string>();
  const fake = {
    getItemAsync: async (k: string) => store.get(k) ?? null,
    setItemAsync: async (k: string, v: string) => { store.set(k, v); },
  };

  beforeAll(() => __useKeystore(fake));
  afterAll(() => __useKeystore(null));
  beforeEach(() => { store.clear(); __resetTaskSources(); });

  test("a relaunch reads the source the last visit ended on", async () => {
    rememberTaskSource("c0ffee", "tracker");
    // A new process has no memory; the phone's own copy is what survives.
    __resetTaskSources();
    expect(lastTaskSource("c0ffee")).toBeNull();
    expect(await readTaskSource("c0ffee")).toBe("tracker");
    expect(lastTaskSource("c0ffee")).toBe("tracker");
  });

  test("one machine's pick is not the next one's", async () => {
    rememberTaskSource("c0ffee", "tracker");
    __resetTaskSources();
    expect(await readTaskSource("beef01")).toBeNull();
    expect(await readTaskSource("c0ffee")).toBe("tracker");
  });

  test("what was stored is what the tab opens on", async () => {
    store.set("agentglass.tasks.source.c0ffee", "tracker");
    const last = await readTaskSource("c0ffee");
    expect(openTaskSource({ available: ["jira", "tracker", "issues"], last })).toBe("tracker");
  });

  test("a pick made while the stored read is in flight is not undone by it", async () => {
    store.set("agentglass.tasks.source.c0ffee", "jira");
    const read = readTaskSource("c0ffee");
    rememberTaskSource("c0ffee", "issues");
    expect(await read).toBe("issues");
  });
});

describe("the screen", () => {
  test("it opens by the rule, and the pill writes what it picked", async () => {
    const src = await Bun.file(new URL("../app/(tabs)/tasks.tsx", import.meta.url)).text();
    expect(src).toContain("openTaskSource({");
    expect(src).toContain("rememberTaskSource(host?.id, id)");
    expect(src).toContain("readTaskSource(id)");
    expect(src).not.toContain("?? defaultTaskSource(sources)");
  });
});

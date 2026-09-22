/*
 * The one fact the desktop's "keep the machine awake while an agent works"
 * mode polls: is anybody actually working, right now.
 *
 * Exercised through injected deps rather than the real trackers — this table
 * and the chat module's active-turn set are shared process-wide state that
 * every other test file in the suite also touches, and asserting against the
 * real thing would be asserting against whatever they happened to leave.
 */
import { describe, expect, test } from "bun:test";
import { agentIsWorking, workingWhy } from "../src/agentworking.ts";

const deps = (opts: { turns?: string[]; running?: { startedAt: number }[] }) => ({
  activeTurns: () => opts.turns ?? [],
  runningRuns: () => opts.running ?? [],
});

describe("agentIsWorking", () => {
  test("nothing running or turning says false", () => {
    expect(agentIsWorking(Date.now(), deps({}))).toBe(false);
  });

  test("a pane mid-turn says true", () => {
    expect(agentIsWorking(Date.now(), deps({ turns: ["abc"] }))).toBe(true);
  });

  test("a running understudy run says true", () => {
    const now = Date.now();
    expect(agentIsWorking(now, deps({ running: [{ startedAt: now }] }))).toBe(true);
  });

  test("a run older than the staleness window stops counting", () => {
    const now = Date.now();
    const threeHoursAgo = now - 3 * 60 * 60 * 1000;
    expect(agentIsWorking(now, deps({ running: [{ startedAt: threeHoursAgo }] }))).toBe(false);
  });

  test("a run just inside the window still counts", () => {
    const now = Date.now();
    const underTwoHours = now - (2 * 60 * 60 * 1000 - 1000);
    expect(agentIsWorking(now, deps({ running: [{ startedAt: underTwoHours }] }))).toBe(true);
  });
});

describe("the sessions this app did not start", () => {
  test("a hook in the last ten minutes is an agent at work", () => {
    const now = Date.now();
    expect(agentIsWorking(now, { ...deps({}), hookedWorking: () => 1 })).toBe(true);
    expect(agentIsWorking(now, { ...deps({}), hookedWorking: () => 0 })).toBe(false);
  });
  test("a named agent whose pane is alive is at work; none alive is not", () => {
    const now = Date.now();
    expect(agentIsWorking(now, { ...deps({}), hookedWorking: () => 0, namedAlive: () => 2 })).toBe(true);
    expect(agentIsWorking(now, { ...deps({}), hookedWorking: () => 0, namedAlive: () => 0 })).toBe(false);
  });
  test("the shell starts in `agent` mode, not `off`", async () => {
    const src = await Bun.file(new URL("../../electron/power.js", import.meta.url)).text();
    const body = src.slice(src.indexOf("function loadMode()"), src.indexOf("function saveMode("));
    expect(body).toContain('return "agent";');
    expect(body).not.toContain('return "off";');
  });
});


describe("why the machine is being kept awake", () => {
  /* The desktop draws this: "awake" alone does not say whether it is a chat
     mid-turn, a run, or somebody's agent in their own terminal. */
  test("each source is counted on its own, and a stale run is not counted", () => {
    const now = Date.now();
    const why = workingWhy(now, {
      activeTurns: () => ["a", "b"],
      runningRuns: () => [{ startedAt: now }, { startedAt: now - 3 * 60 * 60 * 1000 }],
      hookedWorking: () => 3,
      namedAlive: () => 1,
    });
    expect(why).toEqual({ chats: 2, runs: 1, hooked: 3, named: 1 });
  });
  test("nothing at work is all zeroes, and agrees with agentIsWorking", () => {
    const now = Date.now();
    const quiet = { ...deps({}), hookedWorking: () => 0, namedAlive: () => 0 };
    expect(workingWhy(now, quiet)).toEqual({ chats: 0, runs: 0, hooked: 0, named: 0 });
    expect(agentIsWorking(now, quiet)).toBe(false);
  });
});

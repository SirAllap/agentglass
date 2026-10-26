/*
 * The one fact the desktop's "keep the machine awake while an agent works"
 * mode polls: is anybody actually working, right now.
 *
 * Exercised through injected deps rather than the real trackers, which are
 * shared process-wide state that every other test file in the suite also
 * touches.
 */
import { describe, expect, test } from "bun:test";
import { agentIsWorking, workingWhy } from "../src/agentworking.ts";

const deps = (opts: { hooked?: number } = {}) => ({
  hookedWorking: () => opts.hooked ?? 0,
});

describe("agentIsWorking", () => {
  test("nothing running says false", () => {
    expect(agentIsWorking(Date.now(), deps({}))).toBe(false);
  });

  test("an agent that fired a hook lately says true", () => {
    expect(agentIsWorking(Date.now(), deps({ hooked: 1 }))).toBe(true);
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
  /* The desktop draws this: "awake" alone does not say whether it is a hooked agent, or a named one in their own terminal. */
  test("each source is counted on its own", () => {
    const now = Date.now();
    const why = workingWhy(now, {
      hookedWorking: () => 3,
      namedAlive: () => 1,
    });
    expect(why).toEqual({ hooked: 3, named: 1 });
  });
  test("nothing at work is all zeroes, and agrees with agentIsWorking", () => {
    const now = Date.now();
    const quiet = { ...deps({}), hookedWorking: () => 0, namedAlive: () => 0 };
    expect(workingWhy(now, quiet)).toEqual({ hooked: 0, named: 0 });
    expect(agentIsWorking(now, quiet)).toBe(false);
  });
});

describe("the named agents are a tmux question, asked at most every ten seconds", () => {
  test("a second poll inside the window reuses the answer instead of asking tmux again", async () => {
    let calls = 0;
    const d = { ...deps({}), hookedWorking: () => 0, namedAlive: () => { calls++; return Promise.resolve(2); } };
    const now = Date.now();
    workingWhy(now, d);
    await Promise.resolve();
    expect(workingWhy(now + 1_000, d).named, "the answer from the first ask").toBe(2);
    expect(calls, "asked once in ten seconds").toBe(1);
    workingWhy(now + 11_000, d);
    expect(calls).toBe(2);
  });
});

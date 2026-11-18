/*
 * An interactive worker turn's starting point in its transcript is read before
 * its CLI starts. Read after the start returned, a CLI that answers fast had
 * already written its end marker, the watch began past it, and the worker read
 * "still on its turn" until its ceiling (flow-role-switch.test.ts timed out on
 * every run where that happened). Asserted against source: every start of a
 * worker turn measures `tuiFrom` before `startGuarded` and arms with it.
 */
import { expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/agents/policystart.ts", import.meta.url)).text();
const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

test("every worker turn start measures the transcript before the CLI starts", () => {
  const starts = [...code.matchAll(/await startGuarded\(/g)].map((m) => m.index!);
  expect(starts.length).toBeGreaterThanOrEqual(3);
  let prev = 0;
  for (const at of starts) {
    const before = code.slice(prev, at);
    expect(before.lastIndexOf("const tuiFrom = tuiStartOf(")).toBeGreaterThan(-1);
    const after = code.slice(at, code.indexOf("armWorker(", at));
    expect(after.includes("const tuiFrom")).toBe(false);
    const armCall = code.slice(code.indexOf("armWorker(", at), code.indexOf(";", code.indexOf("armWorker(", at)));
    expect(armCall).toContain("tuiFrom)");
    prev = at;
  }
});

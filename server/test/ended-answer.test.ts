/*
 * A worker stopped at its turn limit answered every verb with "no agent by that
 * name", the same words as a name that never existed. The ended row carries the
 * reason (agents/ceilings.ts settles it with exit 124), so the answer names it.
 */
import { describe, expect, test } from "bun:test";
import { endedAnswer, type NamedAgent } from "../src/agentops.ts";

const row = (over: Partial<NamedAgent>): NamedAgent => ({ name: "orbit-ORBIT-1042-bot", kind: "claude", cwd: "/w", paneId: "%1", windowId: "@1", startedAt: 1, endedAt: null, ...over } as NamedAgent);

describe("endedAnswer", () => {
  test("a name nobody had keeps the plain words", () => {
    expect(endedAnswer(null)).toBe("no agent by that name");
  });
  test("an ended turn says why", () => {
    const a = row({ endedAt: 2, exitCode: 124, exitLine: "timeout: still running after 30 minutes, so it was stopped" });
    expect(endedAnswer(a)).toContain("timeout: still running after 30 minutes");
    expect(endedAnswer(a)).toContain("orbit-ORBIT-1042-bot");
  });
  test("an ended row with no reason, or a live one, stays plain", () => {
    expect(endedAnswer(row({ endedAt: 2 }))).toBe("no agent by that name");
    expect(endedAnswer(row({ exitLine: "x" }))).toBe("no agent by that name");
  });
});

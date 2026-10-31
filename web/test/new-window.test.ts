/*
 * The "+" menu: New agent types at the window that appears, Split uses the prefix tmux listens to.
 */
import { describe, expect, test } from "bun:test";
import type { TmuxWindow } from "../../shared/types.ts";
import { AGENT_COMMAND, appearedWindow, splitKeys } from "../src/lib/newWindow.ts";

const W = (id: string) => ({ id, index: 0, name: id, active: false, flags: "" }) as TmuxWindow;

describe("appearedWindow", () => {
  test("the first id not seen before", () => {
    expect(appearedWindow(new Set(["@1", "@2"]), [W("@1"), W("@2"), W("@3")])).toBe("@3");
  });
  test("nothing new: null (a renamed or moved window is not new)", () => {
    expect(appearedWindow(new Set(["@1"]), [W("@1")])).toBeNull();
  });
});

describe("splitKeys", () => {
  test("the prefix byte then %", () => {
    expect(splitKeys(["C-f"])).toBe("\x06%");
    expect(splitKeys(["C-b"])).toBe("\x02%");
  });
  test("a prefix it cannot spell is null, and the next one is tried", () => {
    expect(splitKeys([])).toBeNull();
    expect(splitKeys(["nonsense", "C-a"])).toBe("\x01%");
  });
});

test("the agent command is the CLI by name", () => {
  expect(AGENT_COMMAND).toBe("claude");
});

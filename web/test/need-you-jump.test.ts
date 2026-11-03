/*
 * Ctrl+Alt+N: the next window that is waiting for you, wrapping round, across
 * every project. Nothing waiting is no target.
 */
import { describe, expect, test } from "bun:test";
import type { TmuxWindow } from "../../shared/types.ts";
import { needYouJump } from "../src/lib/needYouJump.ts";

const w = (n: number, status?: TmuxWindow["status"]): TmuxWindow => ({ id: `@${n}`, index: n, name: `w${n}`, active: false, flags: "", status });
const fleet = [w(1), w(2, "waiting"), w(3, "working"), w(4, "waiting"), w(5, "error")];

describe("needYouJump", () => {
  test("goes to the next waiting window after the active one", () => {
    expect(needYouJump(fleet, "@1")).toBe("@2");
    expect(needYouJump(fleet, "@2")).toBe("@4");
  });
  test("wraps from the last waiting window to the first", () => {
    expect(needYouJump(fleet, "@4")).toBe("@2");
    expect(needYouJump(fleet, "@5")).toBe("@2");
  });
  test("an error is not a question: only waiting counts", () => {
    expect(needYouJump([w(1, "error"), w(2)], "@1")).toBeNull();
  });
  test("nothing waiting, or no windows, is null", () => {
    expect(needYouJump([w(1), w(2, "working")], "@1")).toBeNull();
    expect(needYouJump([], null)).toBeNull();
  });
  test("the only waiting window is the target even when it is the active one", () => {
    expect(needYouJump([w(1), w(2, "waiting")], "@2")).toBe("@2");
  });
  test("no active window starts from the first", () => {
    expect(needYouJump(fleet, null)).toBe("@2");
    expect(needYouJump(fleet, "@gone")).toBe("@2");
  });
});

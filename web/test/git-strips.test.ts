import { describe, expect, test } from "bun:test";
import { isLowWindow, LOW_WINDOW_PX, rebaseDots, rangeShare, stepsLeft, blameDots, rescueTiles, unstickDots, laneDots } from "../src/lib/gitStrips.ts";

describe("low window", () => {
  test("420px tall is low, a normal window is not", () => {
    expect(isLowWindow(420)).toBe(true);
    expect(isLowWindow(LOW_WINDOW_PX)).toBe(false);
    expect(isLowWindow(900)).toBe(false);
  });
  test("an unknown height (0) is never low", () => expect(isLowWindow(0)).toBe(false));
});

describe("rebase dots", () => {
  test("dropped are hollow, squash and fixup merged, the rest filled", () => {
    const d = rebaseDots([{ action: "pick", hash: "aaaaaaaa" }, { action: "drop", hash: "bbbbbbbb" }, { action: "squash", hash: "cccccccc" }, { action: "fixup", hash: "dddddddd" }, { action: "reword", hash: "eeeeeeee" }]);
    expect(d.map((x) => x.state)).toEqual(["on", "hollow", "merged", "merged", "on"]);
    expect(d[0]!.label).toBe("aaaaaaa");
  });
});

describe("bisect range", () => {
  test("share shrinks with the remaining range and stays within 0..1", () => {
    expect(rangeShare(8, 16)).toBe(0.5);
    expect(rangeShare(0, 16)).toBe(0);
    expect(rangeShare(20, 16)).toBe(1);
    expect(rangeShare(null, 16)).toBe(1);
  });
  test("steps caption", () => {
    expect(stepsLeft(3)).toBe("about 3 steps left");
    expect(stepsLeft(1)).toBe("about 1 step left");
    expect(stepsLeft(0)).toBe("last step");
    expect(stepsLeft(null)).toBe("");
  });
});

describe("blame dots", () => {
  const h = (n: number) => Array.from({ length: n }, (_, i) => ({ hash: `c${n - i}` }));
  test("oldest first, the selected one ringed", () => {
    const d = blameDots(h(4), "c2");
    expect(d.map((x) => x.label)).toEqual(["c1", "c2", "c3", "c4"]);
    expect(d.map((x) => x.state)).toEqual(["on", "ring", "on", "on"]);
  });
  test("long history is capped and keeps the selected one in view", () => {
    const d = blameDots(h(60), "c10", 24);
    expect(d.length).toBe(24);
    expect(d.some((x) => x.state === "ring")).toBe(true);
  });
  test("HEAD selects nothing, the newest end shows", () => {
    const d = blameDots(h(60), "HEAD", 24);
    expect(d[d.length - 1]!.label).toBe("c60");
  });
});

describe("rescue tiles", () => {
  test("one tile per worktree with its kept count", () => {
    const t = rescueTiles([{ path: "/w/orbit-a", entries: [{ path: "x" }, { path: "y" }] }, { path: "/w/orbit-b/", entries: [] }], (_w, f) => f === "x");
    expect(t).toEqual([{ name: "orbit-a", kept: 1, total: 2 }, { name: "orbit-b", kept: 0, total: 0 }]);
  });
});

describe("unstick track", () => {
  test("done filled, running ringed, failed hollow, waiting grey", () => {
    const t = unstickDots(["a", "b", "c", "d"], { a: { status: "done" }, b: { status: "running" }, c: { status: "failed" } });
    expect(t.dots.map((d) => d.state)).toEqual(["on", "ring", "hollow", "off"]);
    expect(t.done).toBe(1);
  });
});

describe("compare lanes", () => {
  test("caps the dots and counts the rest", () => {
    expect(laneDots(3)).toEqual({ shown: 3, more: 0 });
    expect(laneDots(20, 14)).toEqual({ shown: 14, more: 6 });
    expect(laneDots(0)).toEqual({ shown: 0, more: 0 });
  });
});

import { describe, expect, test } from "bun:test";
import { stripMode } from "../src/lib/laneStrip.ts";

const LABELS = ["Needs your review", "Green", "Blocked", "Waiting on someone", "In flight"];

describe("lane strip mode", () => {
  test("a wide board keeps the text chips", () => {
    expect(stripMode(LABELS, 900)).toBe("text");
  });
  test("a board narrower than the chips turns them into icons", () => {
    expect(stripMode(LABELS, 402)).toBe("icon");
  });
  test("one short chip fits where five do not", () => {
    expect(stripMode(["Green"], 200)).toBe("text");
  });
  test("an unmeasured board is the wide layout", () => {
    expect(stripMode(LABELS, 0)).toBe("text");
    expect(stripMode(LABELS, NaN)).toBe("text");
  });
  test("the switch happens at one width, and stays icon below it", () => {
    let flips = 0, prev = stripMode(LABELS, 1200);
    for (let w = 1199; w >= 300; w--) { const m = stripMode(LABELS, w); if (m !== prev) flips++; prev = m; }
    expect(flips).toBe(1);
  });
});

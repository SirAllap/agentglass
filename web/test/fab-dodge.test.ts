import { describe, expect, test } from "bun:test";
import { fabLift } from "../src/lib/fabDodge.ts";

const dock = { left: 0, right: 360, top: 1025, bottom: 1080 };

describe("fabLift", () => {
  test("a button on the bar rests on top of it, with the gap", () => {
    expect(fabLift({ left: 300, right: 338, top: 1008, bottom: 1046 }, [dock])).toBe(1046 - 1025 + 8);
  });
  test("a button beside or above the bar stays where it is", () => {
    expect(fabLift({ left: 400, right: 438, top: 1030, bottom: 1068 }, [dock])).toBe(0);
    expect(fabLift({ left: 300, right: 338, top: 900, bottom: 938 }, [dock])).toBe(0);
  });
  test("one that only borders the bar does not move", () => {
    expect(fabLift({ left: 300, right: 338, top: 987, bottom: 1025 }, [dock])).toBe(0);
  });
  test("no bar, no lift; the tallest of several wins", () => {
    expect(fabLift({ left: 0, right: 38, top: 0, bottom: 38 }, [])).toBe(0);
    const fab = { left: 10, right: 48, top: 1040, bottom: 1078 };
    expect(fabLift(fab, [dock, { ...dock, top: 1000 }])).toBe(1078 - 1000 + 8);
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { placeTip, readTip, splitTip, tipAttr, tipDelay, TIP_DELAY_MS, TIP_FOCUS_MS, TIP_QUICK_MS } from "../src/lib/tip.ts";

describe("a plain sentence is split into a name and a sentence", () => {
  test.each([
    ["theo-w: changes requested", "theo-w", "changes requested"],
    ["Checks. 9 of 12 passed.", "Checks", "9 of 12 passed."],
    ["Review notes — only you see them", "Review notes", "only you see them"],
    ["Copy card ID", "Copy card ID", ""],
  ])("%s", (plain, name, text) => {
    expect(splitTip(plain)).toEqual({ name, text });
  });
  test("a colon deep in a sentence is not a label", () => {
    expect(splitTip("Merges the branch into main without squashing: history stays").name).toContain("Merges");
    expect(splitTip("Merges the branch into main without squashing: history stays").text).toBe("");
  });
});

describe("the attribute round-trips", () => {
  test("a rich spec comes back whole", () => {
    const spec = { name: "ORBIT-1042", mono: true, detail: "in Tasks", hint: { key: "Click", text: "Open the card" } };
    expect(readTip(tipAttr(spec))).toEqual(spec);
  });
  test("a sentence that starts with a brace is still a sentence", () => {
    expect(readTip("{not json").name).toBe("{not json");
  });
});

describe("when the card shows", () => {
  test("350 ms of rest for the first, 120 right after another closed, 150 for the keyboard", () => {
    expect(tipDelay(false, 10_000)).toBe(TIP_DELAY_MS);
    expect(tipDelay(false, 120)).toBe(TIP_QUICK_MS);
    expect(tipDelay(true, 10_000)).toBe(TIP_FOCUS_MS);
    expect([TIP_DELAY_MS, TIP_QUICK_MS, TIP_FOCUS_MS]).toEqual([350, 120, 150]);
  });
});

describe("where the card goes", () => {
  const tip = { w: 272, h: 80 };
  test("above, centred on the target", () => {
    expect(placeTip({ left: 300, top: 200, width: 40, height: 20 }, tip, 1200, 800)).toEqual({ left: 184, top: 112, below: false });
  });
  test("below when there is no room above", () => {
    expect(placeTip({ left: 300, top: 40, width: 40, height: 20 }, tip, 1200, 800)).toEqual({ left: 184, top: 68, below: true });
  });
  test("kept inside the window at both edges", () => {
    expect(placeTip({ left: 0, top: 200, width: 20, height: 20 }, tip, 1200, 800).left).toBe(8);
    expect(placeTip({ left: 1190, top: 200, width: 20, height: 20 }, tip, 1200, 800).left).toBe(1200 - 272 - 8);
  });
});

describe("a tip is always inside the window, and clear of its target when there is room", () => {
  const VW = 1200, VH = 800, tip = { w: 272, h: 80 };
  const inside = (p: { left: number; top: number }, t = tip) => {
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.left + t.w).toBeLessThanOrEqual(VW - 8);
    expect(p.top + t.h).toBeLessThanOrEqual(VH - 8);
  };
  const overlaps = (p: { left: number; top: number }, a: { left: number; top: number; width: number; height: number }, t = tip) =>
    p.left < a.left + a.width && p.left + t.w > a.left && p.top < a.top + a.height && p.top + t.h > a.top;
  const anchors = [
    ["top-left corner", { left: 0, top: 0, width: 24, height: 24 }],
    ["top-right corner", { left: VW - 24, top: 0, width: 24, height: 24 }],
    ["bottom-left corner", { left: 0, top: VH - 24, width: 24, height: 24 }],
    ["bottom-right corner", { left: VW - 24, top: VH - 24, width: 24, height: 24 }],
    ["right edge, mid height", { left: VW - 26, top: 400, width: 26, height: 26 }],
    ["left edge, mid height", { left: 0, top: 400, width: 26, height: 26 }],
    ["centre", { left: 600, top: 400, width: 26, height: 26 }],
  ] as const;
  test.each(anchors)("%s: inside the window and not over the control", (_n, a) => {
    const p = placeTip(a, tip, VW, VH);
    inside(p);
    expect(overlaps(p, a)).toBe(false);
  });
  test("no room above or below: it goes beside the control, on the side that has room", () => {
    const tall = { w: 272, h: 780 };
    const right = placeTip({ left: 100, top: 400, width: 24, height: 24 }, tall, VW, VH);
    expect(right.left).toBe(100 + 24 + 8);
    const left = placeTip({ left: VW - 124, top: 400, width: 24, height: 24 }, tall, VW, VH);
    expect(left.left).toBe(VW - 124 - 8 - 272);
    inside(right, tall);
    inside(left, tall);
  });
  test("a tip wider or taller than the window starts at the edge instead of running off the other side", () => {
    const p = placeTip({ left: 600, top: 400, width: 24, height: 24 }, { w: 2000, h: 2000 }, VW, VH);
    expect(p.left).toBe(8);
    expect(p.top).toBe(8);
  });
});

describe("the host measures the card once it is in the document", () => {
  test("the placement runs in a passive effect (after Portal attaches its element), never a layout effect", () => {
    const src = readFileSync(new URL("../src/components/TipHost.tsx", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).not.toContain("useLayoutEffect");
    expect(src).toContain("window.innerHeight");
  });
});

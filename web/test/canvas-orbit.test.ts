/*
 * The arithmetic of a sheet. There is no renderer under `bun test`, so what a
 * screen decides (where an angle lands, which marks of the clock have passed,
 * that no two labels touch) is asserted here, on the numbers.
 */
import { describe, expect, test } from "bun:test";
import { MOON_MAX_R } from "../../shared/canvasSheet.ts";
import type { CanvasNode } from "../../shared/pluginCanvas.ts";
import {
  LABEL_H, bandPaths, bracketPath, edgePaths, hatchPath, labelLayout, moonRadius, onPlane, planeGeom, tickPaths, tickState, trailSlices, type LabelIn,
} from "../src/lib/canvasOrbit.ts";

const node = (props: Record<string, unknown>): CanvasNode => ({ id: "n", type: "plane", ...props });
const plane = (over: Record<string, unknown> = {}, phase = 1) => planeGeom(node({ cx: 388, cy: 206, rx: 215, tilt: 27, roll: 0, depth: 0.8, ...over }), phase);
const count = (d: string, ch: string) => d.split(ch).length - 1;

describe("a plane is a circle seen from tilt degrees", () => {
  test("seen from 27 degrees the ellipse is .454 as tall as it is wide, and the front of the ring is the near side", () => {
    const g = plane();
    expect(g.ry / g.rx).toBeCloseTo(0.454, 3);
    const right = onPlane(g, 1, 0), front = onPlane(g, 1, 90), back = onPlane(g, 1, 270);
    expect(right.x).toBeCloseTo(603, 5);
    expect(right.y).toBeCloseTo(206, 5);
    expect(front.y).toBeGreaterThan(back.y);
    expect(front.near).toBeCloseTo(1, 6);
    expect(back.near).toBeCloseTo(-1, 6);
  });
  test("a roll turns the whole ring about its centre", () => {
    const g = plane({ roll: -9 });
    const p = onPlane(g, 1, 0);
    expect(p.y).toBeLessThan(206);
    expect(Math.hypot(p.x - 388, p.y - 206)).toBeCloseTo(215, 5);
  });
  test("tipping: phase 0 is a circle (seen from above), phase 1 as declared, in between in between", () => {
    expect(plane({}, 0).ry).toBeCloseTo(215, 6);
    expect(plane({}, 1).ry).toBeLessThan(plane({}, 0.5).ry);
    expect(plane({}, 0.5).ry).toBeLessThan(plane({}, 0).ry);
    expect(Math.abs(plane({ roll: -9 }, 0).roll)).toBe(0);
  });
  test("hostile numbers become geometry only after a clamp", () => {
    const g = planeGeom(node({ cx: NaN, cy: 1e308, rx: -5, tilt: -400, roll: 9e9, depth: 7 }));
    for (const v of [g.cx, g.cy, g.rx, g.ry, g.roll, g.depth]) expect(Number.isFinite(v)).toBe(true);
    expect(g.rx).toBeGreaterThanOrEqual(1);
    expect(g.ry).toBeGreaterThan(0);
  });
});

describe("a moon is bigger near, smaller far, and never past the cap", () => {
  test("depth scales by the side of the ring", () => {
    expect(moonRadius("md", 1, 0.8)).toBeGreaterThan(moonRadius("md", 0, 0.8));
    expect(moonRadius("md", -1, 0.8)).toBeLessThan(moonRadius("md", 0, 0.8));
    expect(moonRadius("md", 1, 0)).toBe(moonRadius("md", -1, 0));
    expect(moonRadius("lg", 1, 0.8)).toBeGreaterThan(moonRadius("sm", 1, 0.8));
  });
  test("whatever it is told, a moon stays inside MOON_MAX_R", () => {
    for (const near of [-5, 0, 5, 1e9]) for (const depth of [0, 1, 1e9]) expect(moonRadius("lg", near, depth)).toBeLessThanOrEqual(MOON_MAX_R);
  });
});

describe("the clock", () => {
  test("the passed marks follow until and period, the hand sits at the last one, and a spent clock is full", () => {
    expect(tickState(1_060_000, 1_000_000, 60, 60, undefined)).toEqual({ passed: 0, hand: 270 });
    expect(tickState(1_030_000, 1_000_000, 60, 60, undefined).passed).toBe(30);
    expect(tickState(1_030_000, 1_000_000, 60, 60, undefined).hand).toBe(270 + 180);
    expect(tickState(900_000, 1_000_000, 60, 60, undefined).passed).toBe(60);
    expect(tickState(5_000_000, 1_000_000, 60, 60, undefined).passed).toBe(0);
  });
  test("without until, `passed` is the plugin's own number", () => {
    expect(tickState(undefined, 0, 60, 30, 12).passed).toBe(12);
    expect(tickState(undefined, 0, 60, 30, undefined).passed).toBe(0);
  });
  test("60 ticks are four paths: unlit, passed, the last eight lit, and every 15th longer", () => {
    const g = plane();
    const t = tickPaths(g, { id: "c", type: "ticks", count: 60, mark: 15, lit: 8, until: 1_030_000, period: 60 }, 1_000_000);
    // 30 passed: 15 and 30 are marks (0, 15), so of the 30 passed marks, 2 are long, 8 lit, 20 plain passed
    expect(count(t.lit, "M")).toBe(8);
    expect(count(t.mark, "M")).toBe(4);
    expect(count(t.passed, "M")).toBe(30 - 8 - 2);
    expect(count(t.unlit, "M")).toBe(60 - 30 - 2);
    expect(t.hand.startsWith("M")).toBe(true);
  });
});

describe("bands, edges, trails, brackets, hatch", () => {
  test("a gate of 30 sectors, 24 lit, is one path lit and one path unlit", () => {
    const b = bandPaths(plane(), { id: "g", type: "band", r0: 1.04, r1: 1.1, from: 270, to: 630, segments: 30, lit: 24 });
    expect(count(b.lit, "Z")).toBe(24);
    expect(count(b.unlit, "Z")).toBe(6);
    expect(count(b.outline, "Z")).toBe(1);
    expect(bandPaths(plane(), { id: "r", type: "band", r0: 0.3, r1: 0.4, from: 0, to: 360 }).lit).toBe("");
  });
  test("an open breaker cuts the orbit: nothing is drawn inside the gap, and its ends are marked", () => {
    const g = plane({ roll: 0 });
    const whole = edgePaths(g, 20, 120);
    const cut = edgePaths(g, 20, 120, 0.5, 0.2);
    expect(count(cut.near + cut.far, "M")).toBeLessThan(count(whole.near + whole.far, "M"));
    expect(count(cut.marks, "M")).toBe(2);
    expect(whole.marks).toBe("");
    // a point in the middle of the gap (angle 70) lies on no drawn segment's end
    const mid = onPlane(g, 1, 70);
    const nums = (cut.near + cut.far).match(/-?\d+(\.\d+)?/g)!.map(Number);
    const hit = nums.some((v, i) => i % 2 === 0 && Math.abs(v - mid.x) < 0.2 && Math.abs((nums[i + 1] ?? 0) - mid.y) < 0.2);
    expect(hit).toBe(false);
  });
  test("an edge that wraps past 0 is drawn clockwise the long way", () => {
    const e = edgePaths(plane(), 300, 60);
    expect(e.near + e.far).not.toBe("");
  });
  test("a trail is n slices fading from the moon backwards", () => {
    const s = trailSlices(plane(), 100, 40, 6);
    expect(s.length).toBe(6);
    expect(s[0]!.opacity).toBeGreaterThan(s[5]!.opacity);
    expect(s.every((x) => x.opacity > 0 && x.opacity <= 1)).toBe(true);
  });
  test("brackets are four corners in one path", () => {
    expect(count(bracketPath({ x: 50, y: 50 }, 8), "M")).toBe(4);
  });
  test("a hatch is one path, at most 80 lines, whatever the radius and gap", () => {
    expect(count(hatchPath({ x: 0, y: 0 }, 52, 8, 45), "M")).toBe(Math.ceil(104 / 8) + 1);
    expect(count(hatchPath({ x: 0, y: 0 }, 1e9, 6, 45), "M")).toBeLessThanOrEqual(81);
  });
});

describe("labels", () => {
  const seven = (): LabelIn[] => Array.from({ length: 7 }, (_, i) => {
    const p = onPlane(plane({ roll: -9 }), 1, (270 + i * 51.43) % 360);
    return { id: `s${i}`, x: p.x, y: p.y, r: 8, side: i === 0 || i === 4 ? "below" : p.x < 388 ? "left" : "right" };
  });
  const bounds = { w: 776, h: 412, left: 130, right: 646 };
  const overlap = (ys: number[]) => ys.sort((a, b) => a - b).some((y, i) => i > 0 && y - ys[i - 1]! < LABEL_H - 0.01);

  test("seven stations: no two labels in a column touch and none leaves the sheet", () => {
    const { labels } = labelLayout(seven(), bounds);
    for (const side of ["left", "right"] as const) expect(overlap(labels.filter((l) => l.side === side).map((l) => l.y))).toBe(false);
    for (const l of labels) { expect(l.y).toBeGreaterThanOrEqual(0); expect(l.y).toBeLessThanOrEqual(bounds.h); }
    expect(labels.length).toBe(7);
  });
  test("24 labels in one column cannot all fit: the rest are dropped and counted, never stacked", () => {
    const many: LabelIn[] = Array.from({ length: 24 }, (_, i) => ({ id: `m${i}`, x: 100, y: 20 + i * 15, r: 8, side: "left" }));
    const { labels, dropped } = labelLayout(many, bounds);
    expect(labels.length + dropped.left).toBe(24);
    expect(dropped.left).toBeGreaterThan(0);
    expect(overlap(labels.map((l) => l.y))).toBe(false);
  });
  test("the same input gives the same layout", () => {
    expect(labelLayout(seven(), bounds)).toEqual(labelLayout(seven(), bounds));
  });
});

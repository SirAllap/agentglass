/*
 * The arithmetic of a sheet. There is no renderer under `bun test`, so what a
 * screen decides (where an angle lands, which marks of the clock have passed,
 * that no two labels touch) is asserted here, on the numbers.
 */
import { describe, expect, test } from "bun:test";
import { MOON_MAX_R } from "../../shared/canvasSheet.ts";
import type { CanvasNode } from "../../shared/pluginCanvas.ts";
import {
  LABEL_H, VALUE_DROP, bandPaths, bracketPath, edgePaths, gaugeLit, hatchPath, labelLayout, moonRadius, needsClock, onPlane, planeGeom, tickPaths, tickState, trailSlices, type LabelIn,
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

describe("a ticks gauge on the clock", () => {
  test("lit marks follow until and period, so an elapsed gauge costs the plugin nothing while it runs", () => {
    const g = (extra: Record<string, unknown>) => ({ id: "g", type: "gauge", shape: "ticks", value: 5, max: 30, ...extra }) as CanvasNode;
    expect(gaugeLit(g({}), 0, 30)).toBe(5);
    expect(gaugeLit(g({ value: 99 }), 0, 30)).toBe(30);
    expect(gaugeLit(g({ until: 1_060_000, period: 60 }), 1_000_000, 30)).toBe(0);
    expect(gaugeLit(g({ until: 1_030_000, period: 60 }), 1_000_000, 30)).toBe(15);
    expect(gaugeLit(g({ until: 1_000_000, period: 60 }), 1_000_000, 30)).toBe(30);
    expect(gaugeLit(g({ until: 900_000, period: 60 }), 1_000_000, 30)).toBe(30);
    // until wins over value, as it does over `passed` on the sheet's ticks
    expect(gaugeLit(g({ value: 29, until: 1_060_000, period: 60 }), 1_000_000, 30)).toBe(0);
    // period defaults to 60 s, as on the sheet's ticks
    expect(gaugeLit(g({ until: 1_030_000 }), 1_000_000, 30)).toBe(15);
  });
});

const dock = await Bun.file(new URL("../src/components/plugins/CanvasDock.tsx", import.meta.url).pathname).text();
const sheetSrc = await Bun.file(new URL("../src/components/plugins/CanvasSheet.tsx", import.meta.url).pathname).text();
const canvas = await Bun.file(new URL("../src/components/plugins/PluginCanvas.tsx", import.meta.url).pathname).text();

describe("the dock and the flow view hand the clock to the glyph", () => {
  // No renderer under bun test: a rule about source is asserted against source.
  test("a ticks glyph lights its marks with gaugeLit, not with value alone", () => {
    const at = dock.indexOf('case "ticks": {');
    const body = dock.slice(at, dock.indexOf('case "segments"', at));
    expect(at).toBeGreaterThan(0);
    expect(body).toContain("gaugeLit(n, now, total)");
  });
  test("the dock and the flow view's gauge pass ctx.now to it", () => {
    expect(dock).toContain("now={ctx.now}");
    expect(canvas).toContain("now={now}");
    expect(canvas).toContain("now={ctx.now}");
  });
  test("a dock's value line is the time left when it has until, drawn by formatCountdown", () => {
    const at = dock.indexOf("export function Dock(");
    const body = dock.slice(at, dock.indexOf("export function Fold(", at));
    expect(at).toBeGreaterThan(0);
    expect(body).toContain("liveText(n.until, str(n.value), ctx.now)");
  });
  test("the sheet tells the layout whether a label has a value line, and draws that line VALUE_DROP under the name", () => {
    expect(sheetSrc).toContain("lines: str(m.n.value) ? 2 : 1");
    expect(sheetSrc).toContain("y={label.y + VALUE_DROP}");
  });
  test("a spark draws its cap as a dashed line on sparkCapY's height, and tells a screen reader there is a limit", () => {
    const at = canvas.indexOf('case "spark": {');
    const body = canvas.slice(at, canvas.indexOf('case "gauge":', at));
    expect(at).toBeGreaterThan(0);
    expect(body).toContain("sparkCapY(values, 24, cap)");
    expect(body).toContain("sparkPoints(values, 100, 24, cap)");
    expect(body).toContain("{capY !== undefined && <line data-spark-cap");
  });
  test("the 1 Hz ticker runs on needsClock, so a ticks gauge with until gets one", () => {
    expect(canvas).toContain("scene.some(needsClock)");
  });
});

describe("what asks for the 1 Hz clock", () => {
  test("only what counts to a time: a countdown, a clock's ticks, a ticks gauge with until", () => {
    const n = (o: Record<string, unknown>) => ({ id: "x", ...o }) as CanvasNode;
    expect(needsClock(n({ type: "countdown", until: 5 }))).toBe(true);
    expect(needsClock(n({ type: "ticks", count: 60, until: 5 }))).toBe(true);
    expect(needsClock(n({ type: "gauge", shape: "ticks", value: 0, max: 30, until: 5 }))).toBe(true);
    expect(needsClock(n({ type: "dock", title: "Gate", until: 5 }))).toBe(true);
    expect(needsClock(n({ type: "dock", title: "Gate", value: "5" }))).toBe(false);
    expect(needsClock(n({ type: "ticks", count: 60, passed: 3 }))).toBe(false);
    expect(needsClock(n({ type: "gauge", shape: "ticks", value: 3, max: 30 }))).toBe(false);
    expect(needsClock(n({ type: "label", text: "x" }))).toBe(false);
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
  test("an above label is the mirror of a below one: the same 10 unit leader, with its last line standing on it", () => {
    const at = { id: "top", x: 388, y: 120, r: 8 };
    const [below] = labelLayout([{ ...at, side: "below" }], bounds).labels;
    const [one] = labelLayout([{ ...at, side: "above", lines: 1 }], bounds).labels;
    const [two] = labelLayout([{ ...at, side: "above", lines: 2 }], bounds).labels;
    expect(one!.side).toBe("above");
    expect(one!.anchor).toBe("middle");
    // leader: from just over the moon's top edge to 10 units above that
    expect(one!.line).toBe("M388 111L388 101");
    expect(below!.line).toBe("M388 129L388 139");
    // the name of a one-line label: its baseline is 14 over the moon's top edge, as a below label's is 21 under its bottom edge less the text height
    expect(one!.y).toBe(120 - 8 - 14);
    // with a value under it, the name moves up one value line, so the value is where the single line was
    expect(two!.y).toBe(one!.y - VALUE_DROP);
    expect(two!.y + VALUE_DROP).toBe(one!.y);
    // never in a column: an above label takes no room from, and never counts toward, a margin
    expect(labelLayout([{ ...at, side: "above" }], bounds).dropped).toEqual({ left: 0, right: 0 });
  });
  test("an above label does not move the left and right columns", () => {
    const base = labelLayout(seven(), bounds).labels.filter((l) => l.side === "left" || l.side === "right");
    const withAbove = labelLayout([...seven(), { id: "top", x: 388, y: 120, r: 8, side: "above" }], bounds).labels.filter((l) => l.side === "left" || l.side === "right");
    expect(withAbove).toEqual(base);
  });
  test("the same input gives the same layout", () => {
    expect(labelLayout(seven(), bounds)).toEqual(labelLayout(seven(), bounds));
  });
});

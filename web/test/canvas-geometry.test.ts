/*
 * The arithmetic of a live canvas: where a wire runs, how a node rides it, what
 * shifts when a scene reorders, and how many motions may run at once. All pure,
 * called with numbers; and the motion controller, driven through a stand-in
 * for Element.animate so the rules it keeps (only transform and opacity, and
 * nothing at all under reduced motion) are read off what it asks for.
 */
import { describe, expect, test } from "bun:test";
import { CANVAS_LIMITS, effectiveMs, loopingIds, type CanvasScene } from "../../shared/pluginCanvas.ts";
import {
  PILE_MAX, TweenBudget, actionWithValue, arcPath, childrenIndex, clampGrow, easingCss, formatCountdown, fraction, parentsFirst,
  pathData, pathLength, pileSplit, planFlip, planTween, rectOrAncestor, liveText, routeEdge, sparkCapY, sparkPoints, travelFrames, type Rect,
} from "../src/lib/canvasGeometry.ts";
import { CanvasMotion } from "../src/lib/canvasMotion.ts";

const R = (x: number, y: number, w = 100, h = 40): Rect => ({ x, y, w, h });

/** Every segment of a route runs along one axis. */
const orthogonal = (pts: { x: number; y: number }[]) => pts.every((p, i) => i === 0 || p.x === pts[i - 1]!.x || p.y === pts[i - 1]!.y);

describe("routeEdge", () => {
  test("side by side with rows in common: one straight horizontal line through what they share", () => {
    const r = routeEdge(R(0, 0), R(200, 10));
    expect(r).toEqual([{ x: 100, y: 25 }, { x: 200, y: 25 }]);
  });

  test("stacked with columns in common: one straight vertical line", () => {
    const r = routeEdge(R(0, 0), R(20, 120));
    expect(r).toEqual([{ x: 60, y: 40 }, { x: 60, y: 120 }]);
  });

  test("diagonal, more apart across than down: leaves the side, bends half way, arrives at the side", () => {
    const r = routeEdge(R(0, 0), R(300, 100));
    expect(r).toEqual([{ x: 100, y: 20 }, { x: 200, y: 20 }, { x: 200, y: 120 }, { x: 300, y: 120 }]);
    expect(orthogonal(r)).toBe(true);
  });

  test("diagonal, more apart down than across: leaves the bottom, bends half way, arrives at the top", () => {
    const r = routeEdge(R(0, 0), R(140, 300));
    expect(r).toEqual([{ x: 50, y: 40 }, { x: 50, y: 170 }, { x: 190, y: 170 }, { x: 190, y: 300 }]);
    expect(orthogonal(r)).toBe(true);
  });

  test("the target left of the source is the same rule mirrored", () => {
    expect(routeEdge(R(200, 10), R(0, 0))).toEqual([{ x: 200, y: 25 }, { x: 100, y: 25 }]);
    const r = routeEdge(R(300, 100), R(0, 0));
    expect(r[0]).toEqual({ x: 300, y: 120 });
    expect(r.at(-1)).toEqual({ x: 100, y: 20 });
    expect(orthogonal(r)).toBe(true);
  });

  test("the target above the source leaves the top and arrives at the bottom", () => {
    const r = routeEdge(R(0, 200), R(10, 0));
    expect(r).toEqual([{ x: 55, y: 200 }, { x: 55, y: 40 }]);
  });

  test("overlapping or touching boxes have no gap to run in: one bend between the centres", () => {
    const r = routeEdge(R(0, 0), R(50, 20));
    expect(r).toEqual([{ x: 50, y: 20 }, { x: 100, y: 20 }, { x: 100, y: 40 }]);
    expect(orthogonal(r)).toBe(true);
    // Touching side by side with the same rows is the degenerate one: no NaN, no repeats.
    const t = routeEdge(R(0, 0), R(100, 0));
    expect(t.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    expect(t.every((p, i) => i === 0 || p.x !== t[i - 1]!.x || p.y !== t[i - 1]!.y)).toBe(true);
  });

  test("the same two boxes always give the same route", () => {
    const a = R(13.5, 7.25), b = R(311, 92.75, 64, 28);
    expect(routeEdge(a, b)).toEqual(routeEdge(a, b));
    expect(pathData(routeEdge(a, b))).toBe(pathData(routeEdge({ ...a }, { ...b })));
  });

  test("pathData is numbers only", () => {
    expect(pathData([{ x: 1, y: 2 }, { x: 3.14159, y: 4 }])).toBe("M1.0 2.0 L3.1 4.0");
    expect(pathLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 10 }])).toBe(11);
  });
});

describe("travelFrames", () => {
  test("one frame per waypoint spaced by distance, ending on the identity", () => {
    const f = travelFrames([{ x: 0, y: 0 }, { x: 100, y: 0 }], { x: 100, y: 100 });
    expect(f.map((x) => x.offset)).toEqual([0, 0.5, 1]);
    expect(f[0]).toMatchObject({ dx: -100, dy: -100 });
    expect(f.at(-1)).toMatchObject({ offset: 1, dx: 0, dy: 0 });
  });

  test("a route that already ends where the node lands has a zero-length last leg without dividing by zero", () => {
    const f = travelFrames([{ x: 0, y: 0 }, { x: 10, y: 0 }], { x: 10, y: 0 });
    expect(f.map((x) => x.offset)).toEqual([0, 1, 1]);
    const still = travelFrames([{ x: 5, y: 5 }], { x: 5, y: 5 });
    expect(still.every((x) => Number.isFinite(x.offset))).toBe(true);
    expect(still.at(-1)!.offset).toBe(1);
  });
});

describe("planFlip", () => {
  const before = new Map<string, Rect>([["a", R(0, 0)], ["b", R(0, 50)], ["c", R(0, 100)]]);
  const parentless = () => undefined;

  test("what moved gets the offset that puts it back where it was", () => {
    const after = new Map<string, Rect>([["a", R(0, 0)], ["b", R(0, 100)], ["c", R(0, 50)]]);
    const s = planFlip(before, after, ["a", "b", "c"], parentless, new Set(), () => true);
    expect(s).toEqual([{ id: "b", dx: 0, dy: -50 }, { id: "c", dx: 0, dy: 50 }]);
  });

  test("less than half a pixel is not a move", () => {
    const after = new Map<string, Rect>([["a", R(0.3, 0)], ["b", R(0, 50)], ["c", R(0, 100)]]);
    expect(planFlip(before, after, ["a", "b", "c"], parentless, new Set(), () => true)).toEqual([]);
  });

  test("a node with no old position (just added) or one that rides a wire is left alone", () => {
    const after = new Map<string, Rect>([["a", R(0, 40)], ["b", R(0, 90)], ["c", R(0, 100)], ["n", R(0, 10)]]);
    const s = planFlip(before, after, ["a", "b", "c", "n"], parentless, new Set(["b"]), () => true);
    expect(s.map((x) => x.id)).toEqual(["a"]);
  });

  test("a child inside a parent that moved is carried by it, so only the difference is its own", () => {
    const b = new Map<string, Rect>([["p", R(0, 0, 200, 100)], ["k", R(10, 10)]]);
    const a = new Map<string, Rect>([["p", R(0, 60, 200, 100)], ["k", R(10, 70)]]);
    const same = planFlip(b, a, ["p", "k"], (id) => (id === "k" ? "p" : undefined), new Set(), () => true);
    expect(same).toEqual([{ id: "p", dx: 0, dy: -60 }]);
    // The child also moved 20px inside the parent: its own offset is that 20, not 80.
    const a2 = new Map<string, Rect>([["p", R(0, 60, 200, 100)], ["k", R(10, 90)]]);
    const own = planFlip(b, a2, ["p", "k"], (id) => (id === "k" ? "p" : undefined), new Set(), () => true);
    expect(own).toEqual([{ id: "p", dx: 0, dy: -60 }, { id: "k", dx: 0, dy: -20 }]);
  });

  test("a node the budget refuses stays where it landed, and what is inside it is then measured from the world", () => {
    const b = new Map<string, Rect>([["p", R(0, 0, 200, 100)], ["k", R(10, 10)]]);
    const a = new Map<string, Rect>([["p", R(0, 60, 200, 100)], ["k", R(10, 70)]]);
    const s = planFlip(b, a, ["p", "k"], (id) => (id === "k" ? "p" : undefined), new Set(), (() => { let first = true; return () => (first ? ((first = false), false) : true); })());
    expect(s).toEqual([{ id: "k", dx: 0, dy: -60 }]);
  });

  test("the grant is asked once per node that would animate, parents first", () => {
    const after = new Map<string, Rect>([["a", R(0, 10)], ["b", R(0, 60)], ["c", R(0, 100)]]);
    let asked = 0;
    planFlip(before, after, ["a", "b", "c"], parentless, new Set(), () => { asked++; return true; });
    expect(asked).toBe(2);
  });
});

describe("the tween cap and reduced motion", () => {
  test("planTween grants a duration and holds a slot until it is released", () => {
    const b = new TweenBudget(2);
    expect(planTween(b, undefined, 180, false, false)).toBe(180);
    expect(planTween(b, 500, 180, false, false)).toBe(500);
    expect(b.running).toBe(2);
    expect(planTween(b, 500, 180, false, false)).toBe(0);
    b.release();
    expect(planTween(b, 500, 180, false, false)).toBe(500);
  });

  test("the window's cap is the contract's", () => {
    expect(new TweenBudget().cap).toBe(CANVAS_LIMITS.tweens);
    const b = new TweenBudget();
    let granted = 0;
    for (let i = 0; i < CANVAS_LIMITS.tweens + 10; i++) if (planTween(b, 100, 100, false, false) > 0) granted++;
    expect(granted).toBe(CANVAS_LIMITS.tweens);
  });

  test("reduced motion and a hidden canvas answer 0 and take no slot; a plugin's own 0 does too", () => {
    const b = new TweenBudget(1);
    expect(planTween(b, 800, 180, true, false)).toBe(0);
    expect(planTween(b, 800, 180, false, true)).toBe(0);
    expect(planTween(b, 0, 180, false, false)).toBe(0);
    expect(b.running).toBe(0);
  });

  test("a duration is never longer than the contract allows", () => {
    expect(planTween(new TweenBudget(), 9_999, 180, false, false)).toBe(CANVAS_LIMITS.ms);
    expect(effectiveMs(9_999, 180, true)).toBe(0);
  });

  test("under reduced motion nothing loops, whatever the scene asks for", () => {
    const scene: CanvasScene = [
      { id: "w", type: "edge", from: "a", to: "b", activity: "flowing" },
      { id: "t", type: "token", label: "x", activity: "busy" },
    ];
    expect([...loopingIds(scene, false)]).toEqual(["w", "t"]);
    expect([...loopingIds(scene, true)]).toEqual([]);
  });

  test("named curves are a table and anything else is `ease`", () => {
    expect(easingCss("spring")).toBe("cubic-bezier(.34,1.56,.64,1)");
    expect(easingCss("linear")).toBe("linear");
    for (const bad of ["cubic-bezier(9,9,9,9)", "constructor", "__proto__", undefined, 7]) expect(easingCss(bad)).toBe("ease");
  });
});

/** A stand-in for Element.animate that records what was asked and lets a test finish or cancel it. */
function fakeEl() {
  const calls: { frames: Record<string, unknown>[]; opts: Record<string, unknown> }[] = [];
  const anims: FakeAnim[] = [];
  const el = {
    animate(frames: Record<string, unknown>[], opts: Record<string, unknown>) {
      calls.push({ frames, opts });
      const a = new FakeAnim();
      anims.push(a);
      return a;
    },
  };
  return { el: el as unknown as Element, calls, anims };
}
class FakeAnim {
  playState = "running";
  onfinish: (() => void) | null = null;
  oncancel: (() => void) | null = null;
  pause() { this.playState = "paused"; }
  play() { this.playState = "running"; }
  cancel() { this.playState = "idle"; this.oncancel?.(); }
  finish() { this.playState = "finished"; this.onfinish?.(); }
}

describe("CanvasMotion", () => {
  const ALLOWED = new Set(["opacity", "transform", "offset"]);

  test("every motion animates transform and opacity and nothing else", () => {
    const m = new CanvasMotion();
    const f = fakeEl();
    m.enter(f.el);
    m.pulse(f.el, 100);
    m.fadeOut(f.el);
    m.shift(f.el, 5, 7);
    m.travel(f.el, [{ x: 0, y: 0 }, { x: 50, y: 0 }], { x: 50, y: 50 }, undefined, "spring");
    expect(f.calls.length).toBeGreaterThanOrEqual(5);
    for (const c of f.calls) for (const frame of c.frames) expect(Object.keys(frame).filter((k) => !ALLOWED.has(k))).toEqual([]);
  });

  test("a node faded out and then removed is not kept alive: what is held follows what is in the page", () => {
    const m = new CanvasMotion();
    const gone: ReturnType<typeof fakeEl>[] = [];
    for (let i = 0; i < 50; i++) { const f = fakeEl(); m.fadeOut(f.el); gone.push(f); }
    expect(m.heldCount()).toBe(50);
    for (const f of gone) (f.el as { isConnected: boolean }).isConnected = false;
    m.fadeOut(fakeEl().el);
    expect(m.heldCount()).toBe(1);
  });

  test("an enter is 180ms; a pulse is never faster than 3 Hz whatever it is asked", () => {
    const m = new CanvasMotion();
    const f = fakeEl();
    m.enter(f.el);
    m.pulse(f.el, 50);
    expect(f.calls[0]!.opts.duration).toBe(180);
    expect(f.calls[1]!.opts.duration as number).toBeGreaterThanOrEqual(1000 / 3);
  });

  test("reduced motion starts nothing, and turning it on stops what runs", () => {
    const m = new CanvasMotion();
    const f = fakeEl();
    m.enter(f.el);
    expect(m.budget.running).toBe(1);
    m.reduced = true;
    m.cancelAll();
    expect(f.anims[0]!.playState).toBe("idle");
    expect(m.budget.running).toBe(0);
    m.enter(f.el);
    m.pulse(f.el);
    m.travel(f.el, [{ x: 0, y: 0 }, { x: 5, y: 5 }], { x: 5, y: 5 }, 400, undefined);
    expect(f.calls).toHaveLength(1);
  });

  test("a canvas nobody can see starts nothing and pauses what runs; seeing it again resumes", () => {
    const m = new CanvasMotion();
    const f = fakeEl();
    m.enter(f.el);
    m.setPaused(true);
    expect(f.anims[0]!.playState).toBe("paused");
    m.enter(f.el);
    expect(f.calls).toHaveLength(1);
    m.setPaused(false);
    expect(f.anims[0]!.playState).toBe("running");
  });

  test("past the cap a motion is not queued: it is skipped, and finishing frees a slot", () => {
    const m = new CanvasMotion();
    const f = fakeEl();
    for (let i = 0; i < CANVAS_LIMITS.tweens + 5; i++) m.enter(f.el);
    expect(f.calls).toHaveLength(CANVAS_LIMITS.tweens);
    f.anims[0]!.finish();
    m.enter(f.el);
    expect(f.calls).toHaveLength(CANVAS_LIMITS.tweens + 1);
  });

  test("a motion whose clock never runs is ended by hand, so it cannot hold a slot for good", async () => {
    const m = new CanvasMotion();
    const f = fakeEl();
    m.enter(f.el);
    expect(m.budget.running).toBe(1);
    await new Promise((r) => setTimeout(r, 750));
    expect(f.anims[0]!.playState).toBe("finished");
    expect(m.budget.running).toBe(0);
  });

  test("flow marks loop only when allowed, start over when the wire moves, and stop when it stops flowing", () => {
    const m = new CanvasMotion();
    const f = fakeEl();
    const route = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    m.syncFlows(new Map([[f.el, { route, delay: 0 }]]));
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.opts.iterations).toBe(Infinity);
    for (const frame of f.calls[0]!.frames) expect(Object.keys(frame).filter((k) => !ALLOWED.has(k))).toEqual([]);
    m.syncFlows(new Map([[f.el, { route, delay: 0 }]]));
    expect(f.calls).toHaveLength(1);
    m.syncFlows(new Map([[f.el, { route: [{ x: 0, y: 0 }, { x: 100, y: 50 }], delay: 0 }]]));
    expect(f.calls).toHaveLength(2);
    expect(f.anims[0]!.playState).toBe("idle");
    m.syncFlows(new Map());
    expect(f.anims[1]!.playState).toBe("idle");
    m.reduced = true;
    m.syncFlows(new Map([[f.el, { route, delay: 0 }]]));
    expect(f.calls).toHaveLength(2);
  });
});

describe("the scene as a tree", () => {
  const scene: CanvasScene = [
    { id: "late", type: "token", parent: "lane", label: "b" },
    { id: "lane", type: "lane", title: "L" },
    { id: "w", type: "edge", from: "lane", to: "late" },
    { id: "first", type: "token", parent: "lane", label: "a" },
    { id: "top", type: "label", text: "t" },
  ];

  test("children by parent keep scene order, and edges are not children", () => {
    const k = childrenIndex(scene);
    expect(k.get("lane")!.map((n) => n.id)).toEqual(["late", "first"]);
    expect(k.get(undefined)!.map((n) => n.id)).toEqual(["lane", "top"]);
    expect([...k.values()].flat().some((n) => n.type === "edge")).toBe(false);
  });

  test("parents come before their children whatever order the flat list has", () => {
    expect(parentsFirst(scene)).toEqual(["lane", "late", "first", "top"]);
  });

  test("a wire to something not drawn ends at the nearest box around it", () => {
    const rects = new Map<string, Rect>([["lane", R(0, 0, 300, 200)]]);
    const parentOf = (id: string) => (id === "hidden" ? "lane" : undefined);
    expect(rectOrAncestor("hidden", rects, parentOf)).toEqual(R(0, 0, 300, 200));
    expect(rectOrAncestor("lane", rects, parentOf)).toEqual(R(0, 0, 300, 200));
    expect(rectOrAncestor("nowhere", rects, parentOf)).toBeUndefined();
    // A parent loop in a hostile scene ends instead of spinning.
    expect(rectOrAncestor("a", new Map(), (id) => (id === "a" ? "b" : "a"))).toBeUndefined();
  });

  test("a pile shows its first few and counts the rest", () => {
    expect(PILE_MAX).toBe(4);
    expect(pileSplit([1, 2, 3])).toEqual({ shown: [1, 2, 3], hidden: 0 });
    expect(pileSplit([1, 2, 3, 4, 5, 6, 7])).toEqual({ shown: [1, 2, 3, 4], hidden: 3 });
  });

  test("grow is clamped to 1-4 and anything that is not a number is nothing", () => {
    expect([clampGrow(2), clampGrow(9), clampGrow(0), clampGrow(-3), clampGrow(2.9)]).toEqual([2, 4, 1, 1, 2]);
    expect([clampGrow("3"), clampGrow(NaN), clampGrow(Infinity), clampGrow(undefined)]).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe("small drawings", () => {
  test("a countdown reads mm:ss, rounds up, never goes negative and passes an hour without wrapping", () => {
    expect(formatCountdown(65_000, 0)).toBe("01:05");
    expect(formatCountdown(1_500, 0)).toBe("00:02");
    expect(formatCountdown(0, 5_000)).toBe("00:00");
    expect(formatCountdown(75 * 60_000, 0)).toBe("75:00");
  });

  test("a sparkline fills its box, and a flat or single series does not divide by zero", () => {
    expect(sparkPoints([0, 10], 100, 20)).toBe("0.0,20.0 100.0,0.0");
    expect(sparkPoints([5, 5, 5], 100, 20)).toBe("0.0,10.0 50.0,10.0 100.0,10.0");
    expect(sparkPoints([7], 100, 20)).toBe("50.0,10.0");
    expect(sparkPoints([], 100, 20)).toBe("");
  });
  test("a cap above the series is part of the scale: the series stays under the line", () => {
    expect(sparkPoints([0, 10], 100, 20, 20)).toBe("0.0,20.0 100.0,10.0");
    expect(sparkCapY([0, 10], 20, 20)).toBe(0);
  });
  test("a cap under the series pulls the low end of the scale down to itself", () => {
    expect(sparkCapY([5, 10], 20, 0)).toBe(20);
    expect(sparkPoints([5, 10], 100, 20, 0)).toBe("0.0,10.0 100.0,0.0");
  });
  test("a cap inside the range changes no point and sits at its own height; no cap changes nothing", () => {
    expect(sparkPoints([0, 10], 100, 20, 5)).toBe(sparkPoints([0, 10], 100, 20));
    expect(sparkCapY([0, 10], 20, 5)).toBe(10);
    expect(sparkPoints([0, 10], 100, 20, undefined)).toBe("0.0,20.0 100.0,0.0");
  });
  test("a flat series on its cap, and a cap with nothing to compare, draw through the middle", () => {
    expect(sparkCapY([5, 5], 20, 5)).toBe(10);
    expect(sparkCapY([], 20, 5)).toBe(10);
  });
  test("a line is the time left with an until, and its own text without", () => {
    expect(liveText(1_090_000, "9", 1_000_000)).toBe("01:30");
    expect(liveText(undefined, "9", 1_000_000)).toBe("9");
    expect(liveText("soon", undefined, 1_000_000)).toBeUndefined();
  });

  test("a gauge fraction is in [0, 1] and a bad pair is empty", () => {
    expect([fraction(5, 10), fraction(50, 10), fraction(-1, 10), fraction(1, 0), fraction(NaN, 5), fraction("1", 2)]).toEqual([0.5, 1, 0, 0, 0, 0]);
    expect(arcPath(30, 30, 20, -135, 135)).toMatch(/^M[\d. ]+ A20 20 0 1 1 [\d. ]+$/);
  });

  test("a segmented control's value is merged into the action's payload, and a payload that is not an object is replaced", () => {
    expect(actionWithValue({ id: "mode" }, "fast")).toEqual({ id: "mode", payload: { value: "fast" } });
    expect(actionWithValue({ id: "mode", payload: { lane: "gate" } }, "fast")).toEqual({ id: "mode", payload: { lane: "gate", value: "fast" } });
    expect(actionWithValue({ id: "mode", payload: { value: "old" } }, "new").payload).toEqual({ value: "new" });
    expect(actionWithValue({ id: "mode", payload: [1, 2] }, "x").payload).toEqual({ value: "x" });
    expect(actionWithValue({ id: "mode", payload: "s" }, "x").payload).toEqual({ value: "x" });
  });
});

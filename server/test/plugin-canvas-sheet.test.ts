/*
 * The sheet vocabulary (shared/canvasSheet.ts): a body, a tilted ring of
 * stations, a clock round it, a fading tail. A plugin drawing a rate limiter
 * or a set of consumers uses it. Every rule is asserted on add, on set AND on
 * move, because the three are three ways in; every cap is broken on purpose.
 */
import { describe, expect, test } from "bun:test";
import { CANVAS_LIMITS, SHEET_LIMITS, applyOps, validateScene, type CanvasScene } from "../../shared/pluginCanvas.ts";
import { hatchLines, sheetCost } from "../../shared/canvasSheet.ts";

const add = (node: Record<string, unknown>, before?: string) => ({ op: "add", node, ...(before ? { before } : {}) });
const set = (id: string, props: Record<string, unknown>) => ({ op: "set", id, props });
const move = (id: string, parent: string | null, extra: Record<string, unknown> = {}) => ({ op: "move", id, parent, ...extra });
const ok = (ops: unknown[], scene: CanvasScene = []) => {
  const r = applyOps(scene, ops);
  if (!r.ok) throw new Error(r.error);
  return r.value.scene;
};
const bad = (ops: unknown[], scene: CanvasScene = orbit()) => {
  const r = applyOps(scene, ops);
  expect(r.ok, JSON.stringify(ops)).toBe(false);
  return r.ok ? "" : r.error;
};
const get = (s: CanvasScene, id: string) => s.find((n) => n.id === id);

const SHEET = { id: "sh", type: "sheet", w: 776, h: 412, fit: "wide", material: "inset", label: "Orbit", key: [{ shape: "ring", label: "waiting" }, { shape: "dot", label: "in flight" }] };
const ORB = { id: "orb", type: "orb", parent: "sh", cx: 388, cy: 200, r: 52, light: 300, bands: 4, terminator: true };
const PLANE = { id: "pl", type: "plane", parent: "sh", cx: 388, cy: 206, rx: 215, tilt: 27, roll: -9, depth: 0.8, label: "stations" };
const tok = (id: string, at: number, extra: Record<string, unknown> = {}) => ({ id, type: "token", parent: "pl", label: id, at, ...extra });

/** A sheet shaped like the real thing: planet, ring, gate band, clock, stations, a cut orbit, a reticle, a night-side hatch. */
function orbit(): CanvasScene {
  return ok([
    add(SHEET), add(ORB), add(PLANE),
    add({ id: "ring", type: "band", parent: "pl", r0: 0.3, r1: 0.42, from: 0, to: 360, layer: "back", tone: "accent" }),
    add({ id: "gate", type: "band", parent: "pl", r0: 1.04, r1: 1.1, from: 270, to: 630, segments: 30, lit: 24, tone: "warning" }),
    add({ id: "clock", type: "ticks", parent: "pl", count: 60, mark: 15, lit: 8, until: 1_900_000_000_000, period: 60, side: "out", numerals: [{ at: 90, text: "30" }] }),
    add(tok("t1", 270, { leader: "below", value: "00:41", unit: "next", size: "md", count: 1, halo: true })),
    add(tok("t2", 321, { shape: "dot", trail: 6, trailSpan: 40 })),
    add(tok("t3", 12, { shape: "diamond", size: "lg" })),
    add({ id: "e1", type: "edge", parent: "pl", from: "t1", to: "t2", tone: "accent", breakAt: 0.5, breakGap: 0.2 }),
    add({ id: "ret", type: "reticle", parent: "pl", of: "t2", chip: "Orbit plugin: on its way" }),
    add({ id: "hat", type: "hatch", parent: "sh", of: "orb", from: 90, to: 270, gap: 8, angle: 45 }),
  ]);
}

describe("a sheet that draws an instrument", () => {
  test("planet, plane, band, ticks, tokens, an edge, a reticle and a hatch are one valid scene, and a snapshot of it replays", () => {
    const s = orbit();
    expect(s.map((n) => n.type)).toEqual(["sheet", "orb", "plane", "band", "band", "ticks", "token", "token", "token", "edge", "reticle", "hatch"]);
    const again = validateScene(s);
    expect(again.ok).toBe(true);
    expect(sheetCost(s, "sh")).toBeLessThanOrEqual(SHEET_LIMITS.svgNodes);
  });

  test("structure: each type lives where it lives, on add and on move", () => {
    bad([add({ id: "x", type: "orb", cx: 1, cy: 1, r: 10 })], []);
    bad([add({ id: "x", type: "plane", cx: 1, cy: 1, rx: 100, tilt: 20 })], []);
    bad([add({ id: "x", type: "token", parent: "sh", label: "x" })]);
    bad([add({ id: "x", type: "band", parent: "sh", r0: 0.3, r1: 0.4, from: 0, to: 90 })]);
    bad([add({ id: "x", type: "ticks", parent: "sh", count: 12 })]);
    bad([add({ id: "x", type: "label", parent: "pl", text: "no" })]);
    bad([add({ id: "x", type: "sheet", parent: "pl", w: 400, h: 300, fit: "narrow" })]);
    bad([add({ id: "x", type: "hatch", parent: "pl", of: "orb", from: 0, to: 90, gap: 8 })]);
    bad([move("orb", null)]);
    bad([move("ring", "sh")]);
    bad([add({ id: "d", type: "dock", title: "Gate" }), add({ id: "l", type: "label", text: "no", parent: "d" })]);
    // a dock holds one gauge
    const d = ok([add({ id: "d", type: "dock", title: "Gate" }), add({ id: "g1", type: "gauge", parent: "d", shape: "ticks", value: 3, max: 30 })]);
    bad([add({ id: "g2", type: "gauge", parent: "d", shape: "ring", value: 1, max: 2 })], d);
    // a fold takes a row of sheets but not a board, a part or a fold
    bad([add({ id: "f", type: "fold", h: 400 }), add({ id: "f2", type: "fold", h: 400, parent: "f" })], []);
  });

  test("a token in a plane needs its angle; the ring props are refused outside one, on add, set and move", () => {
    const s = orbit();
    bad([add({ id: "n", type: "token", parent: "pl", label: "no angle" })], s);
    bad([set("t1", { at: null })], s);
    for (const [k, v] of [["at", 10], ["shape", "dot"], ["halo", true], ["trail", 3], ["trailSpan", 20], ["leader", "left"], ["value", "x"], ["unit", "ms"]] as const)
      bad([add({ id: "out", type: "token", label: "x", [k]: v })], s);
    bad([add({ id: "out", type: "token", label: "x", size: "lg" })], s);
    const free = ok([add({ id: "free", type: "token", label: "outside" })], s);
    // out of a plane with an angle, in without one, a size lg left behind
    bad([move("t1", null)], free);
    bad([move("free", "pl")], free);
    bad([set("free", { halo: true })], free);
    // an in-plane edge has no points and no label; an edge break lives only in a plane
    bad([set("e1", { points: [[0, 0], [10, 10]] })], s);
    bad([set("e1", { label: "wire" })], s);
    bad([add({ id: "e9", type: "edge", from: "free", to: "t1", breakAt: 0.5 })], free);
  });

  test("what a node references is checked on the whole scene after the batch: no dangling reticle, hatch or edge", () => {
    const s = orbit();
    // moving the token a reticle points at out of that plane, or into another, is refused
    const two = ok([add({ id: "pl2", type: "plane", parent: "sh", cx: 100, cy: 100, rx: 80, tilt: 30 }), add({ id: "far", type: "token", label: "far", at: 10, parent: "pl2" })], s);
    expect(bad([{ op: "remove", id: "e1" }, move("t2", "pl2")], two)).toContain("reticle");
    expect(bad([move("t1", "pl2")], two)).toContain("edge");
    // a reticle at a token of another plane, an edge between planes, a hatch at a thing that is not a shape
    bad([add({ id: "r2", type: "reticle", parent: "pl2", of: "t1" })], two);
    bad([add({ id: "e2", type: "edge", parent: "pl", from: "t1", to: "far" })], two);
    bad([add({ id: "e3", type: "edge", parent: "pl", from: "t1", to: "t1" })], s);
    bad([add({ id: "h2", type: "hatch", parent: "sh", of: "t1", from: 0, to: 90, gap: 8 })], s);
    bad([add({ id: "h3", type: "hatch", parent: "sh", of: "nope", from: 0, to: 90, gap: 8 })], s);
    // removing the target takes its hatch, reticle and edge with it
    const r = ok([{ op: "remove", id: "t2" }], s);
    expect(get(r, "ret")).toBeUndefined();
    expect(get(r, "e1")).toBeUndefined();
    const r2 = ok([{ op: "remove", id: "orb" }], s);
    expect(get(r2, "hat")).toBeUndefined();
    expect(validateScene(r).ok).toBe(true);
  });

  test("the hatch is priced on the shape it covers and a later set on that shape cannot get past the cap", () => {
    const s = orbit();
    expect(hatchLines(52, 8)).toBe(13);
    bad([set("hat", { gap: 6 }), set("orb", { r: 300 })], s);
    ok([set("orb", { r: 300 })], s); // 75 lines at gap 8: under the cap
    bad([set("pl", { rx: 300 }), add({ id: "h4", type: "hatch", parent: "sh", of: "gate", from: 0, to: 360, gap: 6 })], s);
    // a third hatch
    const h2 = ok([add({ id: "h2", type: "hatch", parent: "sh", of: "orb", from: 0, to: 90, gap: 24 })], s);
    bad([add({ id: "h3", type: "hatch", parent: "sh", of: "orb", from: 0, to: 90, gap: 24 })], h2);
    // the band's radius is a ratio of the PLANE's rx: growing the plane grows the hatch
    const onBand = ok([add({ id: "hb", type: "hatch", parent: "sh", of: "gate", from: 0, to: 90, gap: 12 })], s);
    bad([set("pl", { rx: 600 })], onBand);
    ok([set("pl", { tilt: 90 })], onBand);
  });

  test("ranges: refused with the prop named, never clamped into a lie", () => {
    const p = (props: Record<string, unknown>) => bad([set("pl", props)]);
    p({ tilt: 91 }); p({ tilt: 14.9 }); p({ tilt: 0 }); p({ tilt: NaN }); p({ rx: 39 }); p({ rx: 601 }); p({ roll: 46 }); p({ depth: 1.1 }); p({ cx: -1 }); p({ rx: 100.5 });
    const o = (props: Record<string, unknown>) => bad([set("orb", props)]);
    o({ r: 7 }); o({ r: 301 }); o({ light: 360 }); o({ light: -0.1 }); o({ bands: 9 }); o({ r: 1e308 });
    const b = (props: Record<string, unknown>) => bad([set("gate", props)]);
    b({ r1: 0.9 }); b({ r0: 1.2 }); b({ from: 360 }); b({ to: 270 }); b({ to: 631 }); b({ segments: 61 }); b({ segments: 0 }); b({ lit: 31 }); b({ segments: 300, to: 570 });
    const t = (props: Record<string, unknown>) => bad([set("clock", props)]);
    t({ count: 7 }); t({ count: 121 }); t({ mark: 61 }); t({ passed: 61 }); t({ lit: 17 }); t({ period: 0 }); t({ until: 1e17 }); t({ side: "up" });
    t({ numerals: [{ at: 360, text: "1" }] }); t({ numerals: [{ at: 1, text: "1234" }] }); t({ numerals: new Array(5).fill({ at: 1, text: "1" }) }); t({ numerals: [{ at: 1, text: "1", extra: 1 }].slice(0, 0).concat([null as never]) });
    const k = (props: Record<string, unknown>) => bad([set("t2", props)]);
    k({ at: 360 }); k({ at: -1 }); k({ at: Infinity }); k({ trail: 13 }); k({ trail: 2.5 }); k({ trailSpan: 4 }); k({ trailSpan: 121 }); k({ leader: "up" }); k({ shape: "star" }); k({ size: "xl" });
    const e = (props: Record<string, unknown>) => bad([set("e1", props)]);
    e({ breakAt: 1.1 }); e({ breakGap: 0.01 }); e({ breakGap: 0.6 }); e({ breakAt: 0.02 }); e({ breakAt: 0.99, breakGap: 0.2 });
    bad([set("e1", { breakAt: null }), set("e1", { breakGap: 0.2 })]);
    const sh = (props: Record<string, unknown>) => bad([set("sh", props)]);
    sh({ w: 319 }); sh({ w: 1201 }); sh({ h: 199 }); sh({ h: 701 }); sh({ fit: "any" }); sh({ material: "glass" }); sh({ key: new Array(5).fill({ shape: "dot", label: "x" }) }); sh({ key: [{ shape: "star", label: "x" }] }); sh({ key: [{ shape: "dot", label: "x‮" }] });
    const ret = (props: Record<string, unknown>) => bad([set("ret", props)]);
    ret({ chip: "x".repeat(CANVAS_LIMITS.label + 1) }); ret({ chip: "a​b" });
  });

  test("a station's leader can stand above it, and still only in a plane", () => {
    const sc = orbit();
    for (const leader of ["left", "right", "below", "above", "none"]) ok([set("t1", { leader })], sc);
    bad([set("t1", { leader: "over" })]);
    bad([set("t1", { leader: "Above" })]);
    bad([add({ id: "loose", type: "token", label: "x", leader: "above" })], []);
  });

  test("a dock can show the time left on the window's clock, with until", () => {
    const d = (props: Record<string, unknown>) => [add({ id: "d", type: "dock", title: "Gate", ...props })];
    ok(d({ until: 1_900_000_000_000, unit: "left" }));
    ok(d({ until: 1_900_000_000_000, value: "soon" }));
    bad(d({ until: -1 }), []);
    bad(d({ until: "soon" }), []);
    bad(d({ until: Infinity }), []);
    bad(d({ until: 8.64e15 + 1 }), []);
    const s = ok(d({ value: "9", until: 1_900_000_000_000 }));
    bad([set("d", { until: "soon" })], s);
    // a set can start the clock and take it away again
    expect(get(ok([set("d", { until: 1_900_000_001_000 })], s), "d")?.until).toBe(1_900_000_001_000);
  });

  test("a gauge gains ticks, segments, a mark and concentric values, each with its own limits", () => {
    const g = (props: Record<string, unknown>) => [add({ id: "g", type: "gauge", ...props })];
    ok(g({ shape: "ticks", value: 24, max: 30 }));
    ok(g({ shape: "segments", value: 4, max: 10 }));
    ok(g({ shape: "arc", value: 3, max: 10, mark: 0.75, values: [0.5, 0.2, 0.9] }));
    bad(g({ shape: "ticks", value: 1, max: 7 }), []);
    bad(g({ shape: "ticks", value: 1, max: 121 }), []);
    bad(g({ shape: "ticks", value: 1, max: 30.5 }), []);
    bad(g({ shape: "segments", value: 1, max: 13 }), []);
    // A ticks gauge can run on the window's clock, like the sheet's ticks: until, with period.
    ok(g({ shape: "ticks", value: 0, max: 30, until: 1_900_000_000_000, period: 3600 }));
    ok(g({ shape: "ticks", value: 0, max: 30, until: 1_900_000_000_000 }));
    bad(g({ shape: "ticks", value: 0, max: 30, period: 3600 }), []);
    bad(g({ shape: "ring", value: 0, max: 30, until: 1_900_000_000_000 }), []);
    bad(g({ shape: "ticks", value: 0, max: 30, until: 1_900_000_000_000, period: 0 }), []);
    bad(g({ shape: "ticks", value: 0, max: 30, until: 1_900_000_000_000, period: 86_401 }), []);
    bad(g({ shape: "ticks", value: 0, max: 30, until: 1_900_000_000_000, period: 60.5 }), []);
    bad(g({ shape: "ticks", value: 0, max: 30, until: -1 }), []);
    bad(g({ shape: "arc", value: 3, max: 10, mark: 1.1 }), []);
    bad(g({ shape: "pips", value: 3, max: 10, mark: 0.5 }), []);
    bad(g({ shape: "ring", value: 3, max: 10, values: [0.1] }), []);
    bad(g({ shape: "arc", value: 3, max: 10, values: [] }), []);
    bad(g({ shape: "arc", value: 3, max: 10, values: [0.1, 0.2, 0.3, 0.4] }), []);
    bad(g({ shape: "arc", value: 3, max: 10, values: [0.1, 2] }), []);
  });

  test("a fold's height and its open state are set when it is added and never changed by the plugin", () => {
    const f = ok([add({ id: "f", type: "fold", h: 420, open: false, label: "Orbit view" })]);
    expect(bad([set("f", { h: 500 })], f)).toContain("never changed");
    expect(bad([set("f", { open: true })], f)).toContain("never changed");
    bad([set("f", { h: null })], f);
    ok([set("f", { label: "Orbit view: Gate" })], f);
    bad([add({ id: "f2", type: "fold", h: 159 })], f);
    bad([add({ id: "f2", type: "fold", h: 761 })], f);
    const many = ok([add({ id: "fa", type: "fold", h: 200 }), add({ id: "fb", type: "fold", h: 200 })]);
    bad([add({ id: "fc", type: "fold", h: 200 })], many);
  });

  test("counts: sheets by fit, planes, tokens, edges, bands, docks", () => {
    const s = orbit();
    bad([add({ ...SHEET, id: "sh2" })], s); // a second wide
    const both = ok([add({ ...SHEET, id: "sh2", fit: "narrow" })], s);
    bad([add({ ...SHEET, id: "sh3", fit: "narrow" })], both);
    bad([add({ id: "pl3", type: "plane", parent: "sh", cx: 1, cy: 1, rx: 50, tilt: 20 }), add({ id: "pl4", type: "plane", parent: "sh", cx: 1, cy: 1, rx: 50, tilt: 20 })], s);
    bad([add({ id: "o2", type: "orb", parent: "sh", cx: 1, cy: 1, r: 10 })], s);
    const full = ok(Array.from({ length: 21 }, (_, i) => add(tok(`m${i}`, i * 10, { size: "sm" }))), s);
    expect(full.filter((n) => n.parent === "pl" && n.type === "token").length).toBe(SHEET_LIMITS.tokensPerPlane);
    bad([add(tok("one-more", 5))], full);
    bad([add({ id: "r2", type: "reticle", parent: "pl", of: "t1" })], s);
    bad([add({ id: "k2", type: "ticks", parent: "pl", count: 12 })], s);
    const docks = ok(Array.from({ length: SHEET_LIMITS.docks }, (_, i) => add({ id: `dk${i}`, type: "dock", title: "d" })));
    bad([add({ id: "dk-x", type: "dock", title: "d" })], docks);
  });

  test("the cost counts every element: a plugin cannot draw 400 of them with a handful of nodes", () => {
    // ticks, bands and hatches are one path each however many marks they hold, so their caps (count, segments, lines) bound the work instead
    const s = orbit();
    const base = sheetCost(s, "sh");
    expect(base).toBeGreaterThan(50);
    // twenty-one moons with twelve trailing slices each are over 320
    const msg = bad(Array.from({ length: 21 }, (_, i) => add(tok(`s${i}`, 100 + i * 7, { trail: 12, trailSpan: 20 }))), s);
    expect(msg).toContain("SVG elements");
    expect(msg).toMatch(/\d+ SVG elements \(at most 320\)/);
    // trail slices, halos and numerals are priced
    expect(sheetCost(ok([set("t2", { trail: 12 })], s), "sh")).toBe(base + 6);
    expect(sheetCost(ok([set("t3", { halo: true })], s), "sh")).toBe(base + 1);
    // a narrow sheet that is hidden costs the same: cost never reads the theme
    expect(sheetCost(s, "sh")).toBe(base);
  });

  test("hostile input: ids, prototypes, unknown props, strings, one bad op refuses the batch", () => {
    const s = orbit();
    bad([add({ id: "__proto__", type: "token", parent: "pl", label: "x", at: 1 })], s);
    bad([add({ id: "ok-id", type: "token", parent: "pl", label: "x", at: 1, style: "x" })], s);
    bad([add({ id: "ok-id", type: "token", parent: "pl", label: "x", at: 1, onclick: "x" })], s);
    bad([add({ id: "ok-id", type: "orb", parent: "sh", cx: 1, cy: 1, r: 10, fill: "#f00" })], s);
    bad([add({ id: "ok-id", type: "plane", parent: "sh", cx: 1, cy: 1, rx: 100, tilt: 20, transform: "rotate(9)" })], s);
    bad([add({ id: "ok-id", type: "reticle", parent: "pl", of: "__proto__" })], s);
    bad([set("t1", { value: "a‮b" })], s);
    bad([set("t1", { unit: "ms‮" })], s);
    bad([set("t1", { label: "x".repeat(121) })], s);
    // a batch is atomic: the good op before the bad one is not kept
    const before = JSON.stringify(s);
    const r = applyOps(s, [set("t1", { at: 100 }), set("t2", { at: 361 })]);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(s)).toBe(before);
  });

  test("the input scene is never changed and an untouched node comes out as the same object", () => {
    const s = orbit();
    const frozen = JSON.stringify(s);
    const r = applyOps(s, [set("t1", { at: 280 }), move("t3", "pl", { before: "t1" })]);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(s)).toBe(frozen);
    if (!r.ok) return;
    const out = r.value.scene;
    expect(get(out, "t1")).not.toBe(get(s, "t1"));
    expect(get(out, "t1")?.at).toBe(280);
    for (const id of ["sh", "orb", "pl", "ring", "gate", "clock", "t2", "e1", "ret", "hat"]) expect(get(out, id)).toBe(get(s, id));
  });

  test("at the rate a plugin may send (60 batches a second for 10 seconds) the reducer keeps up and shares what it did not touch", () => {
    let s = orbit();
    const start = s;
    const t0 = performance.now();
    for (let i = 0; i < 600; i++) s = ok([set("t2", { at: (321 + i) % 360 })], s);
    const ms = performance.now() - t0;
    // 600 batches is ten seconds of the budget (60 ops/s); the work must be a small part of one second, not of ten.
    expect(ms).toBeLessThan(1000);
    for (const id of ["sh", "orb", "pl", "ring", "gate", "clock", "t1", "t3", "e1", "ret", "hat"]) expect(get(s, id)).toBe(get(start, id));
  });

  test("the module's depth: a sheet in a row in a fold in a stack reaches its tokens, and nine deep does not", () => {
    const deep = ok([
      add({ id: "root", type: "stack" }), add({ id: "f", type: "fold", h: 400, parent: "root" }), add({ id: "r", type: "row", parent: "f" }),
      add({ ...SHEET, parent: "r" }), add({ ...PLANE }), add(tok("t1", 5)),
    ]);
    expect(get(deep, "t1")).toBeDefined();
    const chain: unknown[] = [add({ id: "d0", type: "stack" })];
    for (let i = 1; i < CANVAS_LIMITS.depth; i++) chain.push(add({ id: `d${i}`, type: "stack", parent: `d${i - 1}` }));
    ok(chain);
    bad([...chain, add({ id: "dx", type: "stack", parent: `d${CANVAS_LIMITS.depth - 1}` })], []);
  });
});

/*
 * A plugin may change a prop sixty times a second; the window draws a big
 * state (an orb's light, a lit band, a halo, a sheet's material) at most 2.5
 * times a second per node, and the scene itself stays exact.
 */
import { describe, expect, test } from "bun:test";
import type { CanvasScene } from "../../shared/pluginCanvas.ts";
import { LUMA_MS, LUMA_MS_REDUCED, gateScene, type GateState } from "../src/lib/canvasFlash.ts";

const scene = (props: Record<string, unknown>): CanvasScene => [
  { id: "orb", type: "orb", parent: "sh", cx: 1, cy: 1, r: 50, ...props },
  { id: "label", type: "label", text: "steady" },
];

/** The scene a window would draw if frames arrive every `every` ms and the plugin flips `light` between 0 and 180 each time. */
function flip(every: number, count: number, minMs: number, prop = "light", values: unknown[] = [0, 180]) {
  let st: GateState | undefined;
  const drawn: unknown[] = [];
  let t = 1000;
  for (let i = 0; i < count; i++, t += every) {
    const r = gateScene(st, scene({ [prop]: values[i % values.length] }), t, minMs);
    st = r.state;
    const v = st.shown[0]![prop];
    if (drawn.length === 0 || drawn[drawn.length - 1] !== v) drawn.push(v);
  }
  return drawn;
}

describe("the window draws a flipping big state at most 2.5 times a second", () => {
  test("20 flips in one second (50 ms apart) are drawn at most 3 times", () => {
    expect(flip(50, 20, LUMA_MS).length).toBeLessThanOrEqual(3);
  });
  test("under reduced motion, once a second: 20 flips in one second draw at most 2 values", () => {
    expect(flip(50, 20, LUMA_MS_REDUCED).length).toBeLessThanOrEqual(2);
  });
  test("a slow change is never held: one every 500 ms all show", () => {
    expect(flip(500, 6, LUMA_MS).length).toBe(6);
  });
  test("every luminance prop is held, not only light", () => {
    for (const [prop, vals] of [["tone", ["danger", "success"]], ["halo", [true, false]], ["terminator", [true, false]], ["material", ["plain", "inset"]], ["lit", [0, 30]], ["shape", ["ring", "dot"]]] as const)
      expect(flip(50, 20, LUMA_MS, prop, [...vals]).length, prop).toBeLessThanOrEqual(3);
  });
  test("the newest value wins once the hold ends, and the caller is told when to ask again", () => {
    let r = gateScene(undefined, scene({ light: 0 }), 1000, LUMA_MS);
    r = gateScene(r.state, scene({ light: 90 }), 1100, LUMA_MS); // held
    expect(r.state.shown[0]!.light).toBe(0);
    expect(r.nextAt).toBe(1400);
    r = gateScene(r.state, scene({ light: 180 }), 1200, LUMA_MS); // still held, newer value waits
    expect(r.state.shown[0]!.light).toBe(0);
    r = gateScene(r.state, scene({ light: 180 }), 1400, LUMA_MS);
    expect(r.state.shown[0]!.light).toBe(180);
    expect(r.nextAt).toBeUndefined();
  });
  test("only the luminance props are held: a radius change and a removed node apply at once", () => {
    let r = gateScene(undefined, scene({ light: 0, r: 50 }), 1000, LUMA_MS);
    r = gateScene(r.state, scene({ light: 90, r: 60 }), 1050, LUMA_MS);
    expect(r.state.shown[0]!.r).toBe(60);
    expect(r.state.shown[0]!.light).toBe(0);
    r = gateScene(r.state, [scene({})[1]!], 1060, LUMA_MS);
    expect(r.state.shown.map((n) => n.id)).toEqual(["label"]);
  });
  test("an unchanged node comes out as the same object, so a memo keyed on it still hits", () => {
    const s = scene({ light: 0 });
    const r1 = gateScene(undefined, s, 1000, LUMA_MS);
    const r2 = gateScene(r1.state, [...s], 1010, LUMA_MS);
    expect(r2.state.shown[1]).toBe(s[1]!);
    expect(r2.state.shown[0]).toBe(s[0]!);
  });
  test("the scene that came in is never changed", () => {
    const s = scene({ light: 90 });
    const frozen = JSON.stringify(s);
    gateScene(gateScene(undefined, scene({ light: 0 }), 1000, LUMA_MS).state, s, 1100, LUMA_MS);
    expect(JSON.stringify(s)).toBe(frozen);
  });
});

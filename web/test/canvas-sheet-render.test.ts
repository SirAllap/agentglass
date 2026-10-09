/*
 * Executes a sheet's first paint and counts what it drew against the price the
 * reducer put on it (shared/canvasSheet.ts `sheetCost`). The price is the
 * promise that ten plugin nodes cannot draw four hundred SVG elements; this is
 * the test that the renderer keeps its side of it, on a scene the reducer
 * accepted at its limit. There is no DOM under `bun test`, so what it counts
 * is the static markup.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SHEET_LIMITS, applyOps, type CanvasScene } from "../../shared/pluginCanvas.ts";
import { sheetCost } from "../../shared/canvasSheet.ts";
import { CanvasSheet } from "../src/components/plugins/CanvasSheet.tsx";
import { childrenIndex } from "../src/lib/canvasGeometry.ts";

const add = (node: Record<string, unknown>) => ({ op: "add", node });
const apply = (scene: CanvasScene, ops: unknown[]): CanvasScene | string => { const r = applyOps(scene, ops); return r.ok ? r.value.scene : r.error; };
const must = (scene: CanvasScene, ops: unknown[]): CanvasScene => { const r = apply(scene, ops); if (typeof r === "string") throw new Error(r); return r; };

const base = (): CanvasScene => must([], [
  add({ id: "sh", type: "sheet", w: 776, h: 412, fit: "wide", material: "inset", label: "Orbit", key: [{ shape: "ring", label: "waiting" }, { shape: "dot", label: "in flight" }, { shape: "diamond", label: "held" }] }),
  add({ id: "orb", type: "orb", parent: "sh", cx: 388, cy: 200, r: 52, light: 300, bands: 4, terminator: true, halo: true }),
  add({ id: "pl", type: "plane", parent: "sh", cx: 388, cy: 206, rx: 215, tilt: 27, roll: -9, depth: 0.8 }),
  add({ id: "ring-b", type: "band", parent: "pl", r0: 0.3, r1: 0.42, from: 180, to: 360, layer: "back", tone: "accent" }),
  add({ id: "ring-f", type: "band", parent: "pl", r0: 0.3, r1: 0.42, from: 0, to: 180, layer: "front", tone: "accent" }),
  add({ id: "gate", type: "band", parent: "pl", r0: 1.04, r1: 1.1, from: 270, to: 630, segments: 30, lit: 24, tone: "warning", halo: true }),
  add({ id: "clock", type: "ticks", parent: "pl", count: 60, mark: 15, lit: 8, until: 1_030_000, period: 60, numerals: [{ at: 90, text: "30" }] }),
  ...Array.from({ length: 7 }, (_, i) => add({ id: `st${i}`, type: "token", parent: "pl", label: `Station ${i}`, at: (270 + i * 51.43) % 360, count: i + 1, value: `${i}0`, unit: "ms", leader: i === 0 || i === 4 ? "below" : i < 4 ? "right" : "left", size: i === 6 ? "lg" : "sm", halo: i === 2 })),
  add({ id: "w1", type: "token", parent: "pl", label: "waiting", at: 322, shape: "dot", trail: 6, trailSpan: 40, halo: true }),
  add({ id: "e1", type: "edge", parent: "pl", from: "st3", to: "st4", tone: "danger", breakAt: 0.5, breakGap: 0.2 }),
  add({ id: "ret", type: "reticle", parent: "pl", of: "st2", chip: "Rate gate: 24 of 30 calls" }),
  add({ id: "hat", type: "hatch", parent: "sh", of: "orb", from: 90, to: 270, gap: 8, angle: 45 }),
]);

const draw = (scene: CanvasScene, phase = 1): string => {
  const sheet = scene.find((n) => n.type === "sheet")!;
  return renderToStaticMarkup(React.createElement(CanvasSheet, { sheet, kids: childrenIndex(scene), edges: scene.filter((n) => n.type === "edge"), view: { now: 1_000_000, phase, at: new Map() } }));
};
/** Elements inside the <svg>, counted from the markup: every start tag but the svg itself. */
const elements = (html: string): number => {
  const svg = html.slice(html.indexOf("<svg"), html.indexOf("</svg>"));
  return (svg.match(/<(?!svg|\/)[a-zA-Z]/g) ?? []).length;
};

describe("a sheet draws no more elements than the reducer priced", () => {
  test("the real thing: planet, ring, gate, clock, seven stations, a satellite, a cut orbit, a reticle, a hatch", () => {
    const s = base();
    const n = elements(draw(s));
    expect(n).toBeGreaterThan(80);
    // the cut orbit is drawn: its near run, and the two end marks
    expect(draw(s)).toContain("cv-edge-near");
    expect(draw(s)).toContain("cv-edge-marks");
    expect(n).toBeLessThanOrEqual(sheetCost(s, "sh"));
  });
  test("at the cap: the heaviest scene the reducer accepts still draws within its price", () => {
    let s = base();
    // Moons with everything on them, until the reducer says no.
    for (let i = 0; i < SHEET_LIMITS.tokensPerPlane; i++) {
      const next = apply(s, [add({ id: `x${i}`, type: "token", parent: "pl", label: `Moon ${i}`, at: (i * 15) % 360, count: i, value: "1", unit: "u", leader: i % 3 === 0 ? "below" : i % 2 ? "left" : "right", halo: true, trail: 12, trailSpan: 30, shape: "diamond" })]);
      if (typeof next === "string") { expect(next).toContain("SVG elements"); break; }
      s = next;
    }
    const cost = sheetCost(s, "sh");
    expect(cost).toBeGreaterThan(SHEET_LIMITS.svgNodes - 25);
    expect(cost).toBeLessThanOrEqual(SHEET_LIMITS.svgNodes);
    expect(elements(draw(s))).toBeLessThanOrEqual(cost);
  });
  test("tipped half way, and seen from above, the count does not change", () => {
    const s = base();
    expect(elements(draw(s, 0.5))).toBe(elements(draw(s, 1)));
    expect(elements(draw(s, 0))).toBe(elements(draw(s, 1)));
  });
  test("the clock reads the clock: the hand and the lit marks move with now", () => {
    const s = base();
    const a = draw(s), sheet = s.find((n) => n.type === "sheet")!;
    const later = renderToStaticMarkup(React.createElement(CanvasSheet, { sheet, kids: childrenIndex(s), edges: s.filter((n) => n.type === "edge"), view: { now: 1_015_000, phase: 1, at: new Map() } }));
    expect(later).not.toBe(a);
  });
});

describe("what a scene can and cannot put into the markup", () => {
  const html = draw(base());
  test("nothing from the scene becomes an id, a class, a link, an image or a handler", () => {
    for (const id of ["orb", "pl", "gate", "clock", "st3", "ret", "hat", "sh"]) expect(html).not.toContain(`id="${id}"`);
    expect(html).not.toMatch(/\bhref=|<image|<foreignObject|<script|<use\b|\bon[a-z]+=/i);
    expect(html).not.toMatch(/filter|backdrop|blur/i);
  });
  test("the svg takes no pointer and tells a screen reader what it is; each station is in a hidden list", () => {
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Orbit"');
    expect(html).toContain('class="sr-only"');
    expect(html).toContain("Station 3, 30 ms");
    expect(html).toContain("in flight");
  });
  test("hostile text is text: a label with markup is escaped", () => {
    const s = must(base(), [{ op: "set", id: "st1", props: { label: "<img src=x onerror=alert(1)>" } }]);
    const out = draw(s);
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });
});

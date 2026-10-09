/*
 * A board's arithmetic: how far it scales, which slot a token takes and when
 * a bay says "+N", how rides on one trace are spaced so two tokens never
 * overlap in flight, how a trace's points become a path, where a needle points
 * and what an odometer's cells hold. Pure functions, called with numbers, plus
 * the motion controller through a stand-in for Element.animate.
 */
import { describe, expect, test } from "bun:test";
import type { CanvasScene } from "../../shared/pluginCanvas.ts";
import {
  BOARD_SCALE_MAX, BOARD_SCALE_MIN, RIDE_GAP_MS, RIDE_LATE_MS, baySplit, boardOf, boardRoutes, boardScale, etching,
  ODO_MAX_DIGITS, easeAt, needleAngle, odometerCells, rideClearMs, roundedPath, rideDelay, slotCell, trimStart,
} from "../src/lib/canvasGeometry.ts";
import { CanvasMotion } from "../src/lib/canvasMotion.ts";

describe("boardScale", () => {
  test("follows the width it is given, uniformly", () => {
    expect(boardScale(1180, 1180)).toEqual({ scale: 1, scrolls: false });
    expect(boardScale(1416, 1180).scale).toBeCloseTo(1.2);
  });

  test("keeps the floor and scrolls below it, instead of shrinking the labels past reading", () => {
    expect(boardScale(500, 1180)).toEqual({ scale: BOARD_SCALE_MIN, scrolls: true });
    // Exactly at the floor it still fits: nothing to scroll.
    expect(boardScale(1180 * BOARD_SCALE_MIN, 1180)).toEqual({ scale: BOARD_SCALE_MIN, scrolls: false });
  });

  test("stops at the ceiling on a wide screen", () => {
    expect(boardScale(4000, 1180)).toEqual({ scale: BOARD_SCALE_MAX, scrolls: false });
  });

  test("a width not measured yet is scale 1, never NaN or 0", () => {
    expect(boardScale(0, 1180)).toEqual({ scale: 1, scrolls: false });
    expect(boardScale(Number.NaN, 1180)).toEqual({ scale: 1, scrolls: false });
  });
});

describe("baySplit and slotCell", () => {
  test("one token per slot while they fit", () => {
    expect(baySplit(0, 12)).toEqual({ shown: 0, more: 0 });
    expect(baySplit(12, 12)).toEqual({ shown: 12, more: 0 });
  });

  test("past the last slot, the last slot says +N and holds no token", () => {
    // A burst of 60 into a 4 x 3 bay: 11 tokens and "+49", and 11 + 49 is all of them.
    const { shown, more } = baySplit(60, 12);
    expect(shown).toBe(11);
    expect(more).toBe(49);
    expect(shown + more).toBe(60);
    expect(shown + (more > 0 ? 1 : 0)).toBeLessThanOrEqual(12);
  });

  test("never two tokens in one cell, for any count", () => {
    for (let count = 0; count <= 80; count++) {
      const { shown } = baySplit(count, 12);
      const cells = new Set(Array.from({ length: shown }, (_, i) => { const c = slotCell(i, 4); return `${c.col},${c.row}`; }));
      expect(cells.size).toBe(shown);
      for (const c of cells) expect(Number(c.split(",")[1])).toBeLessThan(3);
    }
  });

  test("cells fill row by row", () => {
    expect(slotCell(0, 4)).toEqual({ col: 0, row: 0 });
    expect(slotCell(5, 4)).toEqual({ col: 1, row: 1 });
    expect(slotCell(3, 0)).toEqual({ col: 0, row: 3 });
  });
});

describe("rideDelay: rides on one trace never overlap", () => {
  test("the first ride goes at once", () => {
    expect(rideDelay(undefined, 1000)).toBe(0);
  });

  test("a ride right behind another waits out the gap", () => {
    expect(rideDelay(1000, 1000)).toBe(RIDE_GAP_MS);
    expect(rideDelay(1000, 1100)).toBe(RIDE_GAP_MS - 100);
    expect(rideDelay(1000, 1000 + RIDE_GAP_MS + 5)).toBe(0);
  });

  test("a burst queues at the gap and the ones past the late mark land in place", () => {
    const m = new CanvasMotion();
    const starts: number[] = [];
    let landed = 0;
    for (let i = 0; i < 60; i++) {
      const d = m.rideTurn("t1", 5000);
      if (d === null) landed++;
      else { starts.push(5000 + d); m.rideTaken("t1", 5000 + d); }
    }
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(RIDE_GAP_MS);
    expect(Math.max(...starts) - 5000).toBeLessThanOrEqual(RIDE_LATE_MS);
    expect(starts.length).toBe(Math.floor(RIDE_LATE_MS / RIDE_GAP_MS) + 1);
    expect(landed).toBe(60 - starts.length);
    // Another trace has its own queue.
    expect(m.rideTurn("t2", 5000)).toBe(0);
  });

  test("a delayed ride is held invisible at the start and fades in as it leaves", () => {
    const m = new CanvasMotion();
    const calls: { frames: Record<string, unknown>[]; opts: Record<string, unknown> }[] = [];
    const el = { animate(frames: Record<string, unknown>[], opts: Record<string, unknown>) { calls.push({ frames, opts }); return { onfinish: null, oncancel: null, cancel() {}, finish() {} }; } } as unknown as Element;
    m.travel(el, [{ x: 0, y: 0 }, { x: 100, y: 0 }], { x: 100, y: 40 }, 400, "ease-in-out", 220);
    expect(calls.length).toBe(2);
    expect(calls[0]!.opts.delay).toBe(220);
    expect(calls[0]!.opts.fill).toBe("backwards");
    expect(calls[1]!.frames[0]).toEqual({ opacity: 0 });
    expect(calls[1]!.opts.delay).toBe(220);
    for (const c of calls) for (const f of c.frames) expect(Object.keys(f).filter((k) => !["opacity", "transform", "offset"].includes(k))).toEqual([]);
  });
});

describe("rideClearMs: the spacing that keeps a token's width between two rides", () => {
  const gapAt = (len: number, ms: number, easing: string, gap: number) => {
    let min = Infinity;
    for (let t = gap; t <= ms; t += 5) {
      const follow = Math.min(1, easeAt(easing, (t - gap) / ms));
      if (follow < 1) min = Math.min(min, (Math.min(1, easeAt(easing, t / ms)) - follow) * len);
    }
    return min;
  };

  test("a long trace at an even speed needs no more than the floor", () => {
    expect(rideClearMs(1000, 600, "linear", 58)).toBe(RIDE_GAP_MS);
  });

  test("a short trace with a slow start is measured, and the measured gap holds a token apart", () => {
    const gap = rideClearMs(105, 600, "ease-in-out", 62);
    expect(gap).toBeGreaterThan(RIDE_GAP_MS);
    expect(gapAt(105, 600, "ease-in-out", gap)).toBeGreaterThanOrEqual(62 - 1);
    // and the floor alone would not have: this is the case it exists for
    expect(gapAt(105, 600, "ease-in-out", RIDE_GAP_MS)).toBeLessThan(62);
  });

  test("a token longer than the route waits the whole ride; bad input falls back to the floor", () => {
    expect(rideClearMs(40, 600, "linear", 58)).toBe(600);
    expect(rideClearMs(0, 600, "linear", 58)).toBe(RIDE_GAP_MS);
    expect(rideClearMs(100, Number.NaN, "linear", 58)).toBe(RIDE_GAP_MS);
  });

  test("easeAt follows the named curves, and an unknown name is ease", () => {
    expect(easeAt("linear", 0.3)).toBeCloseTo(0.3, 3);
    expect(easeAt("ease-in-out", 0.5)).toBeCloseTo(0.5, 3);
    expect(easeAt("ease-in", 0.2)).toBeLessThan(0.2);
    expect(easeAt("nope", 0.4)).toBeCloseTo(easeAt("ease", 0.4), 6);
  });

  test("rideDelay takes the measured gap when it is the larger", () => {
    expect(rideDelay(1000, 1000, 400)).toBe(400);
    expect(rideDelay(1000, 1000, 100)).toBe(RIDE_GAP_MS);
  });
});

describe("roundedPath", () => {
  test("a straight run is a line, from numbers only", () => {
    expect(roundedPath([{ x: 0, y: 0 }, { x: 100, y: 0 }])).toBe("M0.0 0.0 L100.0 0.0");
  });

  test("a corner is rounded by r, through the corner point", () => {
    const d = roundedPath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 14);
    expect(d).toBe("M0.0 0.0 L86.0 0.0 Q100.0 0.0 100.0 14.0 L100.0 100.0");
  });

  test("a short leg caps the radius at half of it, so the curve never folds back", () => {
    const d = roundedPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 100 }], 14);
    expect(d).toContain("L5.0 0.0 Q10.0 0.0 10.0 5.0");
  });

  test("a repeated point is dropped rather than dividing by a zero-length leg", () => {
    const d = roundedPath([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }]);
    expect(d).not.toContain("NaN");
    expect(d.startsWith("M0.0 0.0 L")).toBe(true);
  });
});

describe("needleAngle and odometerCells", () => {
  test("a needle runs from -90 (empty) through 0 (half) to 90 (full), clamped", () => {
    expect(needleAngle(0, 1)).toBe(-90);
    expect(needleAngle(0.5, 1)).toBe(0);
    expect(needleAngle(1, 1)).toBe(90);
    expect(needleAngle(7, 1)).toBe(90);
    expect(needleAngle(-3, 1)).toBe(-90);
    expect(needleAngle("x", 1)).toBe(-90);
  });

  test("an odometer holds a cell per digit and a fixed glyph for the point", () => {
    expect(odometerCells(0.0009, 5)).toEqual([{ digit: 0 }, { glyph: "." }, { digit: 0 }, { digit: 0 }, { digit: 0 }, { digit: 9 }, { digit: 0 }]);
    expect(odometerCells(42, 0)).toEqual([{ digit: 4 }, { digit: 2 }]);
    expect(odometerCells(-1.5, 1)).toEqual([{ glyph: "-" }, { digit: 1 }, { glyph: "." }, { digit: 5 }]);
  });

  test("digits are clamped to 0-6 and a bad value is zero", () => {
    expect(odometerCells(1, 99)!.length).toBe(8);
    expect(odometerCells(Number.NaN, 2)).toEqual([{ digit: 0 }, { glyph: "." }, { digit: 0 }, { digit: 0 }]);
  });
});

describe("boardRoutes and boardOf", () => {
  const scene: CanvasScene = [
    { id: "b", type: "board", w: 1180, h: 560 },
    { id: "q", type: "part", parent: "b", x: 200, y: 20, w: 200, h: 100 },
    { id: "bay", type: "bay", parent: "q", cols: 4, rows: 3 },
    { id: "c", type: "part", parent: "b", x: 400, y: 300, w: 200, h: 200 },
    { id: "k", type: "core", parent: "c" },
    { id: "pts", type: "edge", parent: "b", from: "q", to: "c", points: [[10, 70], [300, 70], [300, 400]] },
    { id: "elb", type: "edge", parent: "b", from: "bay", to: "k" },
    { id: "flow", type: "edge", from: "q", to: "c" },
  ];

  test("an edge with points follows them, in board units", () => {
    expect(boardRoutes(scene).get("pts")).toEqual([{ x: 10, y: 70 }, { x: 300, y: 70 }, { x: 300, y: 400 }]);
  });

  test("one without runs an elbow between the centres of the parts around its ends", () => {
    expect(boardRoutes(scene).get("elb")).toEqual([{ x: 300, y: 70 }, { x: 500, y: 70 }, { x: 500, y: 400 }]);
  });

  test("an edge outside a board is left to the flow layout's routing", () => {
    expect(boardRoutes(scene).has("flow")).toBe(false);
  });

  test("boardOf finds the board a node is drawn in, and nothing for the flow", () => {
    const byId = new Map(scene.map((n) => [n.id, n] as const));
    expect(boardOf("bay", byId)).toBe("b");
    expect(boardOf("b", byId)).toBe("b");
    expect(boardOf("flow", byId)).toBeUndefined();
  });
});

describe("etching", () => {
  test("the same board draws the same lines, on the grid; another board draws others", () => {
    const a = etching("board-1", 1180, 560), b = etching("board-1", 1180, 560), c = etching("board-2", 1180, 560);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    for (const e of a) { expect(e.via.x % 24).toBe(0); expect(e.via.y % 24).toBe(0); }
  });
});

const BOARD_SRC = await Bun.file(new URL("../src/components/plugins/CanvasBoard.tsx", import.meta.url)).text();
const VIEW_SRC = await Bun.file(new URL("../src/components/plugins/PluginCanvas.tsx", import.meta.url)).text();

describe("a control inside a pressable part", () => {
  const fn = (src: string, head: string) => { const at = src.indexOf(head); expect(at).toBeGreaterThan(-1); return src.slice(at, src.indexOf("\n};", at)); };

  test("a key counts for the part only when the part itself has the focus", () => {
    // A bubbled Enter from a lever radio inside it would otherwise be cancelled and press the part instead.
    expect(fn(BOARD_SRC, "const pressProps = (")).toContain("e.target !== e.currentTarget");
  });

  test("the lever's and the chips' options, and a canvas button, keep their click to themselves", () => {
    expect([...VIEW_SRC.matchAll(/onClick=\{\(e\) => \{ e\.stopPropagation\(\);(?: setSnap\(false\);)? choose\(o\.value\); \}\}/g)].length).toBe(2);
    expect(VIEW_SRC).toContain('className="inline-flex self-start" onClick={(e) => e.stopPropagation()}');
  });
});

const CSS_SRC = await Bun.file(new URL("../src/components/plugins/canvasBoard.css", import.meta.url)).text();
const MOTION_SRC = await Bun.file(new URL("../src/lib/canvasMotion.ts", import.meta.url)).text();
const slice = (src: string, head: string) => { const at = src.indexOf(head); expect(at).toBeGreaterThan(-1); return src.slice(at, src.indexOf("\n}\n", at)); };

describe("what a truncated or coloured thing still says", () => {
  test("a token's, a title's and a hint's full text is its name and its tooltip", () => {
    expect(slice(BOARD_SRC, "function TokenChip(")).toContain('role="img" aria-label={label} title={label}');
    const part = slice(BOARD_SRC, "function PartView(");
    expect(part).toContain('className="bd-hd-title" title={title}');
    expect(part).toContain('className="bd-hint" title={hint}');
    expect(slice(BOARD_SRC, "export function ItemView(")).toContain('className="bd-row-t" title={title}');
  });

  test("a pressable part is named even without a title, and every pressable thing has a focus ring", () => {
    expect(slice(BOARD_SRC, "function PartView(")).toContain("`Step ${");
    expect(BOARD_SRC).toMatch(/role: "button" as const, tabIndex: 0, "aria-label": label/);
    expect(CSS_SRC).toMatch(/\.bd-part:focus-visible[^{]*\{ outline: 2px solid/);
    expect(CSS_SRC).toMatch(/\.bd-row:focus-visible \{ outline: 2px solid/);
  });

  test("a closed gate says closed in words, and its pips are a meter", () => {
    const gate = slice(BOARD_SRC, "export function GateView(");
    expect(gate).toContain("closed · ${label}");
    expect(gate).toContain('className="bd-pips" role="meter"');
  });

  test("a lamp is named with its state, and off is hollow, not only grey", () => {
    expect(slice(BOARD_SRC, "export function LampView(")).toContain('`${label}: ${on ? "on" : "off"}`');
    expect(CSS_SRC).toMatch(/\.bd-lamp\[data-on="false"\] i \{ background: transparent;/);
  });
});

describe("motion that respects the person", () => {
  test("under reduced motion a step still leaves a still trace: the part is outlined for a moment", () => {
    const view = VIEW_SRC.slice(VIEW_SRC.indexOf("if (reduced) {"), VIEW_SRC.indexOf("// FLIP: everything"));
    expect(view).toContain("motion.mark(el)");
    expect(MOTION_SRC).toContain('el.setAttribute("data-lit", "true")');
    expect(CSS_SRC).toMatch(/\[data-lit="true"\] \{ outline: 2px solid var\(--bd-lit\)/);
    expect(CSS_SRC).toMatch(/\.bd-core\[data-busy="true"\] \.bd-ring-b/);
  });

  test("exits settle with an ease-out curve and are shorter than enters", () => {
    expect(MOTION_SRC).not.toContain('easingCss("ease-in")');
    expect(MOTION_SRC).toContain('export const SETTLE = "cubic-bezier(0.23, 1, 0.32, 1)"');
    const n = (k: string) => Number(MOTION_SRC.match(new RegExp(`export const ${k} = (\\d+);`))![1]);
    expect(n("EXIT_MS")).toBeLessThan(n("ENTER_MS"));
  });

  test("the lever's knob snaps for arrow keys and slides for a pointer", () => {
    const seg = slice(VIEW_SRC, "function CanvasSegmented(");
    expect(seg).toMatch(/e\.preventDefault\(\);\s*setSnap\(true\);/);
    expect(seg).toContain("setSnap(false); choose(o.value);");
    expect(CSS_SRC).toContain('.bd-knob[data-snap="true"] { transition: none; }');
  });

  test("light is --bd-lit; --primary is kept for focus and selection", () => {
    const uses = CSS_SRC.split("\n").filter((l) => l.includes("var(--primary)"));
    expect(uses.every((l) => /focus-visible|data-selected|--bd-row-hi|--bd-lit:/.test(l))).toBe(true);
    expect(BOARD_SRC).toContain('tone === "accent" ? "var(--bd-lit)"');
  });
});

describe("what a burst costs the window's main thread", () => {
  test("working out a ride's spacing is cheap, and a repeat is a lookup", () => {
    const t0 = performance.now();
    for (let i = 0; i < 400; i++) rideClearMs(80 + i, 600 + (i % 7) * 100, i % 2 ? "spring" : "ease-in-out", 40 + (i % 50));
    const cold = performance.now() - t0;
    const t1 = performance.now();
    for (let i = 0; i < 400; i++) rideClearMs(105, 600, "ease-in-out", 62);
    const warm = performance.now() - t1;
    // Measured before the table and the cache: about 5 ms a call, 400 calls near two seconds.
    expect(cold).toBeLessThan(100);
    expect(warm).toBeLessThan(20);
  });

  test("the sampled curve gives the same spacing as the exact one would, within a step", () => {
    const gap = rideClearMs(105, 600, "ease-in-out", 62);
    expect(gap).toBeGreaterThanOrEqual(300);
    expect(gap).toBeLessThanOrEqual(360);
  });

  test("asking for a turn does not take it: a ride the budget refused leaves the trace free", () => {
    const m = new CanvasMotion();
    for (let i = 0; i < m.budget.cap; i++) m.budget.acquire();
    expect(m.canStart()).toBe(false);
    const el = { animate() { return { onfinish: null, oncancel: null, cancel() {}, finish() {} }; } } as unknown as Element;
    expect(m.rideTurn("t", 1000)).toBe(0);
    expect(m.travel(el, [{ x: 0, y: 0 }, { x: 99, y: 0 }], { x: 99, y: 0 }, 600, "linear", 0)).toBe(false);
    // Nothing was recorded, so the next ride goes at once instead of queueing behind a ghost.
    expect(m.rideTurn("t", 1000)).toBe(0);
    m.rideTaken("t", 1000);
    expect(m.rideTurn("t", 1000)).toBe(RIDE_GAP_MS);
  });

  test("an odometer rolls at most ODO_MAX_DIGITS cells, then is written as text", () => {
    expect(odometerCells(123456789.5, 1)).not.toBeNull();
    expect(odometerCells(-1e12, 6)).toBeNull();
    expect(odometerCells(12345678901, 0)).toBeNull();
    expect(ODO_MAX_DIGITS).toBe(10);
  });

  test("a ride leaves from a part's edge: its start is cut by half a token", () => {
    const cut = trimStart([{ x: 0, y: 0 }, { x: 100, y: 0 }], 29);
    expect(cut[0]!.x).toBeCloseTo(29, 6);
    expect(cut[1]).toEqual({ x: 100, y: 0 });
    expect(trimStart([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 100 }], 30)).toEqual([{ x: 10, y: 20 }, { x: 10, y: 100 }]);
    // never to nothing: at most half of the last leg
    expect(trimStart([{ x: 0, y: 0 }, { x: 20, y: 0 }], 50)).toEqual([{ x: 10, y: 0 }, { x: 20, y: 0 }]);
  });
});

describe("an odometer cell", () => {
  test("is a clipped window one digit tall, of a fixed width, whatever its strip does mid-roll", () => {
    const cell = CSS_SRC.match(/\.bd-odo-cell \{([^}]*)\}/)![1]!;
    for (const rule of ["flex: none", "width: 17px", "height: 32px", "overflow: hidden", "clip-path: inset(0)"]) expect(cell).toContain(rule);
    const col = CSS_SRC.match(/\.bd-odo-col \{([^}]*)\}/)![1]!;
    // ten lines of exactly the cell's height, so a digit lands flush in the window
    expect(col).toContain("line-height: 32px");
    expect(col).toContain("height: 320px");
    expect(BOARD_SRC).toContain("translateY(${-32 * c.digit}px)");
    expect(CSS_SRC).toMatch(/\.bd-odo-glyph \{ flex: none; width: 8px;/);
  });
});

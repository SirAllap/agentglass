/*
 * The drawing model, and the one piece of trigonometry in it.
 *
 * An arrow head that points the wrong way when you drag towards the top-left is
 * the classic way to get this wrong, and it is invisible in a screenshot taken
 * while dragging to the right. So the arrow is checked in all four directions.
 */
import { describe, expect, it } from "bun:test";
import { addShape, arrowHead, dragRect, emptyMarkup, redo, undo, type Shape } from "../src/lib/markup.ts";

const shape = (over: Partial<Shape> = {}): Shape =>
  ({ tool: "pen", colour: "#fff", width: 3, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], ...over });

describe("adding and taking away", () => {
  it("keeps what was drawn", () => {
    const s = addShape(emptyMarkup(), shape());
    expect(s.shapes).toHaveLength(1);
  });

  it("ignores a stroke that never moved — a click is not a drawing", () => {
    const s = addShape(emptyMarkup(), shape({ points: [{ x: 4, y: 4 }] }));
    expect(s.shapes).toHaveLength(0);
  });

  it("undo then redo puts it back where it was", () => {
    const a = shape({ colour: "#a" }), b = shape({ colour: "#b" });
    let s = addShape(addShape(emptyMarkup(), a), b);
    s = undo(s);
    expect(s.shapes.map((x) => x.colour)).toEqual(["#a"]);
    s = redo(s);
    expect(s.shapes.map((x) => x.colour)).toEqual(["#a", "#b"]);
  });

  it("undoes several in the order they were drawn", () => {
    let s = addShape(addShape(addShape(emptyMarkup(), shape({ colour: "#1" })), shape({ colour: "#2" })), shape({ colour: "#3" }));
    s = undo(undo(s));
    expect(s.shapes.map((x) => x.colour)).toEqual(["#1"]);
    s = redo(s);
    expect(s.shapes.map((x) => x.colour)).toEqual(["#1", "#2"]);
  });

  it("drawing something new drops the redo trail", () => {
    // A branch of history nobody can navigate to is a trap: redo would bring
    // back a shape from a drawing that no longer exists.
    let s = addShape(emptyMarkup(), shape({ colour: "#a" }));
    s = undo(s);
    expect(s.undone).toHaveLength(1);
    s = addShape(s, shape({ colour: "#c" }));
    expect(s.undone).toHaveLength(0);
    expect(redo(s).shapes.map((x) => x.colour)).toEqual(["#c"]);
  });

  it("does nothing at the ends", () => {
    const e = emptyMarkup();
    expect(undo(e)).toBe(e);
    expect(redo(e)).toBe(e);
  });
});

describe("a rectangle from a drag", () => {
  it("is the same box whichever corner you started from", () => {
    const want = { x: 5, y: 5, w: 15, h: 25 };
    expect(dragRect({ x: 5, y: 5 }, { x: 20, y: 30 })).toEqual(want);
    expect(dragRect({ x: 20, y: 30 }, { x: 5, y: 5 })).toEqual(want);
    expect(dragRect({ x: 20, y: 5 }, { x: 5, y: 30 })).toEqual(want);
    expect(dragRect({ x: 5, y: 30 }, { x: 20, y: 5 })).toEqual(want);
  });
});

describe("the arrow head", () => {
  /** How far the head's points are from the tip. */
  const spread = (from: { x: number; y: number }, to: { x: number; y: number }, size: number) =>
    arrowHead(from, to, size).map((p) => Math.hypot(p.x - to.x, p.y - to.y));

  it("sits at the tip, not at the tail", () => {
    const [a, b] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 20);
    // Both wings are behind the tip, which is at x=100.
    expect(a.x).toBeLessThan(100);
    expect(b.x).toBeLessThan(100);
    expect(Math.hypot(a.x - 0, a.y - 0)).toBeGreaterThan(50);
  });

  it("points the right way in all four directions", () => {
    // The failure this catches: a head computed from the wrong angle looks fine
    // dragging right and inverts dragging left.
    const cases: [{ x: number; y: number }, { x: number; y: number }][] = [
      [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      [{ x: 100, y: 0 }, { x: 0, y: 0 }],
      [{ x: 0, y: 0 }, { x: 0, y: 100 }],
      [{ x: 0, y: 100 }, { x: 0, y: 0 }],
    ];
    for (const [from, to] of cases) {
      const [a, b] = arrowHead(from, to, 20);
      // The midpoint of the two wings lies BETWEEN tail and tip, never past it.
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const toTip = Math.hypot(to.x - from.x, to.y - from.y);
      const toMid = Math.hypot(mid.x - from.x, mid.y - from.y);
      expect(toMid).toBeLessThan(toTip);
      expect(toMid).toBeGreaterThan(0);
    }
  });

  it("is the size it was asked for", () => {
    for (const d of spread({ x: 0, y: 0 }, { x: 60, y: 60 }, 24)) {
      expect(d).toBeGreaterThan(20);
      expect(d).toBeLessThan(28);
    }
  });

  it("does not blow up on an arrow of no length", () => {
    const [a, b] = arrowHead({ x: 7, y: 7 }, { x: 7, y: 7 }, 12);
    expect(Number.isFinite(a.x)).toBe(true);
    expect(Number.isFinite(b.y)).toBe(true);
  });
});

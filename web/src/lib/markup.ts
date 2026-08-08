// Shapes drawn over a page, and how they are painted.
//
// The model is separate from the canvas so the arithmetic can be tested: where
// an arrow head sits, what a box drawn upwards-and-left actually covers, and
// that an undone shape comes back in the right order. None of that needs a
// browser, and all of it is the part that goes wrong.

export type MarkupTool = "pen" | "arrow" | "box" | "ellipse";

export interface Shape {
  tool: MarkupTool;
  colour: string;
  width: number;
  /** Pen keeps every point; the other three keep exactly two — where the drag
   *  began and where it is now. */
  points: { x: number; y: number }[];
}

export const COLOURS = ["#ff4d4d", "#ff9f2e", "#ffd53d", "#4ade80", "#4a9eff", "#a78bfa", "#ffffff"];

/** Three widths rather than a slider: a slider is a decision nobody wants to
 *  make while pointing at a bug. */
export const WIDTHS = [3, 6, 12];

export interface MarkupState {
  shapes: Shape[];
  /** Shapes taken off by undo, newest last, so redo can put them back in
   *  order. Cleared the moment something new is drawn — a branch of history
   *  nobody can navigate to is a trap, not a feature. */
  undone: Shape[];
}

export const emptyMarkup = (): MarkupState => ({ shapes: [], undone: [] });

export function addShape(s: MarkupState, shape: Shape): MarkupState {
  if (shape.points.length < 2) return s;
  return { shapes: [...s.shapes, shape], undone: [] };
}

export function undo(s: MarkupState): MarkupState {
  if (!s.shapes.length) return s;
  const last = s.shapes[s.shapes.length - 1]!;
  return { shapes: s.shapes.slice(0, -1), undone: [...s.undone, last] };
}

export function redo(s: MarkupState): MarkupState {
  if (!s.undone.length) return s;
  const back = s.undone[s.undone.length - 1]!;
  return { shapes: [...s.shapes, back], undone: s.undone.slice(0, -1) };
}

/** The rectangle a two-point drag covers, whichever way it was dragged. */
export function dragRect(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number; w: number; h: number } {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/**
 * The two points of an arrow's head.
 *
 * Kept here rather than inline in the painter because it is the one piece of
 * trigonometry in the feature, and an arrow head that points the wrong way on a
 * drag towards the top-left is the classic way to get it wrong.
 */
export function arrowHead(from: { x: number; y: number }, to: { x: number; y: number }, size: number): [{ x: number; y: number }, { x: number; y: number }] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const spread = Math.PI / 7;
  return [
    { x: to.x - size * Math.cos(angle - spread), y: to.y - size * Math.sin(angle - spread) },
    { x: to.x - size * Math.cos(angle + spread), y: to.y - size * Math.sin(angle + spread) },
  ];
}

/** Paint one shape. Takes the context rather than a canvas so the same code
 *  draws the live overlay and the copy that is composed onto a screenshot. */
export function paintShape(ctx: CanvasRenderingContext2D, s: Shape): void {
  const pts = s.points;
  if (pts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = s.colour;
  ctx.fillStyle = s.colour;
  ctx.lineWidth = s.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const a = pts[0]!;
  const b = pts[pts.length - 1]!;

  if (s.tool === "pen") {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  } else if (s.tool === "arrow") {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    const head = arrowHead(a, b, Math.max(12, s.width * 3.2));
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(head[0].x, head[0].y);
    ctx.lineTo(head[1].x, head[1].y);
    ctx.closePath();
    ctx.fill();
  } else if (s.tool === "box") {
    const r = dragRect(a, b);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  } else {
    const r = dragRect(a, b);
    ctx.beginPath();
    ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

export function paintAll(ctx: CanvasRenderingContext2D, shapes: Shape[]): void {
  for (const s of shapes) paintShape(ctx, s);
}

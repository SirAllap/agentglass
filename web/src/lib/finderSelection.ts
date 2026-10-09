/*
 * Which result is selected, and the only things allowed to change it.
 *
 * The selection is what the viewer shows and what Enter opens. It used to
 * follow the mouse: `onMouseEnter` set it. So a path clicked in a terminal
 * opened the finder on the right file, and then a pointer that happened to be
 * resting over the list moved the selection to whatever row was under it on the
 * next hover, and the preview jumped to another file. A pointer resting is not a
 * choice.
 *
 * The rule, in one place so it can be tested rather than remembered:
 *
 *   hover     highlights only (a CSS tint) — it is not an event this model acts on
 *   click     selects
 *   key       steps, wrapping (arrows, ctrl+n/p, the "1 of N" stepper)
 *   focus     programmatic: a terminal path, a restored selection
 *   reset     the list was rebuilt under the cursor: back to the top
 */
export type SelEvent =
  | { type: "hover"; index: number }
  | { type: "click"; index: number }
  | { type: "key"; dir: 1 | -1 }
  | { type: "focus"; index: number }
  | { type: "reset" };

export function reduceSelection(cursor: number, ev: SelEvent, length: number): number {
  if (length <= 0) return 0;
  switch (ev.type) {
    case "hover": return cursor >= length ? 0 : cursor;
    case "click":
    case "focus": return ev.index >= 0 && ev.index < length ? ev.index : cursor >= length ? 0 : cursor;
    case "key": return ((cursor + ev.dir) % length + length) % length;
    case "reset": return 0;
  }
}

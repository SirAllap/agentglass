/**
 * The small checks every canvas prop is built from, and the numbers that bound
 * a scene. They live here, not in pluginCanvas.ts, so the sheet vocabulary
 * (canvasSheet.ts) and the reducer can both import them: two files that import
 * each other is a cycle the bundler turns into an undefined helper.
 */
import { TONES, type Tone } from "./pluginUi.ts";

export const CANVAS_LIMITS = {
  /** Nodes in one scene. A busy board is dozens; 400 is a runaway plugin. */
  nodes: 400,
  /** The scene serialised, measured after every apply. 400 nodes of the
   *  longest strings would otherwise be megabytes held per panel. */
  sceneBytes: 128 * 1024,
  /** Nesting under the root. stack > fold > row > sheet > plane > token is 6;
   *  two more is room for a wrapper without a second limit. */
  depth: 8,
  /** Any short string: labels, titles, units. */
  label: 120,
  /** `disclosure` text, drawn as plain text in a <pre>. */
  disclosure: 8_000,
  spark: 120,
  options: 8,
  /** Operations in one POST, and the body they arrive in, checked BEFORE it
   *  is parsed (server/src/plugin-canvas.ts). */
  batchOps: 100,
  bodyBytes: 64 * 1024,
  /** Longest motion a plugin may ask for. */
  ms: 2_000,
  /** Looping animations at once (a flowing edge is CANVAS_FLOW_MARKS of them).
   *  Past it they draw still: a hundred spinning rings is a fan, not information. */
  loops: 64,
  /** Simultaneous one-shot motions (`move`, `animate`) the window runs. */
  tweens: 64,
  payloadBytes: 8_192,
  /** Boards in one scene: a stage is a machine, and two is a machine and the
   *  thing it is compared with. */
  boards: 2,
  /** Points in one trace (2 is a straight run, 12 is a wiring harness). */
  points: 12,
  /** Slots in one bay, `cols * rows`. The window draws a slot per cell. */
  slots: 64,
  /** Pips in one gate, each a cell of the window's own drawing. */
  pips: 60,
} as const;

export const CANVAS_ACTIVITY = ["idle", "busy", "flowing"] as const;
export type CanvasActivity = (typeof CANVAS_ACTIVITY)[number];

/** Limits that belong to a sheet (an SVG instrument), kept apart from the
 *  scene-wide ones because each is a cap on work the window does per draw. */
export const SHEET_LIMITS = {
  /** Sheets in one scene: one per `fit`, wide and narrow. */
  sheets: 2,
  folds: 2,
  docks: 12,
  /** SVG elements one sheet may cost, counted by `sheetCost` (canvasSheet.ts),
   *  which is the same function the window's render test measures against. */
  svgNodes: 320,
  tokensPerPlane: 24,
  planesPerSheet: 2,
  edgesPerPlane: 16,
  bandsPerPlane: 4,
  hatchPerSheet: 2,
  /** Lines one hatch may draw. */
  hatchLines: 80,
  ticks: 120,
  segments: 60,
  trail: 12,
  keyEntries: 4,
  numerals: 4,
} as const;

export const CANVAS_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const ACTION_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** A validator returns the cleaned value, or `undefined` for "not valid".
 *  `null` from the plugin means "unset" and is handled before these run. */
export type Check = (v: unknown) => unknown;

/** Control, zero-width and bidi-override characters: a label that reads one
 *  way and sorts or pastes another is how a "Cancel" gets to say "Allow". */
export const INVISIBLE = /[\p{Cc}\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u;
export const shortStr: Check = (v) => (typeof v === "string" && v.length <= CANVAS_LIMITS.label && !INVISIBLE.test(v) ? v : undefined);
export const oneOf = <T extends string>(allowed: readonly T[]): Check => (v) =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? v : undefined;
export const bool: Check = (v) => (typeof v === "boolean" ? v : undefined);
/** Inclusive on both ends. A half-open range is `below`. */
export const num = (min: number, max: number, int = false): Check => (v) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max && (!int || Number.isInteger(v)) ? v : undefined;
/** `min <= v < max`: an angle is below 360, never 360 (which would read as 0). */
export const below = (min: number, max: number): Check => (v) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v < max ? v : undefined;
export const idRef: Check = (v) => (typeof v === "string" && CANVAS_ID_RE.test(v) ? v : undefined);
/** A unit sits last in its element, so a bidi override there reorders what follows it. */
export const unitStr: Check = (v) => (typeof v === "string" && v.length <= 16 && !INVISIBLE.test(v) ? v : undefined);

export const toneCheck: Check = oneOf(TONES as readonly Tone[]);
export const activity: Check = oneOf(CANVAS_ACTIVITY);
export const action: Check = (v) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const a = v as Record<string, unknown>;
  if (typeof a.id !== "string" || !ACTION_ID_RE.test(a.id)) return undefined;
  if (a.payload === undefined) return { id: a.id };
  let json: string;
  try { json = JSON.stringify(a.payload); } catch { return undefined; }
  if (typeof json !== "string" || json.length > CANVAS_LIMITS.payloadBytes) return undefined;
  return { id: a.id, payload: JSON.parse(json) };
};


/*
 * The workflow map's layout and wording decisions, away from the screen.
 *
 * What the page says about a step (its coverage pill), which units of statuses
 * count and which are folded away, where a connector starts and ends, which colour
 * it is drawn in, and which of the page's states a set of facts is. All of it takes
 * numbers and strings and returns numbers and strings, so it is tested alone: there
 * is no renderer in this project, and a rule that lives inside a component can only
 * be asserted against its source.
 *
 * "Unit" is the thing that owns a set of statuses: a list for ClickUp, a board or a
 * project for another tracker. The words come in as `Nouns`.
 */
import { luminance, parseColor } from "./contrast.ts";
import { needsStatus, withCounted, type MapSpace, type Moment, type Nouns, type Step } from "./workflowMap.ts";

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const hasStatus = (u: MapSpace, status: string) => u.statuses.some((x) => same(x.status, status));

/* ---------- which units count ---------- */

export interface Folded { unit: MapSpace }
export interface Partition { counted: MapSpace[]; folded: Folded[] }

/**
 * The units a step can be judged against, and the ones folded away.
 *
 * Which count is the data layer's answer (`counted: false` is an ignored unit; the
 * default is where the person's own cards live, or every unit until a card has been
 * read). An ignored unit is not deleted: it is still here to count again.
 */
export function partitionUnits(units: readonly MapSpace[]): Partition {
  return {
    counted: units.filter((u) => u.counted !== false),
    folded: units.filter((u) => u.counted === false).map((unit) => ({ unit })),
  };
}

/**
 * The unit the status column opens on: the counted one with most of the person's cards (the first
 * among equals), or the only one there is. With several counted and no card to go on it is NONE, so
 * the person is asked to pick instead of being shown the first space of the answer as if it were theirs.
 */
export function defaultUnit(counted: readonly MapSpace[]): MapSpace | null {
  let best: MapSpace | null = null;
  for (const u of counted) if ((u.cards ?? 0) > (best?.cards ?? 0)) best = u;
  return best ?? (counted.length === 1 ? counted[0]! : null);
}

/**
 * What the eye on a unit saves: the ids that count once this one is hidden (if it counts) or shown
 * (if it is hidden). A list place follows its space. Null when hiding would leave nothing counted.
 */
export function eyeIds(units: readonly MapSpace[], u: MapSpace): string[] | null {
  return withCounted(units, u.fromList && u.spaceId ? u.spaceId : u.id, u.counted === false);
}

/** Where a status lives: in the units that count, and in the ones folded away. */
export function statusHome(p: Partition, status: string): { counted: string[]; folded: string[] } {
  return {
    counted: p.counted.filter((u) => hasStatus(u, status)).map((u) => u.name),
    folded: p.folded.filter((f) => hasStatus(f.unit, status)).map((f) => f.unit.name),
  };
}

/* ---------- the coverage pill ---------- */

export type PillTone = "all" | "part" | "none" | "ignored" | "static";
export interface CoveragePill {
  tone: PillTone;
  label: string;
  /** One bar per counted unit: filled where the status exists. */
  bars: boolean[];
  /** The pill opens a per-unit list. Not the static ones, which have nothing to list. */
  expands: boolean;
}

/**
 * What the pill on a step reads. Null when there is nothing honest to say yet (a step
 * that needs a status and has none: the card already says so).
 */
export function coveragePill(p: Partition, step: Step, m: Moment, n: Pick<Nouns, "list" | "lists">): CoveragePill | null {
  const bars = (status: string | null) => p.counted.map((u) => (status ? hasStatus(u, status) : true));
  if (!m.needs) return { tone: "static", label: `Every ${n.list}`, bars: bars(null), expands: false };
  if (!step.status) return m.optional ? { tone: "static", label: "No status: nothing moves", bars: bars(null), expands: false } : null;
  const home = statusHome(p, step.status);
  const k = home.counted.length, total = p.counted.length;
  const b = bars(step.status);
  if (k === 0 && total > 0) {
    return home.folded.length
      ? { tone: "ignored", label: `Only in ignored ${n.lists}`, bars: b, expands: true }
      : { tone: "none", label: `No ${n.list} has it`, bars: b, expands: true };
  }
  if (total === 0) return null;
  if (k === total) return { tone: "all", label: total === 1 ? `In ${home.counted[0]}` : `All ${total} ${n.lists}`, bars: b, expands: true };
  return { tone: "part", label: k === 1 ? `${home.counted[0]} only` : `${k} of ${total} ${n.lists}`, bars: b, expands: true };
}

export interface CoverageRow { unit: MapSpace; has: boolean }
/** The per-unit lines under an opened pill. */
export const coverageRows = (p: Partition, status: string): CoverageRow[] => p.counted.map((unit) => ({ unit, has: hasStatus(unit, status) }));

/** The numbers (1-based, in page order) of the steps that point at a status this unit lacks. A step with no status points at nothing. */
export function notInUnit(steps: readonly Step[], unit: MapSpace | undefined): number[] {
  if (!unit) return [];
  const out: number[] = [];
  steps.forEach((s, i) => { if (s.status && !hasStatus(unit, s.status)) out.push(i + 1); });
  return out;
}

/* ---------- the page's state ---------- */

export type PageState = "out" | "refused" | "fresh" | "off" | "needs" | "gap" | "connected";

/**
 * Which of the page's states the facts add up to, most pressing first. A page can be
 * in more than one at once (a step needing a status beside one that matches nothing);
 * the page-level banner says the first, and every step still wears its own.
 */
export function pageState(f: { connected: boolean; refused: boolean; writes: boolean; steps: readonly Step[]; part: Partition; m: (s: Step) => Moment }): PageState {
  if (!f.connected) return "out";
  if (f.refused) return "refused";
  if (!f.steps.length) return "fresh";
  if (!f.writes) return "off";
  if (f.steps.some((s) => needsStatus(s, f.m(s)))) return "needs";
  if (f.steps.some((s) => s.status && f.part.counted.length > 0 && statusHome(f.part, s.status).counted.length === 0)) return "gap";
  return "connected";
}

/* ---------- the picker's groups ---------- */

export interface PickRow { name: string; type: string; color?: string; bars: boolean[] }
export interface PickGroup { unit: MapSpace; rows: PickRow[]; ignored?: boolean }
export interface PickView {
  groups: PickGroup[];
  folded: PickGroup[];
  /** The folded group is open: it was asked for, or a search reached into it. */
  foldedOpen: boolean;
  /** Names in the order the arrow keys walk them, with the group each belongs to. */
  order: { key: string; name: string }[];
}

/**
 * What the status picker shows: one group per counted unit, each status once in its
 * own group with a bar per counted unit that has it, and the folded units below. A
 * search reaches into the folded ones and opens them, because a match hidden behind a
 * closed fold reads as "not there".
 */
export function pickView(p: Partition, q: string, foldOpen: boolean): PickView {
  const needle = q.trim().toLowerCase();
  const rowsOf = (u: MapSpace, withBars: boolean): PickRow[] =>
    u.statuses.filter((s) => !needle || s.status.toLowerCase().includes(needle))
      .map((s) => ({ name: s.status, type: s.type, ...(s.color ? { color: s.color } : {}), bars: withBars ? p.counted.map((c) => hasStatus(c, s.status)) : [] }));
  const groups = p.counted.map((unit) => ({ unit, rows: rowsOf(unit, true) })).filter((g) => g.rows.length);
  const folded = p.folded.map((f) => ({ unit: f.unit, ignored: true, rows: rowsOf(f.unit, false) })).filter((g) => g.rows.length);
  const foldedOpen = folded.length > 0 && (foldOpen || !!needle);
  const order = [...groups, ...(foldedOpen ? folded : [])].flatMap((g) => g.rows.map((r) => ({ key: `${g.unit.id}:${r.name}`, name: r.name })));
  return { groups, folded, foldedOpen, order };
}

/* ---------- connectors ---------- */

export interface Pt { x: number; y: number }
export interface Wire { id: number; from: Pt; to: Pt; color: string }
export interface Connector extends Wire { d: string; channel: number }

/** How far right of the cards the first connector turns, and the gap between neighbours' turns. */
export const CHANNEL = { lead: 10, step: 7 } as const;

export const connectorPath = (a: Pt, b: Pt, xm: number): string => `M${a.x} ${a.y} C${xm} ${a.y} ${xm} ${b.y} ${b.x} ${b.y}`;

/**
 * The curves between the steps' status controls and the status rows. Each turns in its
 * own channel past the right edge of the cards, so two that cross do not run along
 * one another; the order is the steps' order, which is also the order the numbers read.
 */
export function planConnectors(wires: readonly Wire[], cardsRight: number): Connector[] {
  return wires.map((w, i) => {
    const channel = cardsRight + CHANNEL.lead + i * CHANNEL.step;
    return { ...w, channel, d: connectorPath(w.from, w.to, channel) };
  });
}

/** Do two boxes share any area? Touching edges do not count. */
export const overlaps = (a: DOMRectLike, b: DOMRectLike): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
export interface DOMRectLike { left: number; right: number; top: number; bottom: number }

/** Every pair among the boxes that share area, as indices. Empty means nothing overlaps. */
export function overlappingPairs(boxes: readonly DOMRectLike[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (overlaps(boxes[i]!, boxes[j]!)) out.push([i, j]);
  return out;
}

/* ---------- the connector's colour ---------- */

const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/**
 * A status's own colour, moved until it reads at 3:1 or better on the surface it is
 * drawn over, so a line in it is never lost: darker on a light page, lighter on a dark
 * one. An unparseable colour is returned as it came.
 */
export function lineInk(color: string, paper: string, min = 3.2): string {
  const c = parseColor(color), bg = parseColor(paper);
  if (!c || !bg) return color;
  const L = luminance(bg);
  const toward = L > 0.4 ? 0 : 255;
  let cur = { ...c };
  for (let i = 0; i < 40 && ratio(L, luminance(cur)) < min; i++) {
    cur = { r: Math.round(cur.r + (toward - cur.r) * 0.1), g: Math.round(cur.g + (toward - cur.g) * 0.1), b: Math.round(cur.b + (toward - cur.b) * 0.1) };
  }
  return `rgb(${cur.r}, ${cur.g}, ${cur.b})`;
}
export const lineContrast = (color: string, paper: string): number | null => {
  const c = parseColor(color), bg = parseColor(paper);
  return c && bg ? ratio(luminance(bg), luminance(c)) : null;
};

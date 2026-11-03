// What a Starboard session card says, decided apart from the screen.
//
// The words are the four the design allows: working, waiting on you, quiet N
// min, finished. A session that has said nothing for a while is "quiet" and the
// age is the whole claim. They read the Lantern's rows,
// the same ones the KPI strip counts, so a card and a number cannot disagree.
import type { LanternRow } from "../components/LanternView.tsx";
import { attention } from "../../../shared/fieldRules.ts";

export type CrewState = "working" | "ask" | "quiet" | "done";
export const CREW_ORDER: Record<CrewState, number> = { ask: 0, working: 1, quiet: 2, done: 3 };

/**
 * The Crew list's order: state first, then the most recent, then the dearest.
 * It was state then cost, which put a $175 session from yesterday above a
 * worker that ended a minute ago for six cents: every headless worker sat at
 * the bottom of 33 rows, under a scrollbar, and the Crew read as if none had run.
 */
export const compareCrew = (a: { state: CrewState; since: number; cost: number }, b: { state: CrewState; since: number; cost: number }): number =>
  CREW_ORDER[a.state] - CREW_ORDER[b.state] || b.since - a.since || b.cost - a.cost;
export const CREW_WORD: Record<CrewState, string> = { ask: "waiting on you", working: "working", quiet: "quiet", done: "finished" };

/** Quiet starts after ten minutes of silence; before that a stopped session has just finished. */
export const QUIET_AFTER_MS = 10 * 60_000;

/** The state and when it began, from the row alone. Waiting means a permission
 *  or a gate waiting on you (the rail pip's rule); a turn that ended, or a session with no
 *  pane left, is finished. An idle session whose pane is alive (an open tool
 *  call, a subagent) is still working. */
export function crewState(r: LanternRow, now: number): { state: CrewState; since: number } {
  const last = r.facts?.lastSeen ?? r.saidAt ?? r.startedAt ?? now;
  if (attention(r, now) === "blocked") return { state: "ask", since: r.needsYou?.since ?? last };
  if (r.needsYou?.kind === "input") return { state: "done", since: r.needsYou.since };
  if (r.gone) return { state: "done", since: last };
  if (r.state === "working" || r.alive) return { state: "working", since: last };
  return { state: now - last >= QUIET_AFTER_MS ? "quiet" : "done", since: last };
}

/** The folder name of a project path: a card reads "orbit", not a home directory. */
export const baseName = (p: string): string => p.replace(/\/+$/, "").split("/").pop() || p;

/** "3 min", "2 h": the coarse age a card prints. */
export function ageWord(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

/** Where each session sits on the Orrery: one ring per project (largest first,
 *  at most RINGS; the rest share the last), bodies spread evenly round a ring.
 *  The angle is layout only; the tip says so. */
export const RINGS = 4;
export interface Placed { row: LanternRow; ring: number; angle: number; project: string }
export function orreryLayout(rows: LanternRow[]): { placed: Placed[]; projects: string[]; projectCount: number } {
  const proj = (r: LanternRow) => r.project ?? r.worktree ?? "no project";
  const count = new Map<string, number>();
  for (const r of rows) count.set(proj(r), (count.get(proj(r)) ?? 0) + 1);
  const projects = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([p]) => p);
  const perRing: LanternRow[][] = Array.from({ length: Math.min(RINGS, projects.length) }, () => []);
  for (const r of rows) perRing[Math.min(projects.indexOf(proj(r)), RINGS - 1)]!.push(r);
  const placed: Placed[] = [];
  perRing.forEach((list, ring) => list.forEach((row, i) => {
    // A start offset per ring keeps neighbouring rings from lining up; the half step keeps
    // the first body off the top, where the ring's own label sits.
    placed.push({ row, ring, project: proj(row), angle: (i / list.length) * 360 + 180 / list.length + ring * 47 - 90 });
  }));
  return { placed, projects: projects.slice(0, RINGS), projectCount: projects.length };
}

/**
 * The Orrery's type, in px at the view's own scale (--sb-u = 1).
 *
 * Every rung is one the app already sets — 12 for the ring names, 14 for a
 * session, 11.5 for what it is doing, 10.5 for the core's two words — so the
 * board gained no sixth scale when these went up from 11/13.5/10.5/9.5.
 */
export const ORRERY_TYPE = { ring: 12, name: 14, sub: 11.5, core: 10.5 } as const;

/** The rung at this view's scale. Grown when the view is bigger than the
 *  design's own size and never shrunk below it: scaling the labels down with
 *  the panel is what put the 1920 board's ring names at 10.2px and its status
 *  lines at 9.8px. */
export const orreryType = (px: number, u: number): number => px * Math.max(1, u);

/** A box in the panel's own coordinates: what a label claims. */
export interface Rect { x0: number; y0: number; x1: number; y1: number }
export interface OrreryLabel { lx: number; ly: number; anchor: "start" | "middle" | "end"; name: string; sub: string | null; box: Rect }
export interface OrreryPill { project: string; index: number; text: string; lx: number; ly: number; w: number; h: number; box: Rect }
export interface OrreryBody {
  row: LanternRow; ring: number; angle: number; state: CrewState; age: string; doing: string;
  x: number; y: number; r: number; label: OrreryLabel | null;
}
export interface OrreryPlan {
  w: number; h: number; u: number;
  core: { cx: number; cy: number; r: number };
  /** The centre count's text box: no body's disc may enter it. */
  coreBox: Rect;
  rings: { project: string; index: number; rx: number; ry: number; pill: OrreryPill | null }[];
  bodies: OrreryBody[];
  nameFs: number; subFs: number; ringFs: number; coreFs: number; lineGap: number;
  /** Sessions whose label no spot could hold; they are named on hover only. */
  dropped: number;
}

export const clipText = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

/** What a session's second line says: the claim, the age, or what it is doing. */
export const doingOf = (row: LanternRow, st: CrewState, age: string): string =>
  st === "ask" ? row.needsYou?.why || "waiting for you" : st === "done" ? `finished ${age} ago` : st === "quiet" ? `quiet ${age}` : row.doing ?? "no status line";

export const ringName = (project: string, index: number, projectCount: number): string =>
  index === RINGS - 1 && projectCount > RINGS ? `${projectCount - RINGS + 1} other projects` : clipText(baseName(project), 18);

const textW = (t: string, fs: number) => t.length * 0.62 * fs;
const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const onCircle = (b: Rect, x: number, y: number, r: number) => {
  const nx = Math.max(b.x0, Math.min(x, b.x1));
  const ny = Math.max(b.y0, Math.min(y, b.y1));
  return (nx - x) ** 2 + (ny - y) ** 2 < r * r;
};
const inside = (b: Rect, w: number, h: number) => b.x0 >= 0 && b.y0 >= 0 && b.x1 <= w && b.y1 <= h;

/**
 * The Orrery as boxes: the bodies, each project's pill and each session's
 * label, in the panel's own coordinates.
 *
 * Bodies first, then the project pills claim their box, then each session's
 * label takes the nearest free spot around its own body: its preferred side,
 * then the other side, then above and below, and only then does it drop its
 * status line, shorten its name with an ellipsis or, when no spot is free, go
 * undrawn (the hover card still names it).
 *
 * Pure, so a test can hold the sessions the owner saw collide against the panel
 * sizes a small screen and a 150-200 % zoom produce.
 *
 * Ceiling: six sessions fit at 500x420; more than about twelve at 500 px with
 * the type at 200 % cannot all be named, and the rest stay on hover only.
 */
export function orreryPlan(rows: LanternRow[], now: number, w: number, h: number, u = 1): OrreryPlan {
  const { placed, projects, projectCount } = orreryLayout(rows);
  const sf = Math.max(1, u);
  const nameFs = orreryType(ORRERY_TYPE.name, u), subFs = orreryType(ORRERY_TYPE.sub, u), ringFs = orreryType(ORRERY_TYPE.ring, u);
  const coreFs = orreryType(ORRERY_TYPE.core, u);
  const CX = w / 2, CY = h / 2;
  const RXM = Math.max(80, w / 2 - 190 * u), RYM = Math.max(70, h / 2 - 50 * u);
  /* A panel 500-900 px wide cannot hold the design's 66 px core at a 200 %
     view: it took the middle where the labels have to go. The core keeps its
     size wherever it fits (1400x700, 900x600) and gives way on a small one. */
  const coreR = Math.min(66 * u, RXM * 0.62, RYM * 0.5);
  const coreHalf = Math.max(coreR, textW("88 ON BOARD", coreFs) / 2 + 6 * u);
  const coreBox: Rect = { x0: CX - coreHalf, y0: CY - coreR - 8 * u, x1: CX + coreHalf, y1: CY + coreR + 14 * u };
  /* The innermost ring clears the core on both axes: at a small panel the 0.34
     ring was narrower than the core, so its bodies and their labels sat on the
     count. 0.72 is the most the ring may grow before the labels have no room. */
  const inner = Math.min(0.72, Math.max(0.34, (coreR + 12 * u) / RXM, (0.7 * coreR + 12 * u) / RYM));
  const frac = (i: number) => (projects.length === 1 ? Math.min(1, Math.max(inner, 0.7)) : inner + ((1 - inner) * i) / (projects.length - 1));
  const lineGap = 15 * sf;

  const bodies: OrreryBody[] = placed.map(({ row, ring, angle }) => {
    const a = (angle * Math.PI) / 180;
    const { state, since } = crewState(row, now);
    const age = ageWord(since, now);
    return {
      row, ring, angle, state, age, doing: doingOf(row, state, age),
      x: CX + Math.cos(a) * RXM * frac(ring), y: CY + Math.sin(a) * RYM * frac(ring),
      r: (12 + Math.sqrt(Math.max(0, row.facts?.cost ?? 0)) * 3.1) * u,
      label: null,
    };
  });

  /* A body over the centre count hid the number the panel exists to show. Each
     disc is pushed out of the count's box by a gap, and overlapping discs
     separate or shrink; the SVG also paints the count after the bodies. */
  const pad = 4 * u, gap = 3 * u;
  const dir = (b: OrreryBody) => {
    const a = (b.angle * Math.PI) / 180;
    return { dx: Math.cos(a) * RXM, dy: Math.sin(a) * RYM };
  };
  /** The furthest out this body may go and still keep its disc in the panel. */
  const capOf = (b: OrreryBody) => {
    const { dx, dy } = dir(b);
    const sx = dx > 0 ? (w - pad - b.r - CX) / dx : dx < 0 ? (CX - pad - b.r) / -dx : Infinity;
    const sy = dy > 0 ? (h - pad - b.r - CY) / dy : dy < 0 ? (CY - pad - b.r) / -dy : Infinity;
    return Math.max(0, Math.min(sx, sy));
  };
  /** The nearest this body may come: where its edge leaves the count's box. */
  const gateOf = (b: OrreryBody) => {
    const { dx, dy } = dir(b);
    const reach = b.r + gap;
    const sx = dx > 0 ? (coreBox.x1 - CX + reach) / dx : dx < 0 ? (CX - coreBox.x0 + reach) / -dx : Infinity;
    const sy = dy > 0 ? (coreBox.y1 - CY + reach) / dy : dy < 0 ? (CY - coreBox.y0 + reach) / -dy : Infinity;
    return Math.min(sx, sy);
  };
  const put = (b: OrreryBody, s: number) => {
    const { dx, dy } = dir(b);
    b.x = CX + dx * s;
    b.y = CY + dy * s;
  };
  for (const b of bodies) while (b.r > 2 * u && gateOf(b) > capOf(b)) b.r *= 0.9;
  const at = bodies.map((b) => Math.min(capOf(b), Math.max(frac(b.ring), gateOf(b))));
  bodies.forEach((b, i) => put(b, at[i]!));

  for (let pass = 0; pass < 200; pass++) {
    let moved = false;
    for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i]!, b = bodies[j]!;
      const d = Math.hypot(a.x - b.x, a.y - b.y), need = a.r + b.r + gap;
      if (d >= need) continue;
      moved = true;
      /* Move the outer body out, where that widens the gap; with no room left,
         both discs shrink instead of overlapping. */
      const o = at[j]! >= at[i]! ? j : i;
      const outer = bodies[o]!;
      const step = (need - d) / Math.max(1, Math.min(RXM, RYM));
      if (at[o]! + step <= capOf(outer)) {
        at[o] = at[o]! + step;
        put(outer, at[o]!);
      } else {
        const cut = (need - d) * 0.4;
        a.r = Math.max(2 * u, a.r - cut);
        b.r = Math.max(2 * u, b.r - cut);
      }
    }
    if (!moved) break;
  }

  /* Every box claimed so far: the core's count, the pills, the labels. A label
     may sit beside its own disc but on no other. */
  const claimed: Rect[] = [coreBox];
  const free = (box: Rect, self: number): boolean =>
    inside(box, w, h) &&
    !claimed.some((c) => overlaps(box, c)) &&
    !bodies.some((q, j) => j !== self && onCircle(box, q.x, q.y, q.r + 2 * u));
  const claim = (box: Rect) => { claimed.push(box); };

  /* Pills claim before any session: a project name is not a passenger. The wide
     pill is the design's own; it only shrinks to its text when the panel cannot
     hold it. */
  const pillH = 18 * u;
  const pillBox = (cx: number, cy: number, pw: number): Rect => ({ x0: cx - pw / 2, y0: cy - pillH / 2, x1: cx + pw / 2, y1: cy + pillH / 2 });
  const pills: { rx: number; ry: number; pill: OrreryPill | null }[] = projects.map((p, i) => {
    const angles = bodies.filter((q) => q.ring === i).map((q) => q.angle);
    const clearance = (c: number) => Math.min(360, ...angles.map((a) => Math.abs((((a - c) % 360) + 540) % 360 - 180)));
    const order: number[] = [];
    for (let c = -180; c < 180; c += 6) order.push(c);
    order.sort((a, b) => clearance(b) - clearance(a));
    const full = ringName(p, i, projectCount);
    const fit = (t: string) => textW(t, ringFs) + 20 * u;
    const variants = [{ text: full, pw: Math.max(120 * u, fit(full)) }, { text: full, pw: fit(full) },
      { text: clipText(full, 12), pw: fit(clipText(full, 12)) }, { text: clipText(full, 8), pw: fit(clipText(full, 8)) }];
    for (const { text, pw } of variants) {
      /* A crowded ring pushes its pill out along the same ray, never onto a
         session: the badge still names the orbit it sits on. */
      for (const grow of [1, 1.12, 1.25, 1.5, 1.8, 2.2]) for (const c of order) {
        const a = (c * Math.PI) / 180;
        const px = CX + Math.cos(a) * RXM * frac(i) * grow, py = CY + Math.sin(a) * RYM * frac(i) * grow;
        const d = Math.hypot(px - CX, py - CY);
        const k = d < coreR + 12 * u ? (coreR + 12 * u) / Math.max(1, d) : 1;
        const box = pillBox(Math.min(Math.max(CX + (px - CX) * k, pw / 2), w - pw / 2), Math.min(Math.max(CY + (py - CY) * k, pillH / 2), h - pillH / 2), pw);
        if (!free(box, -1)) continue;
        claim(box);
        return { rx: RXM * frac(i), ry: RYM * frac(i), pill: { project: p, index: i, text, lx: (box.x0 + box.x1) / 2, ly: (box.y0 + box.y1) / 2, w: pw, h: pillH, box } };
      }
    }
    return { rx: RXM * frac(i), ry: RYM * frac(i), pill: null };
  });

  const nameOnlyH = 1.3 * nameFs;
  const under = lineGap + 0.95 * subFs;
  const blockH = 0.85 * nameFs + under;
  const step = Math.max(6 * u, blockH / 2);

  const candidates = function* (b: OrreryBody, tw: number, hgt: number): Generator<Rect> {
    const first = b.x >= CX ? 1 : -1;
    for (const side of [first, -first]) {
      const x0 = side > 0 ? b.x + b.r + 8 * u : b.x - b.r - 8 * u;
      const left = side > 0 ? Math.min(Math.max(x0, 2), Math.max(2, w - 2 - tw)) : Math.min(Math.max(x0 - tw, 2), Math.max(2, w - 2 - tw));
      const want = b.y - 0.85 * nameFs;
      for (let d = 0; d <= h; d += step) {
        for (const dy of d === 0 ? [0] : [-d, d]) {
          yield { x0: left, y0: want + dy, x1: left + tw, y1: want + dy + hgt };
        }
      }
    }
    for (const up of [true, false]) {
      const y0 = up ? b.y - b.r - 6 * u - hgt : b.y + b.r + 6 * u;
      for (let d = 0; d <= w; d += step) {
        for (const dx of d === 0 ? [0] : [-d, d]) {
          const x0 = Math.min(Math.max(b.x - tw / 2 + dx, 2), Math.max(2, w - 2 - tw));
          yield { x0, y0, x1: x0 + tw, y1: y0 + hgt };
        }
      }
    }
  };

  let dropped = 0;
  for (const [i, b] of bodies.entries()) {
    const full = clipText(b.row.name, 20), sub = clipText(b.doing, 26);
    const variants: { name: string; sub: string | null; tw: number }[] = [
      { name: full, sub, tw: Math.max(textW(full, nameFs), textW(sub, subFs)) },
      { name: full, sub: null, tw: textW(full, nameFs) },
      { name: clipText(full, 12), sub: null, tw: textW(clipText(full, 12), nameFs) },
      { name: clipText(full, 8), sub: null, tw: textW(clipText(full, 8), nameFs) },
    ];
    for (const v of variants) {
      const hgt = v.sub ? blockH : nameOnlyH;
      let found: Rect | null = null;
      for (const box of candidates(b, v.tw, hgt)) if (free(box, i)) { found = box; break; }
      if (!found) continue;
      claim(found);
      b.label = { lx: found.x0, ly: found.y0 + 0.85 * nameFs, anchor: "start", name: v.name, sub: v.sub, box: found };
      break;
    }
    if (!b.label) dropped++;
  }

  return {
    w, h, u, core: { cx: CX, cy: CY, r: coreR }, coreBox,
    rings: pills.map((r, i) => ({ project: projects[i]!, index: i, rx: r.rx, ry: r.ry, pill: r.pill })),
    bodies, nameFs, subFs, ringFs, coreFs, lineGap, dropped,
  };
}

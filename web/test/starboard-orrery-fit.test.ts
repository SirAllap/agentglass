// The Orrery as boxes, at the sizes the owner photographed: a panel 500-900 px
// wide with the view's type at 150-200 % (a narrow window, or the app zoomed).
// The names are invented; the collision they reproduce is not.
import { test, expect, describe } from "bun:test";
import { orreryPlan, type Rect } from "../src/lib/starboardCrew.ts";
import type { LanternRow } from "../src/components/LanternView.tsx";

const NOW = 1_000_000_000;
const GLASS = "/home/dev/code/agentglass";
const ORBIT = "/home/dev/code/orbit";
const row = (name: string, project: string, o: Partial<LanternRow> = {}): LanternRow =>
  ({ name, project, from: "said", state: "idle", saidAt: NOW - 600_000, facts: { tools: 3, errors: 0, turns: 2, cost: 2 }, ...o } as LanternRow);

const SESSIONS: LanternRow[] = [
  row("polaris setup", GLASS, { state: "working", doing: "running the suite", facts: { tools: 9, errors: 0, turns: 4, cost: 6 } }),
  row("agx-orchestrator", GLASS, { state: "working", doing: "watching four tabs", facts: { tools: 4, errors: 0, turns: 9, cost: 11 } }),
  row("orchestrator-quiet", GLASS, { needsYou: { kind: "permission", why: "wants to run Bash", since: NOW - 7200_000 } }),
  row("release-v100-prep", GLASS, { doing: "cutting the release", facts: { tools: 6, errors: 1, turns: 3, cost: 9 } }),
  row("red-guards", ORBIT, { state: "working", doing: "rerunning the red tests", facts: { tools: 5, errors: 0, turns: 2, cost: 4 } }),
  row("live-asks", ORBIT, { doing: "triaging the queue", facts: { tools: 2, errors: 0, turns: 1, cost: 3 } }),
];

const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const onCircle = (b: Rect, x: number, y: number, r: number) => {
  const nx = Math.max(b.x0, Math.min(x, b.x1));
  const ny = Math.max(b.y0, Math.min(y, b.y1));
  return (nx - x) ** 2 + (ny - y) ** 2 < r * r;
};

// A panel of each size, at the design's own type and at the zoom the screenshots
// show. The wide one is here so the fix cannot buy a small panel by breaking a
// large one.
const CASES = [
  { w: 500, h: 420, u: 1 },
  { w: 640, h: 520, u: 1 },
  { w: 900, h: 600, u: 1 },
  { w: 1400, h: 700, u: 1 },
  { w: 500, h: 420, u: 2 },
  { w: 640, h: 520, u: 1.5 },
  { w: 900, h: 600, u: 1.5 },
] as const;

for (const { w, h, u } of CASES) describe(`the Orrery's labels at ${w} x ${h}, type at ${u}`, () => {
  const plan = orreryPlan(SESSIONS, NOW, w, h, u);
  const labels = plan.bodies.flatMap((b, i) => b.label ? [{ i, box: b.label.box, what: b.row.name }] : []);
  const pills = plan.rings.flatMap((r) => r.pill ? [{ box: r.pill.box, what: `project ${r.pill.text}` }] : []);
  const boxes = [...pills, ...labels];

  test("every session and every project is named", () => {
    expect(labels.map((l) => l.what)).toEqual(SESSIONS.map((s) => s.name));
    expect(pills.length).toBe(2);
  });

  test("no label leaves the panel", () => {
    for (const b of boxes) {
      expect([b.what, Math.round(b.box.x0), Math.round(b.box.y0), Math.round(b.box.x1), Math.round(b.box.y1)])
        .toEqual([b.what, Math.max(0, Math.round(b.box.x0)), Math.max(0, Math.round(b.box.y0)), Math.min(w, Math.round(b.box.x1)), Math.min(h, Math.round(b.box.y1))]);
    }
  });

  test("no two labels overlap", () => {
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect([boxes[i]!.what, boxes[j]!.what, overlaps(boxes[i]!.box, boxes[j]!.box)]).toEqual([boxes[i]!.what, boxes[j]!.what, false]);
      }
    }
  });

  test("no label sits on a body that is not its own", () => {
    for (const l of labels) {
      for (const [j, body] of plan.bodies.entries()) {
        if (j === l.i) continue;
        expect([l.what, body.row.name, onCircle(l.box, body.x, body.y, body.r)]).toEqual([l.what, body.row.name, false]);
      }
    }
  });
});

// The same panel without a label's help: what the boxes themselves claim, at
// every count the board can draw, so a crowded ring cannot buy a small panel by
// drawing a disc over the count or over another session.
const COUNTS = [1, 2, 3, 4, 6, 8, 10, 12];
const many = (n: number): LanternRow[] => Array.from({ length: n }, (_, i) =>
  row(`orbit-worker ${i + 1}`, i % 2 ? ORBIT : GLASS, { doing: "holding the line", facts: { tools: 2, errors: 0, turns: 1, cost: [0.5, 2, 6, 12][i % 4]! } }));
const distanceToRect = (b: Rect, x: number, y: number): number => {
  const nx = Math.max(b.x0, Math.min(x, b.x1)), ny = Math.max(b.y0, Math.min(y, b.y1));
  return Math.hypot(nx - x, ny - y);
};

for (const { w, h, u } of CASES) describe(`the Orrery's bodies at ${w} x ${h}, type at ${u}`, () => {
  for (const n of COUNTS) test(`${n} sessions keep off the centre count and each other`, () => {
    const plan = orreryPlan(many(n), NOW, w, h, u);
    for (const b of plan.bodies) {
      expect([b.row.name, distanceToRect(plan.coreBox, b.x, b.y) >= b.r]).toEqual([b.row.name, true]);
      expect([b.row.name, b.x - b.r >= 0 && b.y - b.r >= 0 && b.x + b.r <= w && b.y + b.r <= h]).toEqual([b.row.name, true]);
    }
    for (let i = 0; i < plan.bodies.length; i++) for (let j = i + 1; j < plan.bodies.length; j++) {
      const a = plan.bodies[i]!, b = plan.bodies[j]!;
      expect([a.row.name, b.row.name, Math.hypot(a.x - b.x, a.y - b.y) >= a.r + b.r]).toEqual([a.row.name, b.row.name, true]);
    }
    const boxes = [...plan.bodies.flatMap((b) => b.label ? [{ what: b.row.name, box: b.label.box }] : []),
      ...plan.rings.flatMap((r) => r.pill ? [{ what: `project ${r.pill.text}`, box: r.pill.box }] : [])];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      expect([boxes[i]!.what, boxes[j]!.what, overlaps(boxes[i]!.box, boxes[j]!.box)]).toEqual([boxes[i]!.what, boxes[j]!.what, false]);
    }
  });
});


// The crowded case the panel has to be honest about: at 900x420 with the type
// at 150 % the planner runs out of clean spots, and a name that is not drawn
// still has its hover card.
describe("a crowded small panel", () => {
  const crowd: LanternRow[] = Array.from({ length: 28 }, (_, i) =>
    row(`session-with-a-long-name-${i}`, [GLASS, ORBIT, "/home/dev/code/ledger", "/home/dev/code/site"][i % 4]!,
      { state: i % 3 ? "idle" : "working", facts: { tools: 3, errors: 0, turns: 2, cost: 2 + i } }));

  test("leaves names out, so the count the panel prints is a real one", () => {
    expect(orreryPlan(crowd, NOW, 900, 420, 1.5).dropped).toBeGreaterThan(0);
  });

  test("drops none of them when the panel has the room", () => {
    expect(orreryPlan(crowd, NOW, 900, 420, 1).dropped).toBe(0);
  });
});

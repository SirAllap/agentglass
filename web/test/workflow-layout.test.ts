/*
 * The workflow map's layout and wording decisions, each asserted away from the screen:
 * which lists count and which are folded, what a step's coverage pill says, where a
 * connector starts and ends, the colour it is drawn in, and which state the page is in.
 *
 * The fixture is the shape of a real workspace: three lists that share most of their
 * statuses and differ in a few, and three spaces nobody's cards live in. A status typed
 * in another case still lands on its list.
 */
import { describe, expect, test } from "bun:test";
import {
  CHANNEL, connectorPath, coveragePill, coverageRows, lineContrast, lineInk, notInUnit, overlappingPairs, overlaps,
  pageState, partitionUnits, pickView, planConnectors, statusHome,
} from "../src/lib/workflowLayout.ts";
import { CLICKUP } from "../src/lib/clickupWorkflow.ts";
import { moments, type MapSpace, type Step } from "../src/lib/workflowMap.ts";

const st = (status: string, type = "custom", color?: string) => ({ status, type, ...(color ? { color } : {}) });
const U = (id: string, name: string, statuses: ReturnType<typeof st>[], over: Partial<MapSpace> = {}): MapSpace => ({ id, name, statuses, ...over });
const SPRINT = U("1", "Sprint 42", [st("to do", "open"), st("code review", "custom", "#e0a800"), st("ready for release"), st("done", "done")], { group: "Engineering" });
const BUGS = U("2", "Bugs", [st("open", "open"), st("code review"), st("done", "done")], { group: "Engineering" });
const SUPPORT = U("3", "Support inbox", [st("open", "open"), st("waiting on customer"), st("done", "done")], { group: "Support" });
const SALES = U("4", "Sales pipeline", [st("lead", "open"), st("won", "done")]);
const BRAND = U("5", "Brand assets", [st("idea", "open"), st("approved", "done")]);
const ALL = [SPRINT, BUGS, SUPPORT, SALES, BRAND];
const M = moments(CLICKUP.nouns);
const step = (kind: Step["kind"], status: string | null): Step => ({ kind, status, also: [], unassign: "none", assign: { who: "none" } });
const m = (s: Step) => M[s.kind];

/** The data layer's answer: an ignored unit says `counted: false`; absent counts. */
const ign = (u: MapSpace): MapSpace => ({ ...u, counted: false });
const only = (ids: string[], all = ALL) => partitionUnits(all.map((u) => (ids.includes(u.id) ? u : ign(u))));

describe("which lists count", () => {
  test("nothing ignored: every list counts and nothing is folded", () => {
    const p = partitionUnits(ALL);
    expect(p.counted.map((u) => u.name)).toEqual(ALL.map((u) => u.name));
    expect(p.folded).toEqual([]);
  });

  test("an ignored list is folded, not dropped, and keeps its place in the order it came", () => {
    const p = partitionUnits([SPRINT, ign(BUGS), SUPPORT, ign(SALES)]);
    expect(p.counted.map((u) => u.name)).toEqual(["Sprint 42", "Support inbox"]);
    expect(p.folded.map((f) => f.unit.name)).toEqual(["Bugs", "Sales pipeline"]);
  });

  test("everything ignored counts nothing, and every list is still there to count again", () => {
    const p = partitionUnits(ALL.map(ign));
    expect(p.counted).toEqual([]);
    expect(p.folded).toHaveLength(ALL.length);
  });

  test("a status is found in the counted lists and, separately, in the folded ones, whatever its case", () => {
    const p = only(["1", "2", "3"]);
    expect(statusHome(p, "Code Review")).toEqual({ counted: ["Sprint 42", "Bugs"], folded: [] });
    expect(statusHome(p, "lead")).toEqual({ counted: [], folded: ["Sales pipeline"] });
    expect(statusHome(p, "qa passed")).toEqual({ counted: [], folded: [] });
  });
});

describe("the coverage pill", () => {
  const part = only(["1", "2", "3"]);
  const pill = (s: Step, p = part) => coveragePill(p, s, m(s), CLICKUP.nouns);

  test("a status in every counted list says so, with a filled bar for each", () => {
    expect(pill(step("merge", "done"))).toMatchObject({ tone: "all", label: "All 3 lists", bars: [true, true, true], expands: true });
  });

  test("a status in one list names it; in some, counts them; the bars show which", () => {
    expect(pill(step("move", "ready for release"))).toMatchObject({ tone: "part", label: "Sprint 42 only", bars: [true, false, false] });
    expect(pill(step("menu", "code review"))).toMatchObject({ tone: "part", label: "2 of 3 lists", bars: [true, true, false] });
  });

  test("a status no counted list has says so; if only an ignored list has it, it says that instead", () => {
    expect(pill(step("move", "qa passed"))).toMatchObject({ tone: "none", label: "No list has it", bars: [false, false, false] });
    expect(pill(step("move", "lead"))).toMatchObject({ tone: "ignored", label: "Only in ignored lists" });
  });

  test("one counted list is named, not 'all 1 lists'", () => {
    expect(pill(step("menu", "code review"), only(["1"]))).toMatchObject({ tone: "all", label: "In Sprint 42" });
  });

  test("a step with no status: the merge choice says nothing moves, the others have nothing to say yet", () => {
    expect(pill(step("merge", null))).toMatchObject({ tone: "static", label: "No status: nothing moves", expands: false });
    expect(pill(step("move", null))).toBeNull();
  });

  test("a step that needs no status reaches every list, and has no per-list detail to open", () => {
    expect(pill(step("note", null))).toMatchObject({ tone: "static", label: "Every list", bars: [true, true, true], expands: false });
  });

  test("with no list counted there is nothing to compare against, so no pill and no false 'no list has it'", () => {
    expect(pill(step("move", "done"), partitionUnits(ALL.map(ign)))).toBeNull();
  });

  test("the opened pill has a line per counted list with the reason", () => {
    expect(coverageRows(part, "lead").map((r) => [r.unit.name, r.has])).toEqual([["Sprint 42", false], ["Bugs", false], ["Support inbox", false]]);
    expect(coverageRows(part, "open").map((r) => r.has)).toEqual([false, true, true]);
  });

  test("the steps a list lacks are numbered by their place in the page, and a step with no status points at nothing", () => {
    const steps = [step("move", "ready for release"), step("menu", "code review"), step("merge", "done"), step("note", null)];
    expect(notInUnit(steps, BUGS)).toEqual([1]);
    expect(notInUnit(steps, SPRINT)).toEqual([]);
    expect(notInUnit(steps, undefined)).toEqual([]);
    expect(notInUnit([step("menu", null)], BUGS)).toEqual([]);
  });
});

describe("which state the page is in", () => {
  const part = only(["1", "2", "3"]);
  const base = { connected: true, refused: false, writes: true, steps: [step("move", "ready for release")], part, m };
  test("most pressing first: not connected, then refused, then no steps, then changes off", () => {
    expect(pageState({ ...base, connected: false, refused: true })).toBe("out");
    expect(pageState({ ...base, refused: true })).toBe("refused");
    expect(pageState({ ...base, steps: [], writes: false })).toBe("fresh");
    expect(pageState({ ...base, writes: false, steps: [step("move", null)] })).toBe("off");
  });
  test("a step needing a status outranks one that matches nothing, which outranks a healthy page", () => {
    expect(pageState({ ...base, steps: [step("move", "qa passed"), step("menu", null)] })).toBe("needs");
    expect(pageState({ ...base, steps: [step("move", "qa passed")] })).toBe("gap");
    expect(pageState(base)).toBe("connected");
  });
  test("a status only an ignored list has is a gap too; no counted list at all is not one", () => {
    expect(pageState({ ...base, steps: [step("move", "lead")] })).toBe("gap");
    expect(pageState({ ...base, part: partitionUnits(ALL.map(ign)) })).toBe("connected");
  });
});

describe("the picker", () => {
  const part = only(["1", "2", "3"]);
  test("a group per counted list, each status once in its own group, with a bar per counted list that has it", () => {
    const v = pickView(part, "", false);
    expect(v.groups.map((g) => g.unit.name)).toEqual(["Sprint 42", "Bugs", "Support inbox"]);
    expect(v.groups[0]!.rows.find((r) => r.name === "ready for release")!.bars).toEqual([true, false, false]);
    expect(v.groups[1]!.rows.find((r) => r.name === "code review")!.bars).toEqual([true, true, false]);
    expect(v.foldedOpen).toBe(false);
    expect(v.order.some((o) => o.name === "lead")).toBe(false);
  });
  test("the same status in two lists is two rows with two keys, so the arrows walk both and a key never repeats", () => {
    const keys = pickView(part, "", false).order.map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(pickView(part, "code review", false).order.map((o) => o.key)).toEqual(["1:code review", "2:code review"]);
  });
  test("the folded lists stay shut until asked, and a search that reaches into them opens them", () => {
    expect(pickView(part, "", false).folded.map((g) => g.unit.name)).toEqual(["Sales pipeline", "Brand assets"]);
    const searched = pickView(part, "lead", false);
    expect(searched.foldedOpen).toBe(true);
    expect(searched.groups).toEqual([]);
    expect(searched.order.map((o) => o.name)).toEqual(["lead"]);
    expect(pickView(part, "", true).foldedOpen).toBe(true);
  });
  test("no match anywhere is empty, and the fold is not left open over nothing", () => {
    const v = pickView(part, "zzz", true);
    expect(v.groups).toEqual([]);
    expect(v.folded).toEqual([]);
    expect(v.foldedOpen).toBe(false);
    expect(v.order).toEqual([]);
  });
});

describe("connectors", () => {
  const wires = [
    { id: 1, from: { x: 600, y: 100 }, to: { x: 700, y: 300 }, color: "#c60" },
    { id: 2, from: { x: 600, y: 220 }, to: { x: 700, y: 260 }, color: "#060" },
    { id: 3, from: { x: 600, y: 400 }, to: { x: 700, y: 200 }, color: "#006" },
  ];
  test("each starts where the card's control is and ends on the status's dot, and turns past the cards", () => {
    const c = planConnectors(wires, 620);
    expect(c.map((x) => x.d.split(" ").slice(0, 2).join(" "))).toEqual(["M600 100", "M600 220", "M600 400"]);
    expect(c[0]!.d).toBe(connectorPath(wires[0]!.from, wires[0]!.to, 630));
    expect(c[0]!.d.endsWith("700 300")).toBe(true);
  });
  test("every turn has its own channel, in step order, so two that cross never run along one another", () => {
    const ch = planConnectors(wires, 620).map((x) => x.channel);
    expect(ch).toEqual([620 + CHANNEL.lead, 620 + CHANNEL.lead + CHANNEL.step, 620 + CHANNEL.lead + 2 * CHANNEL.step]);
    expect(new Set(ch).size).toBe(3);
  });
  test("nothing to draw is nothing drawn", () => {
    expect(planConnectors([], 620)).toEqual([]);
  });
});

describe("the connector's colour", () => {
  const LIGHT = "rgb(255, 252, 240)", DARK = "rgb(13, 17, 23)";
  test("a pale status colour is darkened until it reads at 3:1 on a light page", () => {
    for (const c of ["#ffd23f", "#c8d0d8", "#9be39b"]) {
      expect(lineContrast(c, LIGHT)!).toBeLessThan(3);
      expect(lineContrast(lineInk(c, LIGHT), LIGHT)!).toBeGreaterThanOrEqual(3);
    }
  });
  test("a dark status colour is lightened on a dark page instead", () => {
    for (const c of ["#0a2a1a", "#12306a", "#1b1b6b"]) {
      expect(lineContrast(c, DARK)!).toBeLessThan(3);
      expect(lineContrast(lineInk(c, DARK), DARK)!).toBeGreaterThanOrEqual(3);
    }
  });
  test("a colour that already reads is left as it is, and one we cannot parse is returned untouched", () => {
    expect(lineInk("rgb(32, 94, 166)", LIGHT)).toBe("rgb(32, 94, 166)");
    expect(lineContrast("#205ea6", LIGHT)!).toBeGreaterThanOrEqual(3);
    expect(lineInk("var(--x)", LIGHT)).toBe("var(--x)");
  });
});

describe("nothing overlaps", () => {
  const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });
  test("boxes that share area overlap, boxes that only touch do not", () => {
    expect(overlaps(box(0, 0, 10, 10), box(5, 5, 15, 15))).toBe(true);
    expect(overlaps(box(0, 0, 10, 10), box(10, 0, 20, 10))).toBe(false);
    expect(overlaps(box(0, 0, 10, 10), box(0, 10, 10, 20))).toBe(false);
  });
  test("a column of cards beside a status column has no pair that overlaps; a card pushed into the column does", () => {
    const cards = [box(0, 0, 600, 200), box(0, 216, 600, 400)];
    const col = box(648, 0, 928, 500);
    expect(overlappingPairs([...cards, col])).toEqual([]);
    expect(overlappingPairs([...cards, box(590, 0, 928, 500)])).toEqual([[0, 2], [1, 2]]);
  });
});

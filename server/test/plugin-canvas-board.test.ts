/*
 * The board vocabulary (shared/pluginCanvas.ts): a fixed-coordinate stage of
 * parts, bays and traces that a plugin drawing a machine (a pipeline, a build
 * farm) uses instead of the flow layout. Each structural rule is asserted on
 * add AND on move, and each new prop is attacked the way the old ones are.
 */
import { describe, expect, test } from "bun:test";
import { CANVAS_FLOW_MARKS, CANVAS_LIMITS, applyOps, loopingIds, validateScene, type CanvasScene } from "../../shared/pluginCanvas.ts";

const add = (node: Record<string, unknown>, before?: string) => ({ op: "add", node, ...(before ? { before } : {}) });
const ok = (ops: unknown[], scene: CanvasScene = []) => {
  const r = applyOps(scene, ops);
  if (!r.ok) throw new Error(r.error);
  return r.value.scene;
};
const bad = (ops: unknown[], scene: CanvasScene = machine()) => {
  const r = applyOps(scene, ops);
  expect(r.ok, JSON.stringify(ops)).toBe(false);
  return r.ok ? "" : r.error;
};
const BOARD = { id: "b1", type: "board", w: 1180, h: 560, material: "glass", label: "acme/orbit" };
const PART = { id: "p1", type: "part", parent: "b1", x: 40, y: 60, w: 300, h: 200, depth: 2, step: 1, title: "Inbox", hint: "ORBIT-1042" };
const machine = (): CanvasScene =>
  ok([
    add(BOARD),
    add(PART),
    add({ id: "p2", type: "part", parent: "b1", x: 500, y: 60, w: 300, h: 200 }),
    add({ id: "bay1", type: "bay", parent: "p1", cols: 4, rows: 3, caption: "queue" }),
    add({ id: "t1", type: "token", label: "note", parent: "bay1" }),
    add({ id: "lbl", type: "label", text: "free", parent: "p2" }),
    add({ id: "tr", type: "edge", parent: "b1", from: "p1", to: "p2", kind: "trace", activity: "flowing", points: [[340, 160], [420, 160], [420, 100], [500, 100]] }),
  ]);
const get = (s: CanvasScene, id: string) => s.find((n) => n.id === id);

describe("a board that draws a machine", () => {
  test("a board of parts, a bay of tokens and a trace with points is one valid scene", () => {
    const s = machine();
    expect(s.map((n) => n.type)).toEqual(["board", "part", "part", "bay", "token", "label", "edge"]);
    expect(get(s, "tr")?.points).toEqual([[340, 160], [420, 160], [420, 100], [500, 100]]);
    const again = validateScene(s);
    expect(again.ok).toBe(true);
  });

  test("the instrument leaves take their props", () => {
    const s = ok([
      add({ id: "g", type: "gate", parent: "p2", state: "closed", value: 12, max: 60, label: "rate", tone: "warning" }),
      add({ id: "pr", type: "press", parent: "p2", activity: "busy", label: "redact" }),
      add({ id: "c", type: "core", parent: "p1", title: "CALL", value: "0.4", unit: "s", hint: "median", hint2: "p95", activity: "busy", tone: "accent" }),
      add({ id: "i", type: "item", parent: "p1", title: "Fix ORBIT-1042", rank: 1, meta: "0.91 0.92", badge: "waiting", badgeTone: "warning", dim: true, selected: false, action: { id: "inspect" } }),
      add({ id: "l", type: "lamp", parent: "p2", tone: "success", label: "GitHub", on: true }),
      add({ id: "ga", type: "gauge", parent: "p2", shape: "needle", value: 0.4, max: 1, digits: 2, hideMax: true }),
      add({ id: "co", type: "counter", parent: "p2", label: "cost", value: 12.5, digits: 5, prefix: "$", style: "odometer" }),
      add({ id: "sg", type: "segmented", parent: "p2", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], value: "a", action: { id: "mode" }, style: "lever" }),
      add({ id: "cd", type: "countdown", parent: "p2", until: 1e12, shape: "ring", period: 60 }),
    ], machine());
    expect(get(s, "g")?.state).toBe("closed");
    expect(get(s, "ga")?.shape).toBe("needle");
  });

  test("the extended props refuse what is out of range", () => {
    const at = (node: Record<string, unknown>) => bad([add({ parent: node.type === "edge" ? "b1" : "p2", ...node })]);
    at({ id: "x", type: "gate" }); // state is required
    at({ id: "x", type: "gate", state: "ajar" });
    at({ id: "x", type: "gate", state: "open", max: 61 });
    at({ id: "x", type: "gate", state: "open", max: 1.5 });
    at({ id: "x", type: "gate", state: "open", value: -1 });
    at({ id: "x", type: "item" }); // title is required
    at({ id: "x", type: "item", title: "t", rank: 0 });
    at({ id: "x", type: "item", title: "t", rank: 1000 });
    at({ id: "x", type: "item", title: "t", badgeTone: "pink" });
    at({ id: "x", type: "gauge", shape: "dial", value: 1, max: 1 });
    at({ id: "x", type: "gauge", shape: "needle", value: 1, max: 1, digits: 5 });
    at({ id: "x", type: "counter", label: "c", value: 1, digits: 7 });
    at({ id: "x", type: "counter", label: "c", value: 1, prefix: "12345" });
    at({ id: "x", type: "counter", label: "c", value: 1, prefix: "‮$" });
    at({ id: "x", type: "counter", label: "c", value: 1, style: "slot" });
    at({ id: "x", type: "segmented", options: [{ value: "a", label: "A" }], value: "a", action: { id: "m" }, style: "dial" });
    at({ id: "x", type: "countdown", until: 1, shape: "bar" });
    at({ id: "x", type: "countdown", until: 1, period: 0 });
    at({ id: "x", type: "countdown", until: 1, period: 86401 });
    at({ id: "x", type: "edge", from: "p1", to: "p2", kind: "wire" });
  });
});

describe("where each new type may live", () => {
  test("a board only at the root, and at most two per scene", () => {
    bad([add({ ...BOARD, id: "b2", parent: "b1" })]);
    bad([add({ ...BOARD, id: "b2", parent: "p1" })]);
    ok([add({ ...BOARD, id: "b2" })], machine());
    bad([add({ ...BOARD, id: "b2" }), add({ ...BOARD, id: "b3" })]);
    expect(CANVAS_LIMITS.boards).toBe(2);
    // a snapshot with three is refused the same way
    expect(validateScene([BOARD, { ...BOARD, id: "b2" }, { ...BOARD, id: "b3" }]).ok).toBe(false);
  });

  test("a board's size, a part's box and a bay's grid are in range", () => {
    for (const w of [319, 2401, 1.5, NaN, "1180"]) bad([add({ ...BOARD, id: "b2", w })]);
    for (const h of [199, 1601]) bad([add({ ...BOARD, id: "b2", h })]);
    bad([add({ ...BOARD, id: "b2", material: "chrome" })]);
    bad([add({ id: "b2", type: "board", h: 500 })]);
    const p = (o: Record<string, unknown>) => bad([add({ ...PART, id: "p9", ...o })]);
    p({ x: -1 }); p({ y: 1601 - 0 + 1 }); p({ x: 2401 }); p({ w: 23 }); p({ h: 1601 }); p({ depth: 5 }); p({ step: 0 }); p({ step: 100 });
    bad([add({ id: "p9", type: "part", parent: "b1", x: 1, y: 1, w: 50 })]); // h missing
    ok([add({ id: "p9", type: "part", parent: "b1", x: 2400, y: 1600, w: 2400, h: 1600 })], machine()); // not checked against the board: the window clips
  });

  test("a part only as a direct child of a board: root, lane, part and bay are refused", () => {
    bad([add({ ...PART, id: "p9", parent: undefined })]);
    bad([add({ id: "ln", type: "lane" }), add({ ...PART, id: "p9", parent: "ln" })]);
    bad([add({ ...PART, id: "p9", parent: "p1" })]);
    bad([add({ ...PART, id: "p9", parent: "bay1" })]);
  });

  test("a part cannot leave its board, and cannot move into a part or bay", () => {
    bad([{ op: "move", id: "p1", parent: null }]);
    bad([{ op: "move", id: "p1", parent: "p2" }]);
    bad([{ op: "move", id: "p1", parent: "bay1" }]);
    const s = ok([add({ ...BOARD, id: "b2" }), { op: "move", id: "p2", parent: "b2" }], machine());
    expect(get(s, "p2")?.parent).toBe("b2");
  });

  test("a bay only as a direct child of a part, and it holds only tokens", () => {
    const bay = { id: "bay9", type: "bay", cols: 2, rows: 2 };
    bad([add(bay)]);
    bad([add({ ...bay, parent: "b1" })]);
    bad([add({ ...bay, parent: "bay1" })]);
    bad([add({ id: "ln", type: "lane" }), add({ ...bay, parent: "ln" })]);
    ok([add({ ...bay, parent: "p2" })], machine());
    for (const node of [
      { id: "x", type: "label", text: "no" },
      { id: "x", type: "lane" },
      { id: "x", type: "counter", label: "c", value: 1 },
      { id: "x", type: "lamp" },
      { id: "x", type: "edge", from: "p1", to: "p2" },
    ]) bad([add({ ...node, parent: "bay1" })]);
    ok([add({ id: "t2", type: "token", label: "ok", parent: "bay1" })], machine());
  });

  test("a move into a bay is checked too: a label cannot be moved in, a token can", () => {
    bad([{ op: "move", id: "lbl", parent: "bay1" }]);
    bad([{ op: "move", id: "tr", parent: "bay1" }]);
    const s = ok([add({ id: "t2", type: "token", label: "x", parent: "p2" }), { op: "move", id: "t2", parent: "bay1" }], machine());
    expect(get(s, "t2")?.parent).toBe("bay1");
    // and a token can ride out of it through a trace
    const out = ok([{ op: "move", id: "t1", parent: "p2", via: "tr", ms: 400 }], machine());
    expect(get(out, "t1")?.parent).toBe("p2");
  });

  test("a bay moves only between parts", () => {
    bad([{ op: "move", id: "bay1", parent: "b1" }]);
    bad([{ op: "move", id: "bay1", parent: null }]);
    const s = ok([{ op: "move", id: "bay1", parent: "p2" }], machine());
    expect(get(s, "bay1")?.parent).toBe("p2");
  });

  test("an edge lives at the root or directly in a board, and nowhere else", () => {
    const e = { id: "e2", type: "edge", from: "p1", to: "p2" };
    ok([add(e)], machine());
    ok([add({ ...e, parent: "b1" })], machine());
    bad([add({ ...e, parent: "p1" })]);
    bad([add({ ...e, parent: "bay1" })]);
    bad([add({ id: "ln", type: "lane" }), add({ ...e, parent: "ln" })]);
    bad([{ op: "move", id: "tr", parent: "p1" }]);
  });

  test("the cols x rows cap is checked after the merge, on add and on set", () => {
    const bay = { id: "bay9", type: "bay", parent: "p2" };
    ok([add({ ...bay, cols: 8, rows: 8 })], machine());
    bad([add({ ...bay, cols: 9, rows: 8 })]);
    bad([add({ ...bay, cols: 13, rows: 1 })]);
    bad([add({ ...bay, cols: 1, rows: 9 })]);
    bad([add({ ...bay, cols: 2 })]); // rows is required
    // 4x3 is 12; each half of the change is fine on its own
    bad([{ op: "set", id: "bay1", props: { cols: 12, rows: 8 } }]);
    bad([{ op: "set", id: "bay1", props: { cols: 12 } }, { op: "set", id: "bay1", props: { rows: 6 } }]);
    bad([{ op: "set", id: "bay1", props: { rows: null } }]);
    const s = ok([{ op: "set", id: "bay1", props: { cols: 12, rows: 5, sealed: true } }], machine());
    expect(get(s, "bay1")?.cols).toBe(12);
    expect(CANVAS_LIMITS.slots).toBe(64);
  });
});

describe("what a board holds, and units that read one way", () => {
  test("a board holds only parts and edges, on add and on move", () => {
    for (const node of [
      { id: "x", type: "label", text: "no" }, { id: "x", type: "press", activity: "busy" }, { id: "x", type: "token", label: "t" },
      { id: "x", type: "lane" }, { id: "x", type: "gate", state: "open" }, { id: "x", type: "lamp" }, { id: "x", type: "core" }, { id: "x", type: "bay", cols: 1, rows: 1 },
    ]) bad([add({ ...node, parent: "b1" })]);
    bad([{ op: "move", id: "lbl", parent: "b1" }]);
    bad([{ op: "move", id: "t1", parent: "b1", via: "tr" }]);
    bad([{ op: "move", id: "bay1", parent: "b1" }]);
    ok([add({ id: "e2", type: "edge", parent: "b1", from: "p1", to: "p2" }), add({ ...PART, id: "p3", x: 900 })], machine());
    // a snapshot that has a stray node in a board is refused too
    const snap = machine().concat([{ id: "stray", type: "press", parent: "b1", activity: "busy" } as never]);
    expect(validateScene(snap).ok).toBe(false);
  });

  test("a unit refuses invisible and bidi characters, on core and counter", () => {
    for (const ch of ["\u202E", "\u200B", "\u2066", "\u0000", "\uFEFF"]) {
      bad([add({ id: "x", type: "core", parent: "p2", unit: `a${ch}b` })]);
      bad([add({ id: "x", type: "counter", parent: "p2", label: "c", value: 1, unit: ch })]);
      bad([{ op: "set", id: "t1", props: { label: "x" } }, add({ id: "x", type: "core", parent: "p2" }), { op: "set", id: "x", props: { unit: ch } }]);
    }
    bad([add({ id: "x", type: "core", parent: "p2", unit: "x".repeat(17) })]);
    ok([add({ id: "x", type: "core", parent: "p2", unit: "req/min" }), add({ id: "y", type: "counter", parent: "p2", label: "c", value: 1, unit: "$/mo" })], machine());
  });
});

describe("trace points", () => {
  const edge = (points: unknown, parent: string | null = "b1") => add({ id: "e2", type: "edge", from: "p1", to: "p2", ...(parent ? { parent } : {}), points });

  test("2 to 12 integer pairs inside the board's units, copied into a fresh array", () => {
    const pts = [[0, 0], [2400, 1600]];
    const s = ok([edge(pts)], machine());
    expect(get(s, "e2")?.points).toEqual(pts);
    expect(get(s, "e2")?.points).not.toBe(pts);
    expect((get(s, "e2")!.points as number[][])[0]).not.toBe(pts[0]);
    ok([edge(Array.from({ length: 12 }, (_, i) => [i * 10, i * 10]))], machine());
    expect(CANVAS_LIMITS.points).toBe(12);
  });

  test("hostile shapes: NaN, infinities, 1e308, strings, nested arrays, 13 points, negatives, fractions", () => {
    for (const points of [
      [[0, 0], [NaN, 1]], [[0, 0], [Infinity, 1]], [[0, 0], [1e308, 1]], [[0, 0], [1, -1e308]],
      [["1", "2"], [3, 4]], [[0, 0], [[1], [2]]], [[[0, 0]], [[1, 1]]], [[0, 0], [1, 2, 3]], [[0, 0], [1]], [[0, 0], []],
      [[0, 0]], [], Array.from({ length: 13 }, (_, i) => [i, i]),
      [[0, 0], [-1, 5]], [[0, 0], [5, -1]], [[0, 0], [2401, 5]], [[0, 0], [5, 1601]], [[0, 0], [1.5, 2]],
      [[0, 0], null], [[0, 0], { 0: 1, 1: 2, length: 2 }], "0,0 1,1", 12, null, { length: 2 }, [[0, 0], [true, false]],
    ]) bad([edge(points)]);
    bad([{ op: "set", id: "tr", props: { points: [[0, 0], [NaN, 0]] } }]);
    // JSON turns NaN into null, so it is refused as a pair member either way
    bad([edge(JSON.parse('[[0,0],[null,1]]'))]);
    bad([edge(JSON.parse('[[0,0],[1,2]]').concat([[Infinity, 1]]))]);
  });

  test("points are allowed only when the edge's parent is a board", () => {
    bad([edge([[0, 0], [9, 9]], null)]);
    bad([add({ id: "ln", type: "lane" }), edge([[0, 0], [9, 9]], "ln")]);
    // an edge with no points is fine at the root (the flow layout) and in a board (an elbow)
    ok([add({ id: "e2", type: "edge", from: "p1", to: "p2" })], machine());
    // set: the parent is read from the node, not from the op
    const root = ok([add({ id: "e2", type: "edge", from: "p1", to: "p2" })], machine());
    bad([{ op: "set", id: "e2", props: { points: [[0, 0], [9, 9]] } }], root);
    const inBoard = ok([{ op: "set", id: "e2", props: { points: [[0, 0], [9, 9]] } }], ok([add({ id: "e2", type: "edge", from: "p1", to: "p2", parent: "b1" })], machine()));
    expect(get(inBoard, "e2")?.points).toEqual([[0, 0], [9, 9]]);
    // and an edge with points cannot be moved out of its board
    bad([{ op: "move", id: "tr", parent: null }]);
    const moved = ok([{ op: "set", id: "tr", props: { points: null } }, { op: "move", id: "tr", parent: null }], machine());
    expect(get(moved, "tr")?.parent).toBeUndefined();
  });

  test("a cleaned scene never aliases what the plugin sent", () => {
    const pts = [[0, 0], [9, 9]];
    const r = applyOps(machine(), [edge(pts)]);
    if (!r.ok) throw new Error(r.error);
    pts[0]![0] = 99;
    expect((get(r.value.scene, "e2")!.points as number[][])[0]![0]).toBe(0);
  });
});

describe("what a plugin may not say on the new types", () => {
  test("style, href and friends on every new type, and __proto__ as a prop name on the board", () => {
    for (const [id, type] of [["b9", "board"], ["p9", "part"], ["y9", "bay"], ["g9", "gate"], ["r9", "press"], ["c9", "core"], ["i9", "item"], ["l9", "lamp"]] as const) {
      for (const k of ["style", "class", "className", "href", "src", "onclick", "innerHTML", "color", "zIndex", "position", "rotate", "transform", "path", "d", "svg", "__proto__", "constructor", "prototype"]) {
        const base = type === "board" ? { w: 400, h: 300 } : type === "part" ? { parent: "b1", x: 0, y: 0, w: 30, h: 30 } : type === "bay" ? { parent: "p1", cols: 1, rows: 1 } : type === "gate" ? { state: "open" } : type === "item" ? { title: "t" } : {};
        bad([add({ id, type, ...base, [k]: k === "__proto__" ? { polluted: 1 } : "x" })]);
        bad([{ op: "set", id: type === "board" ? "b1" : type === "part" ? "p1" : type === "bay" ? "bay1" : "tr", props: { [k]: "x" } }]);
      }
    }
    // a raw JSON.parse makes __proto__ an own key, which is how it arrives on the wire
    const raw = JSON.parse('{"op":"add","node":{"id":"b9","type":"board","w":400,"h":300,"__proto__":{"polluted":1}}}');
    bad([raw]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("a part is a button only through `action`, which is the fixed shape", () => {
    ok([{ op: "set", id: "p1", props: { action: { id: "inspect", payload: { id: "ORBIT-1042" } } } }], machine());
    bad([{ op: "set", id: "p1", props: { action: { id: "go", href: "x" } , title: { text: "x" } } }]);
    bad([{ op: "set", id: "p1", props: { action: "javascript:alert(1)" } }]);
    bad([{ op: "set", id: "p1", props: { action: { id: "a b" } } }]);
    bad([{ op: "set", id: "p1", props: { title: "Can‮cel" } }]);
    bad([{ op: "set", id: "p1", props: { x: null } }]); // a part cannot lose its place
    bad([{ op: "set", id: "b1", props: { w: null } }]);
  });
});

// A busy core runs a spin and a pulse, a busy press two jaws: two animations each.
const PRESS_COST = 2;

describe("what a busy machine costs", () => {
  test("core and press busy cost two loops each (the animations they run), a flowing trace its marks", () => {
    const s = ok([
      add({ id: "c", type: "core", parent: "p1", activity: "busy" }),
      add({ id: "pr", type: "press", parent: "p2", activity: "busy" }),
      add({ id: "pi", type: "press", parent: "p2", activity: "idle" }),
      add({ id: "gt", type: "gate", parent: "p2", state: "open" }),
    ], machine());
    expect([...loopingIds(s, false)].sort()).toEqual(["c", "pr", "tr"]);
    expect(loopingIds(s, true).size).toBe(0);
    // 31 busy presses leave room for one more press (2) and no trace (3)
    const many = ok([add(BOARD), add(PART), ...Array.from({ length: 32 }, (_, i) => add({ id: `q${i}`, type: "press", parent: "p1", activity: "busy" })), add({ id: "late", type: "edge", parent: "b1", from: "p1", to: "p1", activity: "flowing" })]);
    expect(loopingIds(many, false).size).toBe(32);
  });

  test("the budget is spent in scene order and a press past it draws still", () => {
    const n = CANVAS_LIMITS.loops / PRESS_COST + 3;
    const ops = [add(BOARD), add(PART), ...Array.from({ length: n }, (_, i) => add({ id: `pr${i}`, type: "press", parent: "p1", activity: "busy" }))];
    const s = ok(ops);
    const on = loopingIds(s, false);
    expect(on.size).toBe(CANVAS_LIMITS.loops / PRESS_COST);
    expect(on.has(`pr${CANVAS_LIMITS.loops / PRESS_COST}`)).toBe(false);
    const edgeFirst = ok([add(BOARD), add(PART), add({ id: "e", type: "edge", parent: "b1", from: "p1", to: "p1", activity: "flowing" }), add({ id: "c", type: "core", parent: "p1", activity: "busy" })]);
    expect(loopingIds(edgeFirst, false).size).toBe(2);
    expect(CANVAS_FLOW_MARKS).toBe(3);
  });
});

test("a burst of tokens into a bay is the window's business: the scene holds them all", () => {
  const s = ok(Array.from({ length: 60 }, (_, i) => add({ id: `n${i}`, type: "token", label: `ORBIT-${1000 + i}`, parent: "bay1" })), machine());
  expect(s.filter((n) => n.parent === "bay1").length).toBe(61);
});

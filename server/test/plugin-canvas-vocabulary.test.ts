/*
 * The canvas vocabulary and its reducer (shared/pluginCanvas.ts).
 *
 * A plugin sends operations on a retained scene. Everything it can say is
 * refused by name if it is not in the table, batches are all-or-nothing, and
 * the numbers that reach layout are finite and in range. These are the shapes
 * an attempt takes, next to the ones a real board uses.
 */
import { describe, expect, test } from "bun:test";
import { CANVAS_FLOW_MARKS, CANVAS_LIMITS, applyOps, effectiveMs, loopingIds, sizeOf, validateScene, type CanvasScene } from "../../shared/pluginCanvas.ts";

const add = (node: Record<string, unknown>, before?: string) => ({ op: "add", node, ...(before ? { before } : {}) });
const bad = (ops: unknown[], scene: CanvasScene = board()) => {
  const r = applyOps(scene, ops);
  expect(r.ok, JSON.stringify(ops)).toBe(false);
  return r.ok ? "" : r.error;
};
const board = (): CanvasScene => {
  const r = applyOps([], [
    add({ id: "intake", type: "lane", title: "Intake", layout: "list" }),
    add({ id: "gate", type: "lane", title: "Gate", state: "open", layout: "pile" }),
    add({ id: "wire", type: "edge", from: "intake", to: "gate", activity: "flowing" }),
    add({ id: "t1", type: "token", label: "note", tone: "accent", parent: "intake" }),
  ]);
  if (!r.ok) throw new Error(r.error);
  return r.value.scene;
};

describe("a board that is real", () => {
  test("adds, sets, moves along an edge, removes", () => {
    let s = board();
    const r = applyOps(s, [
      { op: "move", id: "t1", parent: "gate", via: "wire", ms: 400, easing: "ease-out" },
      { op: "set", id: "gate", props: { state: "closed" } },
      { op: "animate", id: "t1", kind: "pulse", ms: 300 },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    s = r.value.scene;
    expect(s.find((n) => n.id === "t1")?.parent).toBe("gate");
    expect(s.find((n) => n.id === "gate")?.state).toBe("closed");
    expect(r.value.ops.map((o) => o.op)).toEqual(["move", "set", "animate"]);
  });

  test("removing a node takes its children and every wire that touched it", () => {
    const r = applyOps(board(), [{ op: "remove", id: "intake" }]);
    expect(r.ok && r.value.scene.map((n) => n.id)).toEqual(["gate"]);
  });

  test("`before` reorders among siblings (a composite row moves by FLIP)", () => {
    const s = applyOps(board(), [add({ id: "t2", type: "token", label: "b", parent: "intake" }), add({ id: "t3", type: "token", label: "c", parent: "intake" }), { op: "move", id: "t3", before: "t1" }]);
    expect(s.ok && s.value.scene.filter((n) => n.parent === "intake").map((n) => n.id)).toEqual(["t3", "t1", "t2"]);
  });

  test("a snapshot round-trips through validateScene, even past one batch", () => {
    const many = applyOps([], Array.from({ length: 100 }, (_, i) => add({ id: `a${i}`, type: "label", text: String(i) })));
    if (!many.ok) throw new Error(many.error);
    const more = applyOps(many.value.scene, Array.from({ length: 50 }, (_, i) => add({ id: `b${i}`, type: "label", text: String(i) })));
    if (!more.ok) throw new Error(more.error);
    const v = validateScene(more.value.scene);
    expect(v.ok && v.value.length).toBe(150);
  });
});

describe("a snapshot of a scene that was rearranged", () => {
  test("moving a container leaves its children before it in the array, and the snapshot still validates", () => {
    const r = applyOps([], [
      add({ id: "a", type: "lane", title: "A" }), add({ id: "t", type: "token", label: "t", parent: "a" }),
      add({ id: "b", type: "lane", title: "B" }), { op: "move", id: "a" },
    ]);
    if (!r.ok) throw new Error(r.error);
    expect(r.value.scene.findIndex((n) => n.id === "t")).toBeLessThan(r.value.scene.findIndex((n) => n.id === "a"));
    const v = validateScene(r.value.scene);
    expect(v.ok, v.ok ? "" : v.error).toBe(true);
    // Sibling order survives: b then a at the root, t under a.
    expect(v.ok && v.value.filter((n) => !n.parent).map((n) => n.id)).toEqual(["b", "a"]);
  });

  test("a move into a later container, `before` among siblings, a deep chain: all round-trip", () => {
    const r = applyOps([], [
      add({ id: "x", type: "stack" }), add({ id: "y", type: "stack", parent: "x" }), add({ id: "z", type: "token", label: "z", parent: "y" }),
      add({ id: "w", type: "stack" }), { op: "move", id: "x", before: "w" }, { op: "move", id: "x", parent: "w" },
    ]);
    if (!r.ok) throw new Error(r.error);
    const v = validateScene(r.value.scene);
    expect(v.ok, v.ok ? "" : v.error).toBe(true);
    expect(v.ok && v.value.map((n) => n.id).sort()).toEqual(["w", "x", "y", "z"]);
  });

  test("a scene whose parent does not exist, or that loops, is still refused by name", () => {
    expect(validateScene([{ id: "a", type: "token", label: "a", parent: "nope" }]).ok).toBe(false);
    expect(validateScene([{ id: "a", type: "stack", parent: "b" }, { id: "b", type: "stack", parent: "a" }]).ok).toBe(false);
    expect(validateScene([{ id: "a", type: "stack", parent: "a" }]).ok).toBe(false);
  });
});

describe("what is refused", () => {
  test("labels cannot carry control, zero-width or bidi-override characters; a disclosure keeps its newlines", () => {
    for (const ch of ["\u0000", "\n", "\u200B", "\u202E", "\u2066", "\uFEFF"]) {
      bad([add({ id: "n1", type: "label", text: `Can${ch}cel` })]);
      bad([add({ id: "n1", type: "button", label: `Go${ch}`, action: { id: "go" } })]);
    }
    const ok = applyOps([], [add({ id: "d1", type: "disclosure", title: "t", text: "line one\nline two" })]);
    expect(ok.ok).toBe(true);
  });

  test("the scene cap is bytes on the wire, not UTF-16 units", () => {
    let error = "";
    let s: CanvasScene = [];
    for (let i = 0; i < 40 && !error; i++) {
      const r = applyOps(s, [{ op: "add", node: { id: `d${i}`, type: "disclosure", title: "t", text: "漢".repeat(CANVAS_LIMITS.disclosure) } }]);
      if (r.ok) s = r.value.scene; else error = r.error;
    }
    expect(error).toContain("bytes");
    expect(sizeOf(s)).toBeLessThanOrEqual(CANVAS_LIMITS.sceneBytes);
    expect(JSON.stringify(s).length).toBeLessThan(CANVAS_LIMITS.sceneBytes);
  });

  test("every way of naming something that runs, draws by URL or styles", () => {
    for (const k of ["style", "class", "className", "href", "src", "onclick", "innerHTML", "html", "markdown", "color", "x", "y", "zIndex", "position", "__proto__", "constructor"]) {
      bad([add({ id: "n1", type: "label", text: "hi", [k]: k === "__proto__" ? { polluted: 1 } : "x" })]);
      bad([{ op: "set", id: "t1", props: { [k]: "x" } }]);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("unknown types and ops, including the ones a Markdown or link node would be", () => {
    for (const type of ["markdown", "link", "html", "image", "iframe", "script", "list", "form", "code", "__proto__"]) bad([add({ id: "n1", type })]);
    bad([{ op: "eval", id: "t1" }]);
    bad([{ op: "add" }]);
    bad(["add"]);
    bad([null]);
  });

  test("ids: the pattern, __proto__ as a VALUE, duplicates, missing targets", () => {
    for (const id of ["__proto__", "a b", "A", "", "-x", "a".repeat(65), "a/b", "a.b", "a\u0000", 7, null]) bad([add({ id, type: "label", text: "x" })]);
    bad([add({ id: "t1", type: "label", text: "dup" })]);
    bad([{ op: "set", id: "nope", props: { text: "x" } }]);
    bad([{ op: "remove", id: "__proto__" }]);
    bad([add({ id: "n1", type: "label", text: "x", parent: "nope" })]);
    bad([add({ id: "n1", type: "label", text: "x", parent: "t1" })]);
  });

  test("names that are only dangerous on a plain object are safe as ids: nodes live in a Map", () => {
    const r = applyOps([], [add({ id: "constructor", type: "stack" }), add({ id: "hasownproperty", type: "label", text: "x", parent: "constructor" })]);
    expect(r.ok && r.value.scene.map((n) => n.id)).toEqual(["constructor", "hasownproperty"]);
    expect(applyOps(r.ok ? r.value.scene : [], [{ op: "set", id: "constructor", props: { gap: "lg" } }]).ok).toBe(true);
  });

  test("a spark can carry a cap, a limit line at a value", () => {
    const r = applyOps([], [add({ id: "s1", type: "spark", values: [1, 4, 2], cap: 3.5, tone: "warning" })]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.scene[0]?.cap).toBe(3.5);
    expect(applyOps([], [add({ id: "s2", type: "spark", values: [1, 4], cap: -2 })]).ok).toBe(true);
    expect(applyOps([], [add({ id: "s3", type: "spark", values: [1, 4], cap: 0 })]).ok).toBe(true);
  });

  test("numbers that reach layout: non-finite, out of range, wrong kind", () => {
    const g = (props: Record<string, unknown>) => bad([add({ id: "g1", type: "gauge", shape: "arc", value: 1, max: 2, ...props })]);
    g({ value: 1e308 }); g({ value: -1 }); g({ value: NaN }); g({ value: Infinity }); g({ value: "3" }); g({ max: 0 }); g({ shape: "spiral" });
    bad([add({ id: "s1", type: "spark", values: [1, 2, 1e13] })]);
    bad([add({ id: "s1", type: "spark", values: Array.from({ length: 121 }, () => 1) })]);
    // a cap is one finite number in the same range as the values
    for (const cap of [1e13, NaN, "2", [2]]) bad([add({ id: "s1", type: "spark", values: [1, 2], cap })]);
    bad([add({ id: "c1", type: "counter", label: "x", value: 1e13 })]);
    bad([add({ id: "k1", type: "countdown", until: -5 })]);
    bad([add({ id: "t9", type: "token", label: "x", count: 1.5 })]);
    bad([{ op: "move", id: "t1", ms: 1e9 }]);
    bad([{ op: "move", id: "t1", ms: -1 }]);
    bad([{ op: "animate", id: "t1", kind: "pulse", ms: 2001 }]);
    bad([{ op: "animate", id: "t1", kind: "spin" }]);
    bad([{ op: "move", id: "t1", easing: "cubic-bezier(1,1,1,1)" }]);
  });

  test("a gauge cannot be over its max: it is clamped, not stored", () => {
    const r = applyOps([], [add({ id: "g1", type: "gauge", shape: "pips", value: 30, max: 23 })]);
    expect(r.ok && r.value.scene[0]!.value).toBe(23);
  });

  test("structure: cycles, depth, edges only at the root, via must be an edge, before must be a sibling", () => {
    const nest = applyOps([], [add({ id: "a", type: "stack" }), add({ id: "b", type: "stack", parent: "a" })]);
    if (!nest.ok) throw new Error(nest.error);
    bad([{ op: "move", id: "a", parent: "b" }], nest.value.scene);
    bad([{ op: "move", id: "a", parent: "a" }], nest.value.scene);
    let chain: unknown[] = [add({ id: "d0", type: "stack" })];
    for (let i = 1; i <= CANVAS_LIMITS.depth; i++) chain.push(add({ id: `d${i}`, type: "stack", parent: `d${i - 1}` }));
    bad(chain);
    bad([add({ id: "e2", type: "edge", from: "intake", to: "gate", parent: "intake" })]);
    bad([{ op: "move", id: "t1", via: "gate" }]);
    bad([{ op: "move", id: "t1", parent: "gate", before: "intake" }]);
    bad([add({ id: "n1", type: "token", label: "x", parent: "gate", before: "intake" })]);
  });

  test("strings and payloads: the short budget, the disclosure budget, no null on add", () => {
    bad([add({ id: "n1", type: "label", text: "x".repeat(CANVAS_LIMITS.label + 1) })]);
    bad([add({ id: "n1", type: "disclosure", title: "t", text: "x".repeat(CANVAS_LIMITS.disclosure + 1) })]);
    bad([add({ id: "n1", type: "label", text: null })]);
    bad([add({ id: "n1", type: "button", label: "x", action: { id: "bad id" } })]);
    bad([add({ id: "n1", type: "button", label: "x", action: { id: "ok", payload: "y".repeat(CANVAS_LIMITS.payloadBytes) } })]);
    bad([add({ id: "n1", type: "segmented", label: "m", options: [], value: "a", action: { id: "mode" } })]);
    bad([add({ id: "n1", type: "segmented", label: "m", options: Array.from({ length: 9 }, (_, i) => ({ value: `v${i}`, label: "x" })), value: "v0", action: { id: "mode" } })]);
    bad([add({ id: "n1", type: "segmented", label: "m", options: [{ value: "a", label: "A" }, { value: "a", label: "B" }], value: "a", action: { id: "mode" } })]);
  });

  test("a payload comes back as a copy, and a required prop cannot be unset", () => {
    const payload = { row: 3 };
    const r = applyOps([], [add({ id: "b1", type: "button", label: "Delete", action: { id: "del", payload }, tone: "danger" })]);
    expect(r.ok && (r.value.scene[0]!.action as { payload: unknown }).payload).toEqual({ row: 3 });
    expect(r.ok && (r.value.scene[0]!.action as { payload: unknown }).payload).not.toBe(payload);
    if (r.ok) bad([{ op: "set", id: "b1", props: { label: null } }], r.value.scene);
  });

  test("a batch is atomic: the good ops before a bad one change nothing", () => {
    const s = board();
    const before = JSON.stringify(s);
    bad([{ op: "set", id: "gate", props: { state: "sealed" } }, add({ id: "n1", type: "label", text: "ok" }), { op: "set", id: "gate", props: { nope: 1 } }], s);
    expect(JSON.stringify(s)).toBe(before);
  });

  test("size: more than a batch, more nodes than the cap, a scene over its bytes", () => {
    bad(Array.from({ length: CANVAS_LIMITS.batchOps + 1 }, (_, i) => add({ id: `n${i}`, type: "label", text: "x" })));
    let s: CanvasScene = [];
    for (let i = 0; i < 4; i++) {
      const r = applyOps(s, Array.from({ length: 100 }, (_, j) => add({ id: `n${i}-${j}`, type: "label", text: "x" })));
      if (!r.ok) throw new Error(r.error);
      s = r.value.scene;
    }
    expect(s.length).toBe(400);
    bad([add({ id: "over", type: "label", text: "x" })], s);
    // 128 KB: a few long disclosures fill it.
    let fat: CanvasScene = [];
    let error = "";
    for (let i = 0; i < 20 && !error; i++) {
      const r = applyOps(fat, [add({ id: `d${i}`, type: "disclosure", title: "t", text: "y".repeat(CANVAS_LIMITS.disclosure) })]);
      if (r.ok) fat = r.value.scene; else error = r.error;
    }
    expect(error).toContain("bytes");
    expect(JSON.stringify(fat).length).toBeLessThanOrEqual(CANVAS_LIMITS.sceneBytes);
  });

  test("validateScene refuses a snapshot that is not a list, or is too long", () => {
    expect(validateScene({}).ok).toBe(false);
    expect(validateScene(Array.from({ length: 401 }, (_, i) => ({ id: `n${i}`, type: "label", text: "x" }))).ok).toBe(false);
    expect(validateScene([{ id: "n", type: "script" }]).ok).toBe(false);
  });
});

describe("motion", () => {
  test("reduced motion collapses every duration and stops every loop", () => {
    expect(effectiveMs(400, 250, true)).toBe(0);
    expect(effectiveMs(undefined, 250, false)).toBe(250);
    expect(effectiveMs(9999, 250, false)).toBe(CANVAS_LIMITS.ms);
    expect(loopingIds(board(), true).size).toBe(0);
    expect(loopingIds(board(), false).has("wire")).toBe(true);
  });

  test("a flowing edge costs its marks: the cap counts animations, not nodes", () => {
    const edges = Array.from({ length: 40 }, (_, i) => add({ id: `e${i}`, type: "edge", from: "a", to: "b", activity: "flowing" }).node);
    const r = applyOps([], [add({ id: "a", type: "lane" }), add({ id: "b", type: "lane" }), ...edges.map((node) => ({ op: "add", node }))]);
    if (!r.ok) throw new Error(r.error);
    const n = loopingIds(r.value.scene, false).size;
    expect(n).toBe(Math.floor(CANVAS_LIMITS.loops / CANVAS_FLOW_MARKS));
  });

  test("loops are capped: past the cap they draw still", () => {
    const r = applyOps([], Array.from({ length: 100 }, (_, i) => add({ id: `t${i}`, type: "token", label: "x", activity: "busy" })));
    if (!r.ok) throw new Error(r.error);
    expect(loopingIds(r.value.scene, false).size).toBe(CANVAS_LIMITS.loops);
  });
});

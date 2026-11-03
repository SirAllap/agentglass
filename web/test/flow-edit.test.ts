/*
 * The Flow edits and the Flow geometry, as pure functions. There is no renderer
 * in this project, so the screens are proved by what these return and by the
 * source-text rules at the bottom; the drawing itself is proved by shots.
 */
import { describe, expect, test } from "bun:test";
import { validateFlow, roleById, type Flow } from "../../shared/flow.ts";
import { templateFlow } from "../../shared/flowTemplates.ts";
import { addRole, clearFail, endIndex, failOf, flowCounts, freshRoleId, moveBlock, movePath, placeOnPath, removeFromPath, removeRole, setFail, setRequired, updateRole } from "../src/lib/flowEdit.ts";
import { BLOCK_H, BLOCK_W, FIT_FLOOR, ORCH_H, organicBlocks, dropIndex, fitView, flowViewState, layoutBlocks, miniMap, orchX, routeWires, ROWS_TOP, toWorld, zoomAbout, ZOOM_MAX, ZOOM_MIN } from "../src/lib/flowView.ts";

const ok = (f: unknown) => {
  const r = validateFlow(f);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

/** The shipped flow as the screens hold it: its places are a guess, so they are dropped and the canvas lays the blocks out. */
const shipped = (): Flow => ({ ...templateFlow(), blocks: [] });

describe("flow edits keep the flow valid", () => {
  test("the template is the starting point and is valid", () => {
    expect(ok(templateFlow()).path).toEqual(["planner", "builder", "inspector", "verifier", "landing"]);
  });

  test("the acceptance case: QA between Inspector and Verifier, fail goes back to In development, 3 rounds, then asks the person", () => {
    let f = shipped();
    f = placeOnPath(f, "qa-only", 3);
    f = setRequired(f, "qa-only", true);
    f = setFail(f, "qa-only", "builder", 3);
    f = ok(f);
    expect(f.path).toEqual(["planner", "builder", "inspector", "qa-only", "verifier", "landing"]);
    expect(f.edges.filter((e) => e.on === "pass").map((e) => `${e.from}>${e.to}`)).toEqual([
      "planner>builder", "builder>inspector", "inspector>qa-only", "qa-only>verifier", "verifier>landing",
    ]);
    expect(failOf(f, "qa-only")).toEqual({ from: "qa-only", to: "builder", on: "fail", maxRounds: 3 });
    expect(roleById(f, "qa-only")!.required).toBe(true);
    expect(roleById(f, "qa-only")!.stage).toBe("qa");
    // The old Verifier loop is untouched by the insert.
    expect(failOf(f, "verifier")!.to).toBe("builder");
  });

  test("a new role of the person's own goes in a gap and the arrows follow", () => {
    const base = shipped();
    const id = freshRoleId(base, "Release notes");
    expect(id).toBe("release-notes");
    const r = addRole(base, { id, name: "Release notes", does: "Writes the notes.", prompt: "You write the notes.", chain: [{ engine: "opencode", model: "glm-4.6" }], tools: ["read"], readsOnly: true, required: false, stage: "land", ico: "map", hue: "g-library" }, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const f = ok(r.flow);
    expect(f.path[2]).toBe("release-notes");
    expect(f.edges.some((e) => e.from === "builder" && e.to === "release-notes" && e.on === "pass")).toBe(true);
    expect(f.edges.some((e) => e.from === "builder" && e.to === "inspector" && e.on === "pass")).toBe(false);
  });

  test("a role added to the team only is off the path and never required", () => {
    const base = shipped();
    const r = addRole(base, { ...roleById(base, "docs")!, id: "docs-2", required: true }, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(ok(r.flow).path).toEqual(base.path);
    expect(roleById(r.flow, "docs-2")!.required).toBe(false);
  });

  test("an id the team has is refused, and so is a team that is full", () => {
    const base = shipped();
    expect(addRole(base, roleById(base, "docs")!, 1).ok).toBe(false);
    let f = base;
    for (let i = 0; f.roster.length < 24; i++) {
      const r = addRole(f, { ...roleById(base, "docs")!, id: `extra-${i}` });
      if (!r.ok) throw new Error(r.error);
      f = r.flow;
    }
    expect(addRole(f, { ...roleById(base, "docs")!, id: "one-more" }).ok).toBe(false);
  });

  test("removing a step reconnects its neighbours and drops its arrows and its hard rule", () => {
    let f = shipped();
    f = setRequired(placeOnPath(f, "qa-only", 3), "qa-only", true);
    f = setFail(f, "qa-only", "builder", 2);
    f = ok(removeFromPath(f, "qa-only"));
    expect(f.path).not.toContain("qa-only");
    expect(f.edges.some((e) => e.from === "qa-only" || e.to === "qa-only")).toBe(false);
    expect(f.edges.some((e) => e.from === "inspector" && e.to === "verifier" && e.on === "pass")).toBe(true);
    expect(roleById(f, "qa-only")!.required).toBe(false);
    expect(roleById(f, "qa-only")).toBeDefined();
  });

  test("the last step cannot be removed", () => {
    let f = shipped();
    for (const id of ["planner", "builder", "inspector", "verifier"]) f = removeFromPath(f, id);
    expect(f.path).toEqual(["landing"]);
    expect(removeFromPath(f, "landing")).toBe(f);
    expect(removeRole(f, "landing")).toBe(f);
    ok(f);
  });

  test("a fail arrow whose target moved after its source is dropped, not left dangling", () => {
    const f = ok(movePath(shipped(), "builder", 4));
    expect(f.path).toEqual(["planner", "inspector", "verifier", "landing", "builder"]);
    expect(f.edges.filter((e) => e.on === "fail")).toEqual([]);
  });

  test("reorder moves the id and rebuilds the passing arrows; blocks are laid out again", () => {
    const start = moveBlock(shipped(), "planner", 10, 20);
    expect(start.blocks).toEqual([{ id: "planner", x: 10, y: 20 }]);
    const f = ok(movePath(start, "inspector", 1));
    expect(f.path).toEqual(["planner", "inspector", "builder", "verifier", "landing"]);
    expect(f.blocks).toEqual([]);
  });

  test("a place a person dropped a block at is whole and not negative, and a move that is not a reorder keeps the others", () => {
    const f = moveBlock(moveBlock(shipped(), "builder", -5.4, 80.6), "inspector", 300.2, 10);
    expect(f.blocks).toEqual([{ id: "builder", x: 0, y: 81 }, { id: "inspector", x: 300, y: 10 }]);
    expect(moveBlock(f, "docs", 1, 1)).toBe(f);
    ok(f);
  });

  test("required only takes on a step that is on the path", () => {
    const f = shipped();
    expect(setRequired(f, "docs", true)).toBe(f);
    expect(roleById(setRequired(f, "builder", true), "builder")!.required).toBe(true);
  });

  test("a fail arrow goes back only, has one per step, is capped and can be cleared", () => {
    const f = shipped();
    expect(setFail(f, "builder", "inspector", 2)).toBe(f);
    expect(setFail(f, "builder", "builder", 2)).toBe(f);
    const g = ok(setFail(f, "inspector", "planner", 99));
    expect(failOf(g, "inspector")).toEqual({ from: "inspector", to: "planner", on: "fail", maxRounds: 12 });
    expect(g.edges.filter((e) => e.on === "fail" && e.from === "inspector").length).toBe(1);
    expect(failOf(clearFail(g, "inspector"), "inspector")).toBeUndefined();
  });

  test("renaming a role and editing its prompt changes the one role", () => {
    const f = ok(updateRole(shipped(), "inspector", { name: "Juno", prompt: "You read the diff." }));
    expect(roleById(f, "inspector")!.name).toBe("Juno");
    expect(roleById(f, "builder")!.name).toBe("Builder");
  });

  test("edits never change the value they were given", () => {
    const f = shipped();
    const before = JSON.stringify(f);
    placeOnPath(f, "qa-only", 3); setFail(f, "inspector", "planner", 2); updateRole(f, "builder", { name: "X" }); removeFromPath(f, "builder"); setRequired(f, "builder", true);
    expect(JSON.stringify(f)).toBe(before);
  });

  test("counts say blocks, stages and team", () => {
    expect(flowCounts(shipped())).toEqual({ blocks: 5, stages: 5, team: 14 });
  });
});

describe("flow geometry", () => {
  const f = shipped();

  test("the layout follows the data: more steps, more blocks, balanced rows", () => {
    const six = ok(placeOnPath(f, "qa-only", 3));
    const wide = layoutBlocks(six, 1500, 720);
    expect(wide.places.size).toBe(6);
    expect(wide.perRow).toBe(3);
    const ys = new Set([...wide.places.values()].map((p) => p.y));
    expect(ys.size).toBe(2);
    expect(layoutBlocks(f, 1920, 1080).perRow).toBe(5); // blocks are 296 wide: the five fit across at 1920
    expect(layoutBlocks(f, 1920, 1080).rowGap).toBe(74);
    expect(layoutBlocks(f, 1920, 700).rowGap).toBe(56);
  });

  test("a place the flow has is kept; the rest are laid out", () => {
    const lay = layoutBlocks(moveBlock(f, "builder", 500, 600), 1920, 1080);
    expect(lay.places.get("builder")).toEqual({ x: 500, y: 600 });
    // The first row starts under the orchestrator's card, wherever the card's own height puts it.
    expect(lay.places.get("planner")!.y).toBe(ROWS_TOP);
  });

  test("a pass between two rows leaves the bottom and enters the top; a fail goes down its left gap and in at the target's left side", () => {
    const six = ok(placeOnPath(f, "qa-only", 3));
    const lay = layoutBlocks(six, 1000, 720);
    const w = routeWires(six, lay);
    expect(w.passes.length).toBe(5);
    const across = w.passes.find((p) => p.points.length === 4)!;
    expect(across.points[0]!.y).toBe(lay.places.get(across.from)!.y + BLOCK_H + 2);
    expect(w.fails.length).toBe(2);
    const fail = w.fails.find((x) => x.from === "verifier")!;
    const t = lay.places.get(fail.to)!;
    expect(fail.points[fail.points.length - 1]!).toEqual({ x: t.x - 7, y: t.y + BLOCK_H / 2 + 16 });
    expect(fail.points.every((p) => p.x >= 6)).toBe(true);
    expect(fail.rounds).toBe(2);
    expect(w.height).toBeGreaterThan(w.laneTop);
  });

  test("every fail has a lane of its own", () => {
    const two = ok(setFail(setFail(f, "inspector", "builder", 3), "landing", "planner", 1));
    const lanes = routeWires(two, layoutBlocks(two, 1920, 1080)).fails.map((x) => x.label.y);
    expect(new Set(lanes).size).toBe(lanes.length);
  });

  test("fit never zooms past 100 % or under the floor, and centres", () => {
    const lay = layoutBlocks(f, 1920, 1080);
    const v = fitView({ x0: 0, x1: 400, y0: 0, y1: 300 }, { w: 1600, h: 900 });
    expect(v.zoom).toBe(1);
    expect(fitView({ x0: 0, x1: 40000, y0: 0, y1: 300 }, { w: 800, h: 600 }).zoom).toBe(ZOOM_MIN);
    expect(lay.places.size).toBe(5);
  });

  test("an automatic fit stops at the reading floor, and only an explicit Fit goes under it", () => {
    const b = { x0: 0, x1: 1640, y0: 0, y1: 300 };
    expect(fitView(b, { w: 1270, h: 700 }).zoom).toBeCloseTo(0.73, 2);
    expect(fitView(b, { w: 1270, h: 700 }, FIT_FLOOR).zoom).toBe(FIT_FLOOR);
    expect(fitView({ x0: 0, x1: 400, y0: 0, y1: 300 }, { w: 1600, h: 900 }, FIT_FLOOR).zoom).toBe(1);
  });

  test("the orchestrator's connector leaves its hub and drops a dot on every block that must run", () => {
    const req = { ...shipped(), roster: shipped().roster.map((r) => (r.id === "builder" || r.id === "inspector" ? { ...r, required: true } : r)) };
    const lay = layoutBlocks(req, 1920, 1080);
    const t = routeWires(req, lay).trunk;
    expect(t.spine[0]).toEqual({ x: orchX(lay) + 70, y: ORCH_H });
    expect(t.spine.at(-1)!.y).toBe(ORCH_H + 18);
    const centres = ["builder", "inspector"].map((id) => lay.places.get(id)!.x + BLOCK_W / 2);
    expect(t.drops.map((d) => d.x)).toEqual(centres.sort((a, b) => a - b));
    expect(t.drops.every((d) => d.to === ROWS_TOP - 3)).toBe(true);
    // Nothing marked required: the mockup draws no connector, not a line to nowhere.
    expect(routeWires(shipped(), layoutBlocks(shipped(), 1920, 1080)).trunk).toEqual({ spine: [], drops: [] });
  });

  test("zoom about a point keeps the point still and stays inside the limits", () => {
    const v0 = { zoom: 1, pan: { x: 10, y: 20 } };
    const at = { x: 300, y: 200 };
    const before = toWorld(v0, at);
    const v1 = zoomAbout(v0, at, 1.25);
    const after = toWorld(v1, at);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(zoomAbout(v0, at, 100).zoom).toBe(ZOOM_MAX);
    expect(zoomAbout(v0, at, 0.0001).zoom).toBe(ZOOM_MIN);
  });

  test("the minimap draws one rectangle per block and its frame stays inside its box", () => {
    const lay = layoutBlocks(f, 1280, 720);
    const m = miniMap(f, lay, { zoom: 0.5, pan: { x: -4000, y: -4000 } }, { w: 1000, h: 600 }, { w: 190, h: 118 });
    expect(m.blocks.length).toBe(5);
    if (m.frame) {
      expect(m.frame.x + m.frame.w).toBeLessThanOrEqual(190);
      expect(m.frame.y + m.frame.h).toBeLessThanOrEqual(118);
    }
    const near = miniMap(f, lay, { zoom: 1, pan: { x: 0, y: 0 } }, { w: 1000, h: 600 }, { w: 150, h: 96 });
    expect(near.frame).not.toBeNull();
    expect(near.frame!.x + near.frame!.w).toBeLessThanOrEqual(150);
  });

  test("dropping a block picks the index among the others by row and then by side", () => {
    const lay = layoutBlocks(f, 1920, 1080);
    const p = lay.places;
    const mid = (id: string) => ({ x: p.get(id)!.x + BLOCK_W - 20, y: p.get(id)!.y + 40 });
    expect(dropIndex(f, lay, "planner", mid("builder"))).toBe(1);
    expect(dropIndex(f, lay, "planner", { x: 0, y: 0 })).toBe(0);
    expect(dropIndex(f, lay, "landing", { x: 0, y: 0 })).toBe(0);
    expect(dropIndex(f, lay, "planner", { x: 99999, y: 99999 })).toBe(4);
  });

  test("the screen has four states and an empty path is one of them", () => {
    expect(flowViewState(null)).toBe("loading");
    expect(flowViewState({ state: "loading" })).toBe("loading");
    expect(flowViewState({ state: "failed", error: "x" })).toBe("error");
    expect(flowViewState({ state: "loaded", flow: null })).toBe("empty");
    expect(flowViewState({ state: "loaded", flow: f })).toBe("ready");
  });
});

describe("a rule about source: the flow screens", () => {
  const FILES = ["flow/FlowEditor.tsx", "flow/FlowCanvas.tsx", "flow/WorkerCard.tsx", "flow/WorkerEditor.tsx", "flow/WorkerPanel.tsx"].map((p) => `../src/components/orchestration/${p}`);
  const SRC = Promise.all(FILES.map(async (p) => [p, await Bun.file(new URL(p, import.meta.url)).text()] as const));
  // Spelled in halves so this file does not trip the private-content scan it guards against.
  const FORBIDDEN = new RegExp(`\\b(${["baby" + "sit", "shep" + "herd", "ti" + "ck", "nu" + "dge", "he" + "ld", "ho" + "ld", "bat" + "ch", "spin" + "off", "in-" + "flight", "meta P" + "R", "non-" + "gating", "infra-" + "rerun", "pre-" + "existing", "unclass" + "ified"].join("|")})\\b`, "i");

  test("no forbidden word and no true/false word in anything a person reads", async () => {
    for (const [name, text] of await SRC) {
      const lines = text.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"));
      const body = lines.join("\n");
      expect(FORBIDDEN.test(body), name).toBe(false);
      // Visible strings: JSX text and quoted copy. A boolean prop is code, not copy.
      const strings = [...body.matchAll(/>([^<>{}]+)</g)].map((m) => m[1]!).concat([...body.matchAll(/(?:label|title|aria-label|placeholder)="([^"]+)"/g)].map((m) => m[1]!));
      for (const s of strings.filter((x) => !/[()=;]/.test(x))) expect(/\b(true|false)\b/i.test(s), `${name}: ${s}`).toBe(false);
    }
  });

  test("the Board toggle is drawn disabled and says Coming soon, and no board code is imported", async () => {
    const editor = (await SRC).find(([n]) => n.endsWith("FlowEditor.tsx"))![1];
    expect(editor).toContain("Coming soon");
    expect(editor).toMatch(/Board[\s\S]{0,200}disabled|disabled[\s\S]{0,200}Board/);
    expect(editor).not.toMatch(/import .*Board/);
  });

  test("the honesty line is on the editor, word for word", async () => {
    for (const [name, text] of await SRC) {
      if (!/FlowEditor/.test(name)) continue;
      expect(text, name).toContain("The orchestrator follows this flow;");
      expect(text, name).toContain("does not force it step by step.");
    }
  });

  test("the editor's root carries its own layout only: `agx-flow` is the page's two-column grid", async () => {
    const editor = (await SRC).find(([n]) => n.endsWith("FlowEditor.tsx"))![1];
    const root = editor.match(/className="fe-root[^"]*"/)?.[0] ?? "";
    // On this root that grid put the bar in a 220px column and gave the canvas 0: every chip stacked a letter per line.
    expect(root).toContain("fe-ed");
    expect(root).not.toContain("agx-flow");
  });

  test("the Team button opens the rail it names: data-team sits on the editor's root, not on body", async () => {
    const css = await Bun.file(new URL("../src/components/orchestration/flow/flowEditor.css", import.meta.url)).text();
    expect(css).toContain(".fe-ed[data-team] .fe-rail");
    expect(css).not.toContain("body[data-team]");
  });
});

describe("endIndex", () => {
  test("a path that ends on a person's step ends before it, so a new block goes in front of the answer", () => {
    const f = ok(shipped());
    expect(endIndex(f)).toBe(f.path.length - 1);
  });

  test("a path that ends on a machine step ends after it", () => {
    const f = ok(removeFromPath(shipped(), "landing"));
    expect(endIndex(f)).toBe(f.path.length);
  });
});

const readSrc = (p: string) => Bun.file(new URL(p, import.meta.url)).text();
const editor = await readSrc("../src/components/orchestration/flow/FlowEditor.tsx");
const workerEditor = await readSrc("../src/components/orchestration/flow/WorkerEditor.tsx");
const sections = await readSrc("../src/components/orchestration/flow/FlowSections.tsx");

describe("one round cap: the reviewing block writes the setting", () => {
  test("the editor sends a reviewer's rounds to the setting, not to /flow", () => {
    expect(editor).toContain("REVIEW_SETTING_IDS.rounds");
    expect(editor).toContain("onReviewRounds={(id, n) => saveReviewRounds(id, n)}");
  });
  test("the reviewer's cap is drawn by ReviewerControls (1..6), other arrows keep the flow's cap", () => {
    expect(workerEditor).toContain("<ReviewerControls");
    expect(workerEditor).toContain("FLOW_ROUNDS_MAX");
  });
  test("the Safety tab no longer has a Review rounds stepper", () => {
    expect(sections).not.toContain('data-limit="rounds"');
    expect(sections).not.toContain("safety-rounds");
  });
});

describe("natural arrangement", () => {
  test("every block on the path gets a place, in path order, and none touch", () => {
    const f = shipped();
    const b = organicBlocks(f);
    expect(b.map((x) => x.id)).toEqual(f.path);
    for (let i = 1; i < b.length; i++) expect(b[i]!.x - b[i - 1]!.x).toBeGreaterThanOrEqual(BLOCK_W);
  });
});

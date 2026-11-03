/*
 * The Flow editor's screen, drawn as the approved mockup's screen: the PR-card
 * family for a worker, the orchestrator's own card, the rail's two lists, the
 * bottom bar's order and the presets drawer. Each test renders the real
 * component and reads its markup; the source guard keeps the next edit from
 * going back to a popover or to a card that is not this family.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { globalStubs } from "./stubGlobal";
globalStubs()("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
const { WorkerCard } = await import("../src/components/orchestration/flow/WorkerCard.tsx");
const { OrchestratorCard } = await import("../src/components/orchestration/flow/OrchestratorCard.tsx");
const { AroundRow } = await import("../src/components/orchestration/flow/AroundFlow.tsx");
const { PresetsLayer } = await import("../src/components/orchestration/flow/PresetsLayer.tsx");
const { railModel } = await import("../src/components/orchestration/flow/flowScreenCopy.ts");
import { roleById, type Flow } from "../../shared/flow.ts";
import { templateFlow } from "../../shared/flowTemplates.ts";
import { composePolicy, defaultStored, type Policy } from "../../shared/orchestration.ts";
import type { Around } from "../src/components/orchestration/flow/AroundFlow.tsx";

const flow: Flow = {
  ...templateFlow(), blocks: [],
  // A chain as the policy resolves it, so the card draws what a saved project draws.
  roster: templateFlow().roster.map((r) => (r.id === "builder" ? { ...r, chain: [{ engine: "claude", model: "claude-sonnet-5" }] } : r)),
};
const builder = roleById(flow, "builder")!;
const inspector = roleById(flow, "inspector")!;
const card = (over: Partial<Parameters<typeof WorkerCard>[0]> = {}) => renderToStaticMarkup(React.createElement(WorkerCard, {
  flow, role: builder, x: 0, y: 0, selected: false, dragging: false,
  onPointerDown() {}, onOpen() {}, onSelect() {}, onArrow() {}, onConfigure() {}, ...over,
} as never));

describe("a worker's card is the mockup's PR-card family", () => {
  test("the status strip is on top, with the live word and the rounds the fail arrow allows", () => {
    const h = card({ role: inspector, counts: { builder: { run: 1, wait: 0, cost: 0.41 } } });
    const strip = h.slice(h.indexOf("fe-wk-h"), h.indexOf("fe-wk-body"));
    expect(strip).toContain("3 tries");
    const running = card({ counts: { builder: { run: 1, wait: 0, cost: 0.41 } } });
    expect(running.slice(running.indexOf("fe-wk-h"), running.indexOf("fe-wk-body"))).toContain("Running");
    expect(h.indexOf("fe-wk-h")).toBeLessThan(h.indexOf("fe-wk-body"));
  });

  test("the ring says where the block is on the path, and the name keeps its number", () => {
    const h = card();
    const ring = h.slice(h.indexOf("fe-wk-ring"), h.indexOf("fe-wk-text"));
    expect(ring).toContain("2");
    expect(ring).toContain("of 5");
    expect(h).toContain('class="fe-wk-num">#2');
  });

  test("the chips say as set or by a rule, and required when the path requires it", () => {
    expect(card()).toContain("as set");
    const required: Flow = { ...flow, roster: flow.roster.map((r) => (r.id === "builder" ? { ...r, required: true } : r)) };
    expect(renderToStaticMarkup(React.createElement(WorkerCard, {
      flow: required, role: required.roster.find((r) => r.id === "builder")!, x: 0, y: 0, selected: false, dragging: false,
      onPointerDown() {}, onOpen() {}, onSelect() {}, onArrow() {}, onConfigure() {},
    } as never))).toContain("required");
  });

  test("the route draws one badge per engine, in the chain's order", () => {
    const h = card();
    const route = h.slice(h.indexOf("fe-wk-route"), h.indexOf("fe-wk-cells"));
    expect(route).toContain('data-engine="claude"');
    expect(route).toContain("claude-sonnet-5");
  });

  test("the three cells are Last, Tries and Cost, and the footer holds Configure and the menu", () => {
    const h = card();
    const cells = h.slice(h.indexOf("fe-wk-cells"), h.indexOf("fe-wk-nxt"));
    expect(cells).toContain("<small>Last</small>");
    expect(cells).toContain("<small>Tries</small>");
    expect(cells).toContain("<small>Cost</small>");
    const foot = h.slice(h.indexOf("fe-wk-ft"));
    expect(foot).toContain("Configure");
    expect(foot).toContain('aria-haspopup="menu"');
  });

  test("a person's block asks for the answer, and says who it waits on", () => {
    const landing = roleById(flow, "landing")!;
    const h = renderToStaticMarkup(React.createElement(WorkerCard, {
      flow, role: landing, x: 0, y: 0, selected: false, dragging: false,
      onPointerDown() {}, onOpen() {}, onSelect() {}, onArrow() {}, onConfigure() {},
    } as never));
    expect(h).toContain("Asks you");
    expect(h).toContain("Review");
    expect(h).toContain("You · this session");
  });
});

describe("the orchestrator's card is the mockup's own", () => {
  const data = { chair: { engine: "claude", model: "claude-haiku-5-5" }, seat: { name: "orbit-orchestrator" }, planLeft: { anthropic: 13 }, maxWorkers: 3, counts: { builder: { run: 1, wait: 0, cost: 0.41 } }, pilotWord: "Co-pilot" };
  const h = renderToStaticMarkup(React.createElement(OrchestratorCard, { flow, data, x: 0, y: 0, project: "orbit", onConfigure() {}, onOpenTab() {} } as never));
  test("the strip names the project it is seated in and the pilot it flies", () => {
    expect(h).toContain("Active · seated in orbit");
    expect(h).toContain("Co-pilot");
  });
  test("the three numbers are workers in flight, the plan and today", () => {
    const stats = h.slice(h.indexOf("fe-obc"), h.indexOf("fe-obl"));
    expect(stats).toContain("Workers in flight");
    expect(stats).toContain("Plan used");
    expect(stats).toContain("Today");
    expect(stats).toContain("1 of 3");
    expect(stats).toContain("87%");
  });
  test("the last decision line, the two ways in and the roles off the path", () => {
    expect(h).toContain("Last decision");
    expect(h).toContain("Configure");
    expect(h).toContain("Open its tab");
    expect(h).toContain("fe-roster");
  });
  test("the engine row reads whole: the name, then the model chip the mockup shows", () => {
    const row = h.slice(h.indexOf("fe-obe"), h.indexOf("fe-obl"));
    expect(row).toContain("Claude Code");
    expect(row).toContain("claude-haiku-5-5");
  });
  test("the rail's model is the family word the mockup writes, and a chain keeps the id", () => {
    expect(railModel("claude-sonnet-5-5")).toBe("sonnet");
    expect(railModel("claude-haiku-5-5")).toBe("haiku");
    expect(railModel("opencode-go/deepseek-v4.1-flash")).toBe("deepseek");
    expect(railModel("openai/gpt-5.6-codex")).toBe("codex");
  });
});

describe("the bottom bar is the mockup's order", () => {
  const policy: Policy = composePolicy(defaultStored(), { orchestrator: { engine: "claude", model: "sonnet" }, workers: { scout: { engine: "opencode", model: "" }, builder: { engine: "claude", model: "sonnet" }, reviewer: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } } });
  const a = {
    root: "/w/orbit", policy, readiness: [], seat: null, gate: { on: true, bundled: true }, states: [], own: true, note: "",
    saveRule: async () => null, claim: async () => null, setGate: async () => {},
  } as Around;
  const tools = { presetsOpen: false, conditionsOpen: false, editing: false, count: 1, off: 0, acting: false, onPresets() {}, onConditions() {} };
  const h = renderToStaticMarkup(React.createElement(AroundRow, { a, open: null, onOpen() {}, tools } as never));
  test("Presets, Conditions, around the flow, Orchestrator, Fallback, Gate", () => {
    const order = ["<b>Presets</b>", "<b>Conditions</b>", ">Around the flow<", "<b>Orchestrator</b>", "<b>Fallback</b>", "<b>Gate</b>"].map((w) => h.indexOf(w));
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(order.every((i) => i >= 0)).toBe(true);
  });
  test("Presets names the preset in force, and Conditions counts on and off", () => {
    expect(h).toContain("No preset");
    expect(h).toContain("1 on, 0 off");
  });
});

describe("the presets drawer", () => {
  const policy: Policy = composePolicy(defaultStored(), { orchestrator: { engine: "claude", model: "sonnet" }, workers: { scout: { engine: "opencode", model: "" }, builder: { engine: "claude", model: "sonnet" }, reviewer: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } } });
  const readiness = ["claude", "opencode"].map((id) => ({ id, title: id, found: true, path: "", version: "1", min: null, versionOk: true, account: { signedIn: true }, answers: { state: "never" }, roles: { worker: { ok: true }, orchestrator: { ok: true } }, missing: [], envelope: { via: null, enforced: "yes", note: "" } }));
  const a = {
    root: "/w/orbit", policy, readiness, seat: null, gate: { on: true, bundled: true }, states: [], own: true, note: "",
    saveRule: async () => null, claim: async () => null, setGate: async () => {},
  } as Around;
  const h = renderToStaticMarkup(React.createElement(PresetsLayer, { a, flow, open: true, anchor: null, preview: null, onPreview() {}, checked: false, onChecked() {}, onClose() {} } as never));
  test("it is a right drawer, not a popover", () => {
    expect(h).toContain("Start from a preset");
    expect(h).toContain('class="fe-drawer"');
    expect(h).not.toContain('class="fe-pop"');
    expect(h).toContain("Check my setup");
  });
  test("each preset says what it sets, per role, with its engine and model", () => {
    expect(h).toContain("Use this preset");
    expect(h).toContain("Shipped");
    expect(h).toContain("See details");
    expect(h).toContain("fe-pset");
  });
});

describe("a rule about source: the screen keeps the mockup's shapes", () => {
  const DIR = join(import.meta.dir, "..", "src", "components", "orchestration", "flow");
  const read = (f: string) => readFileSync(join(DIR, f), "utf8");
  test("the rail is two lists of the mockup's rows, not a run of path chips", () => {
    const editor = read("FlowEditor.tsx");
    expect(editor).toContain("In the team, off the path");
    expect(editor).toContain("drag to place");
    expect(editor).toContain('className="fe-role"');
    expect(editor).not.toContain("fe-pathchips");
  });
  test("the card's engine line keeps its own row, apart from the editor's engine grid", () => {
    // `.fe-eng` is the worker editor's three-column picker; unscoped it left this row with one word per column.
    expect(readFileSync(join(DIR, "flowEditor.css"), "utf8")).toContain(".fe-obe .fe-eng { display: inline-flex;");
  });
  test("a failing arrow names the block it goes back to, in the mockup's words", () => {
    expect(read("FlowCanvas.tsx")).toContain("up to {w.rounds}");
  });
  test("an automatic fit stops at the reading zoom, so a card keeps the mockup's size", () => {
    expect(read("FlowCanvas.tsx")).toContain("fitView(bounds, stage, FIT_FLOOR)");
  });
  test("the honesty line wears the mockup's warning triangle", () => {
    expect(read("FlowEditor.tsx")).toContain('FlowIcon name="alert"');
  });
  test("the editor names the mockup's accent on its own root, because the portal sits outside the page that names it", () => {
    // Portaled to body, above the page that names `--accent`: without it the
    // sentence chips and the plan tick fall back to the theme's monochrome primary.
    expect(read("FlowEditor.tsx")).toContain('style={{ "--accent": MOCKUP_INK.accent }');
    expect(read("FlowEditor.tsx")).toContain("import { MOCKUP_INK }");
  });
  test("the canvas carries the legend and the minimap", () => {
    const canvas = read("FlowCanvas.tsx");
    expect(canvas).toContain("passes to the next");
    expect(canvas).toContain("fails back, with its tries");
    expect(canvas).toContain("must run");
    expect(canvas).toContain("fe-mini");
  });
  test("the drawer's css is a column, not a box under a chip", () => {
    const css = read("flowEditor.css");
    expect(css).toContain(".fe-drawer { position: absolute;");
    expect(css).not.toContain(".fe-pop {");
  });
});

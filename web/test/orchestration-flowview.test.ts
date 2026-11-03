/*
 * What the Orchestration page keeps of the flow's vocabulary: the menu and key
 * lists, the pure rules for what a menu offers, and the pointer to Polaris. The
 * drawing and the per-block panel moved to the Flow editor (flow-around, flow-edit,
 * flow-block-rules, flow-reviewer-controls and flow-policy-controls test them).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composePolicy, defaultStored, type Policy, type PolicyRule } from "../../shared/orchestration.ts";
import { FLOW_KEYS, FLOW_MENU, blockAsText, blocksTouchedBy, fieldOf, flowBlocks, menuOff } from "../src/components/orchestration/flow/flowCopy.ts";


const DIR = join(import.meta.dir, "..", "src", "components", "orchestration");
const strip = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const paneSrc = strip(readFileSync(join(DIR, "OrchestrationPane.tsx"), "utf8"));
const READY = [] as never[];
const base = (): Policy => composePolicy(defaultStored(), {
  orchestrator: { engine: "claude", model: "opus" },
  workers: { scout: { engine: "claude", model: "haiku" }, builder: { engine: "claude", model: "sonnet" }, reviewer: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
});

describe("the menu and the keys are lists, not a paragraph", () => {
  test("seven entries on every block, each with what it does; two say why they are off", () => {
    expect(FLOW_MENU.length).toBe(7);
    for (const m of FLOW_MENU) expect(m.does.length).toBeGreaterThan(0);
    const off = FLOW_MENU.filter((m) => m.needs === "none");
    expect(off.map((m) => m.label)).toEqual(["Add a step after", "Remove step"]);
    for (const m of off) expect(m.why?.length).toBeGreaterThan(10);
  });
  test("the six keys the Keys section prints are the ones the drawing listens for", () => {
    expect(FLOW_KEYS.map((k) => k.what)).toEqual(["Between blocks", "Open this block", "Close a menu", "Context menu", "Context menu · menu key", "Between sections"]);
  });
  test("copy as text is the block's own settings, from the policy", () => {
    const b = flowBlocks({ policy: base(), resolution: null, readiness: READY, gate: { on: true, bundled: true } }).find((x) => x.id === "builder")!;
    const text = blockAsText(b, base(), "all projects");
    expect(text).toContain("Builder");
    expect(text).toContain("Runs on");
    expect(text).toContain("Hands to:");
  });
});

describe("Polaris has a page of its own", () => {
  test("the Flow page is the only thing here, and nothing here points at it any more", () => {
    expect(paneSrc).not.toContain('{ id: "polaris"');
    expect(paneSrc).not.toContain("<PolarisSlot");
    // The card that pointed there left with the rest of the per-block cards: Polaris is reached from its own page in the nav.
    expect(paneSrc).not.toContain("Open Polaris settings");
    expect(paneSrc).not.toContain('openSettings("polaris")');
  });
});

describe("a saved rule marks the blocks it changes", () => {
  const hours = (over: Partial<PolicyRule> = {}): PolicyRule =>
    ({ id: "night", name: "Night", enabled: true, when: [{ kind: "hours", days: [1], from: "22:00", to: "07:00" }], workers: { builder: [{ engine: "opencode", model: "" }] }, ...over });
  test("a plan rule edited from the Fallback marks the Fallback as well as the stop it routes", () => {
    const plan: PolicyRule = { id: "low", name: "Low plan", enabled: true, when: [{ kind: "usage", provider: "anthropic", window: "weekly", remainingAtMost: 15 }], workers: { builder: [{ engine: "opencode", model: "" }] } };
    expect(blocksTouchedBy(plan)).toEqual(["builder", "fallback"]);
    expect(blocksTouchedBy({ ...plan, when: [{ kind: "always" }] })).toEqual(["builder"]);
    expect(blocksTouchedBy({ ...plan, workers: undefined, orchestrator: [{ engine: "opencode", model: "" }] })).toEqual(["orchestrator", "fallback"]);
  });
  test("a rule that moves no stop marks the Fallback", () => {
    expect(blocksTouchedBy(hours({ workers: undefined }))).toEqual(["fallback"]);
  });
});

describe("the menu offers a row only where the row exists", () => {
  test("engine and model are off on You, the Gate and the Fallback, and on where a block has them", () => {
    for (const act of ["engine", "model"] as const) {
      const m = FLOW_MENU.find((x) => x.act === act)!;
      for (const id of ["you", "gate", "fallback"] as const) expect(menuOff(m, { projectScope: true, field: fieldOf(id) !== null }), `${act} on ${id}`).toBe(true);
      for (const id of ["orchestrator", "builder", "scout", "reviewer", "verifier"] as const) expect(menuOff(m, { projectScope: true, field: fieldOf(id) !== null }), `${act} on ${id}`).toBe(false);
    }
  });
  test("Use the general setting is off where there is nothing to drop", () => {
    const m = FLOW_MENU.find((x) => x.act === "general")!;
    expect(menuOff(m, { projectScope: false, field: true })).toBe(true);
    expect(menuOff(m, { projectScope: true, field: true })).toBe(false);
  });
});


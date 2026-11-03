/*
 * The Conditions panel: the rule list as sentences, the empty state, the rules
 * the blocks made, the all-projects rules a project follows, and the order.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { composePolicy, defaultStored, type Policy, type PolicyRule } from "../../shared/orchestration.ts";
import { templateFlow } from "../../shared/flowTemplates.ts";
import type { Around } from "../src/components/orchestration/flow/AroundFlow.tsx";
const { ConditionsPanel, EMPTY_CONDITIONS, fallbackRole } = await import("../src/components/orchestration/flow/ConditionsPanel.tsx");

const base = (): Policy => composePolicy(defaultStored(), {
  orchestrator: { engine: "claude", model: "sonnet" },
  workers: { scout: { engine: "claude", model: "sonnet" }, builder: { engine: "claude", model: "sonnet" }, reviewer: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
});
const rule = (id: string, name: string, over: Partial<PolicyRule> = {}): PolicyRule =>
  ({ id, name, enabled: true, when: [{ kind: "usage", provider: "anthropic", window: "weekly", remainingAtMost: 15 }], workers: { builder: [{ engine: "opencode", model: "glm" }] }, ...over });
const around = (rules: PolicyRule[], over: Partial<Around> = {}): Around => ({
  root: "~/code/orbit", policy: { ...base(), rules }, readiness: null, seat: null, gate: null, states: [], own: true, note: "",
  saveRule: async () => null, claim: async () => null, setGate: async () => {}, ...over,
});
const html = (a: Around) => renderToStaticMarkup(React.createElement(ConditionsPanel, { a, flow: templateFlow(), onClose() {}, onHover() {}, onNew() {}, onEdit() {}, onPickBlock() {} }));
/** The opening tag of the first element that carries `attr`. */
const tagWith = (h: string, attr: string): string => { const at = h.indexOf(attr); return h.slice(h.lastIndexOf("<", at), h.indexOf(">", at) + 1); };

describe("the Conditions panel", () => {
  test("a rule is one sentence with a switch, how many blocks it touches, and its links", () => {
    const h = html(around([rule("r1", "Claude plan low")]));
    expect(h).toContain("Claude plan low");
    expect(h).toContain("Claude plan used ≥ 85%");
    expect(h).toContain('role="switch"');
    expect(h).toContain("touches 1 block<");
    // The mockup's primary press is a plus glyph and the words, not a literal "+".
    expect(tagWith(h, "data-new-condition")).toContain('data-tone="primary"');
    expect(h).toContain("New condition</button>");
  });
  test("no rules: the empty state, and the button to make one", () => {
    const h = html(around([]));
    expect(h).toContain(EMPTY_CONDITIONS);
    expect(EMPTY_CONDITIONS).toBe("No conditions. Blocks use their usual engine.");
    expect(h).toContain("data-new-condition");
  });
  test("a fallback rule is read only and points at its block", () => {
    const h = html(around([rule("fallback-builder", "Builder fallbacks", { when: [{ kind: "always" }] })]));
    expect(fallbackRole("fallback-builder")).toBe("builder");
    expect(fallbackRole("mine")).toBeNull();
    expect(h).toContain("Made by the block");
    expect(h).toContain("Open the block");
    expect(h).not.toContain(">Edit<");
    expect(h).not.toContain("Move Builder fallbacks up");
  });
  test("a project with no setting of its own sees the shared rules read only, with Override", () => {
    const h = html(around([rule("r1", "Shared")], { own: false }));
    expect(h).toContain("data-inherited");
    expect(h).toContain("Override for orbit");
    expect(tagWith(h, "data-new-condition")).toContain("disabled");
    expect(h).not.toContain(">Edit<");
  });
  test("two rules on one block carry the order in their number and their arrows, not in a paragraph", () => {
    const h = html(around([rule("a", "First"), rule("b", "Second")]));
    expect(h).not.toContain("data-order");
    expect(h).not.toContain("wins over");
    expect(tagWith(h, 'aria-label="Move Second up"')).not.toContain("disabled");
    expect(tagWith(h, 'aria-label="Move First up"')).toContain("disabled");
    expect(h).toContain('title="First match wins"');
  });
  test("a rule that holds right now is marked on", () => {
    const state = { scope: "~/code/orbit", ruleId: "r1", name: "x", active: true, since: 1, reading: "", readingAt: 1, holding: "" };
    const h = html(around([rule("r1", "Claude plan low")], { states: [state] }));
    expect(h).toContain("data-on");
    // The mockup's card says it on the switch, not in a second chip row.
    expect(h).not.toContain("On now");
  });
  test("each rule carries its place in the order, which is what decides", () => {
    const h = html(around([rule("a", "First"), rule("b", "Second")]));
    expect(h).toContain('class="fe-ord" title="First match wins">1<');
    expect(h).toContain('class="fe-ord" title="First match wins">2<');
  });
  test("the plan meter and the Fallback card say what the rule does, and the card's switch writes it", () => {
    const h = html(around([rule("plan", "Plan low")]));
    expect(h).toContain("data-plan");
    expect(h).toContain('class="fe-planbar"');
    expect(h).toContain('aria-label="No reading yet"');
    // The mockup's meter carries the bar and its tick, not a 0%–100% scale row.
    expect(h).not.toContain("left now");
    expect(h).toContain("data-fallback");
    expect(h).toContain("Switch at");
    expect(h).toContain("of the Claude plan");
    expect(h).toContain("Switch to");
    expect(h).toContain(">OpenCode Go<");
    expect(h).toContain("Then go back");
    expect(h).toContain('aria-label="Fallback rule"');
  });
  test("each rule reads as the mockup's sentence: when, run, and what lifts it again", () => {
    const usage = html(around([rule("u", "Plan low")]));
    expect(usage).toContain('<span class="fe-when">When</span><span class="fe-tok">');
    expect(usage).toContain('<span class="fe-when">run</span><span class="fe-tok">');
    expect(usage).toContain('· back</span><span class="fe-tok">below 85% used</span>');
    // One engine for every block it names reads as one short token, not a list of clauses.
    expect(usage).toContain('<span class="fe-tok">The block on OpenCode Go</span>');
    // What lifts it is the trigger's own reading, never one sentence for every kind.
    const hours = html(around([rule("h", "Night", { when: [{ kind: "hours", days: [1, 2, 3, 4, 5], from: "23:00", to: "07:00" }] })]));
    expect(hours).toContain("Between 23:00 and 07:00, Mon–Fri");
    expect(hours).toContain('<span class="fe-tok">at 07:00</span>');
    const always = html(around([rule("a", "Standing", { when: [{ kind: "always" }] })]));
    expect(always).toContain("nothing: it holds until it is turned off");
  });

  test("the drawer is the mockup's: a head, one body, and a footer that says which scope it writes", () => {
    const h = html(around([]));
    expect(h).toContain('class="fe-drawerhead"');
    expect(h).toContain('class="fe-drawerbody"');
    expect(h).toContain('class="fe-drawerfoot"');
    expect(h).toContain("Scope: orbit");
    expect(h).toContain("Rules that move a block to another engine");
  });

  test("no usage rule: the card says so instead of inventing a threshold", () => {
    const h = html(around([]));
    expect(h).toContain("No usage rule is set.");
    expect(h).not.toContain("data-plan");
  });

  test("an on switch is the mockup's green, not the page's black", () => {
    const css = readFileSync(join(import.meta.dir, "..", "src", "components", "orchestration", "flow", "flowEditor.css"), "utf8");
    expect(css).toContain(".fe-switch[data-on] .fe-track { background: var(--success); }");
    expect(css).not.toContain(".fe-switch[data-on] .fe-track { background: var(--text); }");
  });
});

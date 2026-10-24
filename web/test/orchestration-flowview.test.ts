/*
 * "Right now": the drawn diagram beside the Orchestration editor. You, the main
 * agent, the jobs, the dashed fallback and the gate, from the policy, the
 * rules' reading, the engines' probe and the gate's switch, with one "Because"
 * line that names what put the jobs there: the defaults, a setup, or a rule.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { globalStubs } from "./stubGlobal";
globalStubs()("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
const { OrchestrationView } = await import("../src/components/orchestration/OrchestrationPane.tsx");
import type { OrchestrationViewProps } from "../src/components/orchestration/OrchestrationPane.tsx";
import { agentProvider } from "../../shared/agentKinds.ts";
import { composePolicy, defaultStored, type Policy, type PolicyRule } from "../../shared/orchestration.ts";
import type { EngineReadiness } from "../../shared/types.ts";
import type { PolicyRuleState } from "../src/lib/api.ts";
import { applyPreset } from "../src/components/orchestration/orchestrationCopy.ts";

const DIR = join(import.meta.dir, "..", "src", "components", "orchestration");
const strip = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const flowSrc = strip(readFileSync(join(DIR, "FlowView.tsx"), "utf8"));
const paneSrc = strip(readFileSync(join(DIR, "OrchestrationPane.tsx"), "utf8"));
const title = (id: string) => agentProvider(id)!.title;

const engine = (id: string, over: Partial<EngineReadiness> = {}): EngineReadiness => ({
  id, title: title(id), found: true, path: `/usr/bin/${id}`, version: "1.0.0", min: null, versionOk: true,
  account: { signedIn: true }, answers: { state: "never" },
  roles: { worker: { ok: true }, orchestrator: { ok: true } },
  missing: [], envelope: { via: null, enforced: "yes", note: "" },
  ...over,
});
const READY = [engine("claude"), engine("opencode"), engine("hermes")];
const base = (): Policy => composePolicy(defaultStored(), {
  orchestrator: { engine: "claude", model: "opus" },
  workers: { scout: { engine: "claude", model: "haiku" }, builder: { engine: "claude", model: "sonnet" }, reviewer: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
});
const st = (ruleId: string, over: Partial<PolicyRuleState> = {}): PolicyRuleState =>
  ({ scope: "global", ruleId, name: ruleId, active: false, since: 0, reading: "", readingAt: 0, holding: "", ...over });
const view = (o: Partial<OrchestrationViewProps> = {}) =>
  renderToStaticMarkup(React.createElement(OrchestrationView, {
    policy: base(), scope: "global", root: "", projects: [], readiness: READY, states: [], seat: null, notes: {}, busy: false,
    onRoot() {}, onSave: async () => null, onScope() {}, onOpenEngines() {}, ...o,
  } as OrchestrationViewProps));
/** The picture's own markup: from its card to the next card. */
const flowOf = (html: string): string => {
  const at = html.indexOf('data-flow="right-now"');
  expect(at).toBeGreaterThan(-1);
  return html.slice(at, html.indexOf("</section>", at));
};

describe("right now, the default", () => {
  const f = flowOf(view());
  test("it is the picture beside the editor, and draws every node of the mock", () => {
    expect(view().indexOf("Drawn, not a capture")).toBeGreaterThan(view().indexOf('class="agx-split-side"'));
    for (const w of ["You", "Orchestrator", "Scout", "Builder", "Reviewer", "Verifier", "Fallback", "Gate"]) expect(f).toContain(`>${w}`);
  });
  test("each of the jobs is a button that opens its details, and each says its engine and model", () => {
    for (const w of ["main agent", "scouts", "builders", "verifiers"]) expect(f).toContain(`aria-label="Change the ${w}"`);
    expect(f).toContain(`${title("claude")} · opus`);
    expect(f).toContain(`${title("claude")} · haiku`);
  });
  test("it says why: no rule is on", () => {
    expect(f).toContain("Because no rule is on: every job uses its own setting.");
  });
  test("with no rule that watches a plan the fallback says none is set, and the gate waits for its answer", () => {
    expect(f).toContain("none set");
    expect(f).toContain("Checking");
  });
  test("the page's old words stay out of it", () => {
    expect(/chair|seat|envelope|ceiling/i.test(f)).toBe(false);
  });
  test("Check my setup is still reachable on the page", () => {
    expect(view()).toContain("Check my setup");
  });
});

describe("right now, after a ready-made setup", () => {
  const p = applyPreset(base(), "claude-orchestrates", READY)!;
  const f = flowOf(view({ policy: p, states: [st("preset-claude-orchestrates", { active: true })] }));
  test("builders show the chain in the order it is tried, and the job a setup moved has the green ground", () => {
    expect(f).toContain(`${title("opencode")} → ${title("hermes")}`);
    expect(f).toContain("color-mix(in srgb, var(--success) 8%");
  });
  test("and names the setup", () => {
    expect(f).toContain("Because of the ready-made setup “Claude Code orchestrates”. The other jobs use their own setting.".replace("Claude Code", title("claude")));
  });
});

describe("right now, under a rule of the person's", () => {
  const rule: PolicyRule = { id: "night", name: "Quiet nights", enabled: true, when: [{ kind: "always" }], workers: { builder: [{ engine: "opencode", model: "big-pickle" }] } };
  const f = flowOf(view({ policy: { ...base(), rules: [rule] }, states: [st("night", { active: true })] }));
  test("the builders move to the rule's engine and the line names the rule", () => {
    expect(f).toContain("big-pickle");
    expect(f).toContain("Because “Quiet nights” is on.");
  });
});

describe("the fallback is the first rule that watches a plan, drawn from its state", () => {
  const rule = (enabled: boolean): PolicyRule => ({ id: "low", name: "Low plan", enabled, when: [{ kind: "usage", provider: "anthropic", window: "weekly", remainingAtMost: 15 }], workers: { builder: [{ engine: "opencode", model: "" }] } });
  const draw = (r: PolicyRule, on: boolean) => flowOf(view({ policy: { ...base(), rules: [r] }, states: [st("low", { active: on })] }));
  test("it names the threshold, the engine and the job it moves", () => {
    const f = draw(rule(true), false);
    expect(f).toContain("≤ 15 % left");
    expect(f).toContain(`${title("opencode")} · builders`);
    expect(f).toContain("Waiting");
  });
  test("while the rule holds it says so and the line is the warning colour, solid", () => {
    const f = draw(rule(true), true);
    expect(f).toContain("In use now");
    expect(f).toContain("var(--warning)");
  });
  test("a rule that is off says so and the node is muted", () => {
    const f = draw(rule(false), false);
    expect(f).toContain("Rule is off");
    expect(f).toContain('opacity="0.62"');
  });
});

describe("the gate is the real switch", () => {
  test("on: amber, and it says what it holds", () => {
    const f = flowOf(view({ gate: { on: true, bundled: true } }));
    expect(f).toContain("push · PR · comment · merge → asks you");
    expect(f).not.toContain("Gate · off");
  });
  test("off: it says nothing outward is held", () => {
    const f = flowOf(view({ gate: { on: false, bundled: true } }));
    expect(f).toContain("Gate · off");
    expect(f).toContain("nothing outward is held");
  });
  test("a build with no gate says so", () => {
    expect(flowOf(view({ gate: { on: false, bundled: false } }))).toContain("Not in this build");
  });
});

describe("right now, when a job cannot run", () => {
  test("the sentence the seat would get is under the picture, and the node says why in a word", () => {
    const dead = [engine("claude"), engine("opencode", { found: false, roles: { worker: { ok: false, why: "OpenCode is not installed." }, orchestrator: { ok: false, why: "OpenCode is not installed." } } })];
    const p = base(); p.base.workers.scout.value = [{ engine: "opencode", model: "" }];
    const f = flowOf(view({ policy: p, readiness: dead }));
    expect(f).toContain("The scouts cannot start");
    expect(f).toContain("Not installed");
  });
  test("before the probe answers no node claims a state and no sentence says cannot start", () => {
    const f = flowOf(view({ readiness: null }));
    expect(f).toContain("Checking this machine.");
    expect(f).not.toContain("cannot start");
    expect(f).not.toContain("Not ready");
  });
});

describe("the picture's source", () => {
  test("it makes no request, and every colour is a theme token", () => {
    expect(/\bapi\./.test(flowSrc)).toBe(false);
    expect(/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(flowSrc)).toBe(false);
  });
  test("a job opens its details on the page, and the page has the row to go to", () => {
    expect(paneSrc).toContain("revealEditor(");
    expect(paneSrc).toContain("<FlowView");
    expect(view({ openPicker: "orchestrator" })).toContain('data-row="orchestrator"');
    expect(view({ openPicker: "scout" })).toContain('data-row="scout"');
  });
});

describe("the reviewer is a job like the others", () => {
  test("the picture and the page order the jobs the same way and miss none of the roles", async () => {
    const { JOB_ORDER } = await import("../src/components/orchestration/orchestrationCopy.ts");
    const { ROLE_IDS } = await import("../../shared/orchestration.ts");
    expect([...JOB_ORDER].sort()).toEqual([...ROLE_IDS].sort());
    const html = view();
    expect(html).toContain("Reviewer");
    expect(flowOf(html)).toContain("Change the reviewers");
  });
});

/*
 * "Right now": the picture at the top of the Orchestration page. The main agent
 * and the three jobs, each a chain of engine tiles in the order they are tried,
 * and one "Because" line that names what put them there: the defaults, a
 * ready-made setup, or a rule.
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
  workers: { scout: { engine: "claude", model: "haiku" }, builder: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
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
  test("it is the picture beside the editor, and uses the plain role words", () => {
    expect(view().indexOf("Right now")).toBeGreaterThan(view().indexOf('class="agx-split-side"'));
    for (const w of ["Main agent", "Scouts", "Builders", "Verifiers"]) expect(f).toContain(w);
  });
  test("every job is a card with one Change button, each tile a state word", () => {
    expect(f.split(">Change<").length - 1).toBe(4);
    expect(f.split("agx-engine-tile").length - 1).toBe(4);
    expect(f).toContain("Ready");
  });
  test("it says why: no rule is on", () => {
    expect(f).toContain("Because no rule is on: every job uses its own setting.");
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
  test("builders show the chain, in order, with position numbers and an arrow", () => {
    expect(f).toContain(">1<");
    expect(f).toContain(">2<");
    expect(f).toContain("agx-flow-arrow");
    expect(f.split("agx-engine-tile").length - 1).toBe(1 + 3 * 2);
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

describe("right now, when a job cannot run", () => {
  test("the card says the sentence the seat would get, and the tile says why on hover", () => {
    const dead = [engine("claude"), engine("opencode", { found: false, roles: { worker: { ok: false, why: "OpenCode is not installed." }, orchestrator: { ok: false, why: "OpenCode is not installed." } } })];
    const p = base(); p.base.workers.scout.value = [{ engine: "opencode", model: "" }];
    const f = flowOf(view({ policy: p, readiness: dead }));
    expect(f).toContain("The scouts cannot start");
    expect(f).toContain("Not installed");
  });
  test("before the probe answers, every tile says Checking and no sentence claims a state", () => {
    const f = flowOf(view({ readiness: null }));
    expect(f.split("Checking").length - 1).toBeGreaterThanOrEqual(4);
    expect(f).not.toContain("cannot start");
  });
});

describe("the picture's source", () => {
  test("it makes no request and draws every engine through the tile", () => {
    expect(/\bapi\./.test(flowSrc)).toBe(false);
    expect(flowSrc).toContain("<EngineTile");
  });
  test("Change goes to the Fine-tune rows on the page, and the page has them to go to", () => {
    expect(paneSrc).toContain("revealEditor(");
    expect(paneSrc).toContain("<FlowView");
    expect(view({ openPicker: "orchestrator" })).toContain('data-row="engine-and-model"');
    expect(view({ openPicker: "scout" })).toContain('data-row="scout"');
  });
});

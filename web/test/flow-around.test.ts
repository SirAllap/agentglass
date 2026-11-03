/*
 * The "Around the flow" row under the canvas: Orchestrator, Fallback and Gate.
 * Each chip shows the current state, and its control makes the call the
 * Orchestration page makes. There is no browser here, so the row is rendered to
 * markup and the calls are asserted on a stubbed fetch.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { composePolicy, defaultStored } from "../../shared/orchestration.ts";
import { withBaseChoice } from "../src/components/orchestration/orchestrationCopy.ts";
import { FallbackControls } from "../src/components/orchestration/flow/FallbackControls.tsx";
import { AroundRow, aroundChips, saveAroundPolicy, switchGate, type Around } from "../src/components/orchestration/flow/AroundFlow.tsx";
import { globalStubs } from "./stubGlobal.ts";

const stubGlobal = globalStubs();
const policy = composePolicy(defaultStored(), {
  orchestrator: { engine: "claude", model: "sonnet" },
  workers: { scout: { engine: "opencode", model: "" }, builder: { engine: "claude", model: "sonnet" }, reviewer: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
});
const withPlanRule = {
  ...policy,
  rules: [{ id: "plan", name: "Plan low", enabled: true, when: [{ kind: "usage", provider: "claude", remainingAtMost: 15 }], workers: { builder: [{ engine: "opencode", model: "" }] } }],
} as unknown as typeof policy;
const around = (over: Partial<Around> = {}): Around => ({
  root: "/home/you/code/orbit", policy: withPlanRule, readiness: null, seat: null, gate: { on: true, bundled: true }, states: [], own: true, note: "",
  saveRule: async () => null, claim: async () => null, setGate: async () => {}, ...over,
});
const html = (a: Around, open: "orchestrator" | "fallback" | null = null) => renderToStaticMarkup(createElement(AroundRow, { a, open, onOpen: () => {} }));

const SRC = join(import.meta.dir, "..", "src", "components", "orchestration", "flow");
const isComment = (l: string) => ["//", "*", "/*"].some((m) => l.trim().startsWith(m));
const code = (f: string) => readFileSync(join(SRC, f), "utf8").split("\n").filter((l) => !isComment(l)).join("\n");

function calls() {
  const seen: { url: string; body: any }[] = [];
  stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ ok: true, policy: withBaseChoice(withPlanRule, "orchestrator", { engine: "opencode", model: "" }) }), { headers: { "content-type": "application/json" } });
  });
  return seen;
}

describe("Orchestrator chip", () => {
  test("renders its name and the engine and model in force", () => {
    expect(html(around())).toContain("Orchestrator");
    expect(aroundChips(around()).orchestrator.value).toContain("sonnet");
  });
  test("the live seat's model wins over the policy's", () => {
    const seat = { seat: { model: "opus" } } as Around["seat"];
    expect(aroundChips(around({ seat })).orchestrator.value).toContain("opus");
  });
  test("a change posts the whole policy to /orchestration, once, for the project that has its own", async () => {
    const seen = calls();
    await saveAroundPolicy(withBaseChoice(withPlanRule, "orchestrator", { engine: "opencode", model: "" }), "/home/you/code/orbit", true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toContain("/orchestration");
    expect(seen[0]!.body.root).toBe("/home/you/code/orbit");
    expect(seen[0]!.body.policy.base.orchestrator.value[0].engine).toBe("opencode");
  });
  test("a project on the all-projects policy saves that one", async () => {
    const seen = calls();
    await saveAroundPolicy(withPlanRule, "/home/you/code/orbit", false);
    expect(seen[0]!.body.root).toBeUndefined();
  });
});

describe("Fallback chip", () => {
  test("renders its name and the rule's state and threshold", () => {
    expect(html(around())).toContain("Fallback");
    expect(aroundChips(around()).fallback.value).toStartWith("at 15 % left · OpenCode");
    expect(aroundChips(around({ policy: { ...withPlanRule, rules: [{ ...withPlanRule.rules[0]!, enabled: false }] } })).fallback.value).toStartWith("off");
    expect(aroundChips(around({ policy })).fallback.value).toBe("no rule");
  });
  test("opens the panel: the chip is pressed while it is open, and FallbackControls is the page's own component", () => {
    expect(html(around(), "fallback")).toContain('aria-pressed="true"');
    expect(code("AroundFlow.tsx")).toContain("<FallbackControls");
    expect(code("AroundFlow.tsx")).not.toContain("function FallbackControls(");
  });
  test("a rule edit goes out as the same /orchestration call", async () => {
    const seen = calls();
    await saveAroundPolicy(withPlanRule, "", false);
    expect(seen[0]!.url).toContain("/orchestration");
  });
});

describe("FallbackControls (moved from the page's This block panel)", () => {
  const ctl = (watch: unknown, stacked = true) => renderToStaticMarkup(createElement(FallbackControls, {
    watch: watch as never, policy, readiness: null, disabled: false, onEditRule() {}, stacked,
  }));
  const rule = withPlanRule.rules[0]!;
  test("with no rule that watches a plan it says so", () => {
    expect(ctl(undefined)).toContain("No usage rule is set");
  });
  test("with one: a threshold select, the fallback select and the Then go back switch, all from the rule", () => {
    const s = ctl(rule);
    expect(s).toContain("Plan left, at most");
    expect(s).toContain("15 % left");
    expect(s).toContain("Fallback engine");
    expect(s).toContain("Then go back");
    expect(s).toContain("Turn the rule off");
  });
  test("Then go back is the rule's own switch: off keeps the rule and never switches", () => {
    expect(ctl({ ...rule, enabled: false })).toContain("Turn the rule on");
  });
});

describe("Gate chip", () => {
  test("renders a switch that shows on, off and 'not in this build'", () => {
    expect(html(around())).toContain('role="switch" aria-checked="true" aria-label="Gate"');
    expect(html(around({ gate: { on: false, bundled: true } }))).toContain('aria-checked="false" aria-label="Gate"');
    expect(aroundChips(around({ gate: { on: false, bundled: false } })).gate.value).toBe("not in this build");
    expect(html(around({ gate: { on: false, bundled: false } }))).toMatch(/aria-label="Gate"[^>]*disabled/);
  });
  test("the switch posts {on} to /hooks/gate and a link opens Settings", async () => {
    const seen = calls();
    await switchGate(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toContain("/hooks/gate");
    expect(seen[0]!.body).toEqual({ on: false });
    expect(html(around())).toContain("Settings");
    expect(code("AroundFlow.tsx")).toContain('openSettings("hooks")');
  });
});

describe("the row fits 292px", () => {
  test("no control in the row or its panel uses nowrap, and the panel lets its children shrink", () => {
    const css = readFileSync(join(SRC, "flowEditor.css"), "utf8");
    const rules = css.split("\n").filter((l) => /\.fe-(around|achip|alink|aroundfb|aroundside|center)/.test(l));
    expect(rules.length).toBeGreaterThan(5);
    for (const l of rules) expect(l).not.toContain("nowrap");
    expect(code("AroundFlow.tsx")).not.toContain("nowrap");
    expect(css).toContain(".fe-aroundside * { min-width: 0; }");
  });
});

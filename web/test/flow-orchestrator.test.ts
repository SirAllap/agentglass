/*
 * The orchestrator's card and its sheet, without a renderer: the card is a pure
 * model painted by one component, and the sheet's writes are three functions.
 * So what is asserted here is what a person reads on the card, that a refusal is
 * the server's sentence rather than a stored value, and where the pilot and the
 * "what it does with code" answer live (one home each).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { templateFlow } from "../../shared/flowTemplates.ts";
import { composePolicy, defaultStored } from "../../shared/orchestration.ts";
import { SETTING_CLASSES, agentVerdict } from "../../shared/settingClass.ts";
import { OrchestratorCard } from "../src/components/orchestration/flow/OrchestratorCard.tsx";
import { saveCeiling, savePilot } from "../src/components/orchestration/flow/OrchestratorSheet.tsx";
import { saveAroundPolicy, type Around } from "../src/components/orchestration/flow/AroundFlow.tsx";
import { usageLeft } from "../src/components/orchestration/orchestrationCopy.ts";
import type { PolicyRuleState } from "../src/lib/api.ts";
import { workerCardModel } from "../src/lib/workerCardView.ts";
import { orchestratorCardModel, type OrchestratorCardData } from "../src/lib/orchestratorCardView.ts";
import { globalStubs } from "./stubGlobal.ts";

const stubGlobal = globalStubs();
const flow = templateFlow();
const policy = composePolicy(defaultStored(), {
  orchestrator: { engine: "opencode", model: "big-pickle" },
  workers: { scout: { engine: "opencode", model: "" }, builder: { engine: "claude", model: "sonnet" }, reviewer: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
});
const ROOT = "/home/you/code/orbit";

const around = (over: Partial<Around> = {}): Around => ({
  root: ROOT, policy, readiness: null, seat: null, gate: null, states: [], own: true, note: "",
  saveRule: async () => null, claim: async () => null, setGate: async () => {}, ...over,
});

const data = (over: Partial<OrchestratorCardData> = {}): OrchestratorCardData => ({
  chair: { engine: "opencode", model: "big-pickle" }, maxWorkers: 3, ...over,
});

const card = (over: Partial<OrchestratorCardData> = {}) => renderToStaticMarkup(createElement(OrchestratorCard, { flow, data: data(over), x: 0, y: 0 }));

function calls(reply: (url: string) => unknown = () => ({ ok: true, policy })) {
  const seen: { url: string; body: any }[] = [];
  stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(reply(String(url))), { headers: { "content-type": "application/json" } });
  });
  return seen;
}

describe("the orchestrator's card", () => {
  test("prints the chair the policy resolved, engine and model", () => {
    const m = orchestratorCardModel(flow, data());
    expect(m.chairWord).toBe("OpenCode · big-pickle");
    expect(card()).toContain("OpenCode · big-pickle");
  });

  test("the count line is n of the policy's own maxWorkers, never a made-up cap", () => {
    const counts = { builder: { run: 1, wait: 0, cost: 2.5 }, scout: { run: 0, wait: 1, cost: 0.5 } };
    const m = orchestratorCardModel(flow, data({ counts }));
    expect(m.flight).toBe("1 of 3");
    expect(orchestratorCardModel(flow, data({ counts, maxWorkers: 12 })).flight).toBe("1 of 12");
    // "waiting on you" is a person, not a queue: nothing here counts it as flying.
    expect(m.flightTip).toContain("Not a queue");
  });

  test("no counts means no reading: the card says — and never a zero it did not read", () => {
    const m = orchestratorCardModel(flow, data());
    expect(m.flight).toBe("—");
    expect(m.today).toBe("—");
    expect(m.last).toBe("—");
    expect(card()).toContain("—");
    const withCounts = orchestratorCardModel(flow, data({ counts: { builder: { run: 2, wait: 0, cost: 1.25 } } }));
    expect(withCounts.today).toBe("$1.25");
  });

  test("the plan used is the chair's own reading, keyed the way the page keys it", () => {
    // The page keys readings by usage provider: Claude's plan is "anthropic", Codex's is "codex".
    const state = (reading: string): PolicyRuleState[] => [{ scope: ROOT, ruleId: "r", name: "r", active: true, since: 1, reading, readingAt: 1, holding: "" }];
    const planOf = (engine: string, reading: string) => orchestratorCardModel(flow, data({ chair: { engine, model: "" }, planLeft: usageLeft(state(reading), ROOT) })).plan;
    expect(planOf("claude", "Claude 58% left")).toBe("42%");
    expect(planOf("codex", "Codex 58% left")).toBe("42%");
    // An engine whose id is also its provider id reads its own key, and never borrows another plan's reading.
    expect(orchestratorCardModel(flow, data({ planLeft: { opencode: 58 } })).plan).toBe("42%");
    expect(planOf("opencode", "Claude 58% left")).toBe("—");
    expect(orchestratorCardModel(flow, data()).plan).toBe("—");
  });

  test("the seat tag says only what the seat route answered", () => {
    expect(card()).toContain("The seat has not been read yet");
    expect(card()).not.toContain("Nobody is seated");
    expect(card({ seat: { name: null } })).toContain("Nobody is seated in this project right now");
  });

  test("the seat says who is in the chair, and nobody when the chair is empty", () => {
    expect(orchestratorCardModel(flow, data({ seat: { name: "orbit-orchestrator" } })).stateWord).toBe("In the chair");
    expect(orchestratorCardModel(flow, data({ seat: { name: null } })).stateWord).toBe("Nobody in the chair");
    // Not read at all: still no guess.
    expect(orchestratorCardModel(flow, data()).stateWord).toBe("—");
  });

  test("the roles off the path are the flow's own, not a constant", () => {
    const m = orchestratorCardModel(flow, data());
    expect(m.team).toHaveLength(flow.roster.length - flow.path.length);
    expect(m.team.map((t) => t.name)).toEqual(flow.roster.filter((r) => !flow.path.includes(r.id)).map((r) => r.name));
    const all = { ...flow, path: flow.roster.map((r) => r.id) };
    expect(orchestratorCardModel(all, data()).teamWord).toBe("the whole team is on the path");
  });

  test("the two ways in are buttons, and Open its tab only when somebody is seated", () => {
    const withBoth = renderToStaticMarkup(createElement(OrchestratorCard, { flow, data: data(), x: 0, y: 0, onConfigure() {}, onOpenTab() {} }));
    expect(withBoth).toContain("Configure");
    expect(withBoth).toContain("Open its tab");
    const closed = renderToStaticMarkup(createElement(OrchestratorCard, { flow, data: data(), x: 0, y: 0, onConfigure() {} }));
    expect(closed).not.toContain("Open its tab");
  });

  test("the card is not bigger than the room the canvas keeps for it", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "lib", "flowView.ts"), "utf8");
    const css = readFileSync(join(import.meta.dir, "..", "src", "components", "orchestration", "flow", "flowEditor.css"), "utf8");
    const h = Number(src.match(/export const ORCH_H = (\d+)/)![1]);
    const top = Number(src.match(/export const ROWS_TOP = (\d+)/)![1]);
    expect(css).toContain(`.fe-oc { width: 560px; height: ${h}px;`);
    // The path starts under the card, so the card never sits on the first row.
    expect(top).toBeGreaterThan(h);
  });
});

describe("the sheet's writes", () => {
  // The sheet saves the ceiling through the editor's own save path, which is the page's: one function, one route.
  const saved = (over: Partial<Around> = {}) => around({
    saveRule: async (next) => {
      const r = await saveAroundPolicy(next, ROOT, true);
      return r.ok ? null : r.error ?? "Could not save.";
    },
    ...over,
  });

  test("a ceiling change is the whole policy to /orchestration, for the project that has its own", async () => {
    const seen = calls();
    const e = await saveCeiling(saved(), { ...policy.ceiling, network: true });
    expect(e).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toContain("/orchestration");
    expect(seen[0]!.body.root).toBe(ROOT);
    expect(seen[0]!.body.policy.ceiling.network).toBe(true);
  });

  test("a ceiling below the worker default is not saved: the server's sentence is what the sheet draws", async () => {
    const sentence = "policy.workerDefault is wider than the most the main agent may allow; lower the default or raise that limit on purpose";
    calls(() => ({ ok: false, error: sentence }));
    const e = await saveCeiling(saved(), { ...policy.ceiling, write: "none" });
    expect(e).toBe(sentence);
  });

  test("the pilot writes flightPlan.pilot at once, in this project", async () => {
    const seen = calls(() => ({ ok: true }));
    expect(await savePilot(ROOT, "copilot")).toBeNull();
    expect(seen[0]!.url).toContain("/settings/door");
    expect(seen[0]!.body).toEqual({ id: "flightPlan.pilot", value: "copilot", root: ROOT });
  });

  test("autopilot is the person's alone: an agent's request is refused, and the sheet says so", async () => {
    const row = SETTING_CLASSES["flightPlan.pilot"]!;
    expect(row.class).toBe("escalation");
    expect(row.personOnlyWhen).toBeDefined();
    // The shared table is what the door reads: autopilot is refused to an agent, and the person's own switch cannot apply it either.
    expect(agentVerdict("flightPlan.pilot", "manual", "autopilot", false)).toBe("refuse");
    expect(agentVerdict("flightPlan.pilot", "manual", "autopilot", true)).toBe("refuse");
    expect(agentVerdict("flightPlan.pilot", "copilot", "manual", false)).toBe("apply");
    const seen = calls(() => ({ ok: false, error: row.personOnlyWhen!.why }));
    expect(await savePilot(ROOT, "autopilot")).toBe(row.personOnlyWhen!.why);
    expect(seen).toHaveLength(1);
  });
});

describe("one home per setting", () => {
  const SRC = join(import.meta.dir, "..", "src", "components", "orchestration", "flow");
  const code = (f: string) => readFileSync(join(SRC, f), "utf8").split("\n").filter((l) => !["//", "*", "/*"].some((m) => l.trim().startsWith(m))).join("\n");

  test("the Orchestrator chip opens the sheet, and the side panel is the Fallback's alone", () => {
    const editor = code("FlowEditor.tsx");
    expect(editor).toContain('<OrchestratorSheet');
    expect(editor).toMatch(/around === "orchestrator" && \([\s\S]*?<OrchestratorSheet/);
    expect(editor).toContain('{around === "fallback" && !selected && <AroundSide');
    // The old orchestrator branch of the side panel is gone, not hidden behind a condition.
    expect(code("AroundFlow.tsx")).not.toContain("OrchestratorControls");
  });

  test("the code-handling radios are not in the sheet: the reviewing block keeps them", () => {
    const sheet = code("OrchestratorSheet.tsx");
    expect(sheet).not.toContain("review.who");
    expect(sheet).toContain("Set on the reviewing block");
    expect(sheet).toContain("reviewWho");
  });

  test("the card and the sheet read the review answer the editor read once, not each their own request", () => {
    const editor = code("FlowEditor.tsx");
    expect(editor.split("REVIEW_SETTING_IDS.who").length - 1).toBe(1);
    expect(code("OrchestratorCard.tsx")).not.toContain("api.");
  });

  test("the ceiling's rows lock while their save is in flight, as the engine and the pilot do", () => {
    const sheet = code("OrchestratorSheet.tsx");
    // Outside a busy bracket, two quick toggles both build from the same stale ceiling and one write is lost.
    expect(sheet).toMatch(/setBusy\(true\);\s*const e = await saveCeiling\(/);
    expect(sheet).not.toMatch(/onChange=\{[^}]*saveCeiling\(/);
  });
});

describe("the card is the worker card's family", () => {
  test("the two cards say a cost the same way, so a person compares them without translating", () => {
    const counts = { builder: { run: 1, wait: 0, cost: 3.4 } };
    const builder = flow.roster.find((r) => r.id === "builder")!;
    expect(workerCardModel(flow, builder, counts).cost).toBe("$3.40");
    expect(orchestratorCardModel(flow, data({ counts })).today).toBe("$3.40");
  });
});

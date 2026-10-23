/*
 * The compact Orchestration page: Quick setup as one segmented choice, Switch
 * things automatically as the one plan rule, Always refused as a textarea and
 * the gate's own switch, the save bar, and the chip beside the title.
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
import { applyPreset, denyLines, presetChip, thresholdsFor, withFallbackEngine, withThreshold } from "../src/components/orchestration/orchestrationCopy.ts";

const DIR = join(import.meta.dir, "..", "src", "components", "orchestration");
const strip = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const paneSrc = strip(readFileSync(join(DIR, "OrchestrationPane.tsx"), "utf8"));
const cssSrc = readFileSync(join(DIR, "orchestration.css"), "utf8");
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
const view = (o: Partial<OrchestrationViewProps> = {}) =>
  renderToStaticMarkup(React.createElement(OrchestrationView, {
    policy: base(), scope: "global", root: "", projects: [], readiness: READY, states: [], seat: null, notes: {}, busy: false,
    onRoot() {}, onSave: async () => null, onScope() {}, onOpenEngines() {}, ...o,
  } as OrchestrationViewProps));
const watch = (over: Partial<PolicyRule> = {}): PolicyRule => ({
  id: "low", name: "Low plan", enabled: true, when: [{ kind: "usage", provider: "anthropic", window: "weekly", remainingAtMost: 15 }],
  workers: { builder: [{ engine: "opencode", model: "" }, { engine: "hermes", model: "" }] }, ...over,
});
const card = (html: string, heading: string): string => {
  const at = html.indexOf(`>${heading}</h3>`);
  expect(at, heading).toBeGreaterThan(-1);
  const next = html.indexOf('<section aria-labelledby', at);
  return html.slice(at, next < 0 ? undefined : next);
};

describe("Quick setup is one segmented choice", () => {
  test("the two setups that always hold are the segments, and none is pressed until one is in force", () => {
    const q = card(view(), "Quick setup");
    expect(q).toContain('aria-label="Start from a preset"');
    expect(q).toContain(">Claude + others</button>");
    expect(q).toContain(">All on Claude</button>");
    expect(q).not.toContain('aria-pressed="true"');
    expect(q).not.toContain(">Save my plan</button>");
  });
  test("the setup in force is the pressed segment and says what it does in one line", () => {
    const q = card(view({ policy: applyPreset(base(), "all-on-claude", READY)! }), "Quick setup");
    expect(q).toMatch(/aria-pressed="true"[^>]*>All on Claude</);
    expect(q).toContain(`${title("claude")} runs the main agent and every worker.`);
  });
  test("the before-and-after cards, Check my setup and the Undo are one disclosure away, not gone", () => {
    const q = card(view(), "Quick setup");
    expect(q).toContain("Before and after, and check my setup");
    expect(q).toContain("Check my setup");
    expect(q).toContain("Use this setup");
  });
  test("a setup that cannot be built here is a disabled segment that says why", () => {
    const q = card(view({ readiness: [engine("claude")] }), "Quick setup");
    expect(q).toMatch(/<button[^>]*title="Needs an engine besides[^"]*"[^>]*disabled=""[^>]*>Claude \+ others</);
  });
});

describe("Switch things automatically is the one plan rule", () => {
  test("with no rule that watches a plan it offers the ready-made one, and every condition stays listed under a disclosure", () => {
    const s = card(view(), "Switch things automatically");
    expect(s).toContain("No plan is watched yet");
    expect(s).toContain("Use this rule");
    expect(s).toContain("All conditions (0)");
    expect(s).toContain("+ Add a condition");
  });
  test("with one: a threshold select, the fallback select and the Then go back switch, all from the rule", () => {
    const s = card(view({ policy: { ...base(), rules: [watch()] } }), "Switch things automatically");
    expect(s).toContain(`When ${title("claude")} has`);
    expect(s).toContain('aria-label="Plan left, at most"');
    expect(s).toContain("15 % left");
    expect(s).toContain('aria-label="Fallback engine"');
    expect(s).toContain(title("opencode"));
    expect(s).toMatch(/role="switch" aria-checked="true"[^>]*><span class="min-w-0"><span class="agx-row-name">Then go back/);
    expect(s).toContain("All conditions (1)");
  });
  test("Then go back is the rule's own switch: off keeps the rule and never switches", () => {
    const s = card(view({ policy: { ...base(), rules: [watch({ enabled: false })] } }), "Switch things automatically");
    expect(s).toMatch(/aria-checked="false"[^>]*><span class="min-w-0"><span class="agx-row-name">Then go back/);
  });
  test("a threshold the select does not offer is added to it, in order; the pure edits keep what they do not touch", () => {
    expect(thresholdsFor(null)).toEqual([5, 10, 15, 20, 25, 30, 40, 50]);
    expect(thresholdsFor(12)).toEqual([5, 10, 12, 15, 20, 25, 30, 40, 50]);
    const r = withThreshold(watch({ when: [{ kind: "hours", days: [1], from: "22:00", to: "07:00" }, ...watch().when] }), 25);
    expect(r.when[0]).toEqual({ kind: "hours", days: [1], from: "22:00", to: "07:00" });
    expect(r.when[1]).toEqual({ kind: "usage", provider: "anthropic", window: "weekly", remainingAtMost: 25 });
    const f = withFallbackEngine(watch(), "codex");
    expect(f.workers?.builder).toEqual([{ engine: "codex", model: "" }, { engine: "hermes", model: "" }]);
    expect(withFallbackEngine({ ...watch(), workers: undefined }, "codex").workers).toBeUndefined();
  });
  test("an edit goes through the page's own save, and nothing else", () => {
    expect(paneSrc).toContain("const editWatch = (next: PolicyRule) => void save(withRule(policy, next), \"rules\")");
  });
});

describe("Always refused", () => {
  test("it is a textarea of the worker default's commands, an add field and the gate's switch", () => {
    const p = base(); p.workerDefault = { ...p.workerDefault, deny: ["docker compose down", "git push --force"] };
    const a = card(view({ policy: p }), "Always refused");
    expect(a).toMatch(/<textarea[^>]*aria-label="Commands no worker may run"[^>]*>docker compose down\ngit push --force<\/textarea>/);
    expect(a).toContain('aria-label="Add a command to refuse"');
    expect(a).toContain("Ask when it runs");
    expect(a).toContain("Why this cannot be changed here");
  });
  test("the Safety card no longer repeats the commands of the default group, and the ceiling keeps its own", () => {
    const s = view().slice(view().indexOf(">Safety and limits</h3>"));
    expect(s).not.toContain('data-row="also-refuse"');
    expect(s).toContain('data-row="at-most-also-refuse"');
  });
  test("the switch is the gate's: on, off, not in this build, and not yet read", () => {
    const sw = (g: OrchestrationViewProps["gate"]) => card(view({ gate: g, onGate: async () => null }), "Always refused");
    expect(sw({ on: true, bundled: true })).toMatch(/role="switch" aria-checked="true"[^>]*data-row="ask-when-it-runs"/);
    expect(sw({ on: false, bundled: true })).toMatch(/role="switch" aria-checked="false"[^>]*data-row="ask-when-it-runs"/);
    expect(sw({ on: false, bundled: false })).toContain("This build ships no gate.");
    expect(sw({ on: false, bundled: false })).toMatch(/disabled=""[^>]*role="switch"/);
    expect(sw(null)).toMatch(/disabled=""[^>]*role="switch"/);
  });
  test("the page flips the gate through the hooks route and reads it again", () => {
    expect(paneSrc).toContain("api.hooksGate(on)");
    expect(paneSrc).toContain("api.hooksStatus()");
  });
  test("the lines of the textarea are trimmed, never blank and never repeated", () => {
    expect(denyLines("  git push --force \n\n docker compose down\ngit push --force\n")).toEqual(["git push --force", "docker compose down"]);
    expect(denyLines("")).toEqual([]);
  });
});

describe("the save bar and the chip", () => {
  test("the bar ends the column, saves both envelopes together and is disabled until something changed", () => {
    const html = view();
    const bar = html.slice(html.indexOf("data-savebar"));
    expect(bar).toMatch(/disabled=""[^>]*>Save these permissions</);
    expect(paneSrc).toContain('void save(withEnvelopes(policy, env), "envelope")');
  });
  test("the chip beside the scope says the page is saved, for the scope on screen", () => {
    expect(view()).toContain("Saved for all projects");
    expect(view({ root: "/w/orbit", projects: ["/w/orbit"], scope: "project" })).toContain("Saved for orbit");
  });
  test("the header chip is the setup in force, or says there is none", () => {
    const label = (id: string) => id;
    expect(presetChip([{ id: "claude-orchestrates", active: false }, { id: "all-on-claude", active: false }], label)).toEqual({ tone: "off", text: "No preset" });
    expect(presetChip([{ id: "claude-orchestrates", active: false }, { id: "all-on-claude", active: true }], label)).toEqual({ tone: "ok", text: "all-on-claude" });
    expect(presetChip([{ id: "save-my-plan", active: true }, { id: "all-on-claude", active: false }], label)).toEqual({ tone: "ok", text: "save-my-plan" });
  });
});

describe("the page's own styles", () => {
  test("every rule is scoped to the page and every colour is a theme token", () => {
    const rules = [...cssSrc.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((m) => m[2]!.trim());
    for (const sel of rules) for (const one of sel.split(",")) expect(/\.agx-orch/.test(one), one).toBe(true);
    expect(/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(cssSrc.replace(/\/\*[\s\S]*?\*\//g, ""))).toBe(false);
  });
});

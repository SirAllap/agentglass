/*
 * The compact Orchestration page: Quick setup as one segmented choice, Switch
 * things automatically as the one plan rule, Always refused as a textarea and
 * a pointer to the Gate in the Flow editor, the save bar, and the chip beside the title.
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
});

describe("the Fallback block is the one plan rule", () => {
  // The block's own controls (threshold, engine, Then go back) are asserted in flow-around.test.ts, on FallbackControls.
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
});

describe("Always refused", () => {
  test("one textarea holds the worker default's commands, one per line, and there is no second field", () => {
    const p = base(); p.workerDefault = { ...p.workerDefault, deny: ["docker compose down", "git push --force"] };
    const a = view({ policy: p }).slice(view({ policy: p }).indexOf('data-pane="refused"'));
    expect(a).toMatch(/<textarea[^>]*aria-label="Also refused here: one command per line"[^>]*>docker compose down\ngit push --force<\/textarea>/);
    expect(a).not.toContain('aria-label="Add a command to refuse"');
    // A placeholder that reads like a real refusal is not a hint: the box is empty until a person writes in it.
    expect(a).not.toContain("placeholder=");
    expect(a).toContain("Why this cannot be changed here");
  });
  test("the Safety card no longer repeats the commands of the default group, and the ceiling keeps its own", () => {
    const s = view().slice(view().indexOf('data-pane="safety"'));
    expect(s).not.toContain('data-row="also-refuse"');
    expect(s).toContain('data-row="at-most-also-refuse"');
  });
  test("the Gate's switch is in Safety and limits, with the trust switch, and not on the refused tab", () => {
    const s = view().slice(view().indexOf('data-pane="safety"'), view().indexOf('data-pane="refused"'));
    expect(s).toContain("Agents and the settings themselves");
    expect(s).toContain("Gate: ask me before landing");
    const a = view().slice(view().indexOf('data-pane="refused"'));
    expect(a).not.toContain("Gate: ask me before landing");
    expect(a).not.toContain("Ask when it runs");
  });
  test("the lines of the textarea are trimmed, never blank and never repeated", () => {
    expect(denyLines("  git push --force \n\n docker compose down\ngit push --force\n")).toEqual(["git push --force", "docker compose down"]);
    expect(denyLines("")).toEqual([]);
  });
});

describe("the save bar and the chip", () => {
  test("the bar ends the column, saves both envelopes together and is drawn only while something changed", () => {
    // Nothing changed: no bar at all, rather than a bar with a dead button.
    expect(view()).not.toContain("data-savebar");
    const bar = paneSrc.slice(paneSrc.indexOf("{dirty && ("));
    expect(bar).toContain("data-savebar");
    expect(bar).toContain("Discard");
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
    for (const sel of rules) for (const one of sel.split(",")) expect(/\.agx-(orch|flow|count)/.test(one), one).toBe(true);
    expect(/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(cssSrc.replace(/\/\*[\s\S]*?\*\//g, ""))).toBe(false);
  });
});

describe("the orchestration screens' font", () => {
  test("is the mockup's sans stack, the app's --font-prose, scoped to the orchestration roots", async () => {
    // The page's rules live in two sheets: the frame's and its own.
    const css = (await Bun.file(new URL("../src/index.css", import.meta.url)).text())
      + readFileSync(join(DIR, "orchestration.css"), "utf8");
    const roots = [...css.matchAll(/(^|\n)\s*\.agx-orch, \.agx-orch-gaps(?![\w-])[^{]*\{([^}]*)\}/g)].map((m) => m[2]!);
    expect(roots.join(" ")).toContain("font-family: var(--font-prose)");
    // The Flow editor is its own sheet and its own root.
    const flow = readFileSync(join(DIR, "flow", "flowEditor.css"), "utf8");
    const fe = [...flow.matchAll(/(^|\n)\s*\.fe-root\s*\{([^}]*)\}/g)].map((m) => m[2]!);
    expect(fe.join(" ")).toContain("font-family: var(--font-prose)");
    // Not the app's body, and not a code value: an engine and a model stay mono.
    expect(css).not.toMatch(/(^|\n)\s*body\s*\{[^}]*font-family:\s*var\(--font-prose\)/);
    expect(css).toMatch(/\.agx-flow-hero-engine code\s*\{[^}]*font-family:\s*var\(--font-mono/);
  });
});

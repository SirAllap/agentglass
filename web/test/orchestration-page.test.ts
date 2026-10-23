/*
 * The Orchestration page, drawn from what it is handed (no request is made),
 * and its source held to the rules the plan gives it: no row carries a level,
 * nothing polls, a refusal's sentence sits under Save, and the controls of a
 * rule stay where they are in every state.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { globalStubs } from "./stubGlobal";
// The libraries below read the window's storage when they load, so they load under a stub that goes back when the file ends.
globalStubs()("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
const { OrchestrationView } = await import("../src/components/orchestration/OrchestrationPane.tsx");
import type { OrchestrationViewProps } from "../src/components/orchestration/OrchestrationPane.tsx";
import { agentProvider } from "../../shared/agentKinds.ts";
import { composePolicy, defaultStored, validatePolicy, type Policy, type PolicyRule } from "../../shared/orchestration.ts";
import type { EngineReadiness } from "../../shared/types.ts";
import type { PolicyRuleState } from "../src/lib/api.ts";
import { GAUGE_HELP, NO_WORKER_ENGINE } from "../src/components/orchestration/orchestrationCopy.ts";

const DIR = join(import.meta.dir, "..", "src", "components", "orchestration");
const strip = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const FILES = readdirSync(DIR).filter((f) => /\.tsx?$/.test(f)).map((f) => ({ f, text: strip(readFileSync(join(DIR, f), "utf8")) }));
const title = (id: string) => agentProvider(id)!.title;

const engine = (id: string, over: Partial<EngineReadiness> = {}): EngineReadiness => ({
  id, title: title(id), found: true, path: `/usr/bin/${id}`, version: "1.0.0", min: null, versionOk: true,
  account: { signedIn: true }, answers: { state: "never" },
  roles: { worker: { ok: true }, orchestrator: { ok: true } },
  missing: [], envelope: { via: null, enforced: "yes", note: "" },
  ...over,
});
const OLD = engine("hermes", {
  version: "0.21.0", min: "0.21.4", versionOk: false,
  roles: { worker: { ok: false, why: "0.21.0 is older than 0.21.4." }, orchestrator: { ok: false, why: "0.21.0 is older than 0.21.4." } },
  missing: [{ kind: "command", what: "0.21.0 is installed.", command: "hermes update" }],
});
const READY = [engine("claude"), engine("opencode"), OLD];
const NONE = [OLD, engine("claude", { roles: { worker: { ok: false, why: "Not signed in." }, orchestrator: { ok: false, why: "Not signed in." } } })];

const base = (): Policy => composePolicy(defaultStored(), {
  orchestrator: { engine: "claude", model: "sonnet" },
  workers: { scout: { engine: "opencode", model: "" }, builder: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
});
const rule = (id: string, over: Partial<PolicyRule> = {}): PolicyRule => ({
  id, name: `Rule ${id}`, enabled: true, when: [{ kind: "usage", provider: "anthropic", window: "weekly", remainingAtMost: 10 }],
  workers: { builder: [{ engine: "opencode", model: "big-pickle" }] }, ...over,
});
const st = (ruleId: string, over: Partial<PolicyRuleState> = {}): PolicyRuleState =>
  ({ scope: "global", ruleId, name: ruleId, active: false, since: 0, reading: "", readingAt: 0, holding: "", ...over });

const view = (o: Partial<OrchestrationViewProps> = {}) =>
  renderToStaticMarkup(React.createElement(OrchestrationView, {
    policy: base(), scope: "global", root: "", projects: [], readiness: READY, states: [], seat: null, notes: {}, busy: false,
    onRoot() {}, onSave: async () => null, onScope() {}, onOpenEngines() {}, ...o,
  } as OrchestrationViewProps));

/** The markup of one row, from its anchor to the next. */
const rowOf = (html: string, label: string): string => {
  const at = html.indexOf(`data-row="${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
  expect(at, label).toBeGreaterThan(-1);
  const next = html.indexOf('data-row="', at + 10);
  return html.slice(at, next < 0 ? undefined : next);
};

describe("the page's source", () => {
  test("no row carries a level: no settingId without agentNever, in any file of the page", () => {
    for (const { f, text } of FILES) {
      const ids = text.match(/\bsettingId\b/g) ?? [];
      expect(ids.length === 0 || /agentNever/.test(text), f).toBe(true);
    }
  });
  test("nothing polls: no timer and no poll hook", () => {
    for (const { f, text } of FILES) {
      expect(/\bset(Interval|Timeout)\b|usePoll|requestAnimationFrame/.test(text), f).toBe(false);
    }
  });
  test("a refused save changes nothing: the policy is replaced only after the failure return", () => {
    const pane = FILES.find((x) => x.f === "OrchestrationPane.tsx")!.text;
    const at = pane.indexOf("const save = async (next: Policy, card: string)");
    const body = pane.slice(at, pane.indexOf("\n  };", at));
    expect(body.indexOf("return e;")).toBeGreaterThan(-1);
    expect(body.indexOf("setLoaded(")).toBeGreaterThan(body.indexOf("return e;"));
  });
  test('"Ask when it runs" flips the stored flag and only that', () => {
    const pane = FILES.find((x) => x.f === "OrchestrationPane.tsx")!.text;
    expect(pane).toContain("withAsk(policy, field, !ask.ask)");
  });
});

describe("a rule's row, in each state", () => {
  const rules = [rule("a"), rule("b"), rule("c"), rule("d", { workers: { builder: [{ engine: "hermes", model: "" }] } }), rule("e", { enabled: false })];
  const html = view({
    policy: { ...base(), rules },
    states: [st("a", { active: true, reading: "weekly 8% left" }), st("c", { holding: "holding: the last usage reading is 47 min old" })],
  });
  const CASES: [string, string, string][] = [
    ["a", "On now", "On now · weekly 8% left"],
    ["b", "Waiting", "Waiting"],
    ["c", "Holding", "Holding · last usage reading is 47 min old"],
    ["d", "Cannot apply", `Cannot apply · ${title("hermes")} needs an update`],
    ["e", "Off", "Off"],
  ];
  test.each(CASES)("%s: %s keeps the switch and Edit in the row, after its badge", (id, _n, badge) => {
    const row = rowOf(html, `Rule ${id}`);
    expect(row).toContain(badge);
    const at = { badge: row.indexOf(badge), sw: row.indexOf('role="switch"'), edit: row.indexOf(">Edit<") };
    expect(at.sw).toBeGreaterThan(at.badge);
    expect(at.edit).toBeGreaterThan(at.sw);
  });
  test("a rule's sentence is its hint", () => {
    expect(rowOf(html, "Rule a")).toContain(`10% or less of the ${title("claude")} weekly plan is left: builders use ${title("opencode")} big-pickle.`);
  });
});

describe("the page, in its other states", () => {
  test("no rules: the empty state says the choices above always apply", () => {
    expect(view()).toContain("No rules. The choices above always apply.");
  });
  test("no engine can work: the Workers card is one empty state, with no role rows", () => {
    const html = view({ readiness: NONE });
    expect(html).toContain(NO_WORKER_ENGINE);
    expect(html).not.toContain("Scout: engine");
    expect(view()).not.toContain(NO_WORKER_ENGINE);
  });
  test("the chosen engine is not ready: the row says why and what runs instead", () => {
    const p = base();
    p.base.workers.builder.value = [{ engine: "hermes", model: "" }];
    const html = view({ policy: p });
    expect(html).toContain("Not ready");
    expect(html).toContain("0.21.0 is older than 0.21.4.");
  });
  test("the chain ran out: the card says so, with the sentence the seat got", () => {
    const p = base();
    p.base.workers.builder.value = [{ engine: "hermes", model: "" }];
    const html = view({ policy: p });
    expect(html).toContain("Nothing in this list is ready");
    expect(html).toContain("no engine in the chain is ready");
  });
  test("the engine's name on the page is the table's, never typed into the page", () => {
    for (const { f, text } of FILES) for (const p of ["Claude Code", "OpenCode", "Hermes", "Codex"]) expect(text.includes(p), `${f} says ${p}`).toBe(false);
  });
  test("a project with no setting of its own shows the general one, greyed, with one way to set it", () => {
    const html = view({ root: "/work/orbit", scope: "global" });
    expect(html).toContain("Set for this project");
    expect(html).not.toContain("Use the general setting");
    expect(html).toContain("orbit has no setting of its own");
  });
  test("a project with its own setting can go back to the general one, and worker roles stay global", () => {
    const html = view({ root: "/work/orbit", scope: "project" });
    expect(html).toContain("Use the general setting");
    expect(html).not.toContain("Set for this project");
    expect(html).toContain("Worker roles are global.");
  });
  test("All projects says the chair's model is a project's choice", () => {
    expect(view()).toContain("The chair&#x27;s model is a project&#x27;s choice: pick a project above.");
  });
});

describe("saving permissions", () => {
  test("a default wider than the ceiling shows the server's own sentence under Save", () => {
    const wide = { ...base(), workerDefault: { ...base().workerDefault, network: true }, ceiling: { ...base().ceiling, network: false } };
    const r = validatePolicy(JSON.parse(JSON.stringify(wide)));
    expect(r.ok).toBe(false);
    const sentence = r.ok ? "" : r.error;
    expect(sentence).toContain("is wider than the ceiling");
    const html = view({ notes: { envelope: sentence } });
    const save = html.indexOf("Save these permissions");
    const note = html.indexOf(sentence.replace(/'/g, "&#x27;"));
    expect(save).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(save);
    expect(view()).not.toContain('role="alert"');
  });
  test("the always-refused line is fixed and says what stays with a person", () => {
    const html = view();
    expect(html).toContain("Push, pull requests, merges, releases, anything that spends.");
    expect(html).toContain("Why this cannot be changed here");
  });
});

describe("the rule form", () => {
  test("the usage condition offers the gauge help line for engines that report no quota", () => {
    const html = view({ openRule: "new" });
    expect(GAUGE_HELP()).not.toBe("");
    expect(html).toContain(GAUGE_HELP().replace(/'/g, "&#x27;"));
    expect(html).toContain("Then ask me.");
  });
});

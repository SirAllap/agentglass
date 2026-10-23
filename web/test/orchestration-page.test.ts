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
import { GAUGE_HELP, LIMIT_RANGE, NO_WORKER_ENGINE, SAFETY, safetyIsDefault } from "../src/components/orchestration/orchestrationCopy.ts";

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

describe("a worker row while a rule holds it", () => {
  const r = rule("a", { workers: { builder: [{ engine: "opencode", model: "" }] } });
  const html = view({ policy: { ...base(), rules: [r] }, states: [st("a", { active: true })] });
  test("shows the rule's choice with the base as a second line, and a way to edit the rule", () => {
    const row = rowOf(html, "Builder");
    expect(row).toContain("opencode/big-pickle");
    expect(row).toContain("From a rule");
    expect(row).toContain("Without it:");
    expect(row).toContain(">Edit the rule<");
  });
  test("a project on the general setting cannot edit it from there", () => {
    expect(rowOf(view({ policy: { ...base(), rules: [r] }, states: [st("a", { active: true })], root: "/work/orbit", scope: "global" }), "Builder")).not.toContain("Edit the rule");
  });
});

describe("the page, in its other states", () => {
  test("no conditions: the empty state says the choices above always apply", () => {
    expect(view()).toContain("No conditions. The choices above always apply.");
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
    expect(html).toContain("Worker roles are the same for every project.");
    expect(html).toContain("Switch to All projects");
  });
  test("the scope bar insets like the cards under it", () => {
    expect(view()).toMatch(/data-scope-bar="true" class="[^"]*agx-settings-x/);
  });
  test("All projects says the main agent's model is a project's choice, once its tiles are open", () => {
    expect(view({ openPicker: "orchestrator" })).toContain("The main agent&#x27;s model is a project&#x27;s choice: pick a project above.");
    expect(view()).not.toContain("is a project&#x27;s choice");
  });
});

describe("saving permissions", () => {
  test("a default wider than the ceiling shows the server's own sentence under Save", () => {
    const wide = { ...base(), workerDefault: { ...base().workerDefault, network: true }, ceiling: { ...base().ceiling, network: false } };
    const r = validatePolicy(JSON.parse(JSON.stringify(wide)));
    expect(r.ok).toBe(false);
    const sentence = r.ok ? "" : r.error;
    expect(sentence).toContain("is wider than the most the main agent may allow");
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

describe("the tile pickers (a disabled engine says why once and cannot be picked)", () => {
  const html = view({ openPicker: "builder" });
  const picker = html.slice(html.indexOf('data-picker="builder"'));
  const tiles = picker.slice(0, picker.indexOf("2. Which model"));
  test("every engine is a tile; the one that cannot run is disabled and its reason is written once", () => {
    for (const id of ["claude", "opencode", "hermes"]) expect(tiles).toContain(`>${title(id)}<`);
    const why = "0.21.0 is older than 0.21.4.";
    expect(tiles.split(why).length - 1).toBe(1);
    expect(tiles).not.toContain(`title="${why}`);
  });
  test("the disabled tile is a disabled button, so pressing it does nothing", () => {
    const old = tiles.slice(tiles.indexOf(`>${title("hermes")}<`));
    const open = tiles.lastIndexOf("<button", tiles.indexOf(`>${title("hermes")}<`));
    expect(tiles.slice(open, open + 400)).toContain('disabled=""');
    expect(old).toContain("Needs update");
  });
  test("a ready tile is enabled and keeps its reason as the hover only", () => {
    const at = tiles.lastIndexOf("<button", tiles.indexOf(`>${title("opencode")}<`));
    const tag = tiles.slice(at, tiles.indexOf(">", at));
    expect(tag).not.toContain("disabled");
    expect(tag).toContain(`title="${title("opencode")} is ready."`);
  });
  test("the main agent's models are tiles; a worker's model is typed", () => {
    const o = view({ openPicker: "orchestrator", root: "/w/orbit", scope: "project", seat: { live: true, model: "sonnet", models: [{ id: "sonnet", label: "Sonnet" }, { id: "opus", label: "Opus" }] } });
    expect(o).toContain("Sonnet</button>");
    expect(o).toContain("default model</button>");
    expect(picker).toContain('placeholder="its default model"');
  });
  test("each press saves at once and Undo only while the choice is still that one", () => {
    const pane = FILES.find((x) => x.f === "OrchestrationPane.tsx")!.text;
    expect(pane).toContain("withBaseChoice(policy, field, to)");
    expect(pane).toContain("pickUndoable(policy, picked)");
  });
});

describe("conditions with their strips, and the side sheet", () => {
  const night = rule("night", { when: [{ kind: "hours", days: [1, 2, 3, 4, 5], from: "22:00", to: "07:00" }] });
  const html = view({
    policy: { ...base(), rules: [rule("a"), night] },
    states: [st("a", { reading: "Claude 62% left", readingAt: 5 })],
    now: new Date(2026, 9, 12, 18, 0),
  });
  test("an hours condition draws its clock strip, with now at 75%, and a usage one its meter", () => {
    const row = rowOf(html, "Rule night");
    expect(row).toContain('data-strip="clock"');
    expect(row).toContain('data-mark="now" style="left:75%');
    expect(row).toContain("left:91.67%;width:8.33%");
    const a = rowOf(html, "Rule a");
    expect(a).toContain('data-strip="meter"');
    expect(a).toContain('data-mark="threshold" style="left:10%');
    expect(a).toContain("62% left now");
  });
  test("the sheet shows the draft's sentence, the test button and the three actions, and only when asked for", () => {
    expect(html).not.toContain('data-sheet="rule"');
    const open = view({ openRule: "night", policy: { ...base(), rules: [night] }, now: new Date(2026, 9, 12, 18, 0) });
    expect(open).toContain('data-sheet="rule"');
    expect(open).toContain("Editing condition for all projects");
    expect(open).toContain(`it is Mon, Tue, Wed, Thu, Fri, 22:00 to 07:00: builders use ${title("opencode")} big-pickle.`);
    for (const t of [">Test it now<", ">Delete<", ">Cancel<", ">Save for all projects<"]) expect(open, t).toContain(t);
  });
  test("a sheet for a rule that does not exist is not drawn", () => {
    expect(view({ openRule: "ghost" })).not.toContain('data-sheet="rule"');
  });
});

describe("Safety and limits", () => {
  const PANE = FILES.find((x) => x.f === "OrchestrationPane.tsx")!.text;
  const SAFE = (html: string) => html.slice(html.indexOf("Safety and limits"));
  test("it is one disclosure, shut by default, that says defaults while nothing in it was changed", () => {
    const html = view();
    const at = html.indexOf("Safety and limits");
    expect(at).toBeGreaterThan(-1);
    const det = html.slice(html.lastIndexOf("<details", at), at);
    expect(det).not.toContain(" open");
    expect(SAFE(html)).toContain(">defaults<");
    expect(SAFE(html)).not.toContain(">changed<");
    const changed = base();
    changed.limits = { ...changed.limits, maxWorkers: 5 };
    expect(SAFE(view({ policy: changed }))).toContain(">changed<");
  });
  test("a stored policy with the server's key order still reads as defaults, and one added refusal does not", () => {
    const p = base();
    p.workerDefault = { deny: [], commit: p.workerDefault.commit, network: p.workerDefault.network, write: p.workerDefault.write };
    expect(safetyIsDefault(p)).toBe(true);
    p.workerDefault = { ...p.workerDefault, deny: ["docker compose down"] };
    expect(safetyIsDefault(p)).toBe(false);
  });
  test("every item says what it does in one sentence and gives an example", () => {
    for (const k of ["write", "network", "commit", "deny"] as const) expect(SAFETY[k]).toMatch(/\. Example: /);
    for (const k of ["workers", "most"] as const) expect(SAFETY[k].note).toMatch(/\. Example: /);
    expect(SAFETY.always.hint).toMatch(/\. Example: /);
    for (const r of Object.values(LIMIT_RANGE)) expect(r.hint).toMatch(/\. Example: /);
    const html = SAFE(view());
    for (const t of ["What a worker may do by default", "The most the main agent may allow", "Limits", "Save these permissions", "Always refused", "Workers at once"]) expect(html).toContain(t);
  });
  test("a refusal under Save or a step opens the disclosure, so the sentence is not hidden", () => {
    expect(PANE).toContain("setSafetyOpen(true)");
    expect(PANE).toMatch(/const safetyNote = notes\.envelope \|\| notes\.limits;/);
  });
  test("a search result that lands on a row inside the shut card opens it", () => {
    expect(PANE).toContain("useContext(Filter).flash");
    expect(PANE).toMatch(/textContent === SAFETY\.title\) setSafetyOpen\(true\)/);
  });
  test("nothing the person reads says chair, seat, envelope or ceiling", () => {
    const html = view({ notes: {} }).replace(/<[^>]+>/g, " ");
    expect(/\b(chair|seat|envelope|ceiling)\b/i.test(html)).toBe(false);
  });
});

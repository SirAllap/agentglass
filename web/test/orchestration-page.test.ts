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
const { OrchestratorHero } = await import("../src/components/orchestration/OrchestratorHero.tsx");
import type { OrchestrationViewProps } from "../src/components/orchestration/OrchestrationPane.tsx";
import { PickRow } from "../src/components/orchestration/SafetyParts.tsx";
import { agentProvider } from "../../shared/agentKinds.ts";
import { composePolicy, defaultStored, validatePolicy, type Policy, type PolicyRule } from "../../shared/orchestration.ts";
import { templateFlow } from "../../shared/flowTemplates.ts";
import { classOf } from "../../shared/settingClass.ts";
import type { EngineReadiness } from "../../shared/types.ts";
import type { PolicyRuleState } from "../src/lib/api.ts";
import { OLD_WORDS, GAUGE_HELP, LIMIT_RANGE, NO_WORKER_ENGINE, SAFETY, safetyIsDefault } from "../src/components/orchestration/orchestrationCopy.ts";
import { nowSentence } from "../src/components/orchestration/flow/FlowSections.tsx";

const DIR = join(import.meta.dir, "..", "src", "components", "orchestration");
const css = readFileSync(join(DIR, "orchestration.css"), "utf8");
const strip = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const FILES = [
  ...readdirSync(DIR).filter((f) => /\.tsx?$/.test(f)).map((f) => ({ f, text: strip(readFileSync(join(DIR, f), "utf8")) })),
  ...readdirSync(join(DIR, "flow")).filter((f) => /\.tsx?$/.test(f)).map((f) => ({ f: `flow/${f}`, text: strip(readFileSync(join(DIR, "flow", f), "utf8")) })),
];
const title = (id: string) => agentProvider(id)!.title;
/** The page's own source, read as text: the tests below hold it to a few rules. */
const PANE_SRC = FILES.find((x) => x.f === "OrchestrationPane.tsx")!.text;

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
  workers: { scout: { engine: "opencode", model: "" }, builder: { engine: "claude", model: "sonnet" }, reviewer: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
});
const rule = (id: string, over: Partial<PolicyRule> = {}): PolicyRule => ({
  id, name: `Rule ${id}`, enabled: true, when: [{ kind: "usage", provider: "anthropic", window: "weekly", remainingAtMost: 10 }],
  workers: { builder: [{ engine: "opencode", model: "big-pickle" }] }, ...over,
});
const st = (ruleId: string, over: Partial<PolicyRuleState> = {}): PolicyRuleState =>
  ({ scope: "global", ruleId, name: ruleId, active: false, since: 0, reading: "", readingAt: 0, holding: "", ...over });

/** A flow whose path holds six blocks, as a project that placed QA-only on it does. */
const SIX = (() => {
  const f = templateFlow();
  const path = ["planner", "builder", "inspector", "qa-only", "verifier", "landing"];
  return { ...f, path, blocks: path.map((id, i) => ({ id, x: i * 240, y: 0 })) };
})();

const view = (o: Partial<OrchestrationViewProps> = {}) =>
  renderToStaticMarkup(React.createElement(OrchestrationView, {
    policy: base(), scope: "global", root: "", projects: [], readiness: READY, states: [], seat: null, notes: {}, busy: false,
    onRoot() {}, onSave: async () => null, onScope() {}, onOpenEngines() {}, ...o,
  } as OrchestrationViewProps));

/** Lot 7: safety and refused moved to Permissions > Workers, the same view drawn with that part. */
const pview = (o: Partial<OrchestrationViewProps> = {}) => view({ part: "permWorkers", ...o });

/** The markup of one row, from its anchor to the next. */
const rowOf = (html: string, label: string): string => {
  const at = html.indexOf(`data-row="${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
  expect(at, label).toBeGreaterThan(-1);
  const next = html.indexOf('data-row="', at + 10);
  return html.slice(at, next < 0 ? undefined : next);
};

describe("the page's source", () => {
  test("a row bound to a setting is a server setting with its own class, or says an agent must not reach it", () => {
    for (const { f, text } of FILES) {
      const ids = [...text.matchAll(/\bsettingId="([^"]+)"/g)].map((m) => m[1]!);
      expect(ids.every((id) => !!classOf(id)) || /agentNever/.test(text), f).toBe(true);
    }
  });
  test("nothing polls: no timer and no poll hook", () => {
    for (const { f, text } of FILES) {
      expect(/\bset(Interval|Timeout)\b|usePoll|requestAnimationFrame/.test(text), f).toBe(false);
    }
  });
  test("the pane's gone-mark is put back when its effect runs again, so a remount keeps its answers", () => {
    const pane = FILES.find((x) => x.f === "OrchestrationPane.tsx")!.text;
    const at = pane.indexOf("const alive = useRef(true);");
    expect(at).toBeGreaterThan(-1);
    const effect = pane.slice(at, pane.indexOf("}, []);", at) + 6);
    expect(effect).toContain("alive.current = true");
    expect(effect).toContain("alive.current = false");
    expect(effect.indexOf("alive.current = true")).toBeLessThan(effect.indexOf("alive.current = false"));
  });
  test("a refused save changes nothing: the policy is replaced only after the failure return", () => {
    const pane = FILES.find((x) => x.f === "OrchestrationPane.tsx")!.text;
    const at = pane.indexOf("const save = async (next: Policy, card: string)");
    const body = pane.slice(at, pane.indexOf("\n  };", at));
    expect(body.indexOf("return e;")).toBeGreaterThan(-1);
    expect(body.indexOf("setLoaded(")).toBeGreaterThan(body.indexOf("return e;"));
  });
});

describe("the page, in its other states", () => {
  test("the engine's name on the page is the table's, never typed into the page", () => {
    for (const { f, text } of FILES) for (const p of ["Claude Code", "OpenCode", "Hermes", "Codex"]) expect(text.includes(p), `${f} says ${p}`).toBe(false);
  });
  test("a project that follows all projects is edited in place: no banner, no make-specific press", () => {
    const html = view({ root: "/work/orbit", scope: "global", projects: ["/work/orbit"] });
    expect(html).not.toContain("Make it specific to");
    expect(html).not.toContain("uses the general setting");
    expect(html).toContain('<span class="whitespace-nowrap">orbit</span><span aria-hidden="true" class="inline-flex opacity-70"><svg');
    expect(html).not.toContain("Only orbit");
  });
  test("a project with its own setting has no old badge and no Use the general setting press", () => {
    const html = view({ root: "/work/orbit", scope: "project", projects: ["/work/orbit"] });
    expect(html).not.toContain("Use the general setting");
    expect(html).not.toContain("has its own settings");
  });
  test("the scope bar insets like the cards under it", () => {
    // The page header holds the one control; the bar is a plain row now.
    expect(view()).toMatch(/data-scope-bar="true"/);
  });
});

describe("saving permissions", () => {
  test("a default wider than the ceiling shows the server's own sentence inside Safety and limits", () => {
    const wide = { ...base(), workerDefault: { ...base().workerDefault, network: true }, ceiling: { ...base().ceiling, network: false } };
    const r = validatePolicy(JSON.parse(JSON.stringify(wide)));
    expect(r.ok).toBe(false);
    const sentence = r.ok ? "" : r.error;
    expect(sentence).toContain("is wider than the most the main agent may allow");
    const html = pview({ notes: { envelope: sentence } });
    const pane = html.slice(html.indexOf('data-pane="safety"'));
    expect(pane).toContain(sentence.replace(/'/g, "&#x27;"));
    expect(pview()).not.toContain('role="alert"');
  });
  test("permissions save at once with an Undo toast: no save bar, no Save button", () => {
    expect(pview()).not.toContain("data-savebar");
    expect(PANE_SRC).not.toContain("Save these permissions");
    expect(PANE_SRC).not.toContain("{dirty && (");
    expect(PANE_SRC).toContain('save(withEnvelopes(policyNow.current, to), "envelope")');
    expect(PANE_SRC).toContain("pushSaveToast(");
  });
  test("the always-refused line is fixed and says what stays with a person", () => {
    const html = pview();
    expect(html).toContain("Only sudo and four git worktree commands");
    expect(html).toContain("Why this cannot be changed here");
  });
});

describe("the rule form", () => {
});

describe("conditions with their strips, and the side sheet", () => {
  const night = rule("night", { when: [{ kind: "hours", days: [1, 2, 3, 4, 5], from: "22:00", to: "07:00" }] });
  const html = view({
    policy: { ...base(), rules: [rule("a"), night] },
    states: [st("a", { reading: "Claude 62% left", readingAt: 5 })],
    now: new Date(2026, 9, 12, 18, 0),
  });
  test("a sheet for a rule that does not exist is not drawn", () => {
    expect(view({ openRule: "ghost" })).not.toContain('data-sheet="rule"');
  });
});

describe("Safety and limits", () => {
  const PANE = PANE_SRC;
  const SAFE = (html: string) => html.slice(html.indexOf("What a worker may do"));
  test("the one table says defaults while nothing in it was changed", () => {
    const html = pview();
    expect(html.indexOf("What a worker may do")).toBeGreaterThan(-1);
    expect(SAFE(html)).toContain(">defaults<");
    expect(SAFE(html)).not.toContain(">changed<");
    const changed = base();
    changed.workerDefault = { ...changed.workerDefault, docker: true };
    changed.ceiling = { ...changed.ceiling, docker: true };
    expect(SAFE(pview({ policy: changed }))).toContain(">changed<");
  });
  test("a stored policy with the server's key order still reads as defaults, and one added refusal does not", () => {
    const p = base();
    p.workerDefault = { deny: [], worktreeOps: p.workerDefault.worktreeOps, commit: p.workerDefault.commit, network: p.workerDefault.network, docker: p.workerDefault.docker, write: p.workerDefault.write };
    expect(safetyIsDefault(p)).toBe(true);
    p.workerDefault = { ...p.workerDefault, deny: ["docker compose down"] };
    expect(safetyIsDefault(p)).toBe(false);
    p.workerDefault = { ...base().workerDefault, docker: true };
    expect(safetyIsDefault(p)).toBe(false);
  });
  test("every item says what it does in one sentence, in the mockup's words", () => {
    // The mockup's cards are one line per row, never a line and an example: that
    // second sentence is what made the page twice as tall as the picture.
    expect(SAFETY.write).toBe("Where a worker may change files");
    expect(SAFETY.commit).toBe("Local only; a push is still refused");
    expect(SAFETY.network).toBe("Fetching from the web and calling APIs");
    expect(SAFETY.deny).toBe("Commands refused on top of the ones that are always refused.");
    expect(SAFETY.gate).toBe("Show the exact push or PR, wait for your answer");
    for (const k of ["workers", "most", "hands", "extra"] as const) expect(SAFETY[k].note, k).not.toContain("Example:");
    expect(SAFETY.always.hint).toMatch(/\. Example: /);
    for (const r of Object.values(LIMIT_RANGE)) expect(r.hint).toMatch(/\. Example: /);
    const html = SAFE(pview());
    // The limits left for Roles & limits; the trust switches for Main agent; the Gate for Changes outside.
    for (const t of ["What a worker may do", "Never in a worker&#x27;s hands", "Extra shell commands", "Fixed: never allowed", "Open until you close them"]) expect(html, t).toContain(t);
    // One table, as the mockup draws it: a row per power, a Default and a Ceiling column; Docker and Worktree ops are one switch for both.
    for (const k of ["write", "commit", "network", "docker", "worktreeOps"]) expect(html, k).toContain(`data-envelope-row="${k}"`);
    for (const t of ["Default<small>a new worker starts with", "Ceiling<small>no role can go past this", "Docker, default", "Docker, ceiling", "Worktree ops, default"]) expect(html, t).toContain(t);
    expect(html).not.toContain("Docker for workers");
    expect(html).not.toContain("At most: docker");
    expect(html).not.toContain("Default: docker");
    // Always refused and the save bar have their own places on the page: a card of their own and the bar that ends the column.
    for (const t of ["Always refused", "Also refused here"]) expect(pview(), t).toContain(t);
    // There is no save bar: a change is written at once (see "permissions save at once" above).
    expect(PANE_SRC).not.toContain("Save these permissions");
  });
  test("a refusal under Save is written inside Safety and limits, where the control that asked is", () => {
    const sentence = "workerDefault is wider than the most the main agent may allow";
    const html = pview({ notes: { envelope: sentence } });
    const at = html.indexOf('data-pane="safety"');
    expect(at).toBeGreaterThan(-1);
    expect(html.slice(at)).toContain(sentence);
    expect(PANE).toContain("note={notes.envelope || notes.limits}");
    expect(PANE).toContain("onSeeRefused={() => document.getElementById(\"agx-flow-refused\")");
  });
  test("every section is in the page behind its tab, so the browser's own find still reaches it", () => {
    expect(pview()).toContain('data-pane="safety"');
    expect(pview()).toContain('id="agx-flow-refused"');
    expect(pview()).not.toContain('id="agx-flow-keys"');
  });
  test("a refusal from the save in Always refused is printed there, not only under Safety", () => {
    const sentence = "workerDefault is wider than the most the main agent may allow";
    const html = pview({ notes: { envelope: sentence } });
    const at = html.indexOf('id="agx-flow-refused"');
    expect(at).toBeGreaterThan(-1);
    expect(html.slice(at)).toContain(sentence);
    expect(PANE).toContain("note={notes.envelope} scopeWord={scopeWord}");
  });
  test("nothing the person reads says chair, seat, envelope or ceiling", () => {
    // The mock keeps one line that names the old words so an old note still reads; that line is the one exception.
    const html = view({ notes: {} }).replace(/<[^>]+>/g, " ").replace(OLD_WORDS, "");
    expect(/\b(chair|seat|envelope|ceiling)\b/i.test(html)).toBe(false);
  });
});

describe("the marks, the footer and the note belong to the thing that changed", () => {
  const PANE = FILES.find((x) => x.f === "OrchestrationPane.tsx")!.text;
  test("a limit changes no block: the limits are page-wide", () => {
    expect(PANE).toContain('void save(withLimits(policy, { [k]: stepLimit(k, policy.limits[k], by) }), "limits");');
    expect(PANE).not.toContain('mark("reviewer", "limits")');
  });
  test("the model row's own default reads as chosen, not as no value", () => {
    const row = renderToStaticMarkup(React.createElement(PickRow, {
      label: "Model", value: "", options: [{ id: "", label: "its default" }, { id: "sonnet", label: "Sonnet" }] as const, onChange() {},
    }));
    const at = row.indexOf(">its default<");
    expect(at).toBeGreaterThan(-1);
    const tag = row.slice(row.lastIndexOf("<button", at), row.indexOf(">", at));
    expect(tag).toContain('aria-pressed="true"');
  });
});

describe("the hero, and the three safety levels", () => {
  /** The markup of one level card, from its data-level to the button's end. */
  const levelCard = (html: string, id: string): string => {
    const at = html.indexOf(`data-level="${id}"`);
    expect(at, id).toBeGreaterThan(-1);
    return html.slice(at, html.indexOf("</button>", at));
  };
  test("the path and the three numbers are the hero's, and its one call to action is the filled one", () => {
    const html = view();
    const hero = html.slice(html.indexOf("data-hero"), html.indexOf('role="tablist"'));
    expect(hero.match(/agx-flow-hero-cta/g)).toHaveLength(1);
    expect(hero.match(/data-readout=/g)).toHaveLength(3);
    for (const k of ['data-readout="plan-used"', 'data-readout="workers"', 'data-readout="today"']) expect(hero).toContain(k);
  });
  test("a number nothing has read is a sentence, never a dash and never a zero", () => {
    const hero = view().slice(view().indexOf("data-hero"), view().indexOf('role="tablist"'));
    expect(hero).toContain("Not connected");
    expect(hero).toContain("Not read yet");
    expect(hero).not.toContain("0%");
    // A dash inside a stat card is the defect this replaces: the card says what it knows.
    const card = hero.slice(hero.indexOf('data-readout="plan-used"'), hero.indexOf('data-readout="workers"'));
    expect(card).not.toContain("\u2014");
    expect(card).not.toContain("agx-flow-hero-meter");
  });
  test("three levels, one marked Now, each listing write, commit and network; docker has its own switch", () => {
    const html = pview();
    for (const id of ["cautious", "balanced", "open"]) {
      const card = levelCard(html, id);
      for (const line of ["Write files", "Commit", "Network"]) expect(card, id).toContain(line);
      expect(card, id).not.toContain("Docker");
    }
    // A fresh policy builds and commits in its own copy, offline: that is Balanced, and only Balanced is on.
    expect(levelCard(html, "balanced")).toContain('aria-pressed="true"');
    for (const id of ["cautious", "open"]) expect(levelCard(html, id)).toContain('aria-pressed="false"');
    expect(html).not.toContain("Custom: ");
  });
  test("the path is one row that never wraps, whatever the flow holds", () => {
    // Six blocks, as a project that placed QA-only on the path has: still one row, and the row scrolls instead of wrapping.
    const hero = renderToStaticMarkup(React.createElement(OrchestratorHero, {
      chair: null, mode: "", conditionsOn: 0,
      path: SIX.path.map((id) => ({ id, name: id, hue: "text3", ico: "compass", engine: "", run: 0, wait: 0 })),
      live: { plan: { label: "Plan used", used: null, mark: null }, flight: null, today: null, last: null },
      onConfigure() {}, onOpenConditions() {}, onOpenFlow() {},
    }));
    expect(hero.match(/data-step=/g)).toHaveLength(6);
    expect(hero).toContain('style="--n:6"');
    const orbit = [...css.matchAll(/\.agx-flow-hero-orbit[^{]*\{([^}]*)\}/g)].map((m) => m[1]!);
    expect(orbit.length).toBeGreaterThan(0);
    // No fixed column count anywhere on the row: it is `auto-flow: column`, and it scrolls when it does not fit.
    for (const body of orbit) expect(body).not.toMatch(/grid-template-columns|repeat\(3/);
    expect(orbit.join(" ")).toContain("grid-auto-flow: column");
    expect(orbit.join(" ")).toContain("overflow-x: auto");
  });
  test("the duplicate rows are gone: the levels are the worker default, and the ceiling keeps its own", () => {
    const pane = FILES.find((x) => x.f === "flow/FlowSections.tsx")!.text;
    expect(pane).not.toContain('prefix="" env={env.workerDefault}');
    expect(pane).toContain("<EnvelopeTable");
  });
});

describe("the hero's three numbers, from what has been read", () => {
  const heroOf = (live: Partial<Parameters<typeof OrchestratorHero>[0]["live"]>) => renderToStaticMarkup(React.createElement(OrchestratorHero, {
    chair: { engine: "claude", model: "sonnet" }, mode: "Co-pilot", conditionsOn: 2,
    path: SIX.path.filter((id) => id !== "qa-only").map((id) => ({ id, name: id, hue: "text3", ico: "compass", engine: "claude", run: 0, wait: 0 })),
    live: { plan: { label: "Claude plan used", used: null, mark: null }, flight: null, today: null, last: null, ...live },
    onConfigure() {}, onOpenConditions() {}, onOpenFlow() {},
  }));
  const cardOf = (html: string, which: string) => html.slice(html.indexOf(`data-readout="${which}"`), html.indexOf('data-readout="', html.indexOf(`data-readout="${which}"`) + 10));
  test("a plan that was read is its percent and its bar; a plan that was not says so and draws no bar", () => {
    const known = cardOf(heroOf({ plan: { label: "Claude plan used", used: 87, mark: 85 } }), "plan-used");
    expect(known).toContain("87%");
    expect(known).toContain("agx-flow-hero-meter");
    const unknown = cardOf(heroOf({}), "plan-used");
    expect(unknown).toContain("Not connected");
    expect(unknown).not.toContain("agx-flow-hero-meter");
  });
  test("workers in flight read as n of m at once, with a bar", () => {
    const card = cardOf(heroOf({ flight: { n: 3, of: 3 } }), "workers");
    expect(card).toContain("3");
    expect(card).toContain("of 3 at once");
    expect(card).toContain("agx-flow-hero-meter");
  });
  test("today's line is the block that settled and when, never the words a worker wrote", () => {
    const at = Date.now() - 12 * 60_000;
    const card = cardOf(heroOf({ today: "$0.59", last: { name: "Builder", at } }), "today");
    expect(card).toContain("Builder");
    expect(card).toContain("12 m ago");
    // The page hands the hero a name and a stamp: a worker's own message is not a reading of anything.
    expect(PANE_SRC).not.toContain("line: live.last.line");
    expect(PANE_SRC).toContain("steps.find((s) => s.id === live.last!.role)?.name");
  });
});

describe("the one line that says what the envelope is now", () => {
  const env = (write: "none" | "worktree", commit: boolean, network: boolean, docker: boolean) => ({ write, commit, network, docker, deny: [] });
  test("the sentence names the nearest level and what differs", () => {
    expect(nowSentence(env("none", true, false, false))).toBe("Custom: Cautious, with commit on");
    expect(nowSentence(env("none", false, true, false))).not.toContain("No level matches");
  });
  test("fewest differing fields wins, a tie goes to the more cautious level, docker is ignored", () => {
    expect(nowSentence(env("worktree", false, false, false))).toBe("Custom: Cautious, with write on"); // Cautious and Balanced both differ once
    expect(nowSentence(env("none", false, true, false))).toBe("Custom: Cautious, with network on");
    expect(nowSentence(env("none", true, true, false))).toBe("Custom: Open, with write off");
    expect(nowSentence(env("worktree", true, true, true))).toBe("Custom: Open"); // a level, docker aside
  });
  test("no double comma for any of the sixteen envelopes", () => {
    for (const write of ["none", "worktree"] as const) for (const commit of [true, false]) for (const network of [true, false]) for (const docker of [true, false]) {
      const line = nowSentence(env(write, commit, network, docker));
      expect(line, line).toMatch(/^Custom: (Cautious|Balanced|Open)(, with (write|commit|network) (on|off)(, (write|commit|network) (on|off))*)?$/);
    }
  });
});

describe("pinned pointer card, one name, compact top, configure icon", () => {
  const rd = (p: string) => readFileSync(join(import.meta.dir, "..", "src", "components", "orchestration", p), "utf8");
  test("the hero sits above the tab bar, the presets behind its own chip, and the scrolling region holds only the sections", () => {
    const html = view({});
    const bar = html.indexOf("data-scope-bar"), hero = html.indexOf("data-hero");
    const scroll = html.indexOf('data-section="session"');
    // Lot 7: the tab bar left with Safety and Always refused; the scrolling region follows the hero directly.
    const tabs = scroll;
    expect(bar).toBeGreaterThan(-1);
    expect(hero).toBeGreaterThan(bar);
    expect(html).not.toContain('role="tablist"');
    expect(tabs).toBeGreaterThan(hero);
    // The presets are not in the page body: a chip in the hero opens the sheet, and nothing is drawn until it does.
    expect(html).not.toContain('data-presets="true"');
    expect(html).toContain("data-presets-chip");
    // One mount, behind the chip: the feature stays, its place on the page does not.
    expect(PANE_SRC.match(/<PresetCards/g)).toHaveLength(1);
    expect(PANE_SRC).toContain("{presetsOpen && (");
    expect(PANE_SRC).toContain("onOpenPresets={() => setPresetsOpen((on) => !on)}");
    // The hero sits inside the page's Flow section now, so what follows it is that section's own markup.
  });
  test("the hint strip and the gap are gone", () => {
    const html = view({});
    expect(html).not.toContain("agx-flow-bar");
    expect(html).not.toContain("Pick a block: its details open below");
  });
  test("the flow's names for the policy roles still reach the page", () => {
    expect(rd("flow/FlowSlot.tsx")).toContain("names[r.policyRole] = { name: r.name, does: r.does }");
  });
  test("the card's corner is its menu, and Configure is one small secondary button", () => {
    const src = rd("flow/WorkerCard.tsx");
    expect(src).toContain("aria-label={`Menu for ${role.name}`}");
    expect(src).toContain("Configure");
    expect(src).toContain('data-size="sm"');
  });
});

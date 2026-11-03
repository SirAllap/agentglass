/*
 * The Orchestration page against the approved mock: four numbered steps, one
 * Fine-tune card that the picture's Change buttons open, the clock bar and the
 * plan meter drawn from the rule, and the project line in the mock's words.
 * Each of these drifted once, when the page was built as five unnumbered cards
 * with a long Workers block of repeated fallback rows.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { globalStubs } from "./stubGlobal";
globalStubs()("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
const { OrchestrationView } = await import("../src/components/orchestration/OrchestrationPane.tsx");
const { OrchestratorHero } = await import("../src/components/orchestration/OrchestratorHero.tsx");
const { ClockStrip, MeterStrip } = await import("../src/components/orchestration/RuleStrips.tsx");
import type { OrchestrationViewProps } from "../src/components/orchestration/OrchestrationPane.tsx";
import { agentProvider } from "../../shared/agentKinds.ts";
import { composePolicy, defaultStored, type Policy, type PolicyRule } from "../../shared/orchestration.ts";
import type { EngineReadiness } from "../../shared/types.ts";
import type { PolicyRuleState } from "../src/lib/api.ts";
import { limitedEngines, scopeSentence } from "../src/components/orchestration/orchestrationCopy.ts";

const DIR = join(import.meta.dir, "..", "src", "components", "orchestration");
const PANE = readFileSync(join(DIR, "OrchestrationPane.tsx"), "utf8");
// The page's own states live in their own file since mockup screen 6; the words
// below are still the page's, so the two are read as one.
const STATES = readFileSync(join(DIR, "OrchStates.tsx"), "utf8");
const engine = (id: string): EngineReadiness => ({
  id, title: agentProvider(id)!.title, found: true, path: `/usr/bin/${id}`, version: "1.0.0", min: null, versionOk: true,
  account: { signedIn: true }, answers: { state: "never" }, roles: { worker: { ok: true }, orchestrator: { ok: true } },
  missing: [], envelope: { via: null, enforced: "yes", note: "" },
});
const base = (): Policy => composePolicy(defaultStored(), {
  orchestrator: { engine: "claude", model: "sonnet" },
  workers: { scout: { engine: "opencode", model: "" }, builder: { engine: "claude", model: "sonnet" }, reviewer: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
});
const night: PolicyRule = { id: "quiet-nights", name: "Quiet nights", enabled: true, when: [{ kind: "hours", days: [1, 2, 3, 4, 5], from: "22:00", to: "07:00" }], workers: { builder: [{ engine: "opencode", model: "" }] } };
const view = (o: Partial<OrchestrationViewProps> = {}) =>
  renderToStaticMarkup(React.createElement(OrchestrationView, {
    policy: base(), scope: "global", root: "", projects: [], readiness: [engine("claude"), engine("opencode")], states: [], seat: null, notes: {}, busy: false,
    onRoot() {}, onSave: async () => null, onScope() {}, onOpenEngines() {}, ...o,
  } as OrchestrationViewProps));
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("the page's frame", () => {
  const html = view();
  test("a pinned region with the scope bar, then two sections in order, in ONE scroll region", () => {
    const tabs = ["Safety and limits", "Always refused"];
    const bar = html.slice(html.indexOf("agx-flow-cfgbar"), html.indexOf("agx-flow-cfgscroll"));
    let at = -1;
    for (const t of tabs) {
      const n = bar.indexOf(`>${t}<`);
      expect(n, t).toBeGreaterThan(at);
      at = n;
    }
    expect(html.indexOf(`role="tablist"`)).toBeLessThan(html.indexOf("agx-flow-cfgscroll"));
    for (const id of ["agx-flow-safety", "agx-flow-refused"]) expect(html.indexOf("agx-flow-cfgscroll")).toBeLessThan(html.indexOf(`id="${id}"`));
    expect(html.indexOf("agx-flow-cfgscroll")).toBeGreaterThan(html.indexOf("data-hero"));
  });
  test("the old unnumbered cards are gone", () => {
    for (const old of [">Main agent</h3>", ">Workers</h3>", ">Switch things automatically<"]) expect(html).not.toContain(old);
  });
});

describe("the clock bar and the plan meter are drawn from the rule", () => {
  const pct = (html: string, key: string) => [...html.matchAll(new RegExp(`${key}:([0-9.]+)%`, "g"))].map((m) => Number(m[1]));
  test("22:00 to 07:00 shades the end of the day and the start of it, and now sits at its time", () => {
    const html = renderToStaticMarkup(React.createElement(ClockStrip, { t: night.when[0] as never, now: new Date(2026, 9, 12, 14, 32) }));
    expect(pct(html, "left")).toEqual([91.67, 0, 60.56]);
    expect(pct(html, "width")).toEqual([8.33, 29.17]);
    expect(html).toContain('data-mark="now"');
    expect(html).toContain("var(--error)");
  });
  test("the meter fills to what is left and marks the threshold", () => {
    const html = renderToStaticMarkup(React.createElement(MeterStrip, { left: 62, threshold: 15 }));
    expect(pct(html, "width")).toEqual([62]);
    expect(pct(html, "left")).toEqual([15]);
    expect(html).toContain("62% left now");
  });
});

describe("the project line and the picture's legend", () => {
  test("the line says what the dot means, then which project is shown", () => {
    expect(scopeSentence("/w/orbit", false, "orbit")).toEqual({ showing: "orbit", tail: ": its own setting. Changes are saved for it only." });
    const html = view({ projects: ["/w/orbit"], root: "/w/orbit", scope: "project", overrides: ["/w/orbit"] });
    // The mockup has no info button in the bar: the dot and the project's title say whose setting it is.
    expect(html).toContain('title="/w/orbit — has its own setting"');
    expect(html).toContain("data-own-dot");
  });
  test("an engine whose plan reads 0% left is still read as limited", () => {
    const st = (reading: string) => [{ scope: "global", ruleId: "x", name: "", active: false, since: 0, reading, readingAt: 1, holding: "" }] as PolicyRuleState[];
    expect([...limitedEngines(st("Claude weekly 0% left"), "global")]).toEqual(["claude"]);
    expect([...limitedEngines(st("Claude weekly 62% left"), "global")]).toEqual([]);
  });
});

describe("the states before there is a page", () => {
  test("a failed read says what the server answered and offers Retry; the wait is a skeleton; nothing open offers All projects", () => {
    for (const w of ["Could not load the setting for", "Retry", 'aria-busy="true"', "Nothing is set up yet", "Set up for all projects"]) expect(PANE + STATES).toContain(w);
  });
});

/*
 * Screen 1's second round: the page is the approved mockup's own markup, in the
 * mockup's colours and order, not a reinterpretation of it. The five blocks on
 * the path take the colours the mockup gives them; the engine chips are the
 * letters the mockup draws; the page says whose setting is on screen where the
 * mockup puts it.
 */
describe("the mockup's own page", () => {
  const CSS = readFileSync(join(DIR, "orchestration.css"), "utf8");
  const HERO = readFileSync(join(DIR, "OrchestratorHero.tsx"), "utf8");
  /** The body of one rule, or "" when the sheet has no such selector. */
  const rule = (sel: string) => {
    const at = CSS.indexOf(`${sel} {`);
    return at < 0 ? "" : CSS.slice(at, CSS.indexOf("}", at));
  };

  test("the bar reads Settings > Orchestration, then the project switch, then the saved chip", () => {
    const html = view({ root: "/w/orbit", scope: "project", overrides: ["/w/orbit"], projects: ["/w/orbit"] });
    const bar = html.slice(html.indexOf("data-scope-bar"), html.indexOf("data-hero"));
    let at = -1;
    for (const s of ["Settings \u203a <b>Orchestration</b>", 'aria-label="Settings for"', "Saved for orbit"]) {
      const n = bar.indexOf(s);
      expect(n, s).toBeGreaterThan(at);
      at = n;
    }
  });

  test("the bar is the mockup's three things, with no extra info button, and the project's dot is the accent", () => {
    const html = view({ root: "/w/orbit", scope: "project", overrides: ["/w/orbit"], projects: ["/w/orbit"] });
    const bar = html.slice(html.indexOf("data-scope-bar"), html.indexOf("agx-flow-pg"));
    expect(bar).not.toContain("agx-flow-inf");
    expect(bar).toContain("data-own-dot");
    // The mockup's `.seg` dot is `--accent`; the page names its accent on `.agx-orch`.
    expect(rule(".agx-orch-own")).toContain("background: var(--accent)");
  });

  test("the title over the hero is the page's name with the mockup's info, and the scope banner sits above it", () => {
    const html = view({ root: "/w/orbit", scope: "project", overrides: ["/w/orbit"], projects: ["/w/orbit"] });
    expect(html).toContain('<h2 class="agx-flow-t">Orchestration <span class="agx-flow-inf"');
    expect(html.indexOf("data-specific-note")).toBeGreaterThan(-1);
    expect(html.indexOf("data-specific-note")).toBeLessThan(html.indexOf('class="agx-flow-t"'));
    expect(html).toContain("orbit has its own settings");
  });

  test("the five blocks on the path keep the mockup's colour, by role id, in one place", () => {
    const path = [
      { id: "planner", name: "Planner", hue: "g-agents", ico: "chart", engine: "claude", run: 0, wait: 0 },
      { id: "builder", name: "Builder", hue: "g-workspace", ico: "rover", engine: "opencode", run: 3, wait: 2 },
      { id: "inspector", name: "Inspector", hue: "g-library", ico: "lens", engine: "opencode", run: 0, wait: 0 },
      { id: "verifier", name: "Verifier", hue: "success", ico: "preflight", engine: "claude", run: 0, wait: 0 },
      { id: "landing", name: "Landing", hue: "warning", ico: "lander", engine: "", run: 0, wait: 1, you: true },
    ];
    const hero = renderToStaticMarkup(React.createElement(OrchestratorHero, {
      chair: { engine: "claude", model: "haiku" }, mode: "Co-pilot", conditionsOn: 2, path,
      live: { plan: { label: "Plan used", used: 87, mark: 40 }, flight: { n: 3, of: 3 }, today: "$0.59", last: null },
      onConfigure() {}, onOpenConditions() {}, onOpenFlow() {},
    }));
    for (const [id, colour] of [["planner", "#c98a7a"], ["builder", "#4aa08f"], ["inspector", "#d4a73a"], ["verifier", "#4cb06f"], ["landing", "#6b6fd6"]]) {
      expect(hero, id).toContain(`data-step="${id}"`);
      expect(hero.slice(hero.indexOf(`data-step="${id}"`), hero.indexOf(`data-step="${id}"`) + 220), id).toContain(`--c:${colour}`);
    }
    // A role the mockup does not draw keeps its stage's hue instead of an invented colour.
    expect(HERO).toContain("ROLE_COLOUR[id] ?? `var(--${hue})`");
  });

  test("an engine chip is the engine's letter in its own colour, never a grey circle", () => {
    const hero = renderToStaticMarkup(React.createElement(OrchestratorHero, {
      chair: { engine: "claude", model: "haiku" }, mode: "", conditionsOn: 0,
      path: [{ id: "builder", name: "Builder", hue: "g-workspace", ico: "rover", engine: "opencode", run: 0, wait: 0 }],
      live: { plan: { label: "Plan used", used: null, mark: null }, flight: null, today: null, last: null },
      onConfigure() {}, onOpenConditions() {}, onOpenFlow() {},
    }));
    expect(hero).toContain('class="agx-flow-eg" data-engine="C" style="--eg:#cc785c"');
    expect(hero).toContain('class="agx-flow-eg" data-engine="O" style="--eg:#2f7d4f"');
    // The chip's ink comes from the mockup's table, and the CSS has no colour of its own for it.
    expect(rule(".agx-flow-eg")).toContain("var(--eg");
  });

  test("the Today line carries the mockup's loop, and the plan meter is its 12px track", () => {
    const hero = renderToStaticMarkup(React.createElement(OrchestratorHero, {
      chair: { engine: "claude", model: "haiku" }, mode: "", conditionsOn: 2, path: [],
      now: Date.UTC(2026, 10, 2, 12, 0, 0),
      live: { plan: { label: "Plan used", used: 87, mark: 40 }, flight: { n: 3, of: 3 }, today: "$0.59", last: { name: "skipped QA only", at: Date.UTC(2026, 10, 2, 11, 48, 0) } },
      onConfigure() {}, onOpenConditions() {}, onOpenFlow() {},
    }));
    const note = hero.slice(hero.indexOf("agx-flow-hero-note"), hero.indexOf("</span>", hero.indexOf("agx-flow-hero-note")));
    expect(note).toContain("<svg");
    expect(note).toContain("skipped QA only");
    expect(rule(".agx-flow-hero-meter")).toContain("height: 12px");
  });

  test("the hero is the mockup's: a peach wash, an accent tile, and the call to action in the accent", () => {
    expect(rule(".agx-flow-hero")).toContain("var(--hero-tint)");
    expect(rule(".agx-flow-hero-hub")).toContain("background: var(--accent)");
    expect(rule(".agx-flow-hero-cta")).toContain("background: linear-gradient(180deg, color-mix(in srgb, var(--accent)");
    // The page names its accent once, so nothing on it falls through to --primary.
    expect(PANE).toContain('style={{ "--accent": MOCKUP_INK.accent }');
    expect(rule(".agx-flow-hero")).not.toContain("var(--primary)");
  });

  test("the current level is tinted, outlined and says Now, and the page is set in the mockup's sans stack", () => {
    const balanced = base();
    balanced.workerDefault = { ...balanced.workerDefault, write: "worktree", commit: true, network: false, docker: false };
    const html = view({ policy: balanced });
    const level = html.slice(html.indexOf('data-level="balanced"'), html.indexOf("</button>", html.indexOf('data-level="balanced"')));
    expect(level).toContain('aria-pressed="true"');
    expect(level).toContain(">Now<");
    expect(rule(".agx-flow-level[aria-pressed=\"true\"]")).toContain("background: color-mix(in srgb, var(--accent)");
    // The mockup's sans, scoped to the orchestration roots: the rest of the app keeps its mono body.
    expect(rule(".agx-orch, .agx-orch-gaps")).toContain("font-family: var(--font-prose)");
  });
});

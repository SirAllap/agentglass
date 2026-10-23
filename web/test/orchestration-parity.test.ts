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
const { ClockStrip, MeterStrip } = await import("../src/components/orchestration/RuleStrips.tsx");
import type { OrchestrationViewProps } from "../src/components/orchestration/OrchestrationPane.tsx";
import { agentProvider } from "../../shared/agentKinds.ts";
import { composePolicy, defaultStored, type Policy, type PolicyRule } from "../../shared/orchestration.ts";
import type { EngineReadiness } from "../../shared/types.ts";
import type { PolicyRuleState } from "../src/lib/api.ts";
import { limitedEngines, scopeSentence } from "../src/components/orchestration/orchestrationCopy.ts";

const DIR = join(import.meta.dir, "..", "src", "components", "orchestration");
const PANE = readFileSync(join(DIR, "OrchestrationPane.tsx"), "utf8");
const engine = (id: string): EngineReadiness => ({
  id, title: agentProvider(id)!.title, found: true, path: `/usr/bin/${id}`, version: "1.0.0", min: null, versionOk: true,
  account: { signedIn: true }, answers: { state: "never" }, roles: { worker: { ok: true }, orchestrator: { ok: true } },
  missing: [], envelope: { via: null, enforced: "yes", note: "" },
});
const base = (): Policy => composePolicy(defaultStored(), {
  orchestrator: { engine: "claude", model: "sonnet" },
  workers: { scout: { engine: "opencode", model: "" }, builder: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
});
const night: PolicyRule = { id: "quiet-nights", name: "Quiet nights", enabled: true, when: [{ kind: "hours", days: [1, 2, 3, 4, 5], from: "22:00", to: "07:00" }], workers: { builder: [{ engine: "opencode", model: "" }] } };
const view = (o: Partial<OrchestrationViewProps> = {}) =>
  renderToStaticMarkup(React.createElement(OrchestrationView, {
    policy: base(), scope: "global", root: "", projects: [], readiness: [engine("claude"), engine("opencode")], states: [], seat: null, notes: {}, busy: false,
    onRoot() {}, onSave: async () => null, onScope() {}, onOpenEngines() {}, ...o,
  } as OrchestrationViewProps));
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("the four numbered steps", () => {
  const html = view();
  test("1 to 4, in the mock's words and order, after the picture", () => {
    const heads = ["Start from a ready-made setup", "Fine-tune who does what", "Switch things automatically", "Safety and limits"];
    let at = html.indexOf('data-flow="right-now"');
    expect(at).toBeGreaterThan(-1);
    heads.forEach((h, i) => {
      const n = html.indexOf(`data-sec="${i + 1}"`);
      expect(n, `step ${i + 1}`).toBeGreaterThan(at);
      expect(html.indexOf(h, n)).toBeGreaterThan(n);
      at = n;
    });
  });
  test("the old unnumbered cards are gone", () => {
    for (const old of [">Quick setup<", ">Main agent</h3>", ">Workers</h3>", ">Conditions</h3>"]) expect(html).not.toContain(old);
  });
});

describe("Fine-tune is one card the picture opens", () => {
  test("closed, it holds one sentence and no per-role fallback rows", () => {
    const html = view();
    expect(html).toContain("Press “Change” on a role in the picture above. The tiles open right here.");
    expect(html).not.toContain("is not available");
    expect(count(html, "Add a fallback rule")).toBe(0);
    expect(count(html, "Ask when it runs")).toBe(0);
  });
  test("a job's Change opens its tiles, its model, Ask when it runs and its fallback inside the card", () => {
    const html = view({ openPicker: "builder" });
    expect(html).toContain('aria-label="Engine for the builders"');
    expect(html).toContain('aria-label="Model for the builders"');
    expect(count(html, "Ask when it runs")).toBe(1);
    expect(count(html, "Add a fallback rule")).toBe(1);
    expect(html).toContain("If builders are not available:");
    expect(html).toContain(">Done<");
  });
  test("the main agent has the same card", () => {
    const html = view({ openPicker: "orchestrator" });
    expect(html).toContain('aria-label="Engine for the main agent"');
    expect(html).toContain("If main agent is not available:");
  });
  test("every Change on the picture goes to the card, and Done closes it", () => {
    expect(PANE).toMatch(/onChange=\{\(field\) => \{ setPicking\(field\);/);
    expect(PANE).toMatch(/onClick=\{\(\) => \{ setPicking\(null\); setPicked\(null\); \}\}>Done/);
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
  test("a rule's row on the page carries its strip, and no rule means no strip", () => {
    expect(view({ policy: { ...base(), rules: [night] }, now: new Date(2026, 9, 12, 14, 32) })).toContain('data-strip="clock"');
    expect(view()).not.toContain("data-strip=");
  });
});

describe("the project line and the picture's legend", () => {
  test("the line says what the dot means, then which project is shown", () => {
    expect(scopeSentence("/w/orbit", false, "orbit")).toEqual({ showing: "orbit", tail: ": its own setting. Changes are saved for it only." });
    const html = view({ projects: ["/w/orbit"], root: "/w/orbit", scope: "project", overrides: ["/w/orbit"] });
    expect(html).toContain("has its own setting · the others follow “All projects”.");
    expect(html).toContain("data-own-dot");
  });
  test("the legend names the four states once, and the Because line offers the setups while nothing is on", () => {
    const html = view();
    for (const w of ["Ready", "Not installed", "Not signed in", "Limit hit"]) expect(html.slice(html.indexOf('data-flow="legend"'))).toContain(w);
    expect(html).toContain("Pick a setup below");
    expect(view({ policy: { ...base(), rules: [{ ...night, when: [{ kind: "always" }] }] }, states: [{ scope: "global", ruleId: "quiet-nights", name: "", active: true, since: 0, reading: "", readingAt: 0, holding: "" } as PolicyRuleState] })).not.toContain("Pick a setup below");
  });
  test("an engine whose plan reads 0% left is Limit hit on its tile", () => {
    const st = (reading: string) => [{ scope: "global", ruleId: "x", name: "", active: false, since: 0, reading, readingAt: 1, holding: "" }] as PolicyRuleState[];
    expect([...limitedEngines(st("Claude weekly 0% left"), "global")]).toEqual(["claude"]);
    expect([...limitedEngines(st("Claude weekly 62% left"), "global")]).toEqual([]);
    expect(view({ states: st("Claude weekly 0% left") })).toContain("Limit hit</span>");
  });
});

describe("the states before there is a page", () => {
  test("a failed read says what the server answered and offers Retry; the wait is a skeleton; nothing open offers All projects", () => {
    for (const w of ["Could not load the setting for", "Retry", 'aria-busy="true"', "Nothing is set up yet", "Set up for all projects"]) expect(PANE).toContain(w);
  });
});

/*
 * Rules on the canvas: the marks a block carries for a rule in force, a preset
 * being previewed, a rule being edited and a machine check, the rule order, and
 * the canvas drawn with them. A mark changes words inside a block, never its box.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { agentProvider } from "../../shared/agentKinds.ts";
import { composePolicy, defaultStored, resolve, type Policy, type PolicyRule } from "../../shared/orchestration.ts";
import { templateFlow } from "../../shared/flowTemplates.ts";
import type { EngineReadiness } from "../../shared/types.ts";
import { applyPreset } from "../src/components/orchestration/orchestrationCopy.ts";
import {
  conditionCounts, marksEditing, marksHit, marksInForce, marksPreview, marksReadiness, mergeMarks, ruleTouches, sharedFields, withRuleMoved,
} from "../src/components/orchestration/flow/canvasRules.ts";
const { FlowCanvas } = await import("../src/components/orchestration/flow/FlowCanvas.tsx");

const eng = (id: string, over: Partial<EngineReadiness> = {}): EngineReadiness => ({
  id, title: agentProvider(id)!.title, found: true, path: `/usr/bin/${id}`, version: "1.0.0", min: null, versionOk: true,
  account: { signedIn: true }, answers: { state: "never" }, roles: { worker: { ok: true }, orchestrator: { ok: true } },
  missing: [], envelope: { via: null, enforced: "yes", note: "" }, ...over,
});
const READY = [eng("claude"), eng("opencode")];
const base = (): Policy => composePolicy(defaultStored(), {
  orchestrator: { engine: "claude", model: "sonnet" },
  workers: { scout: { engine: "claude", model: "sonnet" }, builder: { engine: "claude", model: "sonnet" }, reviewer: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
});
const rule = (id: string, name: string, builder: string, over: Partial<PolicyRule> = {}): PolicyRule =>
  ({ id, name, enabled: true, when: [{ kind: "always" }], workers: { builder: [{ engine: builder, model: "glm" }] }, ...over });
const withRules = (...rules: PolicyRule[]): Policy => ({ ...base(), rules });
const on = (...ids: string[]) => (id: string) => ids.includes(id);

describe("a rule in force", () => {
  test("the block it moves shows the engine in force, the usual one, and the rule's name", () => {
    const m = marksInForce(withRules(rule("r1", "Claude plan low", "opencode")), on("r1"));
    expect(m.builder).toMatchObject({ kind: "rule", tag: "rule on", because: "Because: Claude plan low" });
    expect(m.builder!.now).toContain("OpenCode");
    expect(m.builder!.was).toContain("usually");
    expect(m.scout).toBeUndefined();
  });
  test("a rule that does not hold, or is off, marks nothing", () => {
    expect(marksInForce(withRules(rule("r1", "x", "opencode")), on())).toEqual({});
    expect(marksInForce(withRules(rule("r1", "x", "opencode", { enabled: false })), on("r1"))).toEqual({});
  });
  test("the mark names the same rule `resolve` picks when two hold: the first in the list", () => {
    const p = withRules(rule("a", "First", "opencode"), rule("b", "Second", "claude"));
    expect(marksInForce(p, on("a", "b")).builder!.because).toBe("Because: First");
    expect(resolve(p, { on: on("a", "b") }, READY).workers.builder).toMatchObject({ ok: true, ruleId: "a" });
  });
  test("the main agent is a field too", () => {
    const m = marksInForce(withRules(rule("o", "Cheap chair", "claude", { workers: undefined, orchestrator: [{ engine: "claude", model: "haiku" }] })), on("o"));
    expect(m.orchestrator?.because).toBe("Because: Cheap chair");
  });
  test("the chip counts rules that hold and says whether one is acting", () => {
    const p = withRules(rule("a", "A", "opencode"), rule("b", "B", "opencode", { enabled: false }));
    expect(conditionCounts(p, on("a", "b"))).toEqual({ on: 1, acting: true });
    expect(conditionCounts(p, on())).toEqual({ on: 0, acting: false });
    expect(conditionCounts(null, on())).toEqual({ on: 0, acting: false });
  });
});

describe("priority is the list order", () => {
  test("moving a rule up changes which one `resolve` chooses, and the stored order carries it", () => {
    const p = withRules(rule("a", "A", "opencode"), rule("b", "B", "claude"));
    const q = withRuleMoved(p, "b", -1);
    expect(q.rules.map((r) => r.id)).toEqual(["b", "a"]);
    expect(resolve(p, { on: on("a", "b") }, READY).workers.builder).toMatchObject({ ruleId: "a" });
    expect(resolve(q, { on: on("a", "b") }, READY).workers.builder).toMatchObject({ ruleId: "b" });
  });
  test("the first and last cannot go past the ends", () => {
    const p = withRules(rule("a", "A", "opencode"), rule("b", "B", "claude"));
    expect(withRuleMoved(p, "a", -1)).toBe(p);
    expect(withRuleMoved(p, "b", 1)).toBe(p);
    expect(withRuleMoved(p, "zz", 1)).toBe(p);
  });
  test("rules on one block say who wins", () => {
    const p = withRules(rule("a", "A", "opencode"), rule("b", "B", "claude"));
    expect(sharedFields(p, "b")).toEqual([{ field: "builder", with: ["A"], rank: 2 }]);
    expect(sharedFields(p, "a")[0]!.rank).toBe(1);
    expect(sharedFields(withRules(rule("a", "A", "opencode")), "a")).toEqual([]);
  });
});

describe("preview, hover, editing and the machine check", () => {
  test("a preset previews old → new and writes nothing", () => {
    const p = base();
    const before = JSON.stringify(p);
    const next = applyPreset(p, "claude-orchestrates", READY)!;
    const m = marksPreview(p, next, on());
    expect(JSON.stringify(p)).toBe(before);
    expect(Object.values(m).every((x) => x!.kind === "preview" && x!.tag === "preview")).toBe(true);
    expect(m.scout!.was).toContain("Claude Code");
    expect(m.scout!.now).toContain("OpenCode");
  });
  test("a rule's blocks light up on hover; a rule that touches nothing says so", () => {
    const p = withRules(rule("a", "A", "opencode"));
    expect(Object.keys(marksHit(p, p.rules[0]!))).toEqual(["builder"]);
    expect(ruleTouches({ ...p.rules[0]!, workers: undefined })).toEqual([]);
  });
  test("while editing, blocks outside the rule fade and the ones in it say how many steps", () => {
    const m = marksEditing(base(), { workers: { builder: [{ engine: "opencode", model: "glm" }, { engine: "claude", model: "sonnet" }] } }, new Set(["scout"]));
    expect(m.builder).toMatchObject({ kind: "inrule", tag: "in this rule", hint: "2 steps · edit in the panel" });
    expect(m.builder!.now).toContain("→");
    expect(m.scout).toMatchObject({ kind: "faded", hint: "Role off in this rule · keeps its usual choice" });
    expect(m.reviewer).toMatchObject({ kind: "faded", hint: "not in this rule · click to add" });
  });
  test("the machine check marks an engine that is not installed or not signed in, and only that", () => {
    const p = withRules(rule("a", "A", "opencode"));
    const away = [eng("claude"), eng("opencode", { found: false, roles: { worker: { ok: false, why: "not installed" }, orchestrator: { ok: false, why: "not installed" } } })];
    const m = marksReadiness(p, on("a"), away);
    expect(Object.keys(m)).toEqual(["builder"]);
    expect(m.builder!.warn).toContain("not installed");
    expect(marksReadiness(p, on("a"), READY)).toEqual({});
    expect(marksReadiness(p, on("a"), null)).toEqual({});
  });
  test("layers merge, the later over the earlier, and a warning survives a preview", () => {
    const m = mergeMarks({ builder: { kind: "rule", warn: "w" } }, { builder: { kind: "preview", tag: "preview" } });
    expect(m.builder).toEqual({ kind: "preview", tag: "preview", warn: "w" });
  });
});

describe("the canvas drawn with marks", () => {
  const flow = templateFlow();
  const html = (marks: Parameters<typeof FlowCanvas>[0]["marks"], extra: object = {}) => renderToStaticMarkup(React.createElement(FlowCanvas, {
    flow, selected: null, onSelect() {}, onConfigure() {}, onAddAfter() {}, onRemove() {}, onAddAt() {}, onReorder() {}, onMove() {}, onPlace() {}, onUseTemplate() {}, onAddFirst() {}, templateNames: [], marks, ...extra,
  } as never));
  const roleId = flow.roster.find((r) => r.policyRole === "builder" && flow.path.includes(r.id))!.id;
  const blockOf = (h: string, id: string) => { const pos = h.indexOf(`data-fe-block="${id}"`); const at = h.lastIndexOf("<div", pos); const next = h.indexOf('<div class="fe-blk', pos + 1); return h.slice(at, next < 0 ? undefined : next); };
  test("a block with a rule on says so on itself, and names the usual engine it overrides", () => {
    const h = html(marksInForce(withRules(rule("r1", "Claude plan low", "opencode")), on("r1")));
    const b = blockOf(h, roleId);
    expect(b).toContain('data-mark="rule"');
    expect(b).toContain("rule on");
    expect(b).toContain("Because: Claude plan low");
    // The card was redrawn: the base choice is named in the why line rather than struck through in the body.
    expect(b).toContain("base Claude Code sonnet");
    expect(b).toContain('class="fe-wk-reason"');
  });
  test("a block the rule does not touch is drawn as it was", () => {
    const other = flow.roster.find((r) => r.policyRole === "scout" && flow.path.includes(r.id));
    const h = html(marksInForce(withRules(rule("r1", "x", "opencode")), on("r1")));
    if (other) expect(blockOf(h, other.id)).not.toContain("data-mark");
  });
  test("no marks: the markup carries no mark at all", () => {
    expect(html(undefined)).not.toContain("data-mark=");
  });
  test("the orchestrator node is a button only when a rule is being edited", () => {
    expect(html({})).not.toContain("data-fe-orch=\"\" role=\"button\"");
    expect(html({}, { onOrchestrator() {} })).toContain('role="button"');
  });
  test("the canvas stylesheet never gives a mark its own box size", () => {
    const css = readFileSync(join(import.meta.dir, "..", "src", "components", "orchestration", "flow", "flowEditor.css"), "utf8");
    const marked = css.split("\n").filter((l) => /data-mark/.test(l));
    expect(marked.length).toBeGreaterThan(0);
    for (const l of marked) expect(l).not.toMatch(/\b(width|height|padding|margin|border-width)\s*:/);
  });
});

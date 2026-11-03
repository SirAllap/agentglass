/*
 * The Orchestration page after the per-block tab and the drawing left: a card
 * that points to the Flow editor, the three global tabs, and the cards that
 * stayed (Conditions, Quick setup, Polaris).
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { globalStubs } from "./stubGlobal";
globalStubs()("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
const { OrchestrationView, asSection } = await import("../src/components/orchestration/OrchestrationPane.tsx");
import type { OrchestrationViewProps } from "../src/components/orchestration/OrchestrationPane.tsx";
import { composePolicy, defaultStored } from "../../shared/orchestration.ts";
import { SETTINGS_ROWS, rowId, searchSettings } from "../src/lib/settingsIndex.ts";
const { Filter } = await import("../src/components/SettingRow.tsx");
import { EngineWhy } from "../src/components/orchestration/flow/EngineWhy.tsx";

const SRC = join(import.meta.dir, "..", "src", "components", "orchestration");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");
const policy = composePolicy(defaultStored(), {
  orchestrator: { engine: "claude", model: "sonnet" },
  workers: { scout: { engine: "claude", model: "" }, builder: { engine: "claude", model: "" }, reviewer: { engine: "claude", model: "" }, verifier: { engine: "claude", model: "" } },
});
const view = (o: Partial<OrchestrationViewProps> = {}) =>
  renderToStaticMarkup(React.createElement(OrchestrationView, {
    policy, scope: "global", root: "", projects: [], readiness: null, states: [], seat: null, notes: {}, busy: false,
    onRoot() {}, onSave: async () => null, onScope() {}, onOpenEngines() {}, ...o,
  } as OrchestrationViewProps));

/** The tabs in order, each with whether it is selected. */
const tabsOf = (html: string): [string, string][] =>
  html.split("<button").filter((b) => b.includes('role="tab"')).map((b) => {
    const end = b.indexOf("</button>");
    const label = b.slice(b.lastIndexOf(">", end) + 1, end);
    return [label, b.includes('aria-selected="true"') ? "true" : "false"];
  });

describe("the page after the per-block tab left", () => {
  const html = view();
  test("nothing sits between the project row and the tabs but the hero, and its call to action is the page's only one", () => {
    const bar = html.indexOf("data-scope-bar");
    const hero = html.indexOf("data-hero");
    const tabs = html.indexOf('role="tablist"');
    expect(bar).toBeGreaterThan(-1);
    expect(hero).toBeGreaterThan(bar);
    expect(hero).toBeLessThan(tabs);
    // The presets are behind the hero's own chip, so the page body draws none.
    expect(html).not.toContain('data-presets="true"');
    // One way in, in the hero; the header draws none.
    expect(html.match(/Open the Flow editor/g)).toHaveLength(1);
    expect(read("OrchestrationPane.tsx")).toContain('useReportHead("orchestration", null)');
    expect(read("OrchestrationPane.tsx")).not.toContain('label: "Open the Flow editor"');
  });
  test("exactly two tabs, Safety and limits first and selected", () => {
    expect(tabsOf(html)).toEqual([["Safety and limits", "true"], ["Always refused", "false"]]);
  });
  test("Alt+1 and Alt+2 open Safety and Refused, and Alt+3 is nothing", () => {
    const src = read("OrchestrationPane.tsx");
    expect(src).toContain('["1", "2"].indexOf(e.key)');
    expect(src).not.toContain('"3"');
    const order = [...src.slice(src.indexOf("const SECTIONS")).matchAll(/id: "(\w+)", label/g)].map((m) => m[1]);
    expect(order.slice(0, 2)).toEqual(["safety", "refused"]);
  });
  test("a saved or linked section called block or keys falls back to Safety and limits", () => {
    expect(asSection("block")).toBe("safety");
    expect(asSection(undefined)).toBe("safety");
    expect(asSection("keys")).toBe("safety");
    expect(tabsOf(view({ section: "block" }))[0]).toEqual(["Safety and limits", "true"]);
  });
  test("the page keeps no Conditions, Quick setup, Polaris or per-block card; the project row stays", () => {
    for (const gone of ["Conditions (", "Quick setup", "Polaris", "Per-block settings live", "This block", "Active flow", "agx-flow-bp", 'id="agx-flow-block"', "Turn the Gate"]) expect(html, gone).not.toContain(gone);
    expect(html).toContain("data-scope-bar");
  });
  test("Always refused is the fixed list and one box, and no switch: the Gate's switch is in Safety and limits", () => {
    const pane = html.slice(html.indexOf('data-pane="refused"'));
    expect(pane).toContain("Fixed for everyone");
    expect(pane).toContain("not editable");
    for (const t of ["Git", "Network and other machines", "This machine"]) expect(pane, t).toContain(`>${t}</h3>`);
    expect(pane).toContain("Only for all projects");
    expect(pane.match(/<textarea/g)).toHaveLength(1);
    expect(pane).not.toContain('role="switch"');
    expect(pane).not.toContain("Ask when it runs");
  });
});

describe("Quick setup reaches the Flow editor", () => {
  // The editor takes no policy prop: it reads the policy itself each time it opens.
  // The carrier is the page's `save` (Quick setup's onSave) into setLoaded and the view's `policy`
  // for the page, and FlowSlot mounting FlowEditor only while open, which runs useAround(root) and api.orchestration.
  test("Quick setup saves through the page's save, which replaces the policy the page holds", () => {
    const pane = read("OrchestrationPane.tsx");
    expect(pane).toContain("onSave={save}");
    expect(pane).toContain("setLoaded({ policy: r.policy,");
  });
  test("the editor is mounted only while open and reads the policy when it mounts, so it opens on the applied one", () => {
    expect(read("flow/FlowSlot.tsx")).toContain("return open ? <FlowEditor");
    const around = read("flow/AroundFlow.tsx");
    const at = around.indexOf("export function useAround(");
    const body = around.slice(at, around.indexOf("\n}\n", at));
    expect(body).toContain("api.orchestration(root || undefined)");
    expect(read("flow/FlowEditor.tsx")).toContain("useAround(policyRoot)");
  });
  test("closing the editor reads the page's policy again", () => {
    expect(read("flow/FlowSlot.tsx")).toContain("reload(); onPolicySaved?.();");
    expect(read("OrchestrationPane.tsx")).toContain("onPolicySaved={() => loadPolicy(root)}");
  });
});

describe("the page's chrome after the cards left", () => {
  test("one Save bar, the page's own, after both sections; nothing explains a removed card, and the page has no index of its own", () => {
    const src = read("flow/FlowSections.tsx");
    expect(src).not.toContain("data-savebar");
    const pane = read("OrchestrationPane.tsx");
    const bar = pane.indexOf("data-savebar");
    expect(bar).toBeGreaterThan(pane.indexOf('id="agx-flow-refused"'));
    expect(pane.slice(pane.indexOf("const dirty ="), bar)).toContain("dirty");
    expect(src).not.toContain("What the page counts as one change");
    expect(src).not.toContain("lives on the Reviewer block");
    expect(src).not.toContain("The most review rounds is set on the reviewing block");
    expect(readFileSync(join(SRC, "..", "SettingsModal.tsx"), "utf8")).toMatch(/const NO_TOC[^\n]*"orchestration"/);
  });
  test("Use the general setting is drawn only for a project that has a value of its own", () => {
    const own = view({ projects: ["/w/orbit"], root: "/w/orbit", scope: "project", overrides: ["/w/orbit"] });
    const none = view({ projects: ["/w/orbit"], root: "/w/orbit", scope: "global", overrides: [] });
    expect(own).toContain("Use the general setting");
    expect(none).not.toContain("Use the general setting");
  });
});

describe("the review settings stay findable and open the Flow editor on the reviewing block", () => {
  const ROWS = [
    ["Who reviews and checks", "orchestration.review.who"],
    ["Most rounds before it stops", "orchestration.review.rounds"],
    ["Second reviewer on another model", "orchestration.review.second"],
  ] as const;
  test.each(ROWS)("search for %s lands on the Orchestration page, on that row", (label, id) => {
    const hit = searchSettings(label, [{ id: "orchestration", label: "Orchestration", kw: "" }]).find((r) => r.label === label);
    expect(hit, label).toBeDefined();
    expect(hit!.pane).toBe("orchestration");
    expect(hit!.row).toBe(rowId(label));
    expect(SETTINGS_ROWS.find((r) => r.pane === "orchestration" && r.label === label)?.settingId).toBe(id);
  });
  test("while a settings search lists rows each one is drawn with its button, and otherwise the page draws none", () => {
    const el = React.createElement(OrchestrationView, {
      policy, scope: "global", root: "", projects: [], readiness: null, states: [], seat: null, notes: {}, busy: false,
      onRoot() {}, onSave: async () => null, onScope() {}, onOpenEngines() {},
    } as OrchestrationViewProps);
    const under = (on: boolean) => renderToStaticMarkup(React.createElement(Filter.Provider, { value: { on, q: "review", seen() {} } }, el));
    const quiet = under(false);
    for (const [, id] of ROWS) expect(quiet).not.toContain(`data-setting-id="${id}"`);
    const html = under(true);
    for (const [label, id] of ROWS) {
      const at = html.indexOf(`data-setting-id="${id}"`);
      expect(at, label).not.toBe(-1);
      expect(html.slice(at, at + 900)).toContain("Open at the reviewing block");
    }
    const src = read("OrchestrationPane.tsx");
    expect(src.match(/openFlowEditor\("reviewer"\)/g)).toHaveLength(3);
    expect(src).toContain("setEditBlock(block)");
    expect(read("flow/FlowSlot.tsx")).toContain("select={editBlock}");
    expect(read("flow/FlowEditor.tsx")).toContain("r.policyRole === p.select");
  });
});

describe("an engine that cannot take the role says why in the Flow editor, and offers Show it", () => {
  const readiness = [{ id: "claude", roles: { worker: { ok: false, why: "Not signed in." }, orchestrator: { ok: false } } }] as never;
  test("a picked engine that is not ready gets its reason and the link", () => {
    const html = renderToStaticMarkup(React.createElement(EngineWhy, { engine: "claude", readiness }));
    expect(html).toContain("Not signed in.");
    expect(html).toContain("Show it");
  });
  test("a ready engine, or one not checked yet, adds nothing", () => {
    const ok = [{ id: "claude", roles: { worker: { ok: true }, orchestrator: { ok: true } } }] as never;
    expect(renderToStaticMarkup(React.createElement(EngineWhy, { engine: "claude", readiness: ok }))).toBe("");
    expect(renderToStaticMarkup(React.createElement(EngineWhy, { engine: "claude", readiness: null }))).toBe("");
  });
  test("the role picker and the second reviewer's picker both mount it", () => {
    expect(read("flow/PolicyRoleControls.tsx")).toContain("<EngineWhy engine={choice?.engine}");
    expect(read("flow/ReviewerControls.tsx")).toContain("<EngineWhy engine={second.engine}");
  });
});

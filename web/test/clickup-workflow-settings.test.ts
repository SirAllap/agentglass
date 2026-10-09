/*
 * The ClickUp page, drawn: the workflow map with the settings handed in.
 *
 * Under `bun test` there is no DOM, so this is the first paint. What is pinned
 * is what a person meets: a workspace that set nothing sees no workflow fields
 * at all (no dimmed rows, no QA input, no banner), a step shows the status it
 * points at and which spaces have it, a step with no status says so, and
 * switching changes off keeps the steps and marks them dormant.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ClickUpPrefs } from "../../shared/providers.ts";
import { WorkflowMap, type MapProps } from "../src/components/WorkflowMap.tsx";
import { CLICKUP, clickupSteps } from "../src/lib/clickupWorkflow.ts";
import { allStatuses, resolveImplicit, type MapSpace } from "../src/lib/workflowMap.ts";

const st = (status: string, type = "custom") => ({ status, type });
const SPACES: MapSpace[] = [
  { id: "1", name: "Engineering", statuses: [st("to do", "open"), st("code review"), st("ready for qa"), st("done", "done")] },
  { id: "2", name: "Support", statuses: [st("open", "open"), st("solved", "closed")] },
];
const prefs = (over: Partial<ClickUpPrefs> = {}): ClickUpPrefs => ({
  handoff: { enabled: false, statusNames: [], unassign: "none" },
  review: { enabled: false, statusNames: [], assignReviewer: false },
  merge: { enabled: false, statusNames: [] },
  flows: { noteOnCard: false },
  prLinkField: "", swatchField: "", cardSkillPattern: "", assigned: { includeSubtasks: false },
  sprintListPattern: "", readOnlyFieldPattern: "", bell: { kinds: [] },
  ...over,
});
const draw = (p: ClickUpPrefs, over: Partial<MapProps> = {}) => renderToStaticMarkup(React.createElement(WorkflowMap, {
  adapter: CLICKUP, spaces: SPACES, panel: { kind: "ok" }, steps: clickupSteps(p), changesOn: true,
  onAdd: () => {}, onStatus: () => {}, onRemove: () => {}, onUnassign: () => {}, onRetry: () => {}, ...over,
}));

describe("a workspace that set nothing", () => {
  const html = draw(prefs(), { changesOn: false });
  test("says it only reads, and offers to add a step", () => {
    expect(html).toContain("No steps. agentglass only reads.");
    expect(html).toContain("Add a step");
    expect(html).toContain("read-only");
  });
  test("has no QA field, no dimmed row, no switch for a step: nothing to turn off", () => {
    for (const t of ["Hand off", "QA status names", "Take off the card", "Review status names", "Names on your boards"]) expect(html).not.toContain(t);
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain("disabled=\"\" aria-label=\"QA");
  });
});

describe("steps", () => {
  const p = prefs({
    handoff: { enabled: true, statusNames: ["Ready for QA"], unassign: "me" },
    review: { enabled: true, statusNames: ["code review"], assignReviewer: true },
    merge: { enabled: true, statusNames: ["done"] },
    flows: { noteOnCard: true },
  });
  const html = draw(p);
  test("each is listed with where it appears, in map order", () => {
    const at = ["Move button on a pull request", "Move item in the review menu", "Move option in the merge dialog", "Assigned list in the review menu", "Note button on a pull request"].map((t) => html.indexOf(t));
    expect(at.every((i) => i > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
  test("a status chip names the status, and who comes off is said in words", () => {
    expect(html).toContain("Ready for QA");
    expect(html).toContain(">only me<");
    expect(html).toContain("changes on");
  });
  test("the spaces that lack the status are named, and the button is said to be absent there", () => {
    expect(html).toContain("Support");
    expect(html).toContain("no such status — the button is absent");
  });
  test("Remove has a name that says which step", () => {
    expect(html).toContain('aria-label="Remove step: Move button on a pull request"');
  });
  test("no polling and no per-keystroke write in the files that draw it", async () => {
    for (const f of ["WorkflowMap", "StatusPanel", "ClickUpPane"]) {
      const src = await Bun.file(new URL(`../src/components/${f}.tsx`, import.meta.url).pathname).text();
      expect(src, f).not.toMatch(/setInterval|setTimeout\([^)]*,\s*\d{4,}/);
    }
  });
});

describe("a step with nothing to point at, and one switched off", () => {
  test("a review item that finds no review status anywhere says it needs one and is not active", () => {
    const html = draw(prefs({ review: { enabled: true, statusNames: [], assignReviewer: false } }), { steps: clickupSteps(prefs({ review: { enabled: true, statusNames: [], assignReviewer: false } })) });
    expect(html).toContain("needs a status");
    expect(html).toContain("Not active until you pick a status.");
    expect(html).toContain("choose a status…");
  });
  test("a migrated hand-off on the built-in default says so instead of claiming it is off", () => {
    const p = prefs({ handoff: { enabled: true, statusNames: [], unassign: "none" } });
    const html = draw(p, { steps: resolveImplicit(CLICKUP, clickupSteps(p), allStatuses(SPACES)) });
    expect(html).not.toContain("needs a status");
    expect(html).toContain("The built-in default, until you choose one.");
  });
  test("changes off: the steps stay, marked dormant, and no line is drawn to a status", () => {
    const html = draw(prefs({ flows: { noteOnCard: true } }), { changesOn: false });
    expect(html).toContain("dormant: changes are off");
    expect(html).toContain("Note button on a pull request");
  });
  test("a refused token freezes the map: inert, paused, and Add is disabled", () => {
    const html = draw(prefs({ flows: { noteOnCard: true } }), { frozen: true });
    expect(html).toContain("paused: token refused");
    expect(html).toContain('inert=""');
  });
  test("no spaces yet: the lane says so rather than inventing statuses", () => {
    const html = draw(prefs(), { spaces: [], panel: { kind: "empty" } });
    expect(html).toContain("No spaces to show.");
  });
});

describe("the page is only there with ClickUp", () => {
  test("Settings renders it for a connected ClickUp and sends an unconnected one back to Tools & services", async () => {
    const src = await Bun.file(new URL("../src/components/SettingsModal.tsx", import.meta.url).pathname).text();
    expect(src).toContain('{show("clickup") && cu && <ClickUpPane />}');
    expect(src).toContain('const tabs = useMemo(() => TABS.filter((t) => t.id !== "clickup" || cu), [cu]);');
    expect(src).toContain('if (pane === "clickup" && cuConnected === false) setPane("connections");');
  });
  test("the old blocks are gone from Tools & services", async () => {
    const src = await Bun.file(new URL("../src/components/SettingsModal.tsx", import.meta.url).pathname).text();
    expect(src).not.toContain("ClickUpWorkflow");
    expect(src).not.toContain("Names on your boards");
    expect(src).toContain('onClick={() => openSettings("clickup")}');
  });
  test("the card skills pattern moved to Agents and shows only with ClickUp", async () => {
    const src = await Bun.file(new URL("../src/components/SettingsModal.tsx", import.meta.url).pathname).text();
    expect(src).toContain("<CardSkillsRow connected />");
    expect(src).toContain("{cu && (");
    const pane = await Bun.file(new URL("../src/components/ClickUpPane.tsx", import.meta.url).pathname).text();
    expect(pane).toContain("if (!connected || !prefs) return null;");
    expect(pane.slice(pane.indexOf("export function ClickUpPane"))).not.toContain("cardSkillPattern");
  });
  test("disconnecting drops the copies the sidebar holds, or it draws a card for a minute after", async () => {
    const src = await Bun.file(new URL("../src/components/SettingsModal.tsx", import.meta.url).pathname).text();
    const at = src.indexOf("api.providerDisconnect(spec.id, { forgetBoards })");
    expect(at, "the confirmed disconnect moved").toBeGreaterThan(-1);
    const gone = src.slice(at, src.indexOf("onChanged()", at));
    expect(gone).toContain("__forgetClickupSetup(); __forgetClickupPrefs(); __forgetClickupSpaces(); forgetCards();");
  });
  test("the command palette lists the ClickUp page only while ClickUp is connected", async () => {
    const src = await Bun.file(new URL("../src/components/CommandBar.tsx", import.meta.url).pathname).text();
    expect(src).toContain('const shownPages = cuHere ? SETTINGS_PAGES : SETTINGS_PAGES.filter((p) => p.id !== "clickup");');
    expect(src).toContain('(cuHere || r.pane !== "clickup")');
  });
  test("changing workspace drops the spaces and the id style read under the old one", async () => {
    const src = await Bun.file(new URL("../src/components/SettingsModal.tsx", import.meta.url).pathname).text();
    const at = src.indexOf("await api.providerWorkspace(spec.id, w.id, w.name);");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 200)).toContain("__forgetClickupSpaces()");
  });
  test("the map keeps a focus request until its target exists, and the composer's Escape stays inside it", async () => {
    const src = await Bun.file(new URL("../src/components/WorkflowMap.tsx", import.meta.url).pathname).text();
    expect(src).toContain("root.current?.querySelector<HTMLElement>(focusNext)");
    expect(src).toContain("const ok = await p.onAdd(composer.kind");
    expect(src).toContain('if (e.key === "Escape") { e.stopPropagation(); setComposer(null);');
    expect(src).not.toContain("queueMicrotask");
  });
  test("the review menu reads nothing from ClickUp when neither of its steps is added", async () => {
    const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url).pathname).text();
    expect(src).toContain("if (!query || !wanted0) return;");
  });
  test("every save goes through the one prefs route", async () => {
    const pane = await Bun.file(new URL("../src/components/ClickUpPane.tsx", import.meta.url).pathname).text();
    const body = pane.slice(pane.indexOf("export function ClickUpPane"));
    expect(body.match(/const r = await api\.clickupSetPrefs\(patch\);/g)?.length).toBe(1);
  });
});

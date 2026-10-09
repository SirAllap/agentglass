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
import { partitionUnits } from "../src/lib/workflowLayout.ts";

const st = (status: string, type = "custom") => ({ status, type });
const SPACES: MapSpace[] = [
  { id: "1", name: "Engineering", group: "Platform", cards: 12, statuses: [st("to do", "open"), st("code review"), st("ready for qa"), st("done", "done")] },
  { id: "2", name: "Support", statuses: [st("open", "open"), st("solved", "closed")] },
];
const prefs = (over: Partial<ClickUpPrefs> = {}): ClickUpPrefs => ({
  handoff: { enabled: false, statusNames: [], unassign: "none", assign: { who: "none" } },
  review: { enabled: false, statusNames: [], assignReviewer: false, assign: { who: "none" } },
  merge: { enabled: false, statusNames: [], assign: { who: "none" } },
  flows: { noteOnCard: false },
  prLinkField: "", swatchField: "", cardSkillPattern: "", assigned: { includeSubtasks: false },
  sprintListPattern: "", readOnlyFieldPattern: "", bell: { kinds: [] }, statusSpaces: { counted: [] },
  ...over,
});
/** The markup without its stylesheet: a class name written in the CSS is not something a person meets. */
const bare = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, "");
const draw = (p: ClickUpPrefs, over: Partial<MapProps> = {}) => bare(renderToStaticMarkup(React.createElement(WorkflowMap, {
  adapter: CLICKUP, part: partitionUnits(SPACES), panel: { kind: "ok" }, steps: clickupSteps(p), changesOn: true,
  onAdd: () => {}, onBlocks: () => {}, onRemove: () => {}, onRetry: () => {}, ...over,
})));

describe("a workspace that set nothing", () => {
  const html = draw(prefs(), { changesOn: false });
  test("says it only reads, and offers to add a step", () => {
    expect(html).toContain("No steps yet");
    expect(html).toContain("Add a step");
    expect(html).toContain("Nothing in ClickUp changes until you add one");
  });
  test("has no QA field, no dimmed row, no switch for a step: nothing to turn off", () => {
    for (const t of ["Hand off", "QA status names", "Take off the card", "Review status names", "Names on your boards"]) expect(html).not.toContain(t);
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain("disabled=\"\" aria-label=\"QA");
  });
});

describe("steps", () => {
  const p = prefs({
    handoff: { enabled: true, statusNames: ["Ready for QA"], unassign: "me", assign: { who: "none" } },
    review: { enabled: true, statusNames: ["code review"], assignReviewer: true, assign: { who: "none" } },
    merge: { enabled: true, statusNames: ["done"], assign: { who: "none" } },
    flows: { noteOnCard: true },
  });
  const html = draw(p);
  test("each is listed with where it appears, in map order", () => {
    const at = ["Button on a pull request", "Item in the review menu", "Option in the merge dialog", "Assigned list in the review menu", "Note button on a pull request"].map((t) => html.indexOf(t));
    expect(at.every((i) => i > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
  test("a status chip names the status, and who comes off is said in words", () => {
    expect(html).toContain("Ready for QA");
    expect(html).toContain(">only me<");
    expect(html).toContain("Changes on");
  });
  test("a step says which lists have its status in one pill, and the lists that lack it are one press away", () => {
    expect(html).toContain('aria-label="Coverage: Engineering only. Show per-list detail"');
    expect(html).toContain("Engineering only");
    expect(html).not.toContain("no such status — the button is absent");
  });
  test("each step is a card with a number, a title, where it shows and a one-line purpose", () => {
    expect(html).toContain('aria-label="Step 1: Button on a pull request"');
    expect(html).toContain("The button in a pull request’s card block, when the pull request names a card, its list has “Ready for QA” and the card is not in it already");
    expect(html).toContain("Move the card to");
    expect(html).toContain("Take people off the card");
    expect(html).toContain("Preselect");
  });
  test("the column names each list with its folder and carries a pin, numbered like the step, on the status it points at", () => {
    expect(html).toContain("Your statuses in");
    expect(html).toContain("Platform");
    expect(html).toMatch(/data-status="ready for qa"[^>]*data-tg=""/);
    expect(html).toMatch(/title="Step 1">1</);
    const gap = draw(prefs({ merge: { enabled: true, statusNames: ["solved"], assign: { who: "none" } } }));
    expect(gap).toContain("Not in Engineering");
    expect(gap).toContain("point at a status this list does not have.");
  });
  test("Remove has a name that says which step", () => {
    expect(html).toContain('aria-label="Remove step 1"');
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
    const html = draw(prefs({ review: { enabled: true, statusNames: [], assignReviewer: false, assign: { who: "none" } } }), { steps: clickupSteps(prefs({ review: { enabled: true, statusNames: [], assignReviewer: false, assign: { who: "none" } } })) });
    expect(html).toContain("Needs a status");
    expect(html).toContain("Pick a status");
    expect(html).not.toContain("wfm-cov");
  });
  test("a migrated hand-off on the built-in default says so instead of claiming it is off", () => {
    const p = prefs({ handoff: { enabled: true, statusNames: [], unassign: "none", assign: { who: "none" } } });
    const html = draw(p, { steps: resolveImplicit(CLICKUP, clickupSteps(p), allStatuses(SPACES)) });
    expect(html).not.toContain("Needs a status");
    expect(html).toContain("The built-in default, until you choose one.");
  });
  test("changes off: the steps stay, marked dormant, and no line is drawn to a status", () => {
    const html = draw(prefs({ flows: { noteOnCard: true } }), { changesOn: false });
    expect(html).toContain("Not active · changes off");
    expect(html).toContain("Changes are off, so no step is active.");
    expect(html).toContain("Note button on a pull request");
  });
  test("a refused token freezes the map: inert, paused, and Add is disabled", () => {
    const html = draw(prefs({ flows: { noteOnCard: true } }), { frozen: true });
    expect(html).toContain("Paused: token refused");
    expect(html).toContain('inert=""');
  });
  test("no lists yet: the column says so rather than inventing statuses", () => {
    const html = draw(prefs(), { part: partitionUnits([]), panel: { kind: "empty" } });
    expect(html).toContain("No lists to show.");
  });
  test("a status only an ignored list has is said so, and the way back is one press", () => {
    const p = prefs({ handoff: { enabled: true, statusNames: ["lead"], unassign: "none", assign: { who: "none" } } });
    const sales: MapSpace = { id: "9", name: "Sales pipeline", statuses: [st("lead", "open"), st("won", "done")] };
    const html = draw(p, { part: partitionUnits([...SPACES, { ...sales, counted: false }]), onCountAgain: () => {} });
    expect(html).toContain("Only in ignored lists");
    expect(html).toContain("only exists in lists you ignore (Sales pipeline)");
    expect(html).toContain("Count Sales pipeline again");
    expect(html).toContain("Ignored (1)");
    expect(html).not.toContain("No list has it");
  });
  test("a status no list has says so and does not blame an ignored one", () => {
    const html = draw(prefs({ handoff: { enabled: true, statusNames: ["qa passed"], unassign: "none", assign: { who: "none" } } }));
    expect(html).toContain("No list has it");
    expect(html).toContain("It may have been renamed.");
    expect(html).not.toContain("Count ");
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
    expect(src).toContain("const ok = await p.onAdd(k);");
    expect(src).toContain('if (e.key === "Escape") { e.stopPropagation(); setComposer(false);');
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

describe("the column opens on the list with most of the person's cards", () => {
  const render = (units: MapSpace[]) => renderToStaticMarkup(
    React.createElement(WorkflowMap, { adapter: CLICKUP, part: partitionUnits(units), panel: { kind: "ok" }, steps: [], changesOn: true, onAdd() {}, onBlocks() {}, onRemove() {}, onRetry() {} }));
  const u = (id: string, name: string, cards?: number): MapSpace => ({ id, name, statuses: [st("to do", "open")], ...(cards === undefined ? null : { cards }) });

  test("the busiest of several is selected, though it is not first in the answer", () => {
    const html = render([u("1", "Pro Updates", 0), u("2", "Orbit", 21), u("3", "Sales", 3)]);
    expect(html).toMatch(/aria-selected="true"><span class="n"><b class="text-\[13px\]">Orbit</);
    expect(html).toContain('aria-label="Statuses in Orbit"');
  });
  test("with no card to go on none is selected and the column says why", () => {
    const html = render([u("1", "Pro Updates"), u("2", "Orbit")]);
    expect(html).not.toContain('aria-selected="true"');
    expect(html).not.toContain("Statuses in");
    expect(html).toContain("no list is picked for you");
  });
});

describe("the eye on a list", () => {
  const u = (id: string, name: string, extra: Partial<MapSpace> = {}): MapSpace => ({ id, name, statuses: [st("to do", "open")], cards: 1, ...extra });
  const render = (units: MapSpace[], toggle: MapProps["onToggleCounted"] = () => {}) => renderToStaticMarkup(
    React.createElement(WorkflowMap, { adapter: CLICKUP, part: partitionUnits(units), panel: { kind: "ok" }, steps: [], changesOn: true, onToggleCounted: toggle, onAdd() {}, onBlocks() {}, onRemove() {}, onRetry() {} }));
  const eyes = (html: string) => [...html.matchAll(/<button[^>]*class="wfm-eye"[^>]*>/g)].map((m) => m[0]);

  test("every counted list has an eye that says what it does, and an ignored one has the same eye to bring it back", () => {
    const html = render([u("1", "Orbit"), u("2", "Sales"), u("3", "Support", { counted: false })]);
    const e = eyes(html);
    expect(e.length).toBe(3);
    expect(e[0]).toContain('title="Hide this list from ClickUp statuses"');
    expect(e[1]).toContain('title="Hide this list from ClickUp statuses"');
    expect(e[2]).toContain('title="Show it again"');
    expect(e[2]).toContain('data-eye="off"');
    expect(html).toContain("Ignored (1)");
  });

  test("the eye is a sibling of the tab, at the end of its row: nothing is drawn over anything", () => {
    const html = render([u("1", "Orbit"), u("2", "Sales")]);
    expect(html).toMatch(/<div class="r" data-sel=""><button type="button" class="t" role="tab"[^>]*>.*?<\/button><button type="button" class="wfm-eye"/);
    expect(html).not.toMatch(/<button[^>]*role="tab"[^>]*>(?:(?!<\/button>).)*wfm-eye/);
  });

  test("the last list that counts has its eye disabled, in the same place, and says why", () => {
    const html = render([u("1", "Orbit"), u("3", "Support", { counted: false })]);
    const [first, second] = eyes(html);
    expect(first).toContain("disabled");
    expect(first).toContain("At least one list has to count");
    expect(second).not.toContain("disabled");
  });

  test("without a handler no eye is drawn, and the box it would take is kept", () => {
    const html = render([u("1", "Orbit"), u("2", "Sales")], null as never);
    expect(eyes(html).length).toBe(0);
    expect(html).toContain('class="shrink-0" style="width:26px;margin-right:6px"');
  });
});

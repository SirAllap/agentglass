/*
 * The Polaris view's contract, read from source (there is no renderer here):
 * the drawing pinned, one scroll region of six tabs, every door in exactly one
 * tab, the one draft with Save and Discard, and the old link landing here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DOOR_IDS } from "../../shared/polaris.ts";
import { GROUPS } from "../src/lib/polarisCopy.ts";
import { LIMITS } from "../src/lib/polarisView.ts";

const src = (p: string) => readFileSync(join(import.meta.dir, "..", "src", p), "utf8");
const view = src("components/polaris/PolarisView.tsx");
const css = src("components/polaris/polarisView.css");
const paneSrc = src("components/orchestration/OrchestrationPane.tsx");
const polarisPageSrc = src("components/polaris/PolarisPane.tsx");
const modalSrc = src("components/SettingsModal.tsx");
const openSrc = src("lib/openSettings.ts");

describe("every door in exactly one tab", () => {
  test("the five door groups together are the seventeen doors, with no repeat", () => {
    const doors = GROUPS.flatMap((g) => [...g.doors]);
    expect(doors.slice().sort()).toEqual([...DOOR_IDS].sort());
    expect(new Set(doors).size).toBe(DOOR_IDS.length);
  });
  test("the view draws the same groups and the same limits", () => {
    expect(view).toContain('import { DOOR_COPY, GROUPS } from "../../lib/polarisCopy.ts"');
    expect(view).toContain("LIMITS");
    expect(view).toContain("groupOf(tab)");
  });
  test("all six tabs are named, in the mockup's order", () => {
    const tabs = ["Watching", "Signals", "Landing", "Automatic", "Limits", "Guardrails"];
    const at = tabs.map((t) => view.indexOf(`{ id: "${t}"`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect(at).toEqual(at.slice().sort((a, b) => a - b));
  });
  test("the limit rows are bound to the real settings, not typed twice", () => {
    expect(view).toContain("tab === \"Limits\" && LIMITS.map(");
    expect(view).toContain("Number(doors[l.door][l.param])");
    expect(LIMITS.map((l) => l.door)).toEqual(["cards", "relaunch", "startSession", "course"]);
  });
});

describe("the drawing sits at the top of the page's one scroller", () => {
  test("the drawing is a static block, and the panel follows it in the same region", () => {
    // The polarity page's body is the one scroll region (the frame's contract
    // test states the rest); a sticky drawing taller than that scrollport
    // covers the doors it was meant to leave visible.
    expect(view.indexOf('className="agx-pol-panel"')).toBeGreaterThan(view.indexOf('className="agx-pol-pinned"'));
    expect(polarisPageSrc).toContain("<PolarisView root={root} />");
  });
  test("one scroll region: the panel is the last block, not a second scroller", () => {
    expect(css).not.toMatch(/\.agx-pol-panel \{[^}]*overflow-y:\s*auto/);
    expect(view).toContain('role="tabpanel"');
  });
});

describe("one draft, one save", () => {
  test("Save changes and Discard act on the draft, not on every click", () => {
    expect(view).toContain("Save changes");
    expect(view).toContain("Discard");
    expect(view).toContain("const commit = async (allowed: readonly DoorId[]) =>");
    expect(view).toContain("const discard = () =>");
    expect(view).not.toMatch(/onToggle=\{\(next\) => void save/);
  });
  test("it has a page of its own in Settings > Agents, and Orchestration no longer mounts it", () => {
    expect(polarisPageSrc.match(/<PolarisView /g)?.length).toBe(1);
    expect(paneSrc).not.toContain("<PolarisView");
    expect(paneSrc).not.toContain("<PolarisSlot");
    expect(paneSrc).not.toContain("<PolarisCard");
    expect(modalSrc).toContain('{show("polaris") && <PolarisPane />}');
  });
  test("an old polaris link lands on that page, not on Orchestration", () => {
    expect(openSrc).not.toContain('polaris: "orchestration"');
  });
});

describe("Assisted setup", () => {
  test("one press opens the existing bench session, and the line says where it went", () => {
    expect(view).toContain("askBuilderOnBench(root, assistPrompt(root)");
    expect(view).toContain("JOB.polarisSetup");
    expect(view).toContain("<BenchJobLine");
    expect(view).toContain("approval request");
  });
});

describe("the guardrails are shown, never toggled", () => {
  test("they come from the shared list and carry no switch of their own", () => {
    const at = view.indexOf('{tab === "Guardrails"');
    const block = view.slice(at, view.indexOf("details", at));
    expect(block).toContain("GUARDRAILS.map");
    expect(block).not.toContain("role=\"switch\"");
    expect(block).not.toContain("onClick={() => setDoorOn");
  });
});

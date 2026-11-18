import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { groupLeft, groupRight } from "../src/components/settings/shell/shellRules.ts";

const SRC = new URL("../src/components/", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, SRC), "utf8");
const walk = (d: URL): URL[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(new URL(`${e.name}/`, d)) : [new URL(e.name, d)]);
const settingsFiles = () => walk(new URL("settings/", SRC)).filter((u) => /\.tsx?$/.test(u.pathname));

describe("Settings has one scroller, one scope per page, one save model", () => {
  test("only the modal's .agx-settings-scroll scrolls; no settings file adds overflow-y or h-full to the page", () => {
    for (const f of ["settings/shell/SettingsPage.tsx", "settings/shell/Section.tsx", "settings/shell/PageRail.tsx"]) {
      expect(read(f), f).not.toMatch(/className="[^"]*(\bh-full\b|overflow-y-)/);
    }
    expect(read("SettingsModal.tsx").match(/data-settings-scroll/g)?.length).toBe(1);
  });
  test("Appearance lists each setting id once", () => {
    const t = read("settings/pages/AppearancePage.tsx");
    const ids = [...t.matchAll(/settingId=\{?[`"]([^`"]+)[`"]/g)].map((m) => m[1]);
    // appearance.translucent is one row drawn as a switch or as a locked line (a ternary), never both.
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dup).toEqual(["appearance.translucent"]);
  });
  test("a page renders one ScopeControl: SettingsPage owns it, pages pass a slot or none", () => {
    for (const f of ["FlowReviewPage.tsx", "PolarisPage.tsx", "AppearancePage.tsx"]) {
      expect((read(`settings/pages/${f}`).match(/<ScopeControl/g) ?? []).length).toBeLessThanOrEqual(1);
    }
    expect(read("orchestration/OrchestrationPane.tsx").match(/<ScopeControl/g)?.length).toBe(1);
  });
  test("nothing in Settings or Polaris has a Save changes / Discard bar", () => {
    for (const u of [...settingsFiles(), new URL("polaris/PolarisView.tsx", SRC)]) {
      const t = readFileSync(u, "utf8");
      expect(t, u.pathname).not.toContain("Save changes");
      expect(t, u.pathname).not.toMatch(/>Discard</);
    }
  });
  test("Polaris writes through the Undo toast", () => {
    expect(read("polaris/PolarisView.tsx")).toContain('pushSaveToast("Saved"');
  });
  test("a section is the one card: Polaris and the flow draw flat inside it", () => {
    expect(read("polaris/polarisView.css")).toMatch(/\[data-section\] \.agx-polaris \.agx-pol-panel \{[^}]*border: 0/);
    expect(read("settings/shell/Section.tsx")).not.toMatch(/<Section[^>]*<Section/);
  });
  test("Flow & review: stacked pages share one column; its empty and failed states sit on the shell", () => {
    const page = read("settings/shell/SettingsPage.tsx");
    // One group width on every page (720 + 32 + aside), centred: pages stacked in one pane (Flow & review, then folded Polaris) keep one left edge.
    // A page with no rail or aside keeps the spacer too, alone or stacked, so one left edge holds.
    expect(page).toContain("const spacer = showRailSpacer({ rail, chips, aside: !!aside, wide, wideRail });");
    expect(page).toContain('data-settings-group className="mx-auto max-w-full" style={{ width: chips ? "100%" : wide || rail || aside || spacer ? SHELL_GROUP_WIDTH : SHELL_COLUMN }}');
    expect(page).not.toMatch(/data-settings-group[^>]*w-fit/);
    const pane = read("orchestration/OrchestrationPane.tsx");
    expect(pane).toContain("<OnFlowPage><NothingSetUp");
    expect(pane).toContain("<OnFlowPage><LoadFailed");
    expect(pane).not.toMatch(/return <(NothingSetUp|LoadFailed)/);
  });
  test("content + rail group is centred: equal gaps", () => {
    expect(groupLeft(1000, 600)).toBe(200);
    expect(groupLeft(1000, 600)).toBe(groupRight(1000, 600));
    expect(groupLeft(500, 800)).toBe(0); // wider than the pane: no negative gap
  });
});

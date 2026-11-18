/*
 * The one "Applies to" control on the eight per-project pages: each page draws
 * it, the old widgets are gone, a per-project row says whether it differs, and
 * a machine value is locked under Only <project> and says why in a full sentence.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkersPage, type WorkersPageProps } from "../src/components/settings/pages/WorkersPage.tsx";
import { SettingsPage } from "../src/components/settings/shell/SettingsPage.tsx";
import { MachineLock } from "../src/components/settings/scope/ledger.tsx";

const SRC = join(import.meta.dir, "..", "src", "components");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

const GENERAL = { turnMinutes: 30, maxWorkers: 4, maxRetries: 2, rounds: 3 };
const workers = (o: Partial<WorkersPageProps["scope"]> & { limits?: WorkersPageProps["limits"]; projectScoped?: boolean } = {}) =>
  renderToStaticMarkup(createElement(WorkersPage, {
    limits: o.limits ?? { turnMinutes: 30, maxWorkers: 4, maxRetries: 2 }, rounds: 3, locked: false, busy: false, projectScoped: o.projectScoped ?? false,
    scope: { project: "/code/orbit", choice: "all", onChoice() {}, general: GENERAL, own: false, ...o },
    onLimit() {}, onRounds() {}, onOpenRoles() {}, onOpenEngines() {}, onOpenPermissions() {},
  } as WorkersPageProps));

describe("Workers: one control, row tags", () => {
  test("under All projects: the control, no row tag, no old widgets", () => {
    const html = workers();
    expect(html).toContain("Applies to");
    expect(html).toMatch(/data-scope-trigger[^>]*><span class="whitespace-nowrap">All projects<\/span>/);
    expect(html).not.toContain("data-scope-row");
    expect(html).not.toContain("has its own settings");
    expect(html).not.toContain("Use the general setting");
    expect(html).not.toContain("Saved for");
  });
  test("under Only <project> with its own value: the row that differs says so, with a reset that names the old value", () => {
    const html = workers({ choice: "project", own: true, limits: { turnMinutes: 30, maxWorkers: 2, maxRetries: 2 } });
    expect(html).toMatch(/data-scope-trigger[^>]*><span class="whitespace-nowrap">orbit<\/span>/);
    expect(html).toContain("Differs from all projects (was 4)");
    expect(html).toContain("Reset to all projects (4)");
    // The rows that match say they follow all projects.
    expect(html).toContain("Same as all projects");
  });
  test("a project that follows all projects: every row says it follows", () => {
    const html = workers({ choice: "project", own: false });
    expect(html).not.toContain("Differs from all projects");
    expect(html).toContain("Same as all projects");
  });
  test("the memory ceiling is a machine value: locked under a project, with a full sentence", () => {
    const html = workers({ choice: "project", projectScoped: true });
    expect(html).toContain("This one is set for every project. Change it under All projects.");
    expect(html).not.toContain("All projects only");
  });
  test("no project open: the second option is disabled and says what to do", () => {
    const html = workers({ project: null });
    expect(html).toContain("Open a project to set its own values");
  });
});

describe("machine values", () => {
  test("a page of machine values draws no scope control and locks nothing", () => {
    const html = renderToStaticMarkup(createElement(SettingsPage, {
      title: "Jira", purpose: "x",
      sections: [{ id: "a", title: "A", kind: "normal" as const, body: createElement("div", null, "row") }],
    } as never));
    expect(html).not.toContain("data-scope-slot");
    expect(html).not.toContain("data-scope-control");
    expect(html).not.toContain("data-machine-lock");
    expect(html).not.toContain("inert");
  });
  test("MachineLock: open under All projects, locked with the reason under a project", () => {
    const html = (choice: "all" | "project") => renderToStaticMarkup(createElement(MachineLock, { choice, children: createElement("span", null, "x") }));
    expect(html("all")).toContain('data-machine-lock="open"');
    expect(html("project")).toContain('data-machine-lock="locked"');
    expect(html("project")).toContain("Same for every project. Switch to");
    expect(html("project")).toContain("to change it.");
    expect(html("project")).not.toContain("All projects only");
  });
  test("MachineLock: All projects in the line is a button that switches", () => {
    const out = renderToStaticMarkup(createElement(MachineLock, { choice: "project", onAll: () => {}, children: createElement("span", null, "x") }));
    expect(out).toMatch(/<button[^>]*>All projects<\/button>/);
  });
});

describe("machine pages never draw the control", () => {
  for (const f of ["WatchingPage", "TasksPage", "JiraPage", "ClickUpPage"]) {
    test(f, () => {
      const src = read(`settings/pages/${f}.tsx`);
      expect(src).not.toContain("machineScope");
      expect(src).not.toContain("ScopeControl");
    });
  }
});

describe("the four per-project pages draw the shared control and none keeps an old scope widget", () => {
  const PAGES: Record<string, string> = {
    Permissions: "settings/pages/PermissionsPage.tsx",
    "Flow & review": "orchestration/OrchestrationPane.tsx",
    Workers: "settings/pages/WorkersPage.tsx",
    "Flight plan": "flightPlan/FlightPlanSettings.tsx",
  };
  const OLD = ["ScopeBar", "OrchSeg", "has its own settings", "Use the general setting", "Saved for", "SavedChip", "SpecificNote", "InheritedNote", "AppliesTo"];
  for (const [name, file] of Object.entries(PAGES)) {
    test(`${name}: shared control, no old widget`, () => {
      const src = read(file);
      expect(/ScopeControl|ScopeStrip|useMachineScope|useScope\(/.test(src), `${file} draws the control`).toBe(true);
      for (const o of OLD) expect(src.includes(o), `${file} still has ${o}`).toBe(false);
    });
  }
  test("the old bar is gone", () => {
    expect(() => read("orchestration/ScopeBar.tsx")).toThrow();
  });
});

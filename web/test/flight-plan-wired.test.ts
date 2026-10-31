/*
 * THE FLIGHT PLAN IS WIRED THROUGH, NOT JUST DRAWN.
 *
 * The seams: a view with no rail seat that nothing reaches, a Go button that
 * goes nowhere, a finding action that saves nowhere, a way in that duplicates
 * the view instead of linking to it. Read from source, because each lives in a
 * component that needs the app around it to render.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SHIPPED_RAIL, VIEWS, LETTER_TO_VIEW } from "../src/components/workspace/views.ts";

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url).pathname, "utf8");
const dir = "src/components/flightPlan/";
const view = read(dir + "FlightPlanView.tsx");
const findings = read(dir + "FindingsCard.tsx");
const poll = read(dir + "GoPoll.tsx");
const composer = read(dir + "Composer.tsx");
const settings = read(dir + "SettingsTab.tsx") + read(dir + "usePilotSettings.ts") + read("src/lib/pilotSettings.ts");
const app = read("src/App.tsx");
const api = read("src/lib/api.ts");
const palette = read("src/components/CommandPalette.tsx");
const agents = read("src/components/agents/AgentsView.tsx");
const modal = read("src/components/SettingsModal.tsx");
const topbar = read("src/components/TopBar.tsx");
const tasks = read("src/components/TasksPanel.tsx");
const jiraFacts = read("src/components/jira/JiraFacts.tsx");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");

describe("rail seat", () => {
  test("it is on the shipped work rail, on its own letter, with the label the tooltip shows", () => {
    expect(VIEWS.find((v) => v.id === "flightPlan")?.group).toBeUndefined();
    expect(SHIPPED_RAIL.work.some((v) => v.id === "flightPlan")).toBe(true);
    expect(VIEWS.find((v) => v.id === "flightPlan")?.label).toBe("Flight plan");
    expect(LETTER_TO_VIEW.f).toBe("flightPlan");
  });
  test("it is an ordinary view: visibility follows the rail, so Settings can hide it and asking un-hides it", () => {
    expect(read("src/components/workspace/views.ts")).toContain("export const isVisibleView = (id: ViewId) => visibleIds().includes(id);");
    expect(app).toContain('if (!isVisibleView(v)) moveView(v, "work");');
  });
  test("the workspace mounts it", () => expect(read("src/components/workspace/Workspace.tsx")).toContain('case "flightPlan": return <FlightPlanView'));
});

describe("ways in link, they never duplicate", () => {
  test("palette, Agents header, Settings link and the top bar chip all open it", () => {
    expect(palette).toContain('id: "flight-plan"'); expect(palette).toContain("openFlightPlan({ compose: {} })"); expect(palette).toContain('openFlightPlan({ tab: "settings" })');
    expect(agents).toContain("openFlightPlan()");
    expect(modal).toContain("<FlightPlanLink");
    expect(topbar).toContain("openFlightPlan({ card: needs!.plan })");
    expect(app).toContain("onShowFlightPlan(");
  });
  test("the Settings link has no settings of its own", () => expect(read(dir + "FlightPlanLink.tsx")).not.toMatch(/settingAtSet|settingsDoorSet/));
});

describe("every control reaches a route", () => {
  test("Go launches through the routes; the server opens the builder as a normal tab, so the window never touches the bench", () => {
    const go = view.slice(view.indexOf("const go = useCallback("), view.indexOf("const nogo = useCallback("));
    expect(go).toContain("api.flightPlanGo("); expect(go).toContain("api.flightPlanLaunch("); expect(go).not.toContain("openTicketOnBench(");
  });
  test("No-go sends its reason; the composer creates the plan and opens the author's tab", () => {
    expect(view).toContain("api.flightPlanNoGo(id, reason)");
    expect(composer).toContain("api.flightPlanNew("); expect(view).toContain("openTicketOnBench(r.root, r.ticket");
  });
  test("each finding action saves through the run's finding route; contest and dismiss ask for a note first", () => {
    expect(findings).toContain("api.flightFinding(runId, f.id, action, note)");
    expect(findings).toContain('const NEEDS_NOTE: FindingAction[] = ["contest", "dismiss"]');
  });
  test("settings go through the settings door, at a project", () => {
    expect(settings).toContain("api.settingAtSet("); expect(settings).toContain("flightPlan.preflight.costCapUsd"); expect(settings).toContain('"flightPlan.enabled"');
    for (const id of ["pilot", "preflight.reviews", "budget.dailyUsd", "maxFlying", "autopilot.askOnLarge", "builder.permissions"]) expect(settings).toContain(`flightPlan.${id}`);
  });
  test("the ask rules are a project's: their section is not labelled All projects", () => {
    const tab = read(dir + "SettingsTab.tsx");
    const sec = tab.slice(tab.indexOf('title="Stops and asks you"'), tab.indexOf('title="The builder never"'));
    expect(sec.length).toBeGreaterThan(100);
    expect(sec).not.toContain("All projects");
    expect(sec).toContain("projectName(project)");
  });
  test("every api method the view calls exists", () => {
    for (const m of ["flightPlans", "flightPlan", "flightPlanNew", "flightPlanPreflight", "flightPlanGo", "flightPlanNoGo", "flightPlanLaunch", "flightRuns", "flightRunGo", "flightFinding", "settingAt", "settingAtSet"])
      expect(api).toContain(`  ${m}: `);
  });
});

describe("advisory", () => {
  test("nothing in the Go poll or the view reads a finding to disable Go", () => {
    const go = code(poll.slice(poll.indexOf("<button type=\"button\" className=\"btn go\"")));
    expect(go.split("\n")[0]).toContain("disabled={busy || !canGo(plan)}");
    expect(code(poll)).not.toMatch(/blocked|hold the launch|must resolve/i);
  });
});

describe("no idle polling", () => {
  test("the view polls only while something is in flight, and the chip asks on an event, never on a timer", () => {
    expect(read(dir + "useFlightPlan.ts")).toContain("usePoll(active && enabled !== false && busy, reloadAll, IN_FLIGHT_MS)");
    expect(read("src/lib/useLive.ts")).toContain('"flight-plan"');
  });
});

describe("B3: what the server does is not the view's job, and the card has the control", () => {
  test("the view no longer sends the Preflight itself: the server does when the plan gets its text", () => {
    expect(code(view)).not.toContain("flightPlanPreflight");
  });
  test("an open card has an inline Start a flight plan, and the context menu no longer carries a copy of it", () => {
    expect(code(tasks)).toContain("<StartFlightPlan id=");
    expect(code(jiraFacts)).toContain("<StartFlightPlan id=");
    expect(code(tasks)).not.toContain("Start a flight plan");
  });
  test("the cap error offers a one-off cap; the thumbnail is the real artifact, sandboxed", () => {
    expect(code(findings)).toContain("Run once with");
    expect(code(findings)).toContain("Change the default cap");
    expect(code(findings)).toContain("setCancelled(run.id)");
    expect(code(read(dir + "MockupThumb.tsx"))).toContain('sandbox=""');
  });
});

describe("composer picks the project", () => {
  test("a visible picker, defaulted to the focused pane, and the chosen root is what is saved", () => {
    const c = code(composer);
    expect(c).toContain("<CheckoutPicker");
    expect(c).toContain("focusedPaneRoot()");
    expect(c.indexOf("<CheckoutPicker")).toBeLessThan(c.indexOf('id="fp-rq"'));
    expect(c).toContain("api.flightPlanNew({ root: proj,");
    expect(c).not.toContain("<select");
    expect(code(view)).not.toContain("setCompose({ root: d.root })");
  });
  test("the empty Flying tab says what it is for and offers the way in", () => {
    const l = read(dir + "FlightList.tsx");
    expect(l).toContain("<h4>No flights</h4>");
    expect(l).toContain("New flight plan");
  });
});

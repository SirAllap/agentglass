/*
 * THE FLIGHT PLAN LINE IN SETTINGS ▸ ORCHESTRATION says what the scope on
 * screen allows, not what the app allows everywhere: the global switch was read
 * alone, so a project the person had left out still read "On", and a start
 * there was refused.
 *
 * The decision is a function in lib/flightProjects.ts; the component reads the
 * two switches and draws the word and its tip.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FLIGHT_PLAN_SETTINGS, flightPlanLine } from "../src/lib/flightProjects.ts";

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url).pathname, "utf8");

describe("the word is about the project on screen", () => {
  test("the app's switch off is Off everywhere, and says which switch that is", () => {
    const line = flightPlanLine({ master: false, project: null, root: "" });
    expect(line.word).toBe("Off");
    expect(line.tip).toContain("every project");
    expect(line.tip).toContain("Use Flight plan");
    expect(line.tip).toContain(FLIGHT_PLAN_SETTINGS);
    // A project switch that is on cannot lift the app's own switch.
    expect(flightPlanLine({ master: false, project: true, root: "/w/acme/orbit" }).word).toBe("Off");
  });

  test("the app's switch on with All projects is On, and the tip is about the app's switch, not every project", () => {
    const line = flightPlanLine({ master: true, project: null, root: "" });
    expect(line.word).toBe("On");
    expect(line.tip).toContain("app's own switch");
    // Each project has its own switch: the All-projects line cannot promise one for all of them.
    expect(line.tip).toContain("each project");
    expect(line.tip).not.toContain("On in every project");
  });

  test("a project left out reads Off, and the tip names the project's own switch and where it lives", () => {
    const line = flightPlanLine({ master: true, project: false, root: "/w/acme/orbit" });
    expect(line.word).toBe("Off");
    expect(line.tip).toContain("acme/orbit");
    expect(line.tip).toContain("this project's own switch");
    expect(line.tip).toContain("Projects");
    expect(line.tip).toContain(FLIGHT_PLAN_SETTINGS);
  });

  test("a project left in reads On, and the tip names it", () => {
    const line = flightPlanLine({ master: true, project: true, root: "/w/acme/orbit" });
    expect(line.word).toBe("On");
    expect(line.tip).toContain("acme/orbit");
  });

  test("a read that failed says nothing rather than claiming On", () => {
    expect(flightPlanLine({ master: null, project: null, root: "/w/acme/orbit" }).word).toBe("");
    const unread = flightPlanLine({ master: true, project: null, root: "/w/acme/orbit" });
    expect(unread.word).toBe("");
    expect(unread.tip).toContain("not read");
  });
});

describe("the component reads both switches for the scope it is handed", () => {
  const link = read("src/components/flightPlan/FlightPlanLink.tsx");

  test("the app's switch and the project's, at the project, on every change of scope", () => {
    expect(link).toContain('api.settingAtGlobal("flightPlan.enabled")');
    expect(link).toContain("api.settingAt(PROJECT_ON, root)");
    expect(link).toContain("}, [root]);");
    // The decision is not remade here: it is the lib function's.
    expect(link).toContain("flightPlanLine({ master, project, root })");
  });

  test("the scope bar hands it the root on screen, so the word follows the choice", () => {
    expect(read("src/components/orchestration/OrchestrationPane.tsx")).toContain("p.lead ? p.lead(root) : undefined");
    expect(read("src/components/SettingsModal.tsx")).toContain("<FlightPlanLink root={root}");
  });
});

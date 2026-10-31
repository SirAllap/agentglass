import { describe, expect, test } from "bun:test";
import { flipMoment, momentsLine, momentsOf, pickProject, projectRoots } from "../src/lib/flightProjects.ts";

describe("which projects are in scope", () => {
  test("each once, the one the person is in first, plans of a project that is not open last", () => {
    expect(projectRoots(["/w/orbit"], ["/w/orbit", "/w/acme/billing"], ["/w/third", "/w/orbit"])).toEqual(["/w/orbit", "/w/acme/billing", "/w/third"]);
    expect(projectRoots([""], [])).toEqual([]);
  });
});

describe("the project Settings opens on", () => {
  const roots = ["/w/orbit", "/w/acme/billing", "/w/third"];
  test("the one with the most plans waiting on the person, else the first", () => {
    expect(pickProject(roots, { "/w/acme/billing": 1, "/w/third": 3 }, null)).toBe("/w/third");
    expect(pickProject(roots, {}, null)).toBe("/w/orbit");
  });
  test("a choice stays while its project is in scope, and is dropped when it leaves", () => {
    expect(pickProject(roots, { "/w/third": 3 }, "/w/acme/billing")).toBe("/w/acme/billing");
    expect(pickProject(roots, { "/w/third": 3 }, "/w/gone")).toBe("/w/third");
    expect(pickProject([], {}, null)).toBe("");
  });
});

describe("Preflight moments", () => {
  test("only known moments count, and a value that is not a list is none", () => {
    expect(momentsOf(["pr", "plan", "bogus"])).toEqual(["plan", "pr"]);
    expect(momentsOf("plan")).toEqual([]);
    expect(momentsOf(undefined)).toEqual([]);
  });
  test("flipping one adds or removes it and keeps the drawn order", () => {
    expect(flipMoment(["pr"], "plan")).toEqual(["plan", "pr"]);
    expect(flipMoment(["plan", "pr"], "plan")).toEqual(["pr"]);
    expect(flipMoment([], "taskDone")).toEqual(["taskDone"]);
  });
  test("the table line names them, or says Preflight is off", () => {
    expect(momentsLine(["plan", "pr"])).toBe("Launch · PR");
    expect(momentsLine([])).toBe("Preflight off");
  });
});

describe("the Projects card's pill", () => {
  test("says how many projects are in, and the extremes in plain words", async () => {
    const { pillWording } = await import("../src/lib/flightProjects.ts");
    expect(pillWording(true, 2, 3)).toBe("On in 2 of 3 projects");
    expect(pillWording(true, 3, 3)).toBe("On in every project");
    expect(pillWording(true, 0, 3)).toBe("Off in every project");
    expect(pillWording(false, 3, 3)).toBe("Off in every project");
  });
});

/*
 * Which local tasks belong to the project this phone was paired for.
 *
 * The server keeps one open project (`workspaces` in `/projects`) and every
 * other list on the phone honours it, but the Cards tab drew the whole
 * machine's task store: a phone paired for one project listed tasks for all of
 * them. The rule is by name — a task's `project` is a word the tracker keeps,
 * and a checkout is a directory — so it is spelled out here and checked.
 */
import { describe, expect, test } from "bun:test";
import type { LocalTask } from "../../shared/types.ts";
import { projectNames, scopeLocal } from "../src/model/taskScope.ts";

const task = (uuid: string, project: string | null): LocalTask => ({
  uuid, description: "Write the thing", status: "pending", project, priority: null,
  tags: [], due: null, created: null, completed: null, urgency: 0, notes: [], urls: [],
});

describe("projectNames", () => {
  test("a checkout is the last folder of its path, lower-cased", () => {
    expect(projectNames(["/home/ada/code/Orbit"])).toEqual(["orbit"]);
  });
  test("a trailing slash and an empty entry change nothing", () => {
    expect(projectNames(["/home/ada/code/orbit/", ""])).toEqual(["orbit"]);
  });
  test("no open project is no names", () => {
    expect(projectNames([])).toEqual([]);
    expect(projectNames(null)).toEqual([]);
  });
});

describe("scopeLocal", () => {
  const all = [
    task("1", "orbit"),
    task("2", "Orbit.billing"),
    task("3", "orbital"),
    task("4", "acme"),
    task("5", null),
  ];

  test("keeps the project and its dotted sub-projects", () => {
    expect(scopeLocal(all, ["orbit"]).map((t) => t.uuid)).toEqual(["1", "2"]);
  });
  test("a longer name that merely starts the same is another project", () => {
    expect(scopeLocal(all, ["orbit"]).some((t) => t.uuid === "3")).toBe(false);
  });
  test("a task with no project is nobody's, so it is not this project's", () => {
    expect(scopeLocal(all, ["orbit"]).some((t) => t.uuid === "5")).toBe(false);
  });
  test("several open projects keep all of them", () => {
    expect(scopeLocal(all, ["orbit", "acme"]).map((t) => t.uuid)).toEqual(["1", "2", "4"]);
  });
  test("no open project means nothing to scope by: every task", () => {
    expect(scopeLocal(all, []).length).toBe(5);
  });
  test("not loaded yet is an empty list", () => {
    expect(scopeLocal(null, ["orbit"])).toEqual([]);
  });
});

describe("the Cards tab", () => {
  const screen = Bun.file(new URL("../app/(tabs)/tasks.tsx", import.meta.url)).text();
  const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  test("asks the server which project is open, and scopes the local list by it", async () => {
    const src = code(await screen);
    expect(src.includes('"/projects"')).toBe(true);
    expect(src.includes("scopeLocal(")).toBe(true);
  });
  test("offers the whole machine beside the project, never instead of it", async () => {
    expect(code(await screen).includes('label: "Everything"')).toBe(true);
  });
});

describe("a board that could not be read", () => {
  const screen = Bun.file(new URL("../app/(tabs)/tasks.tsx", import.meta.url)).text();
  const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  /* `/clickup/view` answers 200 with `tasks: []` and `error: "ClickUp answered
     500"` when the read failed. The screen kept only `tasks`, so a board whose
     API was down said "no cards that are still open" — a claim about the
     board, made about a read that never happened. */
  test("reads the error the view answer carries, not only its tasks", async () => {
    const src = code(await screen);
    const board = src.slice(src.indexOf("`/clickup/view?id="));
    expect(/setError\(answer\.value\.error/.test(board)).toBe(true);
  });
  test("the empty-project note points at the switch by name", async () => {
    expect((await screen).includes("Tap Everything above")).toBe(true);
  });
});

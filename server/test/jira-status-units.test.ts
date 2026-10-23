/*
 * Which projects the workflow map is drawn from. A site shows a person many
 * projects and their cards sit in a few: the map is judged against those, the
 * rest stay listed and can be counted again, and a person's own pick wins.
 */
import { describe, expect, test } from "bun:test";
import { jiraStatusUnits, pickProjects, type JiraProjectRead } from "../../shared/jiraStatusUnits.ts";

const read = (key: string, names: [string, "open" | "done" | "other"][]): JiraProjectRead => ({ key, name: `${key} project`, statuses: names.map(([name, kind]) => ({ name, kind })) });
const READ = [
  read("ORBIT", [["Done", "done"], ["Backlog", "open"], ["Parked", "other"], ["Doing", "open"]]),
  read("DOCS", [["Draft", "open"], ["Published", "done"]]),
];

describe("jiraStatusUnits", () => {
  test("statuses read as work goes: open, then neither, then finished", () => {
    const u = jiraStatusUnits(READ, { ORBIT: 3 });
    expect(u.spaces[0]!.statuses.map((s) => `${s.status}:${s.type}`)).toEqual(["Backlog:open", "Doing:open", "Parked:custom", "Done:done"]);
  });

  test("with no pick, the projects holding the person's cards count and the others are folded", () => {
    const u = jiraStatusUnits(READ, { ORBIT: 3 });
    expect(u.source).toBe("tasks");
    expect(u.spaces.map((s) => [s.id, s.counted])).toEqual([["ORBIT", undefined], ["DOCS", false]]);
    expect(u.spaces[0]!.cards).toBe(3);
  });

  test("the person's pick wins over where the cards are, and a key that is not read is ignored", () => {
    const u = jiraStatusUnits(READ, { ORBIT: 3 }, ["DOCS", "GONE"]);
    expect(u.source).toBe("chosen");
    expect(u.spaces.map((s) => [s.id, s.counted])).toEqual([["ORBIT", false], ["DOCS", undefined]]);
  });

  test("a pick naming nothing that was read falls back to where the cards are", () => {
    expect(jiraStatusUnits(READ, { ORBIT: 1 }, ["GONE"]).source).toBe("tasks");
  });

  test("no cards and no pick: every project counts, and the answer says why", () => {
    const u = jiraStatusUnits(READ, {});
    expect(u.source).toBe("spaces");
    expect(u.spaces.every((s) => s.counted === undefined)).toBe(true);
    expect(u.note).toContain("every project is counted");
  });
});

describe("pickProjects", () => {
  const known = ["A", "B", "C", "D", "E"];
  test("the chosen come first, then the most cards, and a cut says how many it dropped", () => {
    expect(pickProjects(["E"], { A: 1, B: 9, C: 4 }, known, 3)).toEqual({ read: ["E", "B", "C"], omitted: 1 });
  });
  test("a key the site does not list is never read, and a key is read once", () => {
    expect(pickProjects(["B", "ZZ"], { B: 2, ZZ: 5 }, known, 5)).toEqual({ read: ["B"], omitted: 0 });
  });
});

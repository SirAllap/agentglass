import { describe, expect, test } from "bun:test";
import { NOTHING_ELSE, READING_SCREEN, pairGroups, requiredNames, screenLine, type MoveItem } from "../src/components/jira/list/moveConfirmModel.ts";

const it = (id: string, key: string, from: string): MoveItem => ({ id, key, title: "t", from });
const field = (key: string, name: string, required: boolean) => ({ key, name, required });

describe("move confirm: what else the step changes", () => {
  test("one group per (project, from-status) pair, first seen first", () => {
    const g = pairGroups([it("1", "ORBIT-1", "To Do"), it("2", "ORBIT-2", "To Do"), it("3", "ORBIT-3", "Doing"), it("4", "MOON-1", "To Do")]);
    expect(g.map((x) => [x.pair, x.ids])).toEqual([["ORBIT|To Do", ["1", "2"]], ["ORBIT|Doing", ["3"]], ["MOON|To Do", ["4"]]]);
    expect(g[0]!.rep.id).toBe("1");
  });
  test("required fields by name, optional ones left out", () => {
    const moves = [{ toStatus: "Done", needs: ["resolution"], fields: [field("resolution", "Resolution", true), field("assignee", "Assignee", false), field("fixVersions", "Fix versions", true)] }];
    expect(requiredNames(moves, "Done")).toEqual(["Resolution", "Fix versions"]);
    expect(screenLine({ phase: "ok", moves }, "Done")).toEqual({ tone: "plain", text: "Needs Resolution, Fix versions" });
  });
  test("a required key the screen did not describe is named by its key", () => {
    expect(requiredNames([{ toStatus: "Done", needs: ["customfield_1"] }], "Done")).toEqual(["customfield_1"]);
  });
  test("no required field: nothing else changes", () => {
    expect(screenLine({ phase: "ok", moves: [{ toStatus: "Done" }] }, "Done")).toEqual({ tone: "plain", text: NOTHING_ELSE });
  });
  test("loading, failed (Move stays possible) and an unlisted step each say so in one line", () => {
    expect(screenLine(undefined, "Done")).toEqual({ tone: "info", text: READING_SCREEN });
    expect(screenLine({ phase: "failed", error: "Jira did not answer" }, "Done")).toEqual({ tone: "warn", text: "Could not read what this step changes: Jira did not answer. You can still move." });
    expect(screenLine({ phase: "failed", error: "" }, "Done").text).toBe("Could not read what this step changes. You can still move.");
    expect(screenLine({ phase: "ok", moves: [{ toStatus: "Other" }] }, "Done").tone).toBe("warn");
  });
});

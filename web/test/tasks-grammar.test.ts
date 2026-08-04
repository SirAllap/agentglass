import { describe, expect, it } from "bun:test";

/*
 * The bar's own parser, and the line it writes back.
 *
 * The server decides what a write means; this one only has to be honest about
 * what it is about to say, because it is what the user reads before pressing
 * Enter. If the two ever disagree the strip becomes a lie, so the cases that
 * matter are pinned on both sides — this file for the client, tasks-write for
 * the server.
 */
const mod = { __test: await import("../src/lib/taskGrammar.ts") };

describe("what the bar says it will do", () => {
  it("round-trips a task through the line and back to the same fields", () => {
    // `e` is only an edit rather than a retype if the line it produces parses
    // to the task it came from.
    const t = {
      uuid: "u", description: "fix the login redirect", status: "pending" as const,
      project: "web", priority: "H" as const, tags: ["auth", "urgent"],
      due: "2026-08-09", created: null, completed: null, urgency: 0, notes: [], urls: [],
    };
    const line = mod.__test.toLine(t);
    expect(line).toContain("fix the login redirect");
    const back = mod.__test.parseLocal(line);
    expect(back.description).toBe(t.description);
    expect(back.priority).toBe("H");
    expect(back.tags).toEqual(["auth", "urgent"]);
    expect(back.project).toBe("web");
    expect(back.due).toBe("2026-08-09");
  });

  it("leaves a token it will not take in the description, where it is visible", () => {
    // Eating it is the trap: the user types something, it disappears, and the
    // app has silently decided what they meant.
    const p = mod.__test.parseLocal("write about C++ and +$(id) and @../../etc");
    expect(p.tags).toEqual([]);
    expect(p.project).toBe(null);
    expect(p.description).toContain("$(id)");
  });

  it("keeps an accented tag whole", () => {
    expect(mod.__test.parseLocal("algo +revisión").tags).toEqual(["revisión"]);
  });

  it("puts a task with nothing in the sorted field last, not first", () => {
    // An absent due date is not "very soon".
    const mk = (uuid: string, due: string | null) => ({
      uuid, description: uuid, status: "pending" as const, project: null, priority: null,
      tags: [], due, created: null, completed: null, urgency: 0, notes: [], urls: [],
    });
    const out = mod.__test.sortTasks([mk("none", null), mk("late", "2026-12-01"), mk("soon", "2026-08-05")], "due");
    expect(out.map((t) => t.uuid)).toEqual(["soon", "late", "none"]);
  });
});

describe("moving the selection", () => {
  const { step } = mod.__test;

  it("lands on an end from nothing, rather than one step into the list", () => {
    // The bug this was extracted for: `j` on a freshly opened list selected row
    // 1, and row 0 could not be reached without arrowing back up.
    expect(step(-1, 1, 3)).toBe(0);
    expect(step(-1, -1, 3)).toBe(2);
  });

  it("stops at both ends instead of wrapping", () => {
    expect(step(0, -1, 3)).toBe(0);
    expect(step(2, 1, 3)).toBe(2);
  });

  it("moves one row at a time from wherever it is", () => {
    expect(step(0, 1, 3)).toBe(1);
    expect(step(2, -1, 3)).toBe(1);
  });

  it("has nowhere to go in an empty list, and says so rather than picking row 0", () => {
    expect(step(-1, 1, 0)).toBe(-1);
    expect(step(-1, -1, 0)).toBe(-1);
  });
});

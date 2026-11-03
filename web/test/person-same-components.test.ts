import { describe, expect, test } from "bun:test";

/*
 * A person's board is not a second layout. Its open pull requests are drawn by the
 * lane columns of the own board and its closed ones by the own Closed list; only
 * the data (whose pull requests) and the banner differ. A rule about source is
 * asserted against source: there is no renderer here.
 */
const src = await Bun.file(new URL("../src/components/TriageBoard.tsx", import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");
const board = code(src);
const fn = (name: string) => {
  const at = board.indexOf(`function ${name}(`);
  expect(at).toBeGreaterThan(-1);
  const end = board.indexOf("\n}\n", at);
  return board.slice(at, end === -1 ? undefined : end + 2);
};

describe("person view shares the board's components", () => {
  test("there is exactly one lane-columns grid and one Closed list", () => {
    expect(board.match(/data-lane=\{l\.id\}/g)?.length).toBe(1);
    expect(board.match(/<ClosedList\b/g)?.length).toBe(1);
  });
  test("the person branches no longer draw a grid or sections of their own", () => {
    expect(board).not.toContain("data-person-section");
    expect(board).not.toContain("PersonSentinel");
    expect(board).not.toContain("PersonSkeleton");
    expect(board).not.toContain("repeat(auto-fill");
  });
  test("a person's open tab falls through to the lane columns, with the banner on top", () => {
    expect(board.match(/<PersonBanner\b/g)?.length).toBe(2);
  });
  test("a person's closed tab is the own closed view fed their sections", () => {
    expect(board).toMatch(/closedView = closedOfPerson[\s\S]{0,200}person\.closed!\.sections/);
  });
  test("the person view never writes the own board's saved folds or sorts", () => {
    expect(board).toContain("if (!viewer) setFoldedLanes(next)");
    expect(board).toContain("if (!viewer) setLaneSorts(next)");
  });
  test("no cleanup control is added by the person view", () => {
    expect(fn("TriageBoard")).not.toMatch(/Clean up|Cleanup/);
  });
});

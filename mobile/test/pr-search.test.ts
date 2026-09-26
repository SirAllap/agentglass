/*
 * The PR list's search box and its state chips.
 *
 * Two things went wrong before this existed: "All" asked the server for open
 * pull requests only, so a merged one could never be found from the phone; and
 * there was no way to type "#595" and land on it. The match is the desktop's,
 * lifted into shared/ so the two cannot drift; the state split is the phone's,
 * because the server only knows open / closed / all and "closed" includes
 * merged.
 */
import { describe, expect, test } from "bun:test";
import { prTextMatch } from "../../shared/prSearch.ts";
import { byState, stateQuery, type StateView } from "../src/model/prState.ts";

const pr = (over: Partial<Parameters<typeof prTextMatch>[0]> & { state?: "OPEN" | "CLOSED" | "MERGED" } = {}) => ({
  number: 595,
  title: "Fix the orbit dock alignment",
  author: "ada-lovelace",
  headRefName: "fix/orbit-dock",
  assignees: ["grace-h"],
  reviewers: [{ login: "linus-t" }],
  state: "OPEN" as const,
  ...over,
});

describe("prTextMatch", () => {
  test("empty and blank text match everything", () => {
    expect(prTextMatch(pr(), "")).toBe(true);
    expect(prTextMatch(pr(), "   ")).toBe(true);
  });
  test("title, number, author, branch, assignee and reviewer", () => {
    expect(prTextMatch(pr(), "dock")).toBe(true);
    expect(prTextMatch(pr(), "595")).toBe(true);
    expect(prTextMatch(pr(), "lovelace")).toBe(true);
    expect(prTextMatch(pr(), "fix/orbit")).toBe(true);
    expect(prTextMatch(pr(), "grace")).toBe(true);
    expect(prTextMatch(pr(), "linus")).toBe(true);
  });
  test("a leading # is the number, not part of the word", () => {
    expect(prTextMatch(pr(), "#595")).toBe(true);
    expect(prTextMatch(pr(), "#59")).toBe(true);
    expect(prTextMatch(pr({ number: 12 }), "#595")).toBe(false);
  });
  test("case-insensitive; a miss is a miss", () => {
    expect(prTextMatch(pr(), "ORBIT")).toBe(true);
    expect(prTextMatch(pr(), "nebula")).toBe(false);
  });
  test("a row with no assignees or reviewers does not throw", () => {
    const bare = { number: 1, title: "t", author: "a", headRefName: "b" } as Parameters<typeof prTextMatch>[0];
    expect(prTextMatch(bare, "zzz")).toBe(false);
  });
});

describe("state chips", () => {
  const rows = [
    pr({ number: 1, state: "OPEN" }),
    pr({ number: 2, state: "MERGED" }),
    pr({ number: 3, state: "CLOSED" }),
  ];
  test("what the server is asked", () => {
    const ask: Record<StateView, "open" | "closed" | "all"> = { open: "open", merged: "closed", closed: "closed", all: "all" };
    for (const v of Object.keys(ask) as StateView[]) expect(stateQuery(v)).toBe(ask[v]);
  });
  test("Merged and Closed are told apart on the phone", () => {
    expect(byState(rows, "merged").map((r) => r.number)).toEqual([2]);
    expect(byState(rows, "closed").map((r) => r.number)).toEqual([3]);
  });
  test("Open and All keep what they were given", () => {
    expect(byState(rows, "open").map((r) => r.number)).toEqual([1]);
    expect(byState(rows, "all").map((r) => r.number)).toEqual([1, 2, 3]);
  });
});

describe("the screen is wired to them", async () => {
  const src = await Bun.file(new URL("../app/(tabs)/prs.tsx", import.meta.url)).text();
  const code = src.split("\n").filter((l) => !/^\s*(\/\*|\*|\/\/)/.test(l)).join("\n");
  test("no request hard-codes state=open any more", () => {
    expect(code).not.toContain("state=open");
    expect(code.match(/state=\$\{stateQuery\(view\)\}/g)?.length).toBe(2);
  });
  test("the box filters with the shared match", () => {
    expect(code).toContain("prTextMatch(p, text)");
  });
});

// The Tasks view's bar and its "All" sections, and which checkout its GitHub
// block reads — the three decisions the component used to make inline.
//
// Every one of them failed the same way on a real screen: the settings said the
// landing was Jira and the order was Jira, ClickUp, Local, GitHub, and the view
// opened on All with tabs reading All, Local, ClickUp, Jira, GitHub. So these
// are asserted as data: the saved order is the bar's order, and the section
// order is the same order.
import { describe, expect, test } from "bun:test";
import type { GitRepoRef } from "../../shared/types.ts";
import { allSections, taskRepoRoot, taskTabs } from "../src/lib/taskView.ts";

const repo = (root: string, name: string, worktreeOf?: string): GitRepoRef =>
  ({ root, name, branch: "main", dirty: 0, ahead: 0, behind: 0, touchedAt: 0, worktreeOf });

describe("the tab bar", () => {
  test("follows the saved order, not the catalogue's", () => {
    expect(taskTabs(["jira", "clickup", "local", "github"]).map((t) => t.id))
      .toEqual(["all", "jira", "clickup", "local", "github"]);
  });

  test("keeps All leftmost, because it is a filter and not a source", () => {
    expect(taskTabs(["github", "local"])[0]).toEqual({ id: "all", label: "All" });
  });

  test("has no All when there is one thing to be all of", () => {
    expect(taskTabs(["jira"]).map((t) => t.id)).toEqual(["jira"]);
  });
});

describe("the sections under All", () => {
  test("are drawn in the saved order", () => {
    expect(allSections(["jira", "clickup", "local", "github"])).toEqual(["local", "github"]);
    expect(allSections(["jira", "github", "local"])).toEqual(["github", "local"]);
  });

  test("leave out a source this person switched off", () => {
    expect(allSections(["jira", "clickup"])).toEqual([]);
  });
});

describe("which checkout the GitHub block reads", () => {
  const orbit = repo("/home/acme/orbit", "orbit");
  const blog = repo("/home/someuser/blog", "blog");

  test("the open project's, not whichever checkout was touched last", () => {
    // blog is first: the server sorts by when it was last worked in, which is
    // not the question. The open project is acme/orbit.
    expect(taskRepoRoot([blog, orbit], ["/home/acme/orbit"]))
      .toEqual({ root: "/home/acme/orbit", note: null });
  });

  test("a worktree of the open project still answers for the project", () => {
    const tree = repo("/home/acme/orbit-ORBIT-1042", "orbit-ORBIT-1042", "/home/acme/orbit");
    expect(taskRepoRoot([tree], ["/home/acme/orbit"]).root).toBe("/home/acme/orbit-ORBIT-1042");
  });

  test("prefers the project's own checkout over a worktree", () => {
    const tree = repo("/home/acme/orbit-ORBIT-1042", "orbit-ORBIT-1042", "/home/acme/orbit");
    expect(taskRepoRoot([tree, orbit], ["/home/acme/orbit"]).root).toBe("/home/acme/orbit");
  });

  test("says which repo it shows and why when it cannot follow the project", () => {
    const pick = taskRepoRoot([blog], ["/home/acme/orbit"]);
    expect(pick.root).toBe("/home/someuser/blog");
    expect(pick.note ?? "").toContain("blog");
    expect(pick.note ?? "").toContain("/home/acme/orbit");
  });

  test("and when no project is open at all", () => {
    const pick = taskRepoRoot([blog, orbit], []);
    expect(pick.root).toBe("/home/someuser/blog");
    expect(pick.note ?? "").toContain("no project is open");
  });
});

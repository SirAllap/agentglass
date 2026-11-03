/*
 * The Open projects dialog is on every start: a slip in the new fourth row
 * would stop people adding any project at all. There is no renderer here, so
 * the rule is asserted against source — the three older rows keep their
 * labels and handlers, the new one sits second, and GitHub-only repositories
 * never reach the server's project list.
 */
import { describe, expect, it } from "bun:test";
import { ADD_ROWS, folderRoute } from "../src/lib/addRows";

const read = (f: string) => Bun.file(new URL(f, import.meta.url)).text();
const stripComments = (t: string) => t.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");

const code = stripComments(await read("../src/components/projects/ProjectsModal.tsx"));
const remoteSources = await Promise.all(
  ["../src/components/RemoteRepoPage.tsx", "../src/components/remoteRepoRows.tsx", "../src/lib/remoteRepos.ts"].map(async (f) => stripComments(await read(f))),
);

describe("the ADD rows", () => {
  it("offer the four routes, in order", () => {
    expect(ADD_ROWS.map((r) => [r.key, r.title])).toEqual([
      ["folder", "Folder…"], ["github", "GitHub repo"], ["clone", "Clone from URL"], ["new", "New project"],
    ]);
  });
  it("always offer the folder route: the chooser where there is one, a typed path where not (D1)", () => {
    expect(folderRoute(true)).toBe("chooser");
    expect(folderRoute(false)).toBe("typed");
    expect(ADD_ROWS.some((r) => r.key === "folder")).toBe(true);
  });
  it("are drawn from that list, and the folder row still browses", () => {
    expect(code).toContain("ADD_ROWS[(cmd.n ? cmd.n - 1 : addIndex)]");
    expect(code).toContain('if (k === "folder") {');
    expect(code).toContain('folderRoute(CAN_BROWSE_FOLDER) === "chooser"');
  });
});

describe("a GitHub-only repository", () => {
  it("is never written to the server's project list", () => {
    for (const t of remoteSources) expect(t).not.toMatch(/setProjectRoot|setWorkspaces/);
  });
  it("leaves the clone and create pages to their own modes", () => {
    expect(code).toContain("<CreatePane");
    expect(code).toContain("<RemoteRepoPage");
  });
});

describe("the screens use those decisions", () => {
  it("the PR panel picks through pickedRoot and never asks for a local repo first", async () => {
    const pr = stripComments(await read("../src/components/PrPanel.tsx"));
    const fn = pr.slice(pr.indexOf("const pickRoot = ("), pr.indexOf("const wantRemote"));
    expect(fn).toContain("pickedRoot(r, away,");
    expect(fn).not.toContain("&& repo)");
    const eff = pr.slice(pr.indexOf("wantedRemoteRoot(wantRemote)"), pr.indexOf("wantedRemoteRoot(wantRemote)") + 160);
    expect(eff).toContain("if (!target) return;");
  });
  it("the dialog draws the hero and the shelf through the two decisions", () => {
    expect(code).toContain("showFirstRunHero(isFirstRun, remotes.length)");
    expect(code).toContain("<GithubShelf");
  });
});

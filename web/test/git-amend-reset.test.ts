// Amend the last commit, and reset soft / mixed: the pure refusals, the doors
// that carry them, and the panel handlers that ask once.
import { describe, expect, it } from "bun:test";
import { amendRefusal } from "../../shared/gitAmend.ts";
import { dockActionsFor, toolbarFor, type DockAction } from "../src/lib/gitDock.ts";
import { actionsFor } from "../src/lib/gitActions.ts";
import { commitEffect, commitIds } from "../src/lib/commitActions.ts";

const panel = await Bun.file(new URL("../src/components/GitPanel.tsx", import.meta.url)).text();
const body = (head: string) => {
  const a = panel.indexOf(head); expect(a, head).toBeGreaterThan(-1);
  return panel.slice(a, panel.indexOf("\n  };\n", a));
};
const by = (l: DockAction[], id: string) => l.find((a) => a.id === id)!;
const one = { count: 1 };

describe("amendRefusal", () => {
  const ok = { detached: false, state: "clean", onRemote: false };
  it("allows a clean branch whose tip is only local", () => expect(amendRefusal(ok)).toBeUndefined());
  it("refuses when the tip is on a remote", () => expect(amendRefusal({ ...ok, onRemote: true })).toContain("already on a remote"));
  it("refuses on a detached HEAD", () => expect(amendRefusal({ ...ok, detached: true })).toContain("not on a branch"));
  it("refuses mid-operation and names it", () => expect(amendRefusal({ ...ok, state: "rebasing" })).toContain("rebasing"));
  it("refuses a repository with no commit", () => expect(amendRefusal({ ...ok, empty: true })).toContain("no commit"));
  it("speaks in plain sentences, with no git text", () => {
    for (const f of [{ ...ok, onRemote: true }, { ...ok, detached: true }, { ...ok, state: "merging" }])
      expect(amendRefusal(f)).not.toMatch(/fatal|error:|git /);
  });
});

describe("reset soft / mixed doors", () => {
  it("the row menu offers both, not red, beside the hard one", () => {
    const m = actionsFor("commit", "abc1234", { inLog: true });
    expect(m.find((a) => a.id === "reset-soft")).toMatchObject({ label: "Reset here, keep changes staged", command: "git reset --soft abc1234" });
    expect(m.find((a) => a.id === "reset-mixed")).toMatchObject({ label: "Reset here, keep changes unstaged", command: "git reset --mixed abc1234" });
    expect(m.find((a) => a.id === "reset-soft")!.danger).toBeUndefined();
    expect(m.find((a) => a.id === "reset-mixed")!.danger).toBeUndefined();
  });
  it("every commit id, the new ones included, has an effect", () => {
    expect(commitIds()).toEqual(expect.arrayContaining(["reset-soft", "reset-mixed"]));
    for (const id of commitIds()) expect(commitEffect(id), id).not.toBeNull();
  });
  it("the dock keeps them behind its Reset button in the Log and the Reflog, shut on a protected branch", () => {
    const menu = (t: "log" | "reflog", branch: string) => by(dockActionsFor(t, one, { branch, protectedBranches: ["main"] }).actions, "reset-hard").menu!;
    for (const t of ["log", "reflog"] as const) {
      expect(by(menu(t, "feature/login"), "reset-soft").disabled).toBeUndefined();
      const shut = menu(t, "main");
      for (const id of ["reset-soft", "reset-mixed"]) expect(by(shut, id)).toMatchObject({ disabled: true, reason: "main is protected: unprotect it in the Branches tab" });
    }
  });
  it("the panel sends each id to resetTo, which asks once and refuses a protected branch first", () => {
    const run = body("const runCommitAction = (");
    expect(run).toContain('case "reset-soft": return void resetTo(hash, "soft")');
    expect(run).toContain('case "reset-mixed": return void resetTo(hash, "mixed")');
    const reset = body("const resetTo = async (");
    expect(reset.match(/\bask\(/g)).toHaveLength(1);
    expect(reset.indexOf("protectedRefusal(")).toBeGreaterThan(-1);
    expect(reset.indexOf("protectedRefusal(")).toBeLessThan(reset.indexOf("await ask({"));
    expect(reset).toContain("danger: hard");
  });
});

describe("amend door", () => {
  it("is a toolbar door of Changes, always drawn, named for the act", () => {
    expect(toolbarFor("changes")).toMatchObject([{ id: "amend", label: "Amend last commit" }]);
    expect(toolbarFor("changes")[0].disabled).toBeUndefined();
  });
  it("is not a row action, so a file's menu never lists it", () => {
    expect(actionsFor("file", "a.txt", {}).map((a) => a.id)).not.toContain("amend");
  });
  it("the panel reads the refusal before it opens the box, and asks once before rewriting", () => {
    const start = body("const startAmend = async (");
    expect(start.indexOf("info.refusal")).toBeGreaterThan(-1);
    expect(start.indexOf("info.refusal")).toBeLessThan(start.indexOf("setAmend({"));
    const run = body("const doAmend = async (");
    expect(run.match(/\bask\(/g)).toHaveLength(1);
    expect(run).not.toContain("danger: true");
    expect(run).toContain("amend.hash");
    expect(run.indexOf("await ask({")).toBeLessThan(run.indexOf("api.gitAmendStaged("));
  });
});

// The server route reads a POST body; a GET to it answers "not found", the
// panel got no list and every protected-branch door stayed open.
describe("protected list request", () => {
  const api = Bun.file(new URL("../src/lib/api.ts", import.meta.url)).text();
  it("asks the server with a POST", async () => {
    const line = (await api).split("\n").find((l) => l.includes("gitProtectedBranches:") && l.includes("/git/protected-branches\""))!;
    expect(line).not.toBeUndefined();
    expect(line).toContain("post<");
  });
});

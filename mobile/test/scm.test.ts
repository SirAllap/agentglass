/*
 * The Branches and Stash views of Source control on the phone.
 *
 * The decisions live in model/scm.ts so they can be asserted without a
 * renderer; the screen is read as source for the wiring that has no other
 * test.
 */
import { describe, expect, test } from "bun:test";
import type { GitBranch } from "../../shared/types.ts";
import { keepOrder, newBranchProblem, orderBranches, scmSuccessText, stashTitle, trackWords, VIEWS } from "../src/model/scm.ts";

const repos = await Bun.file(new URL("../app/(tabs)/repos.tsx", import.meta.url)).text();

const branch = (name: string, current = false): GitBranch => ({
  name, current, upstream: null, track: "", date: "2 days ago", subject: "wip",
});

describe("trackWords", () => {
  test("ahead and behind become arrows", () => {
    expect(trackWords("[ahead 4, behind 53]")).toBe("↑4 ↓53");
    expect(trackWords("[ahead 1]")).toBe("↑1");
    expect(trackWords("[behind 2]")).toBe("↓2");
  });
  test("gone says gone, empty says nothing", () => {
    expect(trackWords("[gone]")).toBe("upstream gone");
    expect(trackWords("")).toBe("");
  });
});

describe("orderBranches", () => {
  test("the current branch first, the rest in the order git gave", () => {
    const out = orderBranches([branch("a"), branch("b", true), branch("c")]);
    expect(out.map((b) => b.name)).toEqual(["b", "a", "c"]);
  });
  test("no current branch (detached) keeps the order", () => {
    expect(orderBranches([branch("a"), branch("b")]).map((b) => b.name)).toEqual(["a", "b"]);
  });
});

describe("newBranchProblem", () => {
  const have = [branch("main", true), branch("feat/search")];
  test("a fine name is no problem", () => {
    expect(newBranchProblem("feat/orbit-1042", have)).toBeNull();
  });
  test("empty, spaces, dots and a leading dash are refused with a reason", () => {
    expect(newBranchProblem("", have)).toBe("Type a name.");
    expect(newBranchProblem("two words", have)).not.toBeNull();
    expect(newBranchProblem("a..b", have)).not.toBeNull();
    expect(newBranchProblem("-x", have)).not.toBeNull();
    expect(newBranchProblem("x/", have)).not.toBeNull();
    expect(newBranchProblem("x.lock", have)).not.toBeNull();
  });
  test("an existing name is refused, trimmed", () => {
    expect(newBranchProblem(" main ", have)).toBe("A branch called main already exists.");
  });
});

describe("stashTitle", () => {
  test("drops the WIP/On prefix and keeps the branch as a tag", () => {
    expect(stashTitle("WIP on feat/search: 1a2b3c4 add box")).toEqual({ title: "add box", branch: "feat/search" });
    expect(stashTitle("On main: half-done thing")).toEqual({ title: "half-done thing", branch: "main" });
  });
  test("a message without the prefix is the title", () => {
    expect(stashTitle("just words")).toEqual({ title: "just words", branch: null });
  });
});

describe("the views", () => {
  test("five, in reading order", () => {
    expect(VIEWS.map((v) => v.id)).toEqual(["changes", "log", "branches", "stash", "pr"]);
  });
});

describe("the screen, read", () => {
  test("branches and stashes come from the routes the desktop uses", () => {
    expect(repos).toContain("/git/branches?root=");
    expect(repos).toContain("/git/stashes?root=");
    expect(repos).toContain('"/git/checkout"');
    expect(repos).toContain('"/git/branch-create"');
    expect(repos).toContain('"/git/stash-apply"');
  });
  test("writes wait for the full scope", () => {
    expect(repos).toMatch(/mayWrite/);
  });
  test("no stash-drop, no branch-delete: those are left for later", () => {
    expect(repos).not.toContain("/git/stash-drop");
    expect(repos).not.toContain("/git/branch-delete");
  });
  test("the commit footer rises above the keyboard rather than under it", () => {
    // The footer is a flex sibling of the file list, not inside a Modal, so a
    // screen-level KeyboardAvoidingView (unlike Sheet's) does reach it.
    expect(repos).toContain("<KeyboardAvoidingView");
    expect(repos).toContain('behavior="padding"');
  });
  test("the avoider counts the header it sits under", () => {
    // Without the offset the padding came out one header short and the
    // footer stopped just under the keyboard's top edge on the emulator.
    expect(repos).toContain("keyboardVerticalOffset={headerHeight}");
    expect(repos).toContain("const headerHeight = useHeaderHeight();");
  });
  test("a write that lands says so, not just a write that fails", () => {
    // `said` used to be set on failure and cleared to null on success — the
    // commit footer's only feedback was silence. `ok: true` is what makes the
    // same line that shows an error show a landed write instead.
    expect(repos).toContain("setSaid(text ? { ok: true, text } : null)");
    expect(repos).toContain('void act("push", "/git/push", { root }, { branch: repo?.branch });');
  });
});

describe("scmSuccessText", () => {
  // Push, Commit, stash Apply and branch Switch used to clear `said` on
  // success and say nothing — the one write that leaves the machine (Push)
  // included. This is the line that goes there instead.
  test("commit counts the files, singular and plural", () => {
    expect(scmSuccessText("/git/commit-staged", { files: 1 })).toBe("Committed 1 file");
    expect(scmSuccessText("/git/commit-staged", { files: 2 })).toBe("Committed 2 files");
  });
  test("push names the branch it went to, or says nothing more than Pushed", () => {
    expect(scmSuccessText("/git/push", { branch: "feat/orbit-1042" })).toBe("Pushed feat/orbit-1042 to origin");
    expect(scmSuccessText("/git/push", {})).toBe("Pushed to origin");
  });
  test("stash apply names the slot", () => {
    expect(scmSuccessText("/git/stash-apply", { index: 0 })).toBe("Applied stash@{0}");
  });
  test("checkout names where it landed", () => {
    expect(scmSuccessText("/git/checkout", { branch: "main" })).toBe("Switched to main");
  });
  test("a write nobody asked a success line for gets none", () => {
    expect(scmSuccessText("/git/stage", {})).toBeNull();
  });
});

describe("keepOrder", () => {
  const r = (root: string) => ({ root });
  test("the order the person was looking at survives a refresh", () => {
    const out = keepOrder([r("a"), r("b"), r("c")], [r("c"), r("a"), r("b")]);
    expect(out.map((x) => x.root)).toEqual(["a", "b", "c"]);
  });
  test("a new checkout goes last, a gone one is dropped", () => {
    const out = keepOrder([r("a"), r("b")], [r("n"), r("b")]);
    expect(out.map((x) => x.root)).toEqual(["b", "n"]);
  });
});

// The Branches, Remotes and Tags tabs: what the dock acts on, the one sentence
// of an error frame, and the "is it on the remote" chip.
import { describe, expect, it } from "bun:test";
import { protectedRefusal, BUSY_REASON, actionsFor } from "../src/lib/gitActions.ts";
import { inkOver } from "../src/components/git/ui.tsx";
import { frameSentence, failToast, branchSelection, remoteSelection, tagSelection, tagOriginChip, tagFormPlan, notHereFirst, type BranchPick } from "../src/lib/gitG4.ts";
import { plainGitError } from "../src/lib/gitActions.ts";
import { dockActionsFor } from "../src/lib/gitDock.ts";

const pick = (name: string, o: Partial<BranchPick> = {}): BranchPick =>
  ({ name, isCurrent: false, held: false, ahead: 0, behind: 0, hasUpstream: true, ...o });
const all: Record<string, BranchPick> = {
  main: pick("main", { isCurrent: true, ahead: 2 }),
  "review/pr-1042": pick("review/pr-1042", { held: true }),
  "spike/pdf-render": pick("spike/pdf-render", { hasUpstream: false }),
};
const by = (n: string) => all[n];

describe("frameSentence", () => {
  it("names the remote when it cannot be reached, and never shows git's own line", () => {
    const raw = "ssh: Could not resolve hostname git.acme.internal\nfatal: Could not read from remote repository.";
    expect(frameSentence(raw, "upstream")).toBe("Could not reach upstream.");
    expect(frameSentence(raw)).not.toContain("hostname");
  });
  it("names a held lock instead of echoing git's line", () => {
    const s = frameSentence("fatal: Unable to create '.git/refs/heads/feat.lock': File exists.");
    expect(s).toBe("Another git process holds the lock. The list refreshes by itself when it lets go.");
  });
  it("says what git refused in one sentence without the raw suffix", () => {
    const s = frameSentence("error: the branch 'x' is not fully merged\nerror: run 'git branch -D x'");
    expect(s.startsWith("git refused: ")).toBe(true);
    expect(s).not.toContain("(");
  });
  it("falls back to one neutral sentence", () => {
    expect(frameSentence("boom")).toBe("Something went wrong. Try again.");
  });
});

describe("plainGitError plainOnly", () => {
  it("keeps the raw suffix by default and drops it when asked", () => {
    const raw = "error: the branch 'x' is not fully merged";
    expect(plainGitError(raw)).toContain("(");
    expect(plainGitError(raw, true)).not.toContain("(");
  });
});

describe("branch dock selection", () => {
  it("is empty with nothing under the cursor", () => {
    expect(branchSelection([], undefined, by).count).toBe(0);
  });
  it("draws Push and Pull for the current branch only (F6)", () => {
    const cur = dockActionsFor("branches", branchSelection([], all.main, by)).actions.map((a) => a.id);
    expect(cur).toContain("push");
    expect(cur).toContain("pull");
    const other = dockActionsFor("branches", branchSelection([], all["spike/pdf-render"], by)).actions.map((a) => a.id);
    expect(other).not.toContain("push");
  });
  it("a held branch offers Remove worktree & delete, not a plain delete (F7)", () => {
    const ids = dockActionsFor("branches", branchSelection([], all["review/pr-1042"], by)).actions.map((a) => a.id);
    expect(ids).toContain("branch-remove-and-delete");
    expect(ids).not.toContain("delete");
  });
  it("several ticked make one bulk dock that names the held ones (F8)", () => {
    const sel = branchSelection(["main", "spike/pdf-render"], undefined, by);
    expect(sel.count).toBe(2);
    expect(sel.heldNames).toEqual(["main"]);
    const del = dockActionsFor("branches", sel).actions.find((a) => a.id === "delete");
    expect(del?.chip).toBe("2 branches");
    expect(del?.title).toBe("main\nspike/pdf-render");
  });
  it("one ticked row wins over the cursor", () => {
    expect(branchSelection(["spike/pdf-render"], all.main, by).name).toBe("spike/pdf-render");
  });
  it("a protected branch cannot be force-deleted from the dock (F4)", () => {
    const d = dockActionsFor("branches", branchSelection([], all["spike/pdf-render"], by), { protectedBranches: ["spike/pdf-render"] });
    expect(d.actions.find((a) => a.id === "delete")?.disabled).toBe(true);
  });
});

describe("remotes and tags selection", () => {
  const rb = { name: "main", ref: "origin/main", hash: "a", subject: "", author: "", date: "", local: true, tracking: true };
  it("a remote branch with a local copy offers the switch", () => {
    const ids = dockActionsFor("remotes", remoteSelection(rb, "/r")).actions.map((a) => a.id);
    expect(ids).toContain("checkout-local");
  });
  it("a worktree on the same checkout is not 'held elsewhere'", () => {
    expect(remoteSelection({ ...rb, worktree: "/r" }, "/r").branchHeld).toBe(false);
    expect(remoteSelection({ ...rb, worktree: "/other" }, "/r").branchHeld).toBe(true);
  });
  it("a tag that is only here cannot be deleted on the remote", () => {
    const t = { name: "v1.2.0-rc.1", subject: "", date: "", hash: "", annotated: false };
    const d = dockActionsFor("tags", tagSelection(t, { name: t.name, onOrigin: "no" }));
    const menu = d.actions.find((a) => a.id === "delete-menu")?.menu ?? [];
    expect(menu.find((a) => a.id === "delete-remote")?.disabled).toBe(true);
    expect(menu.find((a) => a.id === "delete")?.disabled).toBeFalsy();
  });
  it("origin chip: none without a remote, unknown after a failure", () => {
    expect(tagOriginChip(undefined)).toBeNull();
    expect(tagOriginChip({ name: "v1", onOrigin: "unknown" })?.label).toBe("origin unknown");
    expect(tagOriginChip({ name: "v1", onOrigin: "yes", remote: "upstream" })?.label).toBe("on upstream");
    expect(tagOriginChip({ name: "v1", onOrigin: "no" })?.label).toBe("only here");
  });
});

describe("the inline tag form", () => {
  it("an empty message is lightweight, a typed one annotated", () => {
    expect(tagFormPlan("v1.3.0", "  ", [])).toMatchObject({ ok: true, annotated: false, message: "" });
    expect(tagFormPlan("v1.3.0", "Release", [])).toMatchObject({ ok: true, annotated: true, message: "Release" });
  });
  it("refuses an empty, duplicate or malformed name before git does", () => {
    expect(tagFormPlan("", "", []).ok).toBe(false);
    expect(tagFormPlan("v1", "", ["v1"]).reason).toContain("already exists");
    for (const bad of ["a b", "a..b", "-x", "x.lock", "a~1", "a/"]) expect(tagFormPlan(bad, "", []).ok).toBe(false);
  });
});

describe("remote branches order", () => {
  it("puts the ones not here yet first, keeping order inside each group", () => {
    const rows = [{ n: 1, local: true }, { n: 2, local: false }, { n: 3, local: false, worktree: "/w" }, { n: 4, local: false }];
    expect(notHereFirst(rows).map((r) => r.n)).toEqual([2, 4, 1, 3]);
  });
});

describe("failToast", () => {
  const raw = "error: could not write index\nhint: fix it\n";
  it("says one plain sentence on a G4 tab and never git's line", () => {
    for (const v of ["branches", "remotes", "tags", "submodules", "worktrees", "stashes", "tidy"]) {
      const s = failToast(v, raw);
      expect(s).not.toContain("hint");
      expect(s).toBe("git refused: could not write index.");
    }
    expect(failToast("remotes", "fatal: unable to access 'https://x.test/a.git/': Could not resolve host", "upstream")).toBe("Could not reach upstream.");
    expect(failToast("tags", "boom")).toBe("Something went wrong. Try again.");
  });
  it("leaves the other tabs on git's first line", () => {
    expect(failToast("changes", raw)).toBe("could not write index");
  });
});

describe("one refusal for every door (F4, F7)", () => {
  it("names the first protected branch of a batch, and none when none is", () => {
    expect(protectedRefusal(["main", "release"], ["x", "release", "main"])).toBe("release is protected");
    expect(protectedRefusal(["main"], ["x"])).toBeUndefined();
  });
  it("the row menu says a busy worktree is why Remove worktree & delete will not run", () => {
    const label = (busy: boolean) => actionsFor("branch", "feature/x", { elsewhere: true, busy }).find((a) => a.id === "branch-remove-and-delete")?.label;
    expect(label(true)).toContain(BUSY_REASON.toLowerCase());
    expect(label(false)).toBe("Remove worktree & delete…");
  });
});

describe("inkOver", () => {
  it("is the tone's ink pulled toward the theme text, never a new colour", () => {
    expect(inkOver("--success")).toBe("color-mix(in srgb, var(--success-ink) 70%, var(--text))");
  });
});

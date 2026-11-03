// Every question the Git panel asks is drawn by GitDialog, and each one is
// reached from the id the menu really offers. No renderer here, so the rules
// are asserted against source, per the house style.
import { describe, expect, it } from "bun:test";
import { actionsFor, type GitKind } from "../src/lib/gitActions.ts";
import { commitIds } from "../src/lib/commitActions.ts";
import { LAYER } from "../src/lib/layers.ts";

const src = (p: string) => Bun.file(new URL(`../src/components/${p}`, import.meta.url)).text();
const FRAMED = ["GitPanel.tsx", "ConflictMode.tsx", "RescueModal.tsx", "CompareModal.tsx", "RebaseModal.tsx", "BisectModal.tsx", "BlameModal.tsx", "InsightsModal.tsx"];
const files = Object.fromEntries(await Promise.all(FRAMED.map(async (f) => [f, await src(f)] as const)));
const frame = await src("GitDialog.tsx");
const panel = files["GitPanel.tsx"]!;

// Comment lines are not code: "a fixed width" in prose must not trip the scan.
const COMMENT = /^\s*(\/\/|\*|\/\*)/;
const code = (t: string) => t.split("\n").filter((l) => !COMMENT.test(l)).join("\n");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\"]/g, "\\$&");
const idsOf = (kind: GitKind) => (kind === "commit" ? commitIds() : actionsFor(kind, "x", { inLog: true }).map((a) => a.id));
const handlerBody = (name: string) => {
  const a = panel.indexOf(`const ${name} = async (`);
  expect(a, `${name} is not defined as an async handler`).toBeGreaterThan(-1);
  return panel.slice(a, panel.indexOf("\n  };", a));
};

describe("one frame, one overlay", () => {
  for (const f of FRAMED) {
    it(`${f} draws no overlay of its own`, () => {
      const t = code(files[f]!);
      for (const bad of ['position: "fixed"', "fixed inset-0", "createPortal", "Portal", 'role="dialog"', 'role="alertdialog"']) {
        expect(t.includes(bad), `${f} contains ${bad}`).toBe(false);
      }
    });
  }
  it("GitDialog is the place that does, on its own layer", () => {
    expect(frame).toContain('role="dialog"');
    expect(frame).toContain("<Portal z={LAYER.gitDialog}>");
    expect(LAYER.gitDialog).toBe(10160);
  });
  it("the panel no longer imports the old ConfirmDialog", () => {
    expect(panel).not.toContain("ConfirmDialog");
    expect(panel).toContain("useGitDialogs");
  });
  it("the modals are drawn in GitDialog", () => {
    for (const f of ["RescueModal.tsx", "CompareModal.tsx", "RebaseModal.tsx", "BisectModal.tsx", "BlameModal.tsx", "InsightsModal.tsx"]) {
      expect(files[f]).toContain("<GitDialog");
    }
  });
});

describe("a dialog opens from the handler id the menu offers", () => {
  // [what, kind, id, handler the panel dispatches to, how it asks]
  const doors: [string, GitKind, string, string, string][] = [
    ["discard a file", "file", "discard", "discard", "ask("],
    ["drop a stash", "stash", "drop", "stashOp", "ask("],
    ["apply a stash over the tree", "stash", "overwrite", "stashOverwrite", "ask("],
    ["rename a stash", "stash", "rename", "stashRename", "askText("],
    ["turn a stash into a branch", "stash", "to-branch", "stashToBranch", "askText("],
    ["remove a worktree", "worktree", "remove", "removeWorktree", "ask("],
    ["delete a branch", "branch", "delete", "deleteBranch", "ask("],
    ["rename a branch", "branch", "rename", "renameBranch", "askText("],
    ["merge a branch", "branch", "merge", "mergeBranch", "ask("],
    ["rebase onto a branch", "branch", "rebase", "rebaseBranch", "ask("],
    ["delete a tag", "tag", "delete", "tagDeleteAsk", "ask("],
    ["delete a tag on the remote", "tag", "delete-remote", "tagDeleteRemoteAsk", "ask("],
    ["revert a commit", "commit", "revert", "revertOne", "ask("],
    ["hard reset to a commit", "commit", "reset-hard", "resetTo", "ask("],
  ];
  for (const [what, kind, id, handler, asks] of doors) {
    it(`${what}: ${kind}:${id}`, () => {
      expect(idsOf(kind)).toContain(id);
      expect(panel).toMatch(new RegExp(`case "${esc(id)}":[^\\n]*${esc(handler)}\\(`));
      expect(handlerBody(handler), `${handler} never asks`).toContain(asks);
    });
  }

  it("branch from a commit: commit:branch-here asks for a name", () => {
    expect(commitIds()).toContain("branch-here");
    expect(panel).toMatch(/case "branch-here"[\s\S]{0,200}askText\(\{ title: `New branch from/);
  });

  const modals: [string, GitKind, string, string, string, string][] = [
    ["compare", "branch", "compare", "compare", "setCompareTarget(", "<CompareModal"],
    ["rebase from a commit", "commit", "rebase-from-here", "rebase", "setRebaseBase(", "<RebaseModal"],
    ["bisect from a commit", "commit", "bisect-from-here", "bisect", "setBisectOpen(true)", "<BisectModal"],
    ["blame a file", "file", "blame", "blame", "setBlamePath(", "<BlameModal"],
  ];
  for (const [what, kind, offered, handled, setter, tag] of modals) {
    it(`${what}: ${kind}:${offered} mounts its modal`, () => {
      expect(idsOf(kind)).toContain(offered);
      // Commit rows are dispatched through commitEffect(), whose ids are shorter.
      expect(panel).toMatch(new RegExp(`case "${esc(handled)}":[^\\n]*${esc(setter)}`));
      expect(panel).toContain(tag);
    });
  }

  it("the rescue step is reached by removing a worktree and is a GitDialog", () => {
    expect(panel).toContain("<RescueModal");
    expect(panel).toContain("rescueThenRemoveWorktrees(");
  });
  it("the conflict screen's Continue asks through the panel's own ask", () => {
    expect(files["ConflictMode.tsx"]).toContain("Continue the rebase?");
    expect(panel).toMatch(/<ConflictMode[\s\S]{0,600}ask=\{ask\}/);
  });
  it("New tag opens the inline form, which replaced the dialog", () => {
    expect(panel).toContain("<TagForm");
    expect(panel).not.toContain("askTag");
  });
  it("Insights opens from its button", () => {
    expect(panel).toContain("<InsightsModal");
    expect(panel).toContain("setInsightsOpen(true)");
  });
});

describe("a destructive confirm asks once", () => {
  it("every danger action reaches a handler that asks with danger: true", () => {
    const kinds: GitKind[] = ["file", "stash", "worktree", "tag", "branch"];
    expect(kinds.flatMap((k) => actionsFor(k, "x", {}).filter((a) => a.danger).map((a) => `${k}:${a.id}`)).sort())
      .toEqual(["branch:delete", "file:discard", "stash:drop", "stash:overwrite", "tag:delete", "tag:delete-remote", "worktree:remove"]);
    for (const h of ["discard", "removeWorktree", "deleteBranch", "tagDeleteAsk", "tagDeleteRemoteAsk", "stashOverwrite", "revertOne", "resetTo"]) {
      expect(handlerBody(h), h).toContain(h === "resetTo" ? "danger: hard" : "danger: true");
    }
  });
  it("the stash drop handler is the one that holds the danger flag", () => {
    expect(handlerBody("stashOp")).toContain("danger: true");
  });
  it("the menu and the palette add no second confirmation", async () => {
    const menu = await src("GitRowMenu.tsx");
    const palette = await src("GitPalette.tsx");
    expect(menu).not.toContain("Yes, run it");
    expect(palette).not.toContain("Press again");
    expect(panel).not.toContain("menuConfirmed");
  });
});

describe("a step that is running cannot be closed under itself", () => {
  const bodyOf = (t: string, from: string) => { const a = t.indexOf(from); expect(a, from).toBeGreaterThan(-1); return t.slice(a); };
  it("GitDialog turns Escape, the scrim and the X into no-ops while locked", () => {
    const c = code(frame);
    expect(c).toContain("const locked = !!(p.locked ?? p.working)");
    expect(c).toMatch(/if \(!live\.current\.locked[^)]*\) live\.current\.onClose\(\)|const close = /);
    expect(c).not.toMatch(/onClick=\{p\.onClose\}/);
    expect(c).not.toMatch(/live\.current\.onClose\(\);\s*return;\s*\}\s*if \(e\.key !== "Enter"/);
  });
  it("the key listener stops other listeners and asks which dialog owns the key", () => {
    const c = code(frame);
    expect(c).toContain("stopImmediatePropagation");
    expect(c).toContain("dialogKeyScope(");
  });
  it("Rebase and Bisect lock the dialog while their request is in flight", () => {
    expect(code(files["RebaseModal.tsx"]!)).toContain("locked={busy}");
    expect(code(files["BisectModal.tsx"]!)).toContain("locked={busy}");
  });
  it("Rescue's working step locks through `working`", () => {
    const r = code(files["RescueModal.tsx"]!);
    expect(r).toContain("working={working");
  });
});

describe("the delete-branch preview does not promise less than the flow does", () => {
  it("the first ask names no single command, because a worktree or a force can follow", () => {
    const h = handlerBody("deleteBranch");
    const first = h.slice(0, h.indexOf("setBusy(true)"));
    expect(first).not.toContain("git branch -d");
    expect(first).not.toContain("command:");
  });
});

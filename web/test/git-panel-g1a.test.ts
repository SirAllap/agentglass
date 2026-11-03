// The Git panel's dead and wrong-target controls. No renderer here, so each
// decision is a function asserted directly; the two rendering ones are
// asserted against source, per the house style.
import { describe, expect, it } from "bun:test";
import { actionsFor, primaryAction, paletteEntries } from "../src/lib/gitActions.ts";
import { commitEffect, commitIds } from "../src/lib/commitActions.ts";
import { orderPicked, isRunToTip } from "../src/lib/orderPicked.ts";
import { initialOtherFor } from "../src/lib/compareSeed.ts";
import { stashDetailTarget } from "../src/lib/stashDetail.ts";

const src = (p: string) => Bun.file(new URL(p, import.meta.url)).text();
const panel = await src("../src/components/GitPanel.tsx");
const lines = await src("../src/components/diff/DiffLines.tsx");
const fnBody = (text: string, head: string): string => {
  const a = text.indexOf(head); expect(a).toBeGreaterThan(-1);
  const open = text.indexOf("{", text.indexOf(")", a));
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(a, i + 1);
  }
  throw new Error("unclosed");
};

describe("one commit handler for both tabs", () => {
  it("every id the commit menu can offer has an effect", () => {
    const ids = commitIds();
    expect(ids).toContain("reset-hard");
    for (const id of ids) expect(commitEffect(id), id).not.toBeNull();
  });
  it("an unknown id has none", () => expect(commitEffect("nope")).toBeNull());
  it("Log and Reflog both call runCommitAction and nothing else", () => {
    expect(panel).toContain("run: runCommitAction,");
    expect(panel).toContain("runCommitAction(id, e.shortHash, e.subject)");
    expect(panel).not.toContain("setCommitMenu");
  });
  it("reset and revert ask once, in the handler: the menu does not ask first", () => {
    const menu = actionsFor("commit", "abc1234", { inLog: true }).find((a) => a.id === "reset-hard")!;
    expect(menu.danger).toBe(true);
    const run = fnBody(panel, "const runCommitAction = (");
    expect(run).toContain('resetTo(hash, "hard")');
    expect(run).not.toContain('"hard", true');
    const reset = fnBody(panel, "const resetTo = async (");
    expect(reset).toContain("await ask({");
    expect(reset).toContain("git reset --${mode}");
    expect(reset).toContain("danger: hard");
    const revert = fnBody(panel, "const revertOne = async (");
    expect(revert).toContain("await ask({");
    expect(revert).toContain("git revert");
  });
});

describe("cherry-pick from a row", () => {
  it("passes the row's own hash, not the pick set it has just queued a change to", () => {
    expect(fnBody(panel, "const cherryPickOne = async (")).toContain("runCherryPick(noCommit, [hash])");
  });
});

describe("rebase and bisect doors", () => {
  const ids = (s = {}) => actionsFor("commit", "abc1234", s).map((a) => a.id);
  it("only the Log row passes inLog", () => {
    expect(ids({ inLog: true })).toEqual(expect.arrayContaining(["rebase-from-here", "bisect-from-here"]));
    expect(ids()).not.toContain("rebase-from-here");
    expect(ids()).not.toContain("bisect-from-here");
    expect(primaryAction("commit", "abc1234", {})?.id).not.toMatch(/-from-here$/);
    for (const e of paletteEntries([{ kind: "commit", name: "abc1234" }])) expect(e.action.id).not.toMatch(/-from-here/);
  });
  it("the Log rows pass it, the Reflog rows do not", async () => {
    const lists = await src("../src/components/git/Lists.tsx");
    const log = fnBody(lists, "export function commitRows(");
    const reflog = fnBody(lists, "export function reflogRows(");
    expect(log).toContain("inLog: true");
    expect(reflog).not.toContain("inLog");
  });
});

describe("orderPicked", () => {
  const log = ["h0", "h1", "h2", "h3"];
  it("tip clicked first or second gives the same order", () => {
    expect(orderPicked(["h0", "h1"], log)).toEqual(["h0", "h1"]);
    expect(orderPicked(["h1", "h0"], log)).toEqual(["h0", "h1"]);
  });
  it("a gap is not a run to the tip", () => {
    const o = orderPicked(["h2", "h0"], log)!;
    expect(o).toEqual(["h0", "h2"]);
    expect(isRunToTip(o, log)).toBe(false);
    expect(isRunToTip(["h0", "h1"], log)).toBe(true);
    expect(isRunToTip(["h1", "h2"], log)).toBe(false); // not at the tip
  });
  it("a hash outside the loaded log refuses", () => expect(orderPicked(["h0", "zz"], log)).toBeNull());
});

describe("initialOtherFor", () => {
  const refs = ["main", "feature", "v1"];
  it("picks the current branch", () => expect(initialOtherFor("main", "v1", refs)).toBe("main"));
  it("ignores detached HEAD, itself, and a name not in refs", () => {
    expect(initialOtherFor("", "v1", refs)).toBeNull();
    expect(initialOtherFor(undefined, "v1", refs)).toBeNull();
    expect(initialOtherFor("main", "main", refs)).toBeNull();
    expect(initialOtherFor("HEAD", "v1", refs)).toBeNull();
  });
});

describe("compare modal", () => {
  it("seeds from initialOther inside the refs-loaded effect, and sends @worktree", async () => {
    const m = await src("../src/components/CompareModal.tsx");
    expect(m).toContain("initialOtherFor(initialOther, base, refs)");
    expect(m).toContain('"@worktree"');
    expect(m).toContain("disabled={toTree}");
  });
  it("the Log and Reflog compare opens against the working tree", () => {
    expect(fnBody(panel, "const runCommitAction = (")).toContain('setCompareAgainst("worktree")');
  });
});

describe("stash show", () => {
  it("opens the stash's commit, not its ref", () => {
    expect(stashDetailTarget({ ref: "stash@{0}", message: "wip", hash: "a1b2c3d" })).toEqual({ hash: "a1b2c3d", title: "stash@{0} · wip" });
    expect(stashDetailTarget({ ref: "stash@{0}", message: "wip" })).toBeNull();
  });
  it("the handler uses it", () => expect(panel).toContain("stashDetailTarget(s)"));
});

describe("fetch from a remote", () => {
  it("the menu command matches what runs, and the panel names the remote", () => {
    expect(actionsFor("remote", "o1")[0].command).toBe("git fetch --prune --atomic o1");
    expect(panel).toContain("api.gitFetch(root, r.name)");
  });
});

describe("split diff hunk buttons", () => {
  it("SplitDiff takes hunkAction and draws it on the hunk header, wrapped or not", () => {
    const split = fnBody(lines, "export function SplitDiff(");
    expect(split).toContain("hunkAction");
    // One set of buttons per hunk: the right column of the scrolling layout and
    // the header of the wrapped grid. The left header keeps its height without a copy.
    expect(split.match(/hunkAction\(hi\)/g)!.length).toBe(2);
    expect(split).toContain('hunkAction && which === "r"');
    expect(panel).toContain("<SplitDiff c={selected} wrap={wrap} hunkAction={hunkActionFn} />");
  });
});

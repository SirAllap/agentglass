// The dock under Changes, Log and Reflog: what each tab offers for what is
// picked, and why a button is shut. Pure functions, asserted directly.
import { describe, expect, it } from "bun:test";
import { dockActionsFor, dockTarget, hunkActionsFor, reflogEnableArgv, reflogOff, type DockAction } from "../src/lib/gitDock.ts";
import { actionsFor } from "../src/lib/gitActions.ts";
import { protectedList } from "../../shared/gitProtected.ts";
import { pickNumbers } from "../src/lib/orderPicked.ts";

const ids = (l: DockAction[]) => l.map((a) => a.id);
const by = (l: DockAction[], id: string) => l.find((a) => a.id === id)!;
const all = (d: { actions: DockAction[]; more: DockAction[] }) => [...d.actions, ...d.more];
const one = { count: 1 };
const main = { branch: "main" };

describe("dock: Changes", () => {
  it("an unstaged file offers Stage, blame, copy path and Discard, never Unstage", () => {
    const d = dockActionsFor("changes", { count: 1, path: "src/a.ts" }, main);
    expect(ids(d.actions)).toEqual(["stage", "blame", "copy-path", "discard"]);
    expect(by(d.actions, "discard").kind).toBe("danger");
    expect(by(d.actions, "stage").kind).toBe("primary");
    expect(d.more).toEqual([]);
    expect(all(d).some((a) => a.disabled)).toBe(false);
  });
  it("a staged file offers Unstage, blame and copy path, no Stage and no Discard", () => {
    const d = dockActionsFor("changes", { count: 1, staged: true }, main);
    expect(ids(d.actions)).toEqual(["unstage", "blame", "copy-path"]);
  });
  it("an untracked file's Discard tooltip names what is deleted", () => {
    const d = dockActionsFor("changes", { count: 1, untracked: true, path: "notes.txt" }, main);
    expect(by(d.actions, "discard").title).toBe("delete notes.txt");
    expect(by(dockActionsFor("changes", one, main).actions, "discard").title).toBeUndefined();
  });
  it("nothing picked shuts every button with 'Pick a file first'", () => {
    const d = dockActionsFor("changes", { count: 0 }, main);
    for (const a of d.actions) expect([a.id, a.disabled, a.reason]).toEqual([a.id, true, "Pick a file first"]);
  });
  it("several picked keeps Stage and Discard, shuts blame and copy path with 'Pick one'", () => {
    const d = dockActionsFor("changes", { count: 3 }, main);
    expect(by(d.actions, "stage").disabled).toBeUndefined();
    expect(by(d.actions, "discard").disabled).toBeUndefined();
    expect(by(d.actions, "blame")).toMatchObject({ disabled: true, reason: "Pick one" });
    expect(by(d.actions, "copy-path")).toMatchObject({ disabled: true, reason: "Pick one" });
  });
  it("a dirty tree or a detached HEAD changes nothing here", () => {
    const base = dockActionsFor("changes", one, main);
    expect(dockActionsFor("changes", one, { dirty: true, detached: true })).toEqual(base);
  });
});

describe("dock: Log", () => {
  it("on a branch: Show, Compare, New branch, Cherry-pick, Revert, Reset, with More holding the rest", () => {
    const d = dockActionsFor("log", one, main);
    expect(ids(d.actions)).toEqual(["show", "compare", "branch-here", "cherry-pick", "revert", "reset-hard"]);
    expect(ids(d.more)).toEqual(["rebase-from-here", "bisect-from-here", "cherry-pick-stage", "copy-sha"]);
    expect(by(d.actions, "reset-hard")).toMatchObject({ kind: "danger", label: "Reset main to here", chip: "main" });
    // The softer resets are not in More (the approved menu has none); they are the Reset button's own choice.
    expect(ids(by(d.actions, "reset-hard").menu!)).toEqual(["reset-hard", "reset-mixed", "reset-soft"]);
    expect(by(d.actions, "cherry-pick")).toMatchObject({ label: "Cherry-pick onto main", chip: "main" });
    expect(all(d).some((a) => a.disabled)).toBe(false);
  });
  it("nothing picked shuts every button with 'Pick one first'", () => {
    for (const a of all(dockActionsFor("log", { count: 0 }, main))) expect([a.id, a.reason]).toEqual([a.id, "Pick one first"]);
  });
  it("several picked leaves only the cherry-picks open; the rest say 'Pick one'", () => {
    const d = dockActionsFor("log", { count: 2 }, main);
    const open = all(d).filter((a) => !a.disabled).map((a) => a.id);
    expect(open).toEqual(["cherry-pick", "cherry-pick-stage"]);
    expect(by(d.actions, "revert").reason).toBe("Pick one");
  });
  it("a detached HEAD names HEAD, not a branch, on the branch-moving buttons", () => {
    const d = dockActionsFor("log", one, { detached: true, branch: "main" });
    expect(by(d.actions, "reset-hard")).toMatchObject({ label: "Reset HEAD to here", chip: "HEAD" });
    expect(by(d.actions, "cherry-pick").chip).toBe("HEAD");
  });
  it("a dirty tree shuts Cherry-pick and Revert only, with the reason", () => {
    const d = dockActionsFor("log", one, { dirty: true, branch: "main" });
    const shut = all(d).filter((a) => a.disabled);
    expect(ids(shut)).toEqual(["cherry-pick", "revert"]);
    for (const a of shut) expect(a.reason).toBe("Commit or stash your changes first");
  });
  it("Rebase from here has a door in More", () => {
    expect(ids(dockActionsFor("log", one, main).more)).toContain("rebase-from-here");
  });
  it("a branch that is not known yet leaves the label whole and no chip", () => {
    const a = by(dockActionsFor("log", one).actions, "reset-hard");
    expect(a.chip).toBeUndefined();
    expect(a.label).toBe("Reset this branch to here");
  });
});

describe("dock: Reflog", () => {
  it("on a branch: the Log's buttons, without Rebase or Bisect", () => {
    const d = dockActionsFor("reflog", one, main);
    expect(ids(d.actions)).toEqual(["show", "compare", "branch-here", "cherry-pick", "revert", "reset-hard"]);
    expect(ids(d.more)).toEqual(["cherry-pick-stage", "copy-sha"]);
  });
  it("nothing picked shuts every button with 'Pick an entry first'", () => {
    for (const a of all(dockActionsFor("reflog", { count: 0 }, main))) expect(a.reason).toBe("Pick an entry first");
  });
  it("several picked say 'Pick one' on the single-only buttons", () => {
    const d = dockActionsFor("reflog", { count: 2 }, main);
    expect(by(d.actions, "branch-here")).toMatchObject({ disabled: true, reason: "Pick one" });
  });
  it("a detached HEAD names HEAD on Reset", () => {
    expect(by(dockActionsFor("reflog", one, { detached: true }).actions, "reset-hard").chip).toBe("HEAD");
  });
  it("a dirty tree shuts Cherry-pick and Revert", () => {
    const d = dockActionsFor("reflog", one, { dirty: true });
    expect(ids(all(d).filter((a) => a.disabled))).toEqual(["cherry-pick", "revert"]);
  });
});

describe("dock: catalogue", () => {
  it("every id in the dock is an id the catalogue offers for that kind of row", () => {
    const file = [...actionsFor("file", "a", {}), ...actionsFor("file", "a", { merged: true })].map((a) => a.id);
    const commit = actionsFor("commit", "abc1234", { inLog: true }).map((a) => a.id);
    for (const a of all(dockActionsFor("changes", one))) expect(file).toContain(a.id);
    for (const a of all(dockActionsFor("changes", { count: 1, staged: true }))) expect(file).toContain(a.id);
    for (const t of ["log", "reflog"] as const) for (const a of all(dockActionsFor(t, one))) expect(commit).toContain(a.id);
  });
});

describe("hunk buttons", () => {
  it("an unstaged hunk offers Stage and Discard; a staged one only Unstage", () => {
    expect(ids(hunkActionsFor(false))).toEqual(["stage-hunk", "discard-hunk"]);
    expect(ids(hunkActionsFor(true))).toEqual(["unstage-hunk"]);
  });
});

describe("pick badges", () => {
  it("are numbered oldest first, in the order the commits will be applied", () => {
    const log = ["h0", "h1", "h2", "h3"]; // newest first
    const n = pickNumbers(["h0", "h2", "h3"], log)!;
    expect([n.get("h3"), n.get("h2"), n.get("h0")]).toEqual([1, 2, 3]);
    expect(pickNumbers(["h2", "h3", "h0"], log)).toEqual(n);
  });
  it("give nothing when a pick is not in the loaded log", () => {
    expect(pickNumbers(["zz"], ["h0"])).toBeNull();
  });
});

describe("reflog switch", () => {
  it("the argv is fixed", () => {
    expect(reflogEnableArgv()).toEqual(["config", "core.logAllRefUpdates", "true"]);
  });
  it("is off only when git prints false; unset, true and other spellings are not", () => {
    expect(reflogOff("false\n")).toBe(true);
    expect(reflogOff("")).toBe(false);
    expect(reflogOff("true\n")).toBe(false);
    expect(reflogOff("always\n")).toBe(false);
  });
});

describe("dock: protected branch", () => {
  const prot = { branch: "main", protectedBranches: ["main", "master"] };
  it("shuts Reset on a protected branch in the Log and the Reflog, with the reason", () => {
    for (const t of ["log", "reflog"] as const) {
      expect(by(dockActionsFor(t, one, prot).actions, "reset-hard")).toMatchObject({ disabled: true, reason: "main is protected: unprotect it in the Branches tab" });
      expect(by(dockActionsFor(t, one, prot).actions, "revert").disabled).toBeUndefined();
    }
  });
  it("leaves it open on other branches, on a detached HEAD, and while the list is unknown", () => {
    expect(by(dockActionsFor("log", one, { ...prot, branch: "feature/login" }).actions, "reset-hard").disabled).toBeUndefined();
    expect(by(dockActionsFor("log", one, { ...prot, detached: true }).actions, "reset-hard").disabled).toBeUndefined();
    expect(by(dockActionsFor("log", one, main).actions, "reset-hard").disabled).toBeUndefined();
  });
  it("follows the same list as the server: main and master always, plus the configured names", () => {
    const list = protectedList("release/1, staging\n");
    expect(list).toEqual(["main", "master", "release/1", "staging"]);
    expect(by(dockActionsFor("log", one, { branch: "staging", protectedBranches: list }).actions, "reset-hard").disabled).toBe(true);
  });
});

describe("dock: target of the Log", () => {
  const rows = [{ hash: "a1" }, { hash: "b2" }, { hash: "c3" }];
  it("one picked commit wins over the cursor", () => {
    expect(dockTarget(rows, new Set(["c3"]), rows[0])).toBe(rows[2]);
  });
  it("nothing picked or several picked follows the cursor", () => {
    expect(dockTarget(rows, new Set(), rows[1])).toBe(rows[1]);
    expect(dockTarget(rows, new Set(["a1", "c3"]), rows[1])).toBe(rows[1]);
  });
  it("a pick that is not loaded falls back to the cursor", () => {
    expect(dockTarget(rows, new Set(["zz"]), rows[1])).toBe(rows[1]);
  });
});

/*
 * The rule that replaced 86 buttons.
 *
 * Two things are worth locking down here, and neither needs a panel rendered:
 *
 *  1. WHICH action is primary, because that is the one that gets a button and
 *     the one a person will hit without reading. Getting it wrong on a branch
 *     whose remote is gone means offering "switch" where the useful answer is
 *     "delete", and getting it wrong the other way means offering a destructive
 *     button on an ordinary branch.
 *  2. That destructive actions are LAST and in their own group, whatever the
 *     kind. A menu that puts "Delete" between "Compare" and "Copy" is a menu
 *     that gets misclicked, and the ordering is easy to break by appending one
 *     action in the wrong place.
 */
import { test, expect } from "bun:test";
import { actionsFor, primaryAction, grouped, paletteEntries, matchPalette } from "../src/lib/gitActions.ts";

test("the branch you are on offers no row action at all", () => {
  expect(primaryAction("branch", "main", { current: true })).toBeNull();
  const ids = actionsFor("branch", "main", { current: true }).map((a) => a.id);
  expect(ids).not.toContain("delete");
  expect(ids).not.toContain("checkout");
});

test("an ordinary branch offers the switch", () => {
  expect(primaryAction("branch", "feat/x", {})?.id).toBe("checkout");
});

test("a branch checked out elsewhere offers its worktree, because git refuses the switch", () => {
  expect(primaryAction("branch", "feat/x", { elsewhere: true })?.id).toBe("open-worktree");
});

test("gone AND merged is the tidy-up case, and only then is the primary action destructive", () => {
  expect(primaryAction("branch", "feat/x", { gone: true, merged: true })?.id).toBe("delete");
  expect(primaryAction("branch", "feat/x", { gone: true, merged: true })?.danger).toBe(true);
  // Gone but NOT merged still has commits nobody else has. Not a chore.
  expect(primaryAction("branch", "feat/x", { gone: true })?.id).toBe("checkout");
});

test("push and pull are offered only on the branch you are standing on", () => {
  // `git push` with no refspec pushes HEAD, so a row you are not on cannot
  // honestly offer it — the switch is what that row is for.
  const away = actionsFor("branch", "feat/x", { upstream: true, ahead: 3, behind: 2 }).map((a) => a.id);
  expect(away).not.toContain("push");
  expect(away).not.toContain("pull");
  expect(primaryAction("branch", "feat/x", { upstream: true, ahead: 3 })?.id).toBe("checkout");

  const here = actionsFor("branch", "main", { current: true, upstream: true, ahead: 3, behind: 2 }).map((a) => a.id);
  expect(here).toContain("push");
  expect(here).toContain("pull");
});

test("delete uses -d when it is safe and -D when it is not", () => {
  const risky = actionsFor("branch", "feat/x", {}).find((a) => a.id === "delete");
  const safe = actionsFor("branch", "feat/x", { merged: true }).find((a) => a.id === "delete");
  expect(risky?.command).toContain("branch -D");
  expect(safe?.command).toContain("branch -d");
});

test("a name that would not survive a paste is quoted in the shown command", () => {
  const a = actionsFor("branch", "feat/it's here", {}).find((x) => x.id === "delete");
  expect(a?.command).toBe(`git branch -D 'feat/it'\\''s here'`);
});

test("every kind puts its destructive actions last and alone", () => {
  const kinds = ["branch", "tag", "stash", "worktree", "remote", "commit"] as const;
  for (const k of kinds) {
    const groups = grouped(actionsFor(k, "thing", { upstream: true, ahead: 1 }));
    const danger = groups.filter((g) => g.some((a) => a.danger));
    expect(danger.length).toBeLessThanOrEqual(1);
    if (danger.length) {
      expect(groups[groups.length - 1]).toBe(danger[0]);
      // Nothing harmless hides inside the red group except the rename that
      // sits with it deliberately.
      for (const a of danger[0]) expect(a.danger || a.id === "rename").toBe(true);
    }
  }
});

test("a stash offers apply before pop before drop — least destructive first", () => {
  const ids = actionsFor("stash", "stash@{0}").map((a) => a.id);
  expect(ids.indexOf("apply")).toBeLessThan(ids.indexOf("pop"));
  expect(ids.indexOf("pop")).toBeLessThan(ids.indexOf("drop"));
});

test("a busy worktree says so in the label rather than hiding the action", () => {
  const a = actionsFor("worktree", "/w/x", { busy: true }).find((x) => x.id === "remove");
  expect(a?.label).toContain("running inside");
  expect(a?.danger).toBe(true);
});

test("the palette matches action and object together, in any word order", () => {
  const entries = paletteEntries([
    { kind: "branch", name: "feat/git-super-tool", state: { gone: true } },
    { kind: "branch", name: "main", state: { current: true } },
  ]);
  const hits = matchPalette(entries, "delete super");
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0].name).toBe("feat/git-super-tool");
  expect(matchPalette(entries, "super delete").map((h) => h.action.id))
    .toEqual(hits.map((h) => h.action.id));
});

test("the palette cannot offer an action the row does not have", () => {
  const entries = paletteEntries([{ kind: "branch", name: "main", state: { current: true } }]);
  expect(matchPalette(entries, "delete")).toHaveLength(0);
});

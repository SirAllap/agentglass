// The dock under Branches, Remotes, Tags, Submodules, Worktrees and Stashes:
// what each offers for what is picked, and why a button is shut. Pure
// functions; the fixtures are invented repos (acme/orbit).
import { describe, expect, it } from "bun:test";
import {
  DOCK_TABS, TAB_KIND, bulkDeleteView, dockActionsFor, toolbarFor,
  type DockAction, type DockRepoState, type DockSelection, type DockTab,
} from "../src/lib/gitDock.ts";
import { TOOLBAR, actionsFor, type GitKind, type GitRowState } from "../src/lib/gitActions.ts";

const flat = (l: DockAction[]): DockAction[] => l.flatMap((a) => [a, ...flat(a.menu ?? [])]);
const all = (d: { actions: DockAction[]; more: DockAction[] }) => flat([...d.actions, ...d.more]);
const ids = (l: DockAction[]) => l.map((a) => a.id);
const by = (d: { actions: DockAction[]; more: DockAction[] }, id: string) => all(d).find((a) => a.id === id)!;
const dock = (t: DockTab, s: Partial<DockSelection>, r: DockRepoState = { branch: "main" }) =>
  dockActionsFor(t, { count: 1, ...s }, r);
const shut = (d: { actions: DockAction[]; more: DockAction[] }) => ids(all(d).filter((a) => a.disabled));

const TABS: DockTab[] = ["branches", "remotes", "tags", "submodules", "worktrees", "stashes"];

describe("dock G4: every tab has its own case", () => {
  it("lists the nine tabs, each answering for nothing picked with its own noun", () => {
    expect(DOCK_TABS).toHaveLength(9);
    const reasons = DOCK_TABS.map((t) => all(dockActionsFor(t, { count: 0 }, {}))[0]!.reason);
    expect(reasons).toEqual([
      "Pick a file first", "Pick one first", "Pick an entry first", "Pick a branch first", "Pick a remote first",
      "Pick a tag first", "Pick a submodule first", "Pick a worktree first", "Pick a stash first",
    ]);
  });
  it("shuts every button of every tab when nothing is picked, except the toolbar doors", () => {
    for (const t of DOCK_TABS) {
      const d = dockActionsFor(t, { count: 0 }, { branch: "main" });
      expect(all(d).every((a) => a.disabled)).toBe(true);
    }
    for (const t of TABS) for (const a of toolbarFor(t)) expect(a.disabled).toBeUndefined();
  });
  it("no tab borrows another's buttons", () => {
    const seen = TABS.map((t) => ids(all(dock(t, {}))).join());
    expect(new Set(seen).size).toBe(TABS.length);
  });
});

describe("dock G4: Branches", () => {
  it("another branch: Switch, Merge, Rebase, Compare, Delete…, with More holding the rest", () => {
    const d = dock("branches", { name: "feat/search" });
    expect(ids(d.actions)).toEqual(["checkout", "merge", "rebase", "compare", "delete"]);
    expect(ids(d.more)).toEqual(["worktree-new", "open-web", "copy-name", "rename"]);
    expect(by(d, "checkout").kind).toBe("primary");
    expect(by(d, "delete").kind).toBe("danger");
    expect(by(d, "merge").chip).toBe("main");
    expect(shut(d)).toEqual([]);
  });
  it("the current branch draws Push and Pull, enabled by ahead and behind", () => {
    const d = dock("branches", { name: "main", isCurrent: true, upstream: true, ahead: 2, behind: 1 });
    expect(ids(d.actions)).toEqual(["push", "pull", "worktree-new", "open-web", "copy-name"]);
    expect(by(d, "push").label).toBe("Push 2");
    expect(by(d, "pull").label).toBe("Pull 1");
    expect(shut(d)).toEqual([]);
  });
  it("the current branch in sync says why Push and Pull are shut", () => {
    const d = dock("branches", { name: "main", isCurrent: true, upstream: true, ahead: 0, behind: 0 });
    expect(by(d, "push").reason).toBe("Nothing to push");
    expect(by(d, "pull").reason).toBe("Up to date");
  });
  it("the current branch with no upstream offers Publish instead of Push", () => {
    const d = dock("branches", { name: "spike/pdf", isCurrent: true, upstream: false, ahead: 0 });
    expect(ids(d.actions).slice(0, 2)).toEqual(["publish", "pull"]);
    expect(by(d, "publish").disabled).toBeUndefined();
  });
  it("Push, Pull and Delete are not drawn on the current branch, and Push and Pull not on others", () => {
    const cur = dock("branches", { name: "main", isCurrent: true });
    expect(ids(all(cur))).not.toContain("delete");
    const other = dock("branches", { name: "feat/x", ahead: 3, behind: 3, upstream: true });
    expect(ids(all(other))).not.toContain("push");
    expect(ids(all(other))).not.toContain("pull");
  });
  it("a branch held by a worktree opens it and offers Remove worktree & delete… instead of Delete", () => {
    const d = dock("branches", { name: "review/pr-1042", branchHeld: true });
    expect(ids(d.actions)).toEqual(["open-worktree", "merge", "rebase", "compare", "branch-remove-and-delete"]);
    expect(by(d, "branch-remove-and-delete").kind).toBe("danger");
    expect(shut(d)).toEqual([]);
  });
  it("a process in the worktree shuts Remove & delete with the reason", () => {
    const d = dock("branches", { name: "review/pr-1042", branchHeld: true, busy: true });
    expect(by(d, "branch-remove-and-delete").reason).toBe("A process is running in it");
  });
  it("a protected branch shuts Delete, Rename and Remove & delete, each with the reason", () => {
    const repo = { branch: "feat/x", protectedBranches: ["main", "master"] };
    const plain = dock("branches", { name: "main" }, repo);
    expect(shut(plain)).toEqual(["delete", "rename"]);
    expect(by(plain, "delete").reason).toBe("main is protected");
    expect(by(plain, "rename").reason).toBe("main is protected");
    const held = dock("branches", { name: "main", branchHeld: true }, repo);
    expect(by(held, "branch-remove-and-delete").reason).toBe("main is protected");
  });
  it("an unknown protected list shuts nothing; another name is open", () => {
    expect(shut(dock("branches", { name: "main" }, { branch: "x" }))).toEqual([]);
    expect(shut(dock("branches", { name: "feat/a" }, { branch: "x", protectedBranches: ["main"] }))).toEqual([]);
  });
  it("a dirty tree shuts Rebase only; a detached HEAD names HEAD on the chips", () => {
    expect(shut(dock("branches", { name: "feat/a" }, { branch: "main", dirty: true }))).toEqual(["rebase"]);
    const d = dock("branches", { name: "feat/a" }, { detached: true, branch: "main" });
    expect(by(d, "merge").chip).toBe("HEAD");
    expect(by(d, "merge").label).toBe("Merge into HEAD");
  });
  it("several picked: Copy the names, Clear and a Delete chip 'N branches' that lists the names", () => {
    const d = dock("branches", { count: 3, names: ["a/1", "b/2", "c/3"] });
    expect(ids(d.actions)).toEqual(["copy-name", "clear", "delete"]);
    expect(by(d, "copy-name").label).toBe("Copy the names");
    const del = by(d, "delete");
    expect(del.chip).toBe("3 branches");
    expect(del.label).toBe("Delete 3 branches…");
    expect(del.title).toBe("a/1\nb/2\nc/3");
    expect(del.disabled).toBeUndefined();
  });
  it("bulk delete is shut when a picked name is protected, or when none can go", () => {
    const repo = { branch: "x", protectedBranches: ["main"] };
    expect(by(dock("branches", { count: 2, names: ["main", "a"] }, repo), "delete").reason).toBe("main is protected");
    const held = dock("branches", { count: 2, names: ["a", "b"], heldNames: ["a", "b"] }, repo);
    expect(by(held, "delete").reason).toBe("None of them can be deleted");
  });
  it("the bulk dialog groups the held names under Cannot delete and keeps every name", () => {
    const names = Array.from({ length: 12 }, (_, i) => `feat/n${i}`);
    const v = bulkDeleteView(names, ["feat/n3", "feat/n9"]);
    expect(v.chip).toBe("12 branches");
    expect(v.title.split("\n")).toEqual(names);
    expect(v.cannot).toEqual(["feat/n3", "feat/n9"]);
    expect(v.can).toHaveLength(10);
    expect(bulkDeleteView(["a"]).chip).toBe("1 branch");
    expect(bulkDeleteView(["a", "b"]).cannot).toEqual([]);
  });
});

describe("dock G4: Remotes", () => {
  it("a branch not here yet: bring it local, bring and switch, own folder, Compare, Copy", () => {
    const d = dock("remotes", {});
    expect(ids(d.actions)).toEqual(["bring-local", "checkout", "worktree", "compare", "copy-name"]);
    expect(by(d, "bring-local").kind).toBe("primary");
    expect(by(d, "compare").chip).toBe("main");
  });
  it("one that has a local copy switches to it", () => {
    expect(ids(dock("remotes", { localCopy: true }).actions)).toEqual(["checkout-local", "compare", "copy-name"]);
  });
  it("one held by a worktree opens it, even when a local copy exists", () => {
    expect(ids(dock("remotes", { branchHeld: true, localCopy: true }).actions)).toEqual(["open-worktree", "compare", "copy-name"]);
  });
  it("detached HEAD compares with HEAD", () => {
    expect(by(dock("remotes", {}, { detached: true }), "compare").label).toBe("Compare with HEAD");
  });
  it("several picked: single-only buttons say Pick one", () => {
    const d = dock("remotes", { count: 2 });
    expect(shut(d)).toEqual(ids(d.actions));
    expect(by(d, "compare").reason).toBe("Pick one");
  });
  it("the remote itself has toolbar doors that need no selection", () => {
    const t = toolbarFor("remotes", "origin");
    expect(t.map((a) => [a.id, a.label])).toEqual([["remote-fetch", "Fetch from origin"], ["remote-copy-url", "Copy the URL"]]);
  });
});

describe("dock G4: Tags", () => {
  it("Check out, Compare, Push, Copy the name, Delete… with the sha under More", () => {
    const d = dock("tags", { name: "v1.2.0", tagOnOrigin: "no" });
    expect(ids(d.actions)).toEqual(["checkout", "compare", "push", "copy-name", "delete-menu"]);
    expect(ids(d.more)).toEqual(["copy-sha"]);
    expect(ids(by(d, "delete-menu").menu!)).toEqual(["delete", "delete-remote"]);
    expect(shut(d)).toEqual(["delete-remote"]);
  });
  it("a tag on origin cannot be pushed again; deleting it there is open", () => {
    const d = dock("tags", { tagOnOrigin: "yes" });
    expect(shut(d)).toEqual(["push"]);
    expect(by(d, "push").reason).toBe("Already on origin");
  });
  it("origin unknown (a remote did not answer) shuts nothing", () => {
    expect(shut(dock("tags", { tagOnOrigin: "unknown" }))).toEqual([]);
    expect(shut(dock("tags", {}))).toEqual([]);
  });
  it("only here: Delete on the remote too says why it is shut", () => {
    expect(by(dock("tags", { tagOnOrigin: "no" }), "delete-remote").reason).toBe("It is only here");
  });
  it("several picked shuts everything but nothing is deletable in bulk", () => {
    expect(all(dock("tags", { count: 2 })).every((a) => a.disabled || a.menu)).toBe(true);
    expect(by(dock("tags", { count: 2 }), "delete").reason).toBe("Pick one");
  });
  it("New tag and New lightweight tag are toolbar doors", () => {
    expect(toolbarFor("tags").map((a) => a.id)).toEqual(["tag-create", "tag-create-light"]);
  });
});

describe("dock G4: Submodules", () => {
  it("Update, Sync, Copy, then Unregister and Remove… in red", () => {
    const d = dock("submodules", { name: "vendor/ui-kit" });
    expect(ids(d.actions)).toEqual(["update", "submodule-sync", "copy-path", "submodule-deinit", "submodule-remove"]);
    expect(by(d, "update").kind).toBe("primary");
    expect(d.actions.filter((a) => a.kind === "danger").map((a) => a.id)).toEqual(["submodule-deinit", "submodule-remove"]);
    expect(shut(d)).toEqual([]);
  });
  it("several picked shuts all, nothing picked says Pick a submodule first", () => {
    expect(shut(dock("submodules", { count: 2 }))).toHaveLength(5);
    expect(by(dock("submodules", { count: 0 }), "update").reason).toBe("Pick a submodule first");
  });
  it("a dirty tree or detached HEAD changes nothing", () => {
    expect(shut(dock("submodules", {}, { dirty: true, detached: true }))).toEqual([]);
  });
  it("Add a submodule and Open .gitmodules are toolbar doors", () => {
    expect(toolbarFor("submodules").map((a) => a.id)).toEqual(["submodule-add", "submodule-open-gitmodules"]);
  });
});

describe("dock G4: Worktrees", () => {
  it("another worktree: Open, Copy the path, Remove this worktree", () => {
    const d = dock("worktrees", { name: "~/code/orbit-review" });
    expect(ids(d.actions)).toEqual(["open", "copy-path", "remove"]);
    expect(by(d, "remove").label).toBe("Remove this worktree");
    expect(shut(d)).toEqual([]);
  });
  it("something running inside shuts Remove and Remove anyway, with the reason", () => {
    const r = by(dock("worktrees", { busy: true }), "remove");
    expect(r.disabled).toBe(true);
    expect(r.reason).toBe("A process is running in it");
    expect(by(dock("worktrees", { busy: true, worktreeSubmoduleRefused: true }), "worktree-force-remove").reason).toBe("A process is running in it");
  });
  it("a locked worktree adds Unlock and shuts Remove until it is unlocked", () => {
    const d = dock("worktrees", { worktreeLocked: true });
    expect(ids(d.actions)).toEqual(["open", "worktree-unlock", "copy-path", "remove"]);
    expect(by(d, "remove").reason).toBe("Unlock it first");
    expect(ids(dock("worktrees", {}).actions)).not.toContain("worktree-unlock");
  });
  it("the worktree you are in cannot be opened or removed", () => {
    const d = dock("worktrees", { isCurrent: true });
    expect(shut(d)).toEqual(["open", "remove"]);
    expect(by(d, "open").reason).toBe("You are in it");
  });
  it("after git refused on a submodule, Remove anyway replaces Remove; before it, never", () => {
    const d = dock("worktrees", { worktreeSubmoduleRefused: true });
    expect(ids(d.actions)).toEqual(["open", "copy-path", "worktree-force-remove"]);
    expect(by(d, "worktree-force-remove").kind).toBe("danger");
    expect(ids(all(dock("worktrees", {})))).not.toContain("worktree-force-remove");
  });
  it("a locked worktree that git also refused keeps Remove anyway shut", () => {
    expect(by(dock("worktrees", { worktreeSubmoduleRefused: true, worktreeLocked: true }), "worktree-force-remove").reason).toBe("Unlock it first");
  });
});

describe("dock G4: Stashes", () => {
  it("Apply, Apply and remove, To a branch, Show, Drop…, with Rename, files and Overwrite under More", () => {
    const d = dock("stashes", { name: "stash@{0}" });
    expect(ids(d.actions)).toEqual(["apply", "pop", "to-branch", "show", "drop"]);
    expect(ids(d.more)).toEqual(["rename", "stash-files", "overwrite"]);
    expect(by(d, "apply").kind).toBe("primary");
    expect(by(d, "drop").kind).toBe("danger");
    expect(by(d, "overwrite").kind).toBe("danger");
    expect(shut(d)).toEqual([]);
  });
  it("Resolve and Put my tree back appear only on a clash, and Apply stops being primary", () => {
    expect(ids(all(dock("stashes", {})))).not.toContain("stash-resolve");
    const d = dock("stashes", { stashClash: true });
    expect(ids(d.actions).slice(0, 2)).toEqual(["stash-resolve", "stash-put-back"]);
    expect(by(d, "stash-resolve").kind).toBe("primary");
    expect(by(d, "apply").kind).toBe("normal");
    expect(by(d, "stash-resolve").disabled).toBeUndefined();
  });
  it("on a clash, applying again waits for the conflict; Drop stays open", () => {
    const d = dock("stashes", { stashClash: true });
    expect(shut(d)).toEqual(["apply", "pop", "to-branch", "overwrite"]);
    expect(by(d, "apply").reason).toBe("Resolve the conflict first");
  });
  it("several picked says Pick one on every button", () => {
    const d = dock("stashes", { count: 2 });
    expect(all(d).every((a) => a.disabled && a.reason === "Pick one")).toBe(true);
  });
  it("a dirty tree or detached HEAD shuts nothing", () => {
    expect(shut(dock("stashes", {}, { dirty: true, detached: true }))).toEqual([]);
  });
});

// ---------------------------------------------------------------- catalogue --

// The ids each tab owns. A new id in the catalogue must be added here, and a
// deleted one (from the catalogue, the dock or the row menu) turns this red.
const CATALOGUE: Record<Exclude<DockTab, "changes" | "log" | "reflog">, string[]> = {
  branches: ["checkout", "open-worktree", "worktree-new", "compare", "merge", "rebase", "push", "publish", "pull", "open-web", "copy-name", "rename", "delete", "branch-remove-and-delete"],
  remotes: ["fetch", "copy-url", "remote-fetch", "remote-copy-url"],
  tags: ["checkout", "compare", "push", "copy-name", "copy-sha", "delete", "delete-remote", "tag-create", "tag-create-light"],
  submodules: ["update", "submodule-sync", "copy-path", "submodule-deinit", "submodule-remove", "submodule-add", "submodule-open-gitmodules"],
  worktrees: ["open", "copy-path", "remove", "worktree-unlock", "worktree-force-remove"],
  stashes: ["apply", "pop", "to-branch", "show", "stash-files", "rename", "overwrite", "drop", "stash-resolve", "stash-put-back"],
};

/** Every state a row can be in, so the union is every id the catalogue can offer. */
const STATES: GitRowState[] = [
  {}, { current: true }, { elsewhere: true }, { merged: true, gone: true }, { current: true, upstream: true, ahead: 1, behind: 1 },
  { busy: true }, { locked: true }, { submoduleRefused: true }, { clash: true },
];
const menuIds = (kind: GitKind, name: string) =>
  new Set(STATES.flatMap((s) => actionsFor(kind, name, s).map((a) => a.id)));

/** Every id a dock can draw, over a battery of selections. */
function dockIds(tab: DockTab): Set<string> {
  const sels: Partial<DockSelection>[] = [
    {}, { isCurrent: true, upstream: true, ahead: 1, behind: 1 }, { isCurrent: true, upstream: false },
    { branchHeld: true }, { localCopy: true }, { count: 2, names: ["a", "b"] },
    { worktreeLocked: true }, { worktreeSubmoduleRefused: true }, { stashClash: true }, { staged: true },
  ];
  const out = new Set<string>();
  for (const s of sels) for (const a of all(dockActionsFor(tab, { count: 1, ...s }, { branch: "main" }))) out.add(a.id);
  for (const a of toolbarFor(tab)) out.add(a.id);
  return out;
}

// Reached by the remote's row menu, which has no dock: the toolbar doors do the same job.
const MENU_ONLY: Partial<Record<DockTab, string[]>> = { remotes: ["fetch", "copy-url"] };

describe("dock G4: catalogue", () => {
  for (const tab of Object.keys(CATALOGUE) as (keyof typeof CATALOGUE)[]) {
    it(`${tab}: every catalogue id is in the dock rules or in the row menu`, () => {
      const dockSet = dockIds(tab);
      const menu = menuIds(tab === "remotes" ? "remote" : TAB_KIND[tab], "x");
      for (const id of CATALOGUE[tab]) {
        if (MENU_ONLY[tab]?.includes(id)) expect(menu.has(id)).toBe(true);
        else expect(dockSet.has(id)).toBe(true);
      }
    });
    it(`${tab}: every catalogue id is still in gitActions.ts (row menu or toolbar)`, () => {
      const kinds = tab === "remotes" ? (["remote", "remote-branch"] as const) : ([TAB_KIND[tab]] as const);
      const have = new Set<string>([...kinds.flatMap((k) => [...menuIds(k, "x")]),
        ...(TOOLBAR[tab === "remotes" ? "remote" : TAB_KIND[tab]] ?? []).map((a) => a.id)]);
      for (const id of CATALOGUE[tab]) expect(have.has(id)).toBe(true);
    });
    it(`${tab}: every id the dock draws is one the catalogue lists`, () => {
      const rowKind = new Set(menuIds(TAB_KIND[tab], "x"));
      for (const id of dockIds(tab)) {
        if (id === "clear" || id === "delete-menu") continue;
        expect(CATALOGUE[tab].includes(id) || (tab === "remotes" && rowKind.has(id))).toBe(true);
      }
    });
  }
  it("the catalogue offers no id the table above forgot", () => {
    for (const tab of Object.keys(CATALOGUE) as (keyof typeof CATALOGUE)[]) {
      const kinds = tab === "remotes" ? (["remote", "remote-branch"] as const) : ([TAB_KIND[tab]] as const);
      for (const k of kinds) for (const id of menuIds(k, "x")) {
        // remote-branch rows share ids with other kinds; only the remote kind is the tab's own.
        if (k === "remote-branch") continue;
        expect(CATALOGUE[tab]).toContain(id);
      }
      for (const a of TOOLBAR[TAB_KIND[tab] === "remote-branch" ? "remote" : TAB_KIND[tab]] ?? []) expect(CATALOGUE[tab]).toContain(a.id);
    }
  });
  it("the 15 ids of the G4 catalogue exist", () => {
    const g4 = ["tag-create", "tag-create-light", "submodule-add", "submodule-sync", "submodule-deinit", "submodule-remove",
      "submodule-open-gitmodules", "worktree-unlock", "worktree-force-remove", "stash-resolve", "stash-put-back", "stash-files",
      "remote-fetch", "remote-copy-url", "branch-remove-and-delete"];
    const have = new Set(TABS.flatMap((t) => [...dockIds(t)]));
    for (const id of g4) expect(have.has(id)).toBe(true);
    expect(g4).toHaveLength(15);
  });
});

describe("Tags tab list follows the search", () => {
  it("pages the filtered tags, not all of them", async () => {
    const panel = await Bun.file(new URL("../src/components/GitPanel.tsx", import.meta.url)).text();
    // With the unfiltered list paged, "0 of 3" sat over three rows and the dock acted on a hidden tag.
    expect(panel).toContain("useIncremental(shownTags,");
    expect(panel).not.toContain("useIncremental(tags,");
  });
});

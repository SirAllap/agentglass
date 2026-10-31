// The dock under the Changes, Log and Reflog tabs: which buttons it shows for
// what is selected, in what order, and which ones are shut and why. Ids come
// from the shared catalogue (gitActions.ts); the label, icon, kind and order
// per tab live here. The server stays the authority, so "enabled" only means
// "not obviously refused".
import { reflogEnableArgv, reflogOff } from "../../../shared/gitReflog.ts";

import { isProtectedBranch } from "../../../shared/gitProtected.ts";

export { reflogEnableArgv, reflogOff };

import { TOOLBAR, protectedRefusal, BUSY_REASON, type GitKind } from "./gitActions.ts";

export type DockTab = "changes" | "log" | "reflog" | "branches" | "remotes" | "tags" | "submodules" | "worktrees" | "stashes";
export type DockKind = "primary" | "normal" | "danger";

/** Every tab with a dock, in tab order. Tidy has none: nothing is selected there. */
export const DOCK_TABS: readonly DockTab[] = ["changes", "log", "reflog", "branches", "remotes", "tags", "submodules", "worktrees", "stashes"];

/** The catalogue kind each tab's rows are. Remotes lists remote branches; the
 *  remote itself (fetch, copy the URL) is reached through `toolbarFor`. */
export const TAB_KIND: Record<DockTab, GitKind> = {
  changes: "file", log: "commit", reflog: "commit", branches: "branch", remotes: "remote-branch",
  tags: "tag", submodules: "submodule", worktrees: "worktree", stashes: "stash",
};

export interface DockSelection {
  /** How many rows are picked. */
  count: number;
  /** The picked row's name: the branch, tag, worktree path or stash. For the protected check. */
  name?: string;
  /** Branches, several picked: all their names, in list order. */
  names?: readonly string[];
  /** Branches, several picked: those among them that cannot be deleted (the current one, or one held by a worktree). */
  heldNames?: readonly string[];
  /** Branches: the picked row is the checked-out branch. */
  isCurrent?: boolean;
  /** Branches and remotes: the branch is checked out in another worktree. */
  branchHeld?: boolean;
  /** Branches: commits ahead of / behind the upstream, and whether there is one. */
  ahead?: number;
  behind?: number;
  upstream?: boolean;
  /** Remotes: a local branch of that name already exists. */
  localCopy?: boolean;
  /** Worktrees and held branches: a process has its cwd inside. */
  busy?: boolean;
  /** Worktrees: git has it locked. */
  worktreeLocked?: boolean;
  /** Worktrees: git refused to remove it because a submodule is set up inside. */
  worktreeSubmoduleRefused?: boolean;
  /** Tags: whether origin has it. "unknown" when a remote did not answer. */
  tagOnOrigin?: "yes" | "no" | "unknown";
  /** Stashes: the last apply left unmerged paths and the stash still exists. */
  stashClash?: boolean;
  /** Changes: the picked file is staged. */
  staged?: boolean;
  /** Changes: the picked file is one git has never seen. */
  untracked?: boolean;
  /** Changes: the picked file's path, for the Discard tooltip. */
  path?: string;
}

export interface DockRepoState {
  /** Uncommitted changes in the working tree. */
  dirty?: boolean;
  /** HEAD is not on a branch. */
  detached?: boolean;
  /** The checked-out branch, for the chip on branch-moving buttons. */
  branch?: string;
  /** The repository's protected branches, once known; unknown shuts nothing. */
  protectedBranches?: readonly string[];
}

export interface DockAction {
  id: string;
  label: string;
  icon: string;
  kind: DockKind;
  /** The target branch inside `label`, drawn as a chip and never truncated. */
  chip?: string;
  disabled?: boolean;
  reason?: string;
  title?: string;
  /** A button that opens a small menu of the actions under it (a tag's Delete…). */
  menu?: DockAction[];
}

export interface Dock { actions: DockAction[]; more: DockAction[] }

interface Spec {
  id: string; label: string; icon: string; kind?: DockKind;
  /** Works on several rows at once; everything else needs exactly one. */
  multi?: boolean;
  /** The server refuses it on a dirty tree. */
  cleanOnly?: boolean;
  /** Name the target branch in the label: `{b}` is replaced by it. */
  branchy?: boolean;
  /** Draws a chip of its own (a bulk delete's "N branches"), with a tooltip. */
  chip?: string;
  title?: string;
  /** Opens a menu of these instead of acting. */
  menu?: Spec[];
  /** A reason to shut it beyond count and dirty tree, from what is selected. */
  guard?: (sel: DockSelection, repo: DockRepoState) => string | undefined;
}

const sp = (id: string, label: string, icon: string, kind: DockKind = "normal", o: Partial<Spec> = {}): Spec =>
  ({ id, label, icon, kind, ...o });

const LOG: { actions: Spec[]; more: Spec[] } = {
  actions: [
    sp("show", "Show this commit", "eye", "primary"),
    sp("compare", "Compare with the working tree", "compare"),
    sp("branch-here", "New branch from here", "plus"),
    sp("cherry-pick", "Cherry-pick onto {b}", "pick", "normal", { multi: true, cleanOnly: true, branchy: true }),
    sp("revert", "Revert it", "undo", "danger", { cleanOnly: true }),
    // One button, three ways to move the tip: the menu holds the two softer ones the
    // approved More menu does not carry, so they stay reachable from the dock.
    sp("reset-hard", "Reset {b} to here", "trash", "danger", { branchy: true, menu: [
      sp("reset-hard", "Hard: discard working changes", "trash", "danger"),
      sp("reset-mixed", "Mixed: keep changes unstaged", "undo"),
      sp("reset-soft", "Soft: keep changes staged", "undo"),
    ] }),
  ],
  more: [
    sp("rebase-from-here", "Rebase from here…", "rebase"),
    sp("bisect-from-here", "Find the bad commit from here…", "bug"),
    sp("cherry-pick-stage", "Cherry-pick, stage only", "pick", "normal", { multi: true }),
    sp("copy-sha", "Copy the sha", "copy"),
  ],
};

// The reflog has no Rebase or Bisect door: only the Log handles them.
const REFLOG = { actions: LOG.actions, more: LOG.more.filter((s) => !s.id.endsWith("-from-here")) };

const CHANGES_UNSTAGED: Spec[] = [
  sp("stage", "Stage", "plus", "primary", { multi: true }),
  sp("blame", "Who wrote each line", "eye"),
  sp("copy-path", "Copy the path", "copy"),
  sp("discard", "Discard the changes", "trash", "danger", { multi: true }),
];
const CHANGES_STAGED: Spec[] = [
  sp("unstage", "Unstage", "minus", "primary", { multi: true }),
  sp("blame", "Who wrote each line", "eye"),
  sp("copy-path", "Copy the path", "copy"),
];

const NOTHING: Record<DockTab, string> = {
  changes: "Pick a file first",
  log: "Pick one first",
  reflog: "Pick an entry first",
  branches: "Pick a branch first",
  remotes: "Pick a remote first",
  tags: "Pick a tag first",
  submodules: "Pick a submodule first",
  worktrees: "Pick a worktree first",
  stashes: "Pick a stash first",
};

const protectedReason = (sel: DockSelection, repo: DockRepoState) =>
  sel.name ? protectedRefusal(repo.protectedBranches ?? [], [sel.name]) : undefined;

/** What the bulk delete shows: the dock chip ("N branches", names in its
 *  tooltip) and the dialog's two groups. A held branch (the current one, or one
 *  checked out in another worktree) is named under "Cannot delete" and is never
 *  touched; every name stays in the list, none is folded into "and N more". */
export function bulkDeleteView(names: readonly string[], heldNames: readonly string[] = []) {
  const held = new Set(heldNames);
  return {
    chip: `${names.length} ${names.length === 1 ? "branch" : "branches"}`,
    title: names.join("\n"),
    can: names.filter((n) => !held.has(n)),
    cannot: names.filter((n) => held.has(n)),
  };
}

function branchSpecs(sel: DockSelection): { actions: Spec[]; more: Spec[] } {
  if (sel.count > 1) {
    const v = bulkDeleteView(sel.names ?? [], sel.heldNames);
    return {
      actions: [
        sp("copy-name", "Copy the names", "copy", "normal", { multi: true }),
        sp("clear", "Clear", "x", "normal", { multi: true }),
        sp("delete", `Delete ${v.chip}…`, "trash", "danger", {
          multi: true, chip: v.chip, title: v.title,
          guard: (s, repo) => {
            const bad = protectedRefusal(repo.protectedBranches ?? [], s.names ?? []);
            if (bad) return bad;
            return s.names && v.can.length === 0 ? "None of them can be deleted" : undefined;
          },
        }),
      ],
      more: [],
    };
  }
  if (sel.isCurrent) {
    const ahead = sel.ahead ?? 0, behind = sel.behind ?? 0;
    // Publish when the branch never left this machine, Push otherwise: the same rule the row menu uses.
    const push = sel.upstream === false
      ? sp("publish", "Publish and track", "up", "primary")
      : sp("push", ahead > 0 ? `Push ${ahead}` : "Push", "up", ahead > 0 ? "primary" : "normal", { guard: () => (ahead > 0 ? undefined : "Nothing to push") });
    return {
      actions: [
        push,
        sp("pull", behind > 0 ? `Pull ${behind}` : "Pull", "dn", "normal", { guard: () => (behind > 0 ? undefined : "Up to date") }),
        sp("worktree-new", "New worktree here", "folder"),
        sp("open-web", "Open on GitHub", "ext"),
        sp("copy-name", "Copy the name", "copy"),
      ],
      more: [],
    };
  }
  const removeAndDelete = sp("branch-remove-and-delete", "Remove worktree & delete…", "trash", "danger", {
    guard: (s, repo) => protectedReason(s, repo) ?? (s.busy ? BUSY_REASON : undefined),
  });
  return {
    actions: [
      sel.branchHeld ? sp("open-worktree", "Open its worktree", "folder", "primary") : sp("checkout", "Switch to this branch", "arrow", "primary"),
      sp("merge", "Merge into {b}", "merge", "normal", { branchy: true }),
      sp("rebase", "Rebase {b} onto it", "rebase", "normal", { branchy: true, cleanOnly: true }),
      sp("compare", "Compare with {b}", "compare", "normal", { branchy: true }),
      // A branch held by a worktree cannot be deleted until that worktree is gone.
      sel.branchHeld ? removeAndDelete : sp("delete", "Delete…", "trash", "danger", { guard: protectedReason }),
    ],
    more: [
      sp("worktree-new", "New worktree here", "folder"),
      sp("open-web", "Open on GitHub", "ext"),
      sp("copy-name", "Copy the name", "copy"),
      sp("rename", "Rename", "edit", "normal", { guard: protectedReason }),
    ],
  };
}

function remoteSpecs(sel: DockSelection): { actions: Spec[]; more: Spec[] } {
  const go = sel.branchHeld
    ? [sp("open-worktree", "Open its worktree", "folder", "primary")]
    : sel.localCopy
      ? [sp("checkout-local", "Switch to the local copy", "arrow", "primary")]
      : [
          sp("bring-local", "Bring it local, stay here", "dn", "primary"),
          sp("checkout", "Bring it and switch", "arrow"),
          sp("worktree", "Check it out in its own folder", "folder"),
        ];
  return { actions: [...go, sp("compare", "Compare with {b}", "compare", "normal", { branchy: true }), sp("copy-name", "Copy the name", "copy")], more: [] };
}

function tagSpecs(): { actions: Spec[]; more: Spec[] } {
  return {
    actions: [
      sp("checkout", "Check out this tag", "arrow", "primary"),
      sp("compare", "Compare with {b}", "compare", "normal", { branchy: true }),
      sp("push", "Push to the remote", "up", "normal", { guard: (s) => (s.tagOnOrigin === "yes" ? "Already on origin" : undefined) }),
      sp("copy-name", "Copy the name", "copy"),
      // One door, two choices: each is its own confirmation with its command.
      sp("delete-menu", "Delete…", "trash", "danger", {
        menu: [
          sp("delete", "Delete locally", "trash", "danger"),
          sp("delete-remote", "Delete on the remote too", "cloud", "danger", {
            guard: (s) => (s.tagOnOrigin === "no" ? "It is only here" : undefined),
          }),
        ],
      }),
    ],
    more: [sp("copy-sha", "Copy the sha", "copy")],
  };
}

function submoduleSpecs(): { actions: Spec[]; more: Spec[] } {
  return {
    actions: [
      sp("update", "Update it", "refresh", "primary"),
      sp("submodule-sync", "Sync the URL", "cloud"),
      sp("copy-path", "Copy the path", "copy"),
      sp("submodule-deinit", "Unregister", "minus", "danger"),
      sp("submodule-remove", "Remove…", "trash", "danger"),
    ],
    more: [],
  };
}

function worktreeSpecs(sel: DockSelection): { actions: Spec[]; more: Spec[] } {
  const here = (s: DockSelection) => (s.isCurrent ? "You are in it" : undefined);
  const unlockFirst = (s: DockSelection) => here(s) ?? (s.worktreeLocked ? "Unlock it first" : undefined)
    ?? (s.busy ? BUSY_REASON : undefined);
  return {
    actions: [
      sp("open", "Open this checkout", "arrow", "primary", { guard: here }),
      ...(sel.worktreeLocked ? [sp("worktree-unlock", "Unlock", "lock")] : []),
      sp("copy-path", "Copy the path", "copy"),
      // git refused on a submodule: the plain Remove would only refuse again.
      sel.worktreeSubmoduleRefused
        ? sp("worktree-force-remove", "Remove anyway", "trash", "danger", { guard: unlockFirst })
        : sp("remove", "Remove this worktree", "trash", "danger", { guard: unlockFirst }),
    ],
    more: [],
  };
}

function stashSpecs(sel: DockSelection): { actions: Spec[]; more: Spec[] } {
  const clash = !!sel.stashClash;
  const wait = clash ? () => "Resolve the conflict first" : undefined;
  const apply = (id: string, label: string, kind: DockKind): Spec => sp(id, label, "dn", clash ? "normal" : kind, { guard: wait });
  return {
    actions: [
      ...(clash ? [sp("stash-resolve", "Resolve the conflict", "merge", "primary"), sp("stash-put-back", "Put my tree back", "undo")] : []),
      apply("apply", "Apply, keeping the stash", "primary"),
      apply("pop", "Apply and remove it", "normal"),
      sp("to-branch", "Turn it into a branch", "branch", "normal", { guard: wait }),
      sp("show", "Show what is in it", "eye"),
      sp("drop", "Drop it…", "trash", "danger"),
    ],
    more: [
      sp("rename", "Rename", "edit"),
      sp("stash-files", "List its files", "list"),
      sp("overwrite", "Apply over the working tree", "alert", "danger", { guard: wait }),
    ],
  };
}

function build(s: Spec, tab: DockTab, sel: DockSelection, repo: DockRepoState): DockAction {
  const target = repo.detached ? "HEAD" : repo.branch;
  const label = s.branchy ? s.label.replace("{b}", target ?? "this branch") : s.label;
  const a: DockAction = { id: s.id, label, icon: s.icon, kind: s.kind ?? "normal" };
  if (s.branchy && target) a.chip = target;
  if (s.chip) a.chip = s.chip;
  if (s.title) a.title = s.title;
  if (s.id === "discard" && sel.untracked) a.title = `delete ${sel.path ?? "the file"}`;
  const shut = (reason: string) => { a.disabled = true; a.reason = reason; };
  if (sel.count === 0) shut(NOTHING[tab]);
  else if (sel.count > 1 && !s.multi) shut("Pick one");
  else if (s.cleanOnly && repo.dirty) shut("Commit or stash your changes first");
  // The server refuses a hard reset on a protected branch; say so before the confirm.
  // Soft and mixed lose nothing, but they still move a protected tip, so the dock shuts them too.
  else if (s.id.startsWith("reset-") && !repo.detached && isProtectedBranch(repo.protectedBranches ?? [], repo.branch))
    shut(`${repo.branch} is protected: unprotect it in the Branches tab`);
  else {
    const why = s.guard?.(sel, repo);
    if (why) shut(why);
  }
  if (s.menu) a.menu = s.menu.map((m) => build(m, tab, sel, repo));
  return a;
}

export function dockActionsFor(tab: DockTab, selection: DockSelection, repoState: DockRepoState = {}): Dock {
  let t: { actions: Spec[]; more: Spec[] };
  switch (tab) {
    case "changes": t = { actions: selection.staged ? CHANGES_STAGED : CHANGES_UNSTAGED, more: [] }; break;
    case "log": t = LOG; break;
    case "reflog": t = REFLOG; break;
    case "branches": t = branchSpecs(selection); break;
    case "remotes": t = remoteSpecs(selection); break;
    case "tags": t = tagSpecs(); break;
    case "submodules": t = submoduleSpecs(); break;
    case "worktrees": t = worktreeSpecs(selection); break;
    case "stashes": t = stashSpecs(selection); break;
    default: { const never: never = tab; throw new Error(`no dock for ${String(never)}`); }
  }
  return {
    actions: t.actions.map((s) => build(s, tab, selection, repoState)),
    more: t.more.map((s) => build(s, tab, selection, repoState)),
  };
}

const TOOLBAR_ICON: Record<string, string> = {
  "tag-create": "plus", "tag-create-light": "tag", "submodule-add": "plus",
  "submodule-open-gitmodules": "file", amend: "undo", "remote-fetch": "refresh", "remote-copy-url": "copy",
};

/** The doors of a tab that need no selection (New tag, Add a submodule, Fetch
 *  from a remote). Always enabled; the toolbar draws them, the dock rules own them. */
export function toolbarFor(tab: DockTab, remote?: string): DockAction[] {
  return (TOOLBAR[TAB_KIND[tab] === "remote-branch" ? "remote" : TAB_KIND[tab]] ?? []).map((a) => ({
    id: a.id,
    label: a.id === "remote-fetch" && remote ? `Fetch from ${remote}` : a.label,
    icon: TOOLBAR_ICON[a.id] ?? "plus",
    kind: "normal" as const,
  }));
}

/** The buttons on a hunk header: discard only where the change is not staged. */
export function hunkActionsFor(staged: boolean): DockAction[] {
  return staged
    ? [{ id: "unstage-hunk", label: "Unstage hunk", icon: "minus", kind: "normal" }]
    : [
        { id: "stage-hunk", label: "Stage hunk", icon: "plus", kind: "normal" },
        { id: "discard-hunk", label: "Discard hunk", icon: "trash", kind: "danger" },
      ];
}

/** The row the Log dock acts on: the one commit picked when exactly one is,
 *  otherwise the row under the cursor (several picks go to the series handlers). */
export function dockTarget<T extends { hash?: string }>(rows: readonly T[], picked: ReadonlySet<string>, cursor: T | undefined): T | undefined {
  if (picked.size !== 1) return cursor;
  const [h] = picked;
  return rows.find((r) => r.hash === h) ?? cursor;
}

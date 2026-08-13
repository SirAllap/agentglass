// What you can do to a branch, a tag, a stash, a worktree — and which one of
// those you were probably going to do.
//
// The git view used to answer this by putting every action on the row: seven
// buttons on a branch, three on a tag, and 86 across the panel. They appeared
// on hover, which kept them out of the way of the eye but not out of the way of
// the pointer — the row you wanted to READ was the row that sprouted a toolbar,
// and the button you wanted was in a different position on every row because it
// depended on the branch's state.
//
// So the actions moved off the row and into three places that scale, and this
// file is the single list all three read:
//
//   * the context menu (right-click), which shows everything, grouped;
//   * ONE primary button on hover, chosen from the row's own state — the
//     branch whose remote is gone offers "Delete", the one that is ahead offers
//     "Publish", and the ordinary one offers "Switch";
//   * the command palette, which is this list flattened and searchable.
//
// Keeping it as data rather than JSX is what makes the three agree. It also
// makes the rule testable without rendering a panel: see gitActions.test.ts.
//
// `command` is the git the action runs, shown to the user before anything
// irreversible happens. Not every action has one — some are three commands or a
// dialog — and those simply do not offer it rather than showing a lie.

/** The things the git view lists. One kind per section, plus `commit`, which
 *  appears in the log and in the reflog. */
export type GitKind = "branch" | "tag" | "stash" | "worktree" | "remote" | "remote-branch" | "submodule" | "commit";

/** What a row knows about itself. Every field optional: a tag has no upstream,
 *  a worktree has no ahead count, and the rules below ask only what they need. */
export interface GitRowState {
  /** The branch you are standing on. It cannot be switched to or deleted. */
  current?: boolean;
  /** Upstream is gone — a merged, tidied-up pull request. */
  gone?: boolean;
  ahead?: number;
  behind?: number;
  /** Has an upstream at all. A branch that never left this machine cannot be
   *  "pushed" in the sense the button means; it has to be published. */
  upstream?: boolean;
  /** Checked out in a worktree other than this one, which changes the primary
   *  action from "switch" (impossible — git refuses) to "open it". */
  elsewhere?: boolean;
  /** Already contained in the trunk. */
  merged?: boolean;
  /** A worktree with a process inside, or the one the app is running from.
   *  Removing it is what leaves a session with a deleted cwd. */
  busy?: boolean;
}

export interface GitAction {
  id: string;
  label: string;
  /** Menu grouping. Groups render in first-seen order with a rule between. */
  group: "go" | "compare" | "remote" | "copy" | "danger";
  /** Irreversible, or hard enough to undo that it reads as irreversible. */
  danger?: boolean;
  /** Shown right-aligned in the menu. The palette reads it too. */
  shortcut?: string;
  /** The git this runs, for the confirm step. Absent when it is not one line. */
  command?: string;
}

/** Quote a ref for display in a command line. Names can hold anything a ref can
 *  hold, and a shown command that would not survive a paste is worse than none. */
const q = (s: string): string => (/^[A-Za-z0-9._/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * Everything you can do to this row, in menu order.
 *
 * Order is deliberate and is the same for every kind: where you GO first (the
 * thing you came for), then what you can COMPARE it against, then the REMOTE,
 * then what you can COPY, and last, alone under a rule and in red, what cannot
 * be undone. A menu whose destructive item sits between two ordinary ones is a
 * menu that gets misclicked.
 */
export function actionsFor(kind: GitKind, name: string, s: GitRowState = {}): GitAction[] {
  const out: GitAction[] = [];
  const push = (a: GitAction) => out.push(a);

  if (kind === "branch") {
    if (!s.current) {
      if (s.elsewhere) push({ id: "open-worktree", label: "Open its worktree", group: "go", shortcut: "↵" });
      else push({ id: "checkout", label: "Switch to this branch", group: "go", shortcut: "↵", command: `git switch ${q(name)}` });
      push({ id: "worktree-new", label: "New worktree here", group: "go", shortcut: "⇧↵" });
    }
    push({ id: "compare", label: "Compare with the current branch", group: "compare" });
    if (!s.current) push({ id: "merge", label: `Merge into the current branch`, group: "compare" , command: `git merge ${q(name)}` });
    if (!s.current) push({ id: "rebase", label: "Rebase the current branch onto it", group: "compare", command: `git rebase ${q(name)}` });
    // Push and pull are about the branch you are STANDING on — `git push` with
    // no refspec pushes HEAD. Offering them on a row you are not on would mean
    // `git push origin name:name`, which is a different operation with
    // different failure modes, so the row does not pretend to have it.
    if (s.current) {
      if (s.upstream && (s.ahead ?? 0) > 0) push({ id: "push", label: `Push${s.ahead ? ` ${s.ahead}` : ""}`, group: "remote", shortcut: "⌘P", command: `git push` });
      if (!s.upstream) push({ id: "publish", label: "Publish and track", group: "remote", command: `git push -u origin ${q(name)}` });
      if ((s.behind ?? 0) > 0) push({ id: "pull", label: `Pull${s.behind ? ` ${s.behind}` : ""}`, group: "remote", command: `git pull` });
    }
    push({ id: "open-web", label: "Open on GitHub", group: "remote" });
    push({ id: "copy-name", label: "Copy the name", group: "copy", shortcut: "⌘C" });
    if (!s.current) {
      push({ id: "rename", label: "Rename", group: "danger" });
      // `-d` when the commits are somewhere else, `-D` when they are not, and
      // the shown command says which — the difference between "tidy up" and
      // "throw away work" is one letter, and it is the letter worth reading.
      push({ id: "delete", label: "Delete locally", group: "danger", danger: true, shortcut: "⌫",
        command: `git branch ${s.merged || s.gone ? "-d" : "-D"} ${q(name)}` });
    }
    return out;
  }

  if (kind === "tag") {
    push({ id: "checkout", label: "Check out this tag", group: "go", shortcut: "↵", command: `git checkout ${q(name)}` });
    push({ id: "compare", label: "Compare with the current branch", group: "compare" });
    push({ id: "push", label: "Push to the remote", group: "remote", command: `git push origin ${q(name)}` });
    push({ id: "copy-name", label: "Copy the name", group: "copy", shortcut: "⌘C" });
    push({ id: "copy-sha", label: "Copy the sha", group: "copy" });
    push({ id: "delete", label: "Delete locally", group: "danger", danger: true, shortcut: "⌫", command: `git tag -d ${q(name)}` });
    push({ id: "delete-remote", label: "Delete on the remote too", group: "danger", danger: true, command: `git push origin --delete ${q(name)}` });
    return out;
  }

  if (kind === "stash") {
    // Apply before pop, and pop before drop: the order is least destructive
    // first, because a stash is the one object here with no reflog to save you.
    push({ id: "apply", label: "Apply, keeping the stash", group: "go", shortcut: "↵", command: `git stash apply ${q(name)}` });
    push({ id: "pop", label: "Apply and remove it", group: "go", command: `git stash pop ${q(name)}` });
    push({ id: "to-branch", label: "Turn it into a branch", group: "go" });
    push({ id: "show", label: "Show what is in it", group: "compare" });
    push({ id: "rename", label: "Rename", group: "copy" });
    // Overwrite is destructive to the WORKING TREE rather than to the stash,
    // which is why it sits in red with the drop rather than beside apply: it
    // replaces paths you may have moved on from since you stashed.
    push({ id: "overwrite", label: "Apply over the working tree", group: "danger", danger: true });
    push({ id: "drop", label: "Drop it", group: "danger", danger: true, shortcut: "⌫", command: `git stash drop ${q(name)}` });
    return out;
  }

  if (kind === "worktree") {
    if (!s.current) push({ id: "open", label: "Open this checkout", group: "go", shortcut: "↵" });
    push({ id: "copy-path", label: "Copy the path", group: "copy", shortcut: "⌘C" });
    if (!s.current) {
      // `busy` is not a warning we invent: it is a process whose cwd is inside.
      // Removing it under a running session is what leaves that session with a
      // deleted working directory, which nothing but a relaunch recovers.
      push({ id: "remove", label: s.busy ? "Remove — something is running inside" : "Remove this worktree",
        group: "danger", danger: true, command: `git worktree remove ${q(name)}` });
    }
    return out;
  }

  if (kind === "remote-branch") {
    // A branch on the remote you do not have yet. The three things you can do
    // with it differ in ONE way that matters — what happens to the checkout you
    // are standing in — so they are worded around that rather than around git's
    // verbs: bring it (nothing moves), switch to it (this checkout moves), or
    // put it in its own folder (nothing moves, and you get a second place).
    if (s.elsewhere) push({ id: "open-worktree", label: "Open its worktree", group: "go", shortcut: "↵" });
    else if (s.merged) push({ id: "checkout-local", label: "Switch to the local copy", group: "go", shortcut: "↵" });
    else {
      push({ id: "bring-local", label: "Bring it local, stay here", group: "go", shortcut: "↵" });
      push({ id: "checkout", label: "Bring it and switch this checkout", group: "go", shortcut: "⇧↵" });
      push({ id: "worktree", label: "Check it out in its own folder", group: "go" });
    }
    push({ id: "compare", label: "Compare with the current branch", group: "compare" });
    push({ id: "copy-name", label: "Copy the name", group: "copy", shortcut: "⌘C" });
    return out;
  }

  if (kind === "remote") {
    // Only what the server can actually do. Prune and remove belong on this
    // list the day there is an endpoint behind them, and not one day earlier:
    // a menu item that does nothing is worse than a missing one, because it
    // teaches you the app is broken rather than that the feature is absent.
    push({ id: "fetch", label: "Fetch from it", group: "go", shortcut: "↵", command: `git fetch ${q(name)}` });
    push({ id: "copy-url", label: "Copy the URL", group: "copy", shortcut: "⌘C" });
    return out;
  }

  if (kind === "submodule") {
    push({ id: "update", label: "Update it", group: "go", shortcut: "↵", command: `git submodule update --init ${q(name)}` });
    push({ id: "copy-path", label: "Copy the path", group: "copy", shortcut: "⌘C" });
    return out;
  }

  // commit — in the log and in the reflog
  push({ id: "show", label: "Show this commit", group: "go", shortcut: "↵" });
  push({ id: "compare", label: "Compare with the working tree", group: "compare" });
  push({ id: "branch-here", label: "New branch from here", group: "go" });
  push({ id: "cherry-pick", label: "Cherry-pick onto the current branch", group: "compare", command: `git cherry-pick ${q(name)}` });
  push({ id: "copy-sha", label: "Copy the sha", group: "copy", shortcut: "⌘C" });
  push({ id: "revert", label: "Revert it", group: "danger", danger: true, command: `git revert ${q(name)}` });
  push({ id: "reset-hard", label: "Reset this branch to here", group: "danger", danger: true, command: `git reset --hard ${q(name)}` });
  return out;
}

/**
 * The ONE action that earns a button on the row, or null when none does.
 *
 * This is the whole reason the seven buttons could go away. They were seven
 * because the row could be in seven states and nobody wanted to decide which
 * one mattered; deciding is exactly what makes the row readable. The rule reads
 * the state in the order a person does — "can I even?", then "is something
 * wrong with it?", then "is something owed to the remote?", then the ordinary
 * case.
 *
 * A current branch gets nothing: every action it could offer is either
 * impossible (switch to itself, delete itself) or belongs to the toolbar, not
 * to a row.
 */
export function primaryAction(kind: GitKind, name: string, s: GitRowState = {}): GitAction | null {
  const all = actionsFor(kind, name, s);
  const by = (id: string) => all.find((a) => a.id === id) ?? null;

  if (kind === "branch") {
    // The branch you are on has no row action: everything it could offer is
    // either impossible against itself or belongs to the toolbar above, which
    // is where push and pull already live.
    if (s.current) return null;
    if (s.elsewhere) return by("open-worktree");
    // Gone AND merged is the tidy-up case, and the only one where the primary
    // action is destructive: the branch's remote is deleted and its commits are
    // in the trunk, so "delete" is not a risk, it is the leftover chore.
    if (s.gone && s.merged) return by("delete");
    return by("checkout");
  }
  if (kind === "remote-branch") {
    // `merged` is reused here to mean "you already have a local copy", which is
    // the only state that changes the answer: there is nothing to bring.
    if (s.elsewhere) return by("open-worktree");
    if (s.merged) return by("checkout-local");
    return by("bring-local");
  }
  if (kind === "worktree") return s.current ? null : by("open");
  if (kind === "stash") return by("apply");
  if (kind === "remote") return by("fetch");
  if (kind === "submodule") return by("update");
  if (kind === "tag") return by("checkout");
  return by("show");
}

/** Menu groups in render order, each with its actions. Empty groups are gone,
 *  so a caller can put a rule between every pair it gets back. */
export function grouped(actions: GitAction[]): GitAction[][] {
  const order: GitAction["group"][] = ["go", "compare", "remote", "copy", "danger"];
  return order.map((g) => actions.filter((a) => a.group === g)).filter((xs) => xs.length > 0);
}

/**
 * Everything actionable in the view, flattened for the command palette.
 *
 * The palette searches the ACTION and the OBJECT together — "borrar super"
 * has to find "Delete locally" on `feat/git-super-tool` — so each entry carries
 * a haystack of both rather than making the palette guess how to join them.
 */
export interface PaletteEntry {
  kind: GitKind;
  name: string;
  action: GitAction;
  /** Lowercased "label name" for substring matching. */
  haystack: string;
}

export function paletteEntries(rows: { kind: GitKind; name: string; state?: GitRowState }[]): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  for (const r of rows) {
    for (const action of actionsFor(r.kind, r.name, r.state)) {
      out.push({ kind: r.kind, name: r.name, action, haystack: `${action.label} ${r.name}`.toLowerCase() });
    }
  }
  return out;
}

/** Palette matching: every whitespace-separated term must appear somewhere, in
 *  any order. "super borrar" and "borrar super" find the same thing, which is
 *  what people actually type. */
export function matchPalette(entries: PaletteEntry[], query: string): PaletteEntry[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return entries;
  return entries.filter((e) => terms.every((t) => e.haystack.includes(t)));
}

// ---------------------------------------------------------------- grouping --

export interface PrefixGroup<T> {
  /** `feat` for feat/thing. Empty string is the group of branches with no
   *  prefix at all, which is where the trunk lives and which always sorts last
   *  — it is a leftover pile, not a family. */
  prefix: string;
  rows: T[];
}

/**
 * Eighteen branches are not eighteen things: they are four `feat/`, three
 * `fix/` and a handful with no prefix.
 *
 * Only the FIRST segment counts. `feat/git/super` is one `feat` family, not a
 * tree — a two-level grouping looks tidier on a whiteboard and produces groups
 * of one on a real repository, which is a heading per branch and worse than no
 * grouping at all.
 *
 * Order is by size, biggest family first, with the no-prefix pile last however
 * big it is: the families are the structure, and the pile is what did not fit.
 * Within a family the caller's order is preserved, because that is already the
 * sort the list is showing (most out-of-sync first, or by name).
 */
export function groupByPrefix<T>(rows: T[], nameOf: (r: T) => string): PrefixGroup<T>[] {
  const byPrefix = new Map<string, T[]>();
  for (const r of rows) {
    const name = nameOf(r);
    const cut = name.indexOf("/");
    const prefix = cut > 0 ? name.slice(0, cut) : "";
    const bucket = byPrefix.get(prefix);
    if (bucket) bucket.push(r); else byPrefix.set(prefix, [r]);
  }
  const groups = [...byPrefix].map(([prefix, rows]) => ({ prefix, rows }));
  groups.sort((a, b) => {
    if (!a.prefix) return 1;
    if (!b.prefix) return -1;
    return b.rows.length - a.rows.length || a.prefix.localeCompare(b.prefix);
  });
  return groups;
}

/**
 * What a bulk action can actually do to a selection, and what it must refuse.
 *
 * Deleting nine branches is a decision about nine branches, and the honest way
 * to offer it is to say which of the nine it will not touch: the branch you are
 * standing on cannot be deleted, and one checked out in another worktree cannot
 * either — git refuses both, and a bulk button that reports "9 deleted" after
 * deleting 7 is worse than one that said 7 up front.
 */
export function bulkDeletable<T>(rows: T[], stateOf: (r: T) => GitRowState): { can: T[]; held: T[] } {
  const can: T[] = [], held: T[] = [];
  for (const r of rows) {
    const s = stateOf(r);
    (s.current || s.elsewhere ? held : can).push(r);
  }
  return { can, held };
}

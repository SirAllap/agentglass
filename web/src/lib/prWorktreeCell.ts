// "Where is this branch on my machine?" — as three answers, not two.
//
// The pull request header carried the branch name and stopped there, so the
// question everybody asks next — is this the checkout I have open, and does it
// have work in it — meant going to a shell. The terminal's own header has carried
// the worktree for a while, with Git and Diff beside it; this is the same fact in
// the place where the branch is already named.
//
// The three answers exist because two of them are easy to collapse into one and
// they mean opposite things: "nobody has checked this out" is worth knowing, and
// "we have not found out yet" must never be drawn as it. That collapse is the
// mistake this file is here to make impossible — the header would announce "not
// checked out here" for the second or so before the answer landed, on a branch
// sitting in a worktree the reader has open in the next tab.

import type { PrLocalHead } from "../../../shared/types.ts";

export type WtCell =
  /** Not answered yet. Draw nothing at all. */
  | { kind: "unknown" }
  /** Answered: no worktree on this machine has it. */
  | { kind: "none" }
  /** Answered: this checkout has it. */
  | { kind: "here"; root: string; folder: string; dirty: boolean };

/** The last path segment — the folder as somebody refers to it out loud, and
 *  what File changes filters its paths against. */
export function folderOf(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export function wtCell(local: PrLocalHead | null | undefined): WtCell {
  if (!local) return { kind: "unknown" };
  // A path that is present but empty is not a checkout. It reaches here as the
  // absence it is rather than as a cell with a blank name and two live buttons.
  const root = typeof local.worktree === "string" ? local.worktree.trim() : "";
  if (!root) return { kind: "none" };
  return { kind: "here", root, folder: folderOf(root), dirty: local.dirty === true };
}

/** The whole sentence, for the cell's tooltip. The buttons say what they do; this
 *  says which tree they are about, in full, because the cell shows a folder name
 *  and two checkouts of one repository differ by their path. */
export function wtCellTitle(local: PrLocalHead | null | undefined): string {
  const cell = wtCell(local);
  const branch = local?.branch || "That branch";
  if (cell.kind === "unknown") return "Reading which worktree has this branch";
  if (cell.kind === "none") return `${branch} is not checked out in any worktree on this machine`;
  return `${branch} is checked out in ${cell.root}${cell.dirty ? " — which has uncommitted changes" : ""}`;
}

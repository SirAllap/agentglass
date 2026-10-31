// What each id of the shared commit menu does, for the Log and the Reflog.
// The panel runs the effect; this file only decides which one, so a catalogue
// id with no effect is a test failure rather than a menu item that does nothing.
import { actionsFor } from "./gitActions.ts";

export type CommitEffect =
  | "show" | "compare-worktree" | "branch-here" | "cherry-pick" | "cherry-pick-stage"
  | "revert" | "reset-soft" | "reset-mixed" | "reset-hard" | "copy-sha" | "rebase" | "bisect";

const EFFECT: Record<string, CommitEffect> = {
  show: "show",
  compare: "compare-worktree",
  "branch-here": "branch-here",
  "cherry-pick": "cherry-pick",
  "cherry-pick-stage": "cherry-pick-stage",
  revert: "revert",
  "reset-soft": "reset-soft",
  "reset-mixed": "reset-mixed",
  "reset-hard": "reset-hard",
  "copy-sha": "copy-sha",
  "rebase-from-here": "rebase",
  "bisect-from-here": "bisect",
};

export const commitEffect = (id: string): CommitEffect | null => EFFECT[id] ?? null;

/** Every id a commit row can offer, in either tab. */
export const commitIds = (): string[] => actionsFor("commit", "abc1234", { inLog: true }).map((a) => a.id);

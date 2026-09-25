/**
 * What "Hand to Claude in a terminal" says and which model it opens on.
 *
 * The prompt is a `ReviewRecipe` of the `conflicts` group — the same store, the
 * same editor, the same placeholders as the review prompts, so there is one
 * place to write wording and one file it lives in. What this adds is the two
 * things a conflict knows that a review does not: how many hunks are open, and
 * therefore how much model it deserves (see shared/conflictModel.ts).
 */
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import type { ReviewRecipeContext } from "../../shared/types.ts";
import { expandRecipe } from "../../shared/recipeText.ts";
import { isGenerated, pickConflictModel, resolveConflictModel, type ConflictPick } from "../../shared/conflictModel.ts";
import { conflictRecipe } from "./reviewPrompts.ts";
import { worktreeParent } from "./worktree.ts";

/** Most it will read for one answer. It is a guess at a model, not an audit. */
const MAX_BYTES = 8_000_000;

/** Open hunks in the conflicted files: a `<<<<<<<` line each. Only regular
 *  files inside the worktree are read: a symlink could point anywhere, and a
 *  FIFO would block the event loop forever. Anything unreadable counts as none —
 *  a wrong model pick is cheap, a read outside the worktree is not. */
export function countHunks(worktree: string, files: string[]): number {
  let n = 0, read = 0;
  for (const f of files) {
    const rel = normalize(f);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) continue;
    const abs = join(worktree, rel);
    try {
      const st = lstatSync(abs);
      if (!st.isFile() || st.size > 2_000_000 || (read += st.size) > MAX_BYTES) continue;
      n += (readFileSync(abs, "utf8").match(/^<{7}(?: |$)/gm) ?? []).length;
    } catch { /* unreadable is uncounted */ }
  }
  return n;
}

export interface ConflictPromptInput {
  /** Already scope-checked by the caller. The project a per-project prompt is
   *  keyed on is derived from it, never sent: a client cannot name another
   *  project's prompt, and a worktree path cannot miss its own. */
  worktree: string;
  files: string[];
  number?: number;
  repo?: string;
  branch?: string;
  base?: string;
  title?: string;
}

export interface ConflictPromptResult extends ConflictPick {
  /** A skill goes first and on its own line; the caller writes the briefing after it. */
  skill: string;
  ask: string;
  recipeId: string;
}

export function conflictPrompt(i: ConflictPromptInput): ConflictPromptResult {
  const r = conflictRecipe(worktreeParent(i.worktree) ?? i.worktree);
  const ctx: ReviewRecipeContext = {
    number: i.number ?? 0, repo: i.repo ?? "", head: "", branch: i.branch ?? "", title: i.title ?? "",
    author: "", url: "", base: i.base ?? "", files: i.files.join("\n"), worktree: i.worktree,
  };
  const pick = resolveConflictModel(r, pickConflictModel({ files: i.files, hunks: countHunks(i.worktree, i.files.filter((f) => !isGenerated(f))) }));
  return {
    ...pick,
    skill: r.skill ? expandRecipe(r.skill, ctx).trim() : "",
    ask: expandRecipe(r.body ?? "", ctx).trim(),
    recipeId: r.id,
  };
}

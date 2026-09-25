/**
 * Which model a conflict tab opens on, decided from the conflict itself.
 *
 * A lockfile that both sides regenerated does not need the model that reads a
 * migration and a billing rule; a tab opened on the biggest one for every
 * conflict spends most of its budget on the easy ones. The rule is a plain
 * function of two things git already knows — the file names and how many
 * hunks are open — so it is the same answer every time and a test can hold it.
 *
 * Its ceiling, said plainly: it cannot see that BOTH sides rewrote the same
 * function. The open-hunk total over the files merged by hand stands in for that
 * (many hunks is usually the same code edited twice), and the critical-path list catches the files
 * where a wrong merge costs the most. Anything subtler is the user's override,
 * per prompt, in Settings.
 */
import type { ConflictEffort, ConflictModel } from "./types.ts";
import { isLockfile } from "./riskFlags.ts";

/** Regenerate, never hand-merge: lockfiles, and what a tool writes. */
const GENERATED = /(^|\/)(baml_client|__generated__|generated)\/|\.generated\.|\.snap$|\.min\.(js|css)$/;
export const isGenerated = (f: string): boolean => isLockfile(f) || GENERATED.test(f);

/** Where a wrong merge is expensive: schema history, prompt text, money, access. */
const CRITICAL = /(^|\/)(migrations?|prompts?|billing|payments?|auth|permissions?|security)(\/|\.|$)/i;

/** More than this many open hunks, or files, and it is a merge to think about. */
const MANY_HUNKS = 8;
const MANY_FILES = 6;

export interface ConflictPick { model: Exclude<ConflictModel, "auto">; effort: Exclude<ConflictEffort, "auto">; why: string }

export function pickConflictModel(input: { files: string[]; /** Open hunks in the files that are not generated. */ hunks?: number }): ConflictPick {
  const hand = input.files.filter((f) => !isGenerated(f));
  if (!hand.length) return { model: "haiku", effort: "low", why: "only lockfiles and generated files: regenerate them" };
  const critical = hand.find((f) => CRITICAL.test(f));
  if (critical) return { model: "opus", effort: "medium", why: `${critical} is a file where a wrong merge is costly` };
  if ((input.hunks ?? 0) > MANY_HUNKS) return { model: "opus", effort: "medium", why: `${input.hunks} open hunks` };
  if (hand.length > MANY_FILES) return { model: "opus", effort: "medium", why: `${hand.length} files conflicted by hand` };
  return { model: "sonnet", effort: "medium", why: "a few small hunks" };
}

/** A prompt's own setting wins; `auto` (or nothing) takes the pick. */
export function resolveConflictModel(
  set: { model?: ConflictModel; effort?: ConflictEffort },
  pick: ConflictPick,
): ConflictPick {
  const model = set.model && set.model !== "auto" ? set.model : pick.model;
  const effort = set.effort && set.effort !== "auto" ? set.effort : pick.effort;
  const setModel = model !== pick.model, setEffort = effort !== pick.effort;
  if (setModel && setEffort) return { model, effort, why: "set on the prompt" };
  return { model, effort, why: setModel ? "model set on the prompt; effort from the conflict" : setEffort ? "effort set on the prompt; model from the conflict" : pick.why };
}

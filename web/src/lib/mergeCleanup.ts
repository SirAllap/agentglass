/*
 * What the merge dialog's cleanup tick will remove, and what it already knows
 * will be held back, read before the merge so the tick is a decision and not a
 * hope. Both reads are advisory: the dry run that opens after the merge asks
 * again, so a failed read here only means the card shows less.
 */
import { api } from "./api.ts";
import { blockViews } from "./cleanupPr.ts";
import { includeOf } from "./cleanupSettings.ts";
import type { CleanupKind } from "./cleanupSettings.ts";

export interface CleanupPreview {
  /** The kinds the project's settings include, in the settings' own order. */
  kinds: CleanupKind[];
  /** Safety blocks that already apply. "The PR is still open" is not one: it is the merge this dialog is about to do. */
  held: { title: string; why: string }[];
}

export async function cleanupPreview(root: string, pr: number): Promise<CleanupPreview | null> {
  const [inc, plan] = await Promise.all([api.settingAt("cleanup.include", root).catch(() => null), api.cleanupPlan(root, pr).catch(() => null)]);
  if (!inc) return null;
  const held = plan?.ok && plan.plan ? blockViews(plan.plan).filter((b) => b.kind !== "pr-open").map((b) => ({ title: b.title, why: b.why })) : [];
  return { kinds: includeOf(inc.value), held };
}

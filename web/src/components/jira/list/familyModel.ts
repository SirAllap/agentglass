/*
 * Which cards on the board are family of the card that is open. A sub-task and its parent are two cards that look alike
 * on a board; while one is open the other carries a quiet mark, so the link reads without opening anything. Pure: the
 * board only turns the answer into a class.
 */
import type { ProviderTask } from "../../../../../shared/providers.ts";
import { isSubtask, keyOf } from "./laneModel.ts";

type FamilyCard = Pick<ProviderTask, "id" | "customId" | "issueType" | "parent">;

/** "parent": the open card is a sub-task of this one. "child": this is a sub-task of the open card. */
export type FamilyRole = "parent" | "child";

/** card id -> its role next to the open card. The open card itself is never in the map; an epic's stories are not family. */
export function familyOf(cards: readonly FamilyCard[], openKey: string | null | undefined): Map<string, FamilyRole> {
  const out = new Map<string, FamilyRole>();
  const open = (openKey ?? "").toLowerCase();
  if (!open) return out;
  const opened = cards.find((c) => c.id.toLowerCase() === open || keyOf(c).toLowerCase() === open);
  const parentKey = opened && isSubtask(opened) ? opened.parent?.key.toLowerCase() : undefined;
  for (const c of cards) {
    if (c === opened) continue;
    if (parentKey && keyOf(c).toLowerCase() === parentKey) out.set(c.id, "parent");
    else if (isSubtask(c) && c.parent?.key.toLowerCase() === (opened ? keyOf(opened).toLowerCase() : open)) out.set(c.id, "child");
  }
  return out;
}

/** The chip a board card shows for its `parent`: an epic's name on a story, the parent card's key on a sub-task. */
export function parentChipOf(t: Pick<ProviderTask, "issueType" | "parent">): "epic" | "parent" | null {
  if (!t.parent) return null;
  return isSubtask(t) ? "parent" : "epic";
}

/** The family a card belongs to, named by its parent's key: a sub-task by its parent, a parent by itself. Undefined for a card alone. */
export function familyKeyOf(t: Pick<ProviderTask, "id" | "customId" | "issueType" | "parent" | "subtasks" | "children">): string | undefined {
  if (isSubtask(t)) return t.parent?.key;
  return (t.subtasks ?? 0) > 0 || (t.children?.length ?? 0) > 0 ? keyOf(t) : undefined;
}

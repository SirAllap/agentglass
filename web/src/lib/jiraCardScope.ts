/*
 * Where a card lives, as the page the main view should load for it: its epic's page (the one the sidebar's epic row opens), else its
 * space's. A sub-task has no epic of its own, so its parent task is asked: sub-task, parent task, that task's epic.
 * Ceiling: one hop up. A parent that is itself a sub-task is not walked further (Jira does not nest them).
 */
import type { ProviderTask } from "../../../shared/providers.ts";
import { isSubtask } from "../components/jira/list/laneModel.ts";
import { scopeIdOf } from "./jiraTree.ts";
import { findCardByKey } from "./jiraCardLookup.ts";
import type { BoardSource } from "./boardSource.ts";

const keyOf = (t: Pick<ProviderTask, "id" | "customId">): string => t.customId ?? t.id;
const spaceOfKey = (k: string): string => (k.lastIndexOf("-") > 0 ? k.slice(0, k.lastIndexOf("-")) : "").toUpperCase();

/** The epic a card hangs under: its own parent, or for a sub-task the parent task's parent. */
export function epicOfCard(t: ProviderTask, parentTask?: ProviderTask | null): { key: string; title: string } | null {
  const p = isSubtask(t) ? (parentTask && !isSubtask(parentTask) ? parentTask.parent : undefined) : t.parent;
  return p?.key ? { key: p.key, title: p.title } : null;
}

/** The scope id to load for a card: its epic page, else its space page, else null. */
export function scopeOfCard(t: ProviderTask, parentTask?: ProviderTask | null): string | null {
  const epic = epicOfCard(t, parentTask);
  const space = spaceOfKey(epic?.key ?? keyOf(t));
  if (!space) return null;
  return epic ? scopeIdOf({ kind: "epic", space, epic: epic.key } as Parameters<typeof scopeIdOf>[0]) : scopeIdOf({ kind: "space", space });
}

/** `scopeOfCard`, reading the parent task first when the card is a sub-task. */
export async function scopeOfFound(source: Pick<BoardSource, "find">, t: ProviderTask): Promise<string | null> {
  const parent = isSubtask(t) && t.parent?.key ? await findCardByKey(source, t.parent.key) : null;
  return scopeOfCard(t, parent);
}

/*
 * The local task list, shaped for the Cards tab.
 *
 * `/tasks/list` is the provider-neutral route: what the machine's own tracker
 * holds, as `LocalTask` rows (shared/types.ts). The tab read ClickUp's routes
 * whoever you were, so on a machine tracking work locally it drew an empty
 * board titled after a product nobody there used. This is the other half of
 * the tab — the pure part, so it can be checked without a phone.
 *
 * A `LocalTask` is not a `ProviderTask` and is not forced into one: it has a
 * uuid and no url, a project and no list, a letter for priority and no colour.
 * Pretending otherwise would put empty chips on every row.
 */
import type { LocalTask } from "../../../shared/types.ts";

/**
 * Which rows the Open switch shows.
 *
 * `export` with no filter hands back everything the store has ever held —
 * completed and deleted included, and on a store a few years old that is most
 * of it. "Open" is `pending`, the one status that is work still owed; "All"
 * keeps completed and drops deleted, because a deleted task is not a thing
 * anybody asks "did I close that?" about.
 */
export function visibleLocal(tasks: LocalTask[] | null, openOnly: boolean): LocalTask[] {
  if (!tasks) return [];
  return tasks.filter((t) => (openOnly ? t.status === "pending" : t.status !== "deleted"));
}

/** Taskwarrior's letters, as words. `null` is "no priority", which most tasks
 *  are, and draws nothing rather than "none". */
export const PRIORITY_WORD: Record<NonNullable<LocalTask["priority"]>, string> = {
  H: "high",
  M: "medium",
  L: "low",
};

/**
 * The line under the description: project, then priority, then tags.
 *
 * Pieces rather than a sentence, so the row can colour the priority and leave
 * the rest quiet. Empty pieces are dropped here, not in the row — a row that
 * has to ask "is this one blank" per field is a row that forgets one.
 */
export function localMeta(task: LocalTask): string[] {
  const out: string[] = [];
  if (task.project) out.push(task.project);
  if (task.priority) out.push(PRIORITY_WORD[task.priority]);
  for (const tag of task.tags) out.push(`+${tag}`);
  return out;
}

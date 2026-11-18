/*
 * One card, by its key, for a caller that already knows it is not on the page: a sub-task's parent, or the
 * breadcrumb above a sub-task's title. Kept out of components/jira/list/ on purpose — that directory's own seam
 * test (jira-list-seam.test.ts) keeps every read behind the list's one hook, and this is a second, deliberately
 * narrow one: it never replaces what is on screen, it only answers "what is this card" for something that opens
 * in place.
 */
import type { BoardSource } from "./boardSource.ts";
import type { ProviderTask } from "../../../shared/providers.ts";

export async function findCardByKey(source: Pick<BoardSource, "find">, key: string): Promise<ProviderTask | null> {
  const r = await source.find(key).catch(() => null);
  return r?.ok && r.task ? r.task : null;
}

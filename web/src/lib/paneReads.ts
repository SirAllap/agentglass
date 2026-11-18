/*
 * Does showing a side pane again need a read, per source — without a DOM.
 *
 * The PR section used to send its list, facets, mentions and repository reads
 * on every show, so ten tab switches cost forty requests for rows that had
 * not moved. The decision lives here, over the same rule the Diff section
 * uses (mustReadOnShow in changeRows.ts): a source reads when it never read,
 * when a push marked it dirty, or when its safety window ended. A read that
 * failed does not count as seen, so the source stays dirty.
 */
import { mustReadOnShow } from "./changeRows.ts";

export type ReadSource = "list" | "facets" | "mentions" | "repos" | "detail";
export const READ_SOURCES: readonly ReadSource[] = ["list", "facets", "mentions", "repos", "detail"];

/** A pane the user left alone for this long reads once more on the way back. */
export const PANE_SAFETY_MS = 60_000;

type Entry = { lastReadAt: number | null; seq: number; seen: number; scope: string };
export type ShowReads = Record<ReadSource, Entry>;

const fresh = (): Entry => ({ lastReadAt: null, seq: 0, seen: 0, scope: "" });

export function newShowReads(): ShowReads {
  return { list: fresh(), facets: fresh(), mentions: fresh(), repos: fresh(), detail: fresh() };
}

/** A push this pane hears marks these sources stale. A counter, not a flag:
 *  a push that lands while a read runs must still count as unseen. */
export function markPush(s: ShowReads, sources: readonly ReadSource[] = READ_SOURCES): void {
  for (const k of sources) s[k].seq++;
}

/** Whether `source` must read now. `scope` is what it reads about (repository, filter):
 *  another scope is a different question, so it always reads. */
export function needsRead(s: ShowReads, source: ReadSource, scope: string, now: number, safetyMs = PANE_SAFETY_MS): boolean {
  const e = s[source];
  if (e.scope !== scope) return true;
  return mustReadOnShow(e.lastReadAt, e.seq !== e.seen, now, safetyMs);
}

/** Call when a read starts; give the result to readDone. */
export const readStarted = (s: ShowReads, source: ReadSource): number => s[source].seq;

/** A read that worked has seen the pushes up to `ticket`. A failed read calls nothing: it stays dirty. */
export function readDone(s: ShowReads, source: ReadSource, scope: string, ticket: number, now: number): void {
  const e = s[source];
  e.seen = ticket; e.lastReadAt = now; e.scope = scope;
}

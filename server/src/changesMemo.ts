/**
 * The newest edited paths, memoised until an edit is written.
 *
 * `getChanges(300, undefined, false)` is a scoped scan of `events` plus up to
 * 300 JSON.parse calls. Five request paths (/prs/locate, /git/repo, the repo
 * picker, the PR rows) each ran it per request: the stall log counted 12
 * stalls and 45.5 s on GET /git/repo alone, and a 1.8 s `/prs/locate`
 * computing line. The answer only changes when an Edit/Write/MultiEdit result
 * is ingested or rows are deleted, so that is the only thing that drops it;
 * no timer.
 *
 * Ceiling: a scoped answer also depends on which paths the scope has recorded.
 * An edit event carries its own path, so it drops the memo; an event of another
 * kind that records a new in-scope path does not, and an older edit it would
 * newly admit shows at the next edit write. Switching scope is part of the key.
 */

/** Does writing this event change the list? Same filter the query applies. */
export function changesAffectedBy(e: { hook_event_type: string; tool_name?: string | null }): boolean {
  return e.hook_event_type === "PostToolUse"
    && (e.tool_name === "Edit" || e.tool_name === "Write" || e.tool_name === "MultiEdit");
}

export interface ChangesMemo<T> {
  get(scope: string, compute: () => T): T;
  drop(): void;
}

export function changesMemo<T>(): ChangesMemo<T> {
  let held: { scope: string; value: T } | null = null;
  return {
    get(scope, compute) {
      if (held && held.scope === scope) return held.value;
      const value = compute();
      held = { scope, value };
      return value;
    },
    drop() { held = null; },
  };
}

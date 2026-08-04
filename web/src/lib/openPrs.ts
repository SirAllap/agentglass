/*
 * "Show me that pull request."
 *
 * A ClickUp card knows its PR numbers; the pull-request view knows how to
 * display one. Neither is a parent of the other, and the panel asking is three
 * levels down from the one that owns the view. The same one-slot bus as
 * termIssue.ts and openSettings.ts, for the same reason: the sender does not
 * know whether the receiver is mounted, and should not have to.
 *
 * What travels is a SEARCH, not a selection — a number typed into the box that
 * view already has. That is deliberate: it is the gesture somebody performs by
 * hand today, it lands them somewhere they recognise, and it degrades honestly
 * when the PR is in another repository or has been deleted. Pushing a selection
 * instead would need the view to hold a card's idea of what exists.
 */
let listener: ((query: string) => void) | null = null;

export function onOpenPrs(fn: ((query: string) => void) | null): () => void {
  listener = fn;
  return () => { if (listener === fn) listener = null; };
}

/** Open the pull-request view with this text in its search box. */
export function openPrs(query: string): void {
  listener?.(query);
}

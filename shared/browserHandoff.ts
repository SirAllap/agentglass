/*
 * What an agent may still do on a tab while it is handed to the person.
 *
 * A handoff lifts the glass and the agent stays attached, so without this its
 * clicks and typing reached the very page the person was using — it could even
 * press Done for them. While a tab is in handoff, only looking is open, plus the
 * handoff's own verb (check, cancel). Everything else is refused, including a
 * verb nobody listed here yet: a new verb defaults to acting, the same rule
 * read-only mode follows on the server (`isActing`). Guide mode reads this list.
 */

/** The verbs that stay open on a tab in handoff. Anything not here is refused. */
export const HANDOFF_OPEN_VERBS: ReadonlySet<string> = new Set([
  // the handoff's own: check and cancel (a re-arm by the same verb replaces it)
  "handoff",
  // looking at the page
  "observe", "read", "markdown", "extract", "links", "count", "search", "interactive", "forms", "attr",
  "text", "html", "shot", "a11y", "frames", "vitals", "inspect",
  // the logs
  "console", "network", "events",
  // waiting on the page, which changes nothing
  "wait", "waitfor",
  // about the caller or the list, not the page
  "whoami", "health", "tabs", "done",
]);

/** Null when `op` may run on a tab in handoff; otherwise the sentence the caller gets. */
export function handoffRefusal(op: string): string | null {
  if (HANDOFF_OPEN_VERBS.has(op)) return null;
  return `this tab is handed to the person (handoff): "${op}" would act on the page they are using, so it is refused. `
    + "Wait for the handoff to end (the person presses Done, its --until is met, or it times out), "
    + "or cancel it (the handoff verb with cancel); reading the page still works.";
}

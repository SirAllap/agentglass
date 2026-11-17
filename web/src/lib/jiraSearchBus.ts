/**
 * One way in for "show the board filtered by this search" from outside the
 * list pane (a Team row in the sidebar, a saved query, the palette). The list
 * pane subscribes; senders never touch its state.
 */
type Listener = (q: string) => void;
const listeners = new Set<Listener>();

export function setJiraSearch(q: string): void {
  for (const l of listeners) l(q);
}

export function onJiraSearch(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** The search now in the list's box, kept here so the sidebar can write it to a Jira filter without reaching into the list. */
let boxNow = "";
export const reportJiraSearch = (q: string): void => { boxNow = q; };
export const jiraSearchNow = (): string => boxNow;

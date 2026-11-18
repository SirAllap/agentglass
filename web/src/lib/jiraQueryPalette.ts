/**
 * The saved searches the Jira list pane has loaded, handed to the Ctrl+K palette. The pane publishes them while it is
 * mounted and withdraws them on leaving; the palette reads them and runs one through `setJiraSearch`.
 */
import { typingInto } from "./taskGrammar.ts";

export interface PaletteQuery { id: string; name: string; jql: string }

let current: readonly PaletteQuery[] = [];
const listeners = new Set<() => void>();

export function publishJiraQueries(list: readonly PaletteQuery[]): void {
  current = list;
  for (const l of listeners) l();
}
export const jiraQueriesNow = (): readonly PaletteQuery[] => current;

/* Whether the Jira view is the one on screen. Outside it the palette is the app's own, exactly as before the Jira view. */
let jiraOnScreen = false;
export function setJiraViewActive(on: boolean): void { jiraOnScreen = on; }
export const jiraViewActiveNow = (): boolean => jiraOnScreen;

/**
 * Whether Ctrl+K / Cmd+K opens the palette. Everywhere outside the Jira view it always does. Inside it, a terminal or a
 * field keeps the chord (a shell reads Ctrl+K as kill-line); the xterm input is a textarea, so `typingInto` covers it.
 */
export function paletteChordOpens(jiraActive: boolean, focused: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean {
  return !jiraActive || !typingInto(focused);
}
export function onJiraQueries(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/*
 * The Jira view's own jump palette (components/jira/list/JiraJump.tsx). Ctrl+K inside the Jira view opens it; outside, the
 * app's palette. The view says it is mounted and listening; App asks `openJump` and falls back to its own palette when
 * nobody listens, so a Jira view with no palette mounted never swallows the chord.
 */
const jumpers = new Set<() => void>();
export function onJiraJump(l: () => void): () => void { jumpers.add(l); return () => { jumpers.delete(l); }; }
/** True when a Jira palette took the chord. */
export function openJiraJump(): boolean {
  if (!jumpers.size) return false;
  for (const l of jumpers) l();
  return true;
}
/** What Ctrl+K does: the Jira palette inside the Jira view (when it can open), the app's palette everywhere else. */
export function chordTarget(jiraActive: boolean, focused: { tagName?: string; isContentEditable?: boolean } | null | undefined, hasJump: boolean): "jira" | "app" | "none" {
  if (!paletteChordOpens(jiraActive, focused)) return "none";
  return jiraActive && hasJump ? "jira" : "app";
}

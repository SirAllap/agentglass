/*
 * Which view and which area (an epic, or the sprint) the Jira tab is on, settable from outside the rail.
 *
 * The tab's body owns the selection (`wanted`, `areaSel`) and the rail clicks keep writing it. This store is the second
 * door, in two halves that never write each other (a single shared value let a caller's request and the body's own
 * reset overwrite one another when a view change closes its area):
 *
 *   request   `setJiraSelection({ viewId, areaId })`, from the space / epic tree. The body takes each request once, goes
 *             to the view, and opens the area when that view has landed (an area belongs to its board).
 *             A field left out is left alone; `areaId: null` closes the area.
 *   current   `useJiraSelection()` is where the body is now, for the tree to draw "this one is selected" from.
 *
 * Ceiling: one Jira tab. Two mounted at once would share one selection.
 */
import { useSyncExternalStore } from "react";

export interface JiraSelectionRequest { viewId?: string; areaId?: string | null }
export interface JiraSelection { viewId: string | null; areaId: string | null }

let request: { seq: number; want: JiraSelectionRequest } = { seq: 0, want: {} };
let current: JiraSelection = { viewId: null, areaId: null };
const listeners = new Set<() => void>();
const tell = () => { for (const l of listeners) l(); };

/** Ask the Jira tab to go to a view and / or open an area. */
export function setJiraSelection(want: JiraSelectionRequest): void {
  request = { seq: request.seq + 1, want };
  tell();
}

/** The last request and its number: the body acts on a number it has not seen. */
export const getJiraRequest = (): { seq: number; want: JiraSelectionRequest } => request;

/** Body only: where the tab is now. */
export function publishJiraSelection(now: JiraSelection): void {
  if (now.viewId === current.viewId && now.areaId === current.areaId) return;
  current = now;
  tell();
}

export const getJiraSelection = (): JiraSelection => current;

const subscribe = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Where the Jira tab is now (view, area). */
export const useJiraSelection = (): JiraSelection => useSyncExternalStore(subscribe, getJiraSelection, getJiraSelection);

/** The request counter, for the body to subscribe to. */
export const useJiraRequest = (): { seq: number; want: JiraSelectionRequest } => useSyncExternalStore(subscribe, getJiraRequest, getJiraRequest);

/** Test seam. */
export const __resetJiraSelection = (): void => { request = { seq: 0, want: {} }; current = { viewId: null, areaId: null }; listeners.clear(); };

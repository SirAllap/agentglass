/*
 * The list selector's decisions: which boards the phone already holds, how a
 * space unfolds into folders and lists, and what a tap on a list does.
 *
 * Three sources, cheapest first. The saved boards come with `/clickup/views`,
 * which the screen reads anyway (nothing extra). The spaces are one request,
 * and a space's folders and lists another (two ClickUp reads behind it), made
 * only when somebody drills in and kept for the session. Search narrows what
 * has been read; it never reads more.
 */
import { ASSIGNED_VIEW_ID, type ListPlace, type SavedView } from "../../../shared/providers.ts";
import { matchesQuery } from "../../../shared/taskref.ts";

/** "Orbit / Delivery": where a board sits, from the list it was read from when
 *  there is one, else from what was saved with it. Empty when it is unknown —
 *  a pasted address says nothing about its space. */
export function boardPath(view: Pick<SavedView, "spaceName" | "folderName"> | undefined, place: ListPlace | undefined): string {
  return [place?.space ?? view?.spaceName, place?.folder ?? view?.folderName].filter(Boolean).join(" / ");
}

export interface BoardEntry { id: string; name: string; path: string; on: boolean }

const UNFILED = "Saved boards";

/**
 * The boards already on this phone's computer: Assigned to me apart, the rest
 * grouped under their space in the order they were saved. A group left empty
 * by the search is dropped rather than drawn as a heading over nothing.
 */
export function boardEntries(views: readonly SavedView[], current: string | null, q: string): {
  assigned: BoardEntry | null;
  groups: { heading: string; entries: BoardEntry[] }[];
} {
  const entry = (v: SavedView): BoardEntry => ({ id: v.id, name: v.name, path: boardPath(v, undefined), on: v.id === current });
  const keep = (e: BoardEntry): boolean => !q.trim() || matchesQuery([e.name, e.path], q);
  const builtin = views.find((v) => v.id === ASSIGNED_VIEW_ID);
  const assigned = builtin && keep(entry(builtin)) ? entry(builtin) : null;
  const groups = new Map<string, BoardEntry[]>();
  for (const v of views) {
    if (v.id === ASSIGNED_VIEW_ID) continue;
    const e = entry(v);
    if (!keep(e)) continue;
    const heading = v.spaceName || UNFILED;
    groups.set(heading, [...(groups.get(heading) ?? []), e]);
  }
  return { assigned, groups: [...groups.entries()].map(([heading, entries]) => ({ heading, entries })) };
}

export interface SpaceShape { id: string; name: string }

export const matchSpaces = <T extends SpaceShape>(spaces: readonly T[], q: string): T[] =>
  spaces.filter((s) => !q.trim() || matchesQuery([s.name], q));

export interface FolderShape {
  id: string;
  name: string;
  lists: { id: string; name: string; tasks?: number }[];
  /** Not a folder: the lists that sit directly in the space. */
  folderless?: boolean;
}

export type TreeRow =
  | { kind: "folder"; id: string; name: string; open: boolean; lists: number }
  | { kind: "list"; id: string; name: string; tasks?: number; depth: 0 | 1; viewId: string | null; on: boolean };

/**
 * A space as rows: folders (closed unless opened), each followed by its lists
 * when open, and the folderless lists at the top level with no row of their
 * own — the tracker draws them as peers of the folders, and so does this.
 *
 * Searching opens every folder and keeps only what matches; a folder whose own
 * name matches keeps all its lists, because that is what somebody typing a
 * folder's name wants to see.
 */
export function spaceTree(
  folders: readonly FolderShape[], open: ReadonlySet<string>, views: readonly SavedView[], current: string | null, q: string,
): TreeRow[] {
  const searching = !!q.trim();
  const list = (l: FolderShape["lists"][number], depth: 0 | 1): TreeRow => {
    const held = views.find((v) => v.listId === l.id);
    return { kind: "list", id: l.id, name: l.name, tasks: l.tasks, depth, viewId: held?.id ?? null, on: !!held && held.id === current };
  };
  const rows: TreeRow[] = [];
  const loose: TreeRow[] = [];
  for (const f of folders) {
    if (f.folderless) {
      loose.push(...f.lists.filter((l) => !searching || matchesQuery([l.name], q)).map((l) => list(l, 0)));
      continue;
    }
    const folderHit = searching && matchesQuery([f.name], q);
    const lists = f.lists.filter((l) => !searching || folderHit || matchesQuery([l.name], q));
    if (searching && !lists.length) continue;
    const isOpen = searching || open.has(f.id);
    rows.push({ kind: "folder", id: f.id, name: f.name, open: isOpen, lists: f.lists.length });
    if (isOpen) rows.push(...lists.map((l) => list(l, 1)));
  }
  return [...rows, ...loose];
}

/** What a tap on a list does: open the board the phone already has for it, or
 *  add one first — the desk's "the list itself", one request to the tracker. */
export function listTarget(listId: string, views: readonly SavedView[]): { view: string } | { add: string } {
  const held = views.find((v) => v.listId === listId);
  return held ? { view: held.id } : { add: listId };
}

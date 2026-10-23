/*
 * Folder peeking, decided away from the screen. Strata's switch of the same
 * name: rest the pointer on a folder in Icons or List and a small card lists
 * what is inside it. Its numbers (src/ui/browser/peek.rs): 256 px wide, 500 ms
 * before it opens, 80 ms before it closes, eight entries, eight pixels from
 * the row.
 *
 * The card sorts the first page the server sends (folders first, then the
 * listing's own order); a folder bigger than that page is cut by the page, not
 * by a full sort, and says how many more there are.
 */
import type { BrowseEntry } from "../../../shared/types.ts";
import { folderPreview, type FolderRow } from "./finderFolder.ts";

export const PEEK = { width: 256, gap: 8, open: 500, close: 80, limit: 8 } as const;

export interface Peek { rows: FolderRow[]; more: number; empty: boolean; count: string }

/** `left` is what the listing did not send (its own count of the rest). */
export function peekOf(name: string, entries: BrowseEntry[], left: number): Peek {
  const p = folderPreview(name, entries, null, left);
  const rows = p.rows.slice(0, PEEK.limit);
  return { rows, more: Math.max(0, entries.length + left - rows.length), empty: p.empty, count: p.count };
}

interface Box { left: number; right: number; top: number; bottom: number }

/** Beside the row, on its right; on its left when the right has no room; lifted when the bottom has none; never past an edge. */
export function peekPlace(anchor: Box, size: { w: number; h: number }, view: { w: number; h: number }): { left: number; top: number } {
  const m = PEEK.gap;
  let left = anchor.right + m;
  if (left + size.w > view.w - m) left = anchor.left - m - size.w;
  let top = anchor.top;
  if (top + size.h > view.h - m) top = view.h - m - size.h;
  return { left: Math.max(m, left), top: Math.max(m, top) };
}

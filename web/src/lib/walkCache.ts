/*
 * The AI walkthrough of a changeset, remembered.
 *
 * Cached per CHANGESET rather than per panel, so it survives closing and
 * reopening whatever showed it and never re-hits the model for diffs it has
 * already described. The signature is order-independent — the same files in a
 * different order are the same changeset — and moves as soon as any file's size
 * does, which is the cheapest honest test for "this is different work now".
 *
 * It lived in the Diff view's file, and was the last thing the Git panel needed
 * from it once the renderer moved out.
 */

import type { FileChange, WalkthroughResult } from "../../../shared/types.ts";

const WALK_KEY = "agentglass.walkCache";
/** Enough for a session's worth of changesets; past that the oldest goes. */
const MAX_ENTRIES = 24;

type WalkCache = Record<string, WalkthroughResult>;

export function changesetSig(list: FileChange[]): string {
  const s = list.map((c) => `${c.file_path}:${c.additions}:${c.deletions}`).sort().join("|");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return `${list.length}.${(h >>> 0).toString(36)}`;
}

export function readWalkCache(): WalkCache {
  try { return JSON.parse(localStorage.getItem(WALK_KEY) || "{}") as WalkCache; } catch { return {}; }
}

export function writeWalkCache(sig: string, r: WalkthroughResult): void {
  try {
    const c = readWalkCache();
    c[sig] = r;
    const keys = Object.keys(c);
    if (keys.length > MAX_ENTRIES) delete c[keys[0]!];
    localStorage.setItem(WALK_KEY, JSON.stringify(c));
  } catch { /* private mode, or a full quota — the cache is an optimisation */ }
}

/*
 * Which files of a commit have been ticked as read.
 *
 * Kept on the phone and nowhere else: a tick here is a note to yourself on the
 * way through a diff, and nothing in git or on GitHub knows about it. It lives
 * in memory for as long as the app does — the commit screen and its diff both
 * read the same set, which is what lets a tick made in the diff show up in the
 * list when you go back. It is not saved: a stale "viewed" on a commit you
 * opened a week ago is worse than none.
 */
import { toggled } from "../model/gitReview.ts";
import { memoryStore } from "./memory-store.ts";

/** One commit's ticks, keyed by checkout and hash so two worktrees of one
 *  repository never share them. */
export function viewedKey(root: string, hash: string): string {
  return `${root}\0${hash}`;
}

export const useViewed = memoryStore<ReadonlySet<string>>(new Set(), toggled);

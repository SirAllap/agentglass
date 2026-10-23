/*
 * What the search box offers when it gets focus: the people somebody follows,
 * their pinned searches, and the last ones they ran. Local to this browser,
 * per repository; the hook owns the state and the storage, the rules are in
 * prSearchMemory.ts and prFollow.ts.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { loadUse, recordPicks } from "./personUsage.ts";
import {
  EMPTY_MEMORY, clearRecent, countOf, isPinned, isRemembered, loadMemory, noteCount, noteSearch,
  recentRows, removeRecent, saveMemory, togglePin, type RecentSearch, type SearchMemory,
} from "./prSearchMemory.ts";
import { isFollowed, loadFollows, peopleRows, saveFollows, toggleFollow } from "./prFollow.ts";

export interface SearchFocus {
  followed: string[];
  suggested: string[];
  saved: { q: string; n?: number }[];
  recent: RecentSearch[];
  isRemembered: (q: string) => boolean;
  isPinned: (q: string) => boolean;
  /** Fill the box with this search and run it: one Enter. */
  run: (q: string) => void;
  /** Open a colleague's board. */
  openPerson: (login: string) => void;
  pin: (q: string) => void;
  remove: (q: string) => void;
  clearRecent: () => void;
  isFollowed: (login: string) => boolean;
  toggleFollow: (login: string) => void;
}

export type FocusItem = { kind: "person" | "saved" | "recent"; value: string };

/** Every row of the panel in reading order — what Up and Down walk. */
export function focusItems(f: Pick<SearchFocus, "followed" | "suggested" | "saved" | "recent">): FocusItem[] {
  return [
    ...[...f.followed, ...f.suggested].map((value): FocusItem => ({ kind: "person", value })),
    ...f.saved.map((s): FocusItem => ({ kind: "saved", value: s.q })),
    ...f.recent.map((r): FocusItem => ({ kind: "recent", value: r.q })),
  ];
}

export function useSearchFocus(
  repoKey: string | undefined,
  roster: readonly string[] | null,
  actions: { run: (q: string) => void; openPerson: (login: string) => void },
) {
  const [mem, setMem] = useState<SearchMemory>(EMPTY_MEMORY);
  const [follows, setFollows] = useState<string[]>([]);
  useEffect(() => {
    setMem(repoKey ? loadMemory(repoKey) : EMPTY_MEMORY);
    setFollows(repoKey ? loadFollows(repoKey) : []);
  }, [repoKey]);

  const edit = useCallback((f: (m: SearchMemory) => SearchMemory) => {
    setMem((cur) => { const next = f(cur); if (repoKey && next !== cur) saveMemory(repoKey, next); return next; });
  }, [repoKey]);
  const remember = useCallback((q: string) => edit((m) => noteSearch(m, q)), [edit]);
  const count = useCallback((q: string, n: number) => edit((m) => noteCount(m, q, n)), [edit]);

  const follow = useCallback((login: string) => {
    setFollows((cur) => { const next = toggleFollow(cur, login); if (repoKey) saveFollows(repoKey, next); return next; });
  }, [repoKey]);

  const { run, openPerson } = actions;
  const focus: SearchFocus = useMemo(() => {
    /* Read when the panel is built, which is when it opens: a pick made in the
       "@" menu a moment ago is in the ranking. */
    const people = peopleRows(follows, roster ? [...roster] : null, loadUse());
    return {
      ...people,
      saved: mem.saved.map((q) => ({ q, n: countOf(mem, q) })),
      recent: recentRows(mem),
      isRemembered: (q) => isRemembered(mem, q),
      isPinned: (q) => isPinned(mem, q),
      run: (q) => { remember(q); run(q); },
      openPerson: (login) => { recordPicks([login]); openPerson(login); },
      pin: (q) => edit((m) => togglePin(m, q)),
      remove: (q) => edit((m) => removeRecent(m, q)),
      clearRecent: () => edit(clearRecent),
      isFollowed: (login) => isFollowed(follows, login),
      toggleFollow: follow,
    };
  }, [mem, follows, roster, run, openPerson, edit, follow, remember]);

  return { focus, remember, count };
}

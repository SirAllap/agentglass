/*
 * The boards behind the open view, read the way the card menu reads them (resolveCardBoard's reads), for Filters > Sprint.
 * Kept out of the pane's own files: they never call the site; this one does, once per set of projects.
 */
import { useEffect, useState } from "react";
import type { JiraBoardContext } from "../../../../../../shared/providers.ts";
import { api } from "../../../../lib/api.ts";
import { readBoardsOf, type CardBoardReads } from "./cardBoard.ts";

export const BOARD_READS: CardBoardReads = { projectBoards: (k) => api.jiraProjectBoards(k), boardContext: (v) => api.jiraBoardContext(v) };

/** The boards whose sprints the open view's cards belong to: the view's own context when it is a board, else the boards of the cards' projects. */
export function useBoardsInView(keys: readonly string[], own: JiraBoardContext | null, enabled: boolean): JiraBoardContext[] {
  const [got, setGot] = useState<{ at: string; cs: JiraBoardContext[] } | null>(null);
  const at = keys.join(",");
  const need = enabled && !own && !!at;
  useEffect(() => {
    if (!need) return;
    let gone = false;
    void readBoardsOf(keys, BOARD_READS).then((cs) => { if (!gone) setGot({ at, cs }); });
    return () => { gone = true; };
  }, [need, at]); // eslint-disable-line react-hooks/exhaustive-deps
  if (own) return own.ok && (!!own.sprint || !!own.futures?.length) ? [own] : [];
  return got && got.at === at ? got.cs : [];
}


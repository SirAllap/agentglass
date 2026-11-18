/*
 * The board a card's sprints come from, in a view that is no board's (a list, a saved filter, a JQL view).
 * A board view already holds its context; anywhere else the menu asks the card's project for its boards and reads
 * their context (the server keeps each ten minutes), so the Sprint row offers the same sprints as on the board.
 *
 * Which board: the one whose active or future sprint the card is in; else, for a card in no sprint, the project's
 * only board with sprints. Two scrum boards and a backlog card is no guess (null): one click would move the card into
 * another team's sprint. Nor is a card whose sprint no board read holds, or any board read that failed (null). A kanban board (no sprint, no future sprint) is never the answer. Ceiling: the first
 * BOARDS_MAX boards are read.
 */
import { useEffect, useState } from "react";
import type { JiraBoardContext, ProviderTask } from "../../../../../../shared/providers.ts";

export const BOARDS_MAX = 4;

export interface CardBoardReads {
  projectBoards: (key: string) => Promise<{ ok: boolean; boards?: readonly { id: string; name: string }[] }>;
  boardContext: (viewId: string) => Promise<JiraBoardContext>;
}

const hasSprints = (c: JiraBoardContext): boolean => !!c.sprint || !!c.futures?.length;
const holds = (c: JiraBoardContext, sprintId: string | undefined): boolean =>
  !!sprintId && (c.sprint?.id === sprintId || !!c.futures?.some((x) => x.id === sprintId));

/** The context of the card's board, or null when its project has no board with sprints or several could be it. */
export async function resolveCardBoard(t: Pick<ProviderTask, "customId" | "id" | "sprintId" | "sprintState">, reads: CardBoardReads): Promise<JiraBoardContext | null> {
  const key = (t.customId ?? t.id).split("-")[0]?.toUpperCase() ?? "";
  if (!key) return null;
  const r = await reads.projectBoards(key).catch(() => null);
  if (!r?.ok || !r.boards?.length) return null;
  const found: JiraBoardContext[] = [];
  let unread = false;
  for (const b of r.boards.slice(0, BOARDS_MAX)) {
    const c = await reads.boardContext(`board:${b.id}`).catch(() => null);
    // A board that did not answer could be the card's: no guess past it.
    if (!c?.ok) { unread = true; continue; }
    if (!hasSprints(c)) continue;
    if (holds(c, t.sprintId)) return c;
    found.push(c);
  }
  // A card whose active or future sprint no board holds is on a board not read: the one board left is not it.
  // A closed sprint is on no board's list, so it says nothing: that card is a backlog card.
  const open = !!t.sprintId && t.sprintState !== "closed";
  return !unread && !open && found.length === 1 ? found[0]! : null;
}

/** Every future sprint a board context holds: the one list the card menu and the Filters > Sprint group both offer. */
export const futuresOf = (c: JiraBoardContext | null | undefined): readonly { id: string; name: string; start?: number; end?: number }[] => c?.futures ?? (c?.next ? [c.next] : []);

/** The contexts (active + future sprints) of the boards of these projects, each read once by the server's own ten-minute keep. A board that fails is left out. */
export async function readBoardsOf(keys: readonly string[], reads: CardBoardReads): Promise<JiraBoardContext[]> {
  const out: JiraBoardContext[] = [];
  for (const key of keys) {
    const r = await reads.projectBoards(key).catch(() => null);
    if (!r?.ok) continue;
    for (const b of (r.boards ?? []).slice(0, BOARDS_MAX)) {
      const c = await reads.boardContext(`board:${b.id}`).catch(() => null);
      if (c?.ok && hasSprints(c)) out.push(c);
    }
  }
  return out;
}

/** The context the card menu reads sprints from: the board view's own, or the card's board resolved once per card. */
export function useCardBoard(t: ProviderTask | null, own: JiraBoardContext | null, reads: CardBoardReads | null): JiraBoardContext | null {
  const [got, setGot] = useState<{ id: string; c: JiraBoardContext | null } | null>(null);
  const need = !!t && !own && !!reads;
  useEffect(() => {
    if (!need || !t || !reads) return;
    let gone = false;
    void resolveCardBoard(t, reads).then((c) => { if (!gone) setGot({ id: t.id, c }); });
    return () => { gone = true; };
  }, [need, t?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (own) return own;
  return got && t && got.id === t.id ? got.c : null;
}

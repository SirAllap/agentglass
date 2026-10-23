/*
 * The Jira tab's decisions, apart from the screen so they can be asserted.
 *
 * When it asks again is lib/boardPoll.ts, the same rule the ClickUp board
 * follows: on arrival and on coming back to the window once the rows are a
 * minute old, a heartbeat every five minutes while focused, and Refresh at any
 * time. Counted for one open window that is at most 60 reads an hour from a
 * window that keeps losing and gaining focus, 12 from one that stays, and the
 * server keeps an answer for a minute (jira.ts `mine`), so a second window or a
 * phone asking inside it costs nothing.
 */
import type { ProviderTask } from "../../../shared/providers.ts";

export interface MineAnswer { ok: boolean; error?: string; throttled?: boolean; truncated?: boolean }

/** What to say above the rows, if anything. Rows that were already on screen stay: a failed read is never an empty list. */
export function mineNote(r: MineAnswer, hadRows: boolean): { text: string; bad: boolean } | null {
  if (!r.ok) {
    const why = r.error || "Jira did not answer";
    return { text: hadRows ? `${why}. These are the cards from the last read.` : why, bad: !r.throttled };
  }
  if (r.truncated) return { text: "Showing the most recently changed cards. Narrow it in Jira to see the rest.", bad: false };
  return null;
}

const norm = (s: string): string => s.trim().toLowerCase();

/** The row a jump from the bell or a pull request means: by key, or by Jira's own id. */
export function rowFor(rows: ProviderTask[], query: string): ProviderTask | undefined {
  const q = norm(query);
  return q ? rows.find((t) => norm(t.customId ?? "") === q || norm(t.id) === q) : undefined;
}

/**
 * The list with one card replaced by what a write answered. Same array when
 * the card is not in it, so a list that does not hold it does not redraw. A
 * card that no longer belongs (handed off, given away) stays until the next
 * read: a row vanishing under the pointer that just pressed it reads as lost.
 */
export function replaceTask(rows: ProviderTask[], t: ProviderTask): ProviderTask[] {
  const i = rows.findIndex((r) => r.id === t.id);
  if (i < 0) return rows;
  const next = rows.slice();
  next[i] = t;
  return next;
}

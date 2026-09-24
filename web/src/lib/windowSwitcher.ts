/*
 * The window switcher, as decisions: which rows, in which order, and where the
 * "next one waiting for you" key goes.
 *
 * Past twenty windows the strip stops being the way to find one — every product
 * that stays usable at that size routes around its tab bar with a searchable
 * list instead of making the bar bigger. This is that list, over every window
 * on the tmux server rather than only the attached session's, ordered by what
 * needs you: a question first, then an error, then work, then a finish.
 */
import type { AgentPane } from "../../../shared/types.ts";
import { statusRank, worstStatus, type WindowStatus } from "../../../shared/windowStatus.ts";
import { scoreMatch } from "./finderQuery.ts";

export interface SwitcherRow {
  windowId: string;
  /** tmux's session id and name — the id is what focusing needs, the name is
   *  what a person reads. */
  sessionId: string;
  session: string;
  index: number;
  name: string;
  /** The project the window is working in, by its folder name — the main
   *  checkout's, for a worktree; the directory's own name outside a repository
   *  or while the server is still resolving it. */
  repo: string;
  /** The pane to land in: the one whose agent is most urgent, else the first. */
  paneId: string;
  status?: WindowStatus;
  attached: boolean;
}

const lastSegment = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

/**
 * One row per window, from the per-pane list the server already answers.
 *
 * A window can appear under two sessions — a phone joins as a grouped session
 * that shares the desk's windows — and it is the same window, so it is one row,
 * under the session somebody has on a screen. Popups are left out: a scratchpad
 * shown over another session is not a place to go.
 */
export function windowsFromPanes(panes: readonly AgentPane[]): SwitcherRow[] {
  const byWindow = new Map<string, AgentPane[]>();
  for (const p of panes) {
    if (p.popup) continue;
    const list = byWindow.get(p.windowId);
    if (list) list.push(p); else byWindow.set(p.windowId, [p]);
  }
  const rows: SwitcherRow[] = [];
  for (const [windowId, list] of byWindow) {
    // The session a person is looking at, when the window is in more than one.
    const home = list.find((p) => p.attached) ?? list[0]!;
    const own = list.filter((p) => p.session === home.session);
    const status = worstStatus(own.map((p) => p.status));
    const lead = (status && own.find((p) => p.status === status)) || own[0]!;
    rows.push({
      windowId,
      sessionId: home.sessionId,
      session: home.session,
      index: Number(home.windowIndex) || 0,
      name: home.windowName,
      repo: lastSegment(lead.repo || lead.path),
      paneId: lead.paneId,
      status,
      attached: home.attached !== false,
    });
  }
  return rows;
}

/**
 * Filtered by the query and put in order.
 *
 * With nothing typed the order is urgency, then the session somebody is
 * looking at, then tmux's own order. With a query it is first HOW it matched —
 * the name starting with it, then containing it, then the folder or session,
 * then letters in order, which are `scoreMatch`'s tiers — and inside a tier,
 * urgency. Not the raw score: inside a tier it is mostly the name's length,
 * and "acme" put `acme-ci` above the `acme-1042` that was waiting for you
 * only because its name is shorter.
 *
 * Not ordered by recency inside a status: the pane list carries no activity
 * time. Adding `window_activity` to the server's pane format is what that
 * would take, and it is not here.
 */
export function rankWindows(rows: readonly SwitcherRow[], query: string): SwitcherRow[] {
  const q = query.trim();
  const byUrgency = (a: SwitcherRow, b: SwitcherRow) =>
    statusRank(a.status) - statusRank(b.status)
    || Number(b.attached) - Number(a.attached)
    || a.session.localeCompare(b.session)
    || a.index - b.index;
  if (!q) return [...rows].sort(byUrgency);
  const scored: { r: SwitcherRow; s: number }[] = [];
  for (const r of rows) {
    const s = scoreMatch(`${r.session}/${r.repo}/${r.name}`, q, false);
    if (s >= 0) scored.push({ r, s });
  }
  // scoreMatch's own bands: name starts with it (800+), name contains it
  // (600–800), the folder or session contains it (~600), letters in order (≤400).
  const tier = (s: number) => (s >= 800 ? 3 : s > 600 ? 2 : s > 400 ? 1 : 0);
  return scored.sort((a, b) => tier(b.s) - tier(a.s) || byUrgency(a.r, b.r) || b.s - a.s).map((x) => x.r);
}

/**
 * The next row waiting for you after `from`, wrapping round; `from` itself if
 * it is the only one, and -1 when nothing is waiting. Pressing the switcher's
 * chord again walks these, so a desk with three questions open is three
 * presses from answering all of them.
 */
export function nextWaiting(rows: readonly SwitcherRow[], from: number): number {
  const n = rows.length;
  for (let step = 1; step <= n; step++) {
    const i = (((from + step) % n) + n) % n;
    if (rows[i]!.status === "waiting") return i;
  }
  return -1;
}

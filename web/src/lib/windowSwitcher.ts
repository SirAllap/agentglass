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
  /** The folder the window is working in, by its last segment. */
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
      repo: lastSegment(lead.path),
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
 * looking at, then tmux's own order. With a query it is how well it matched —
 * the name before the folder before the session, because `scoreMatch` weighs
 * the last path segment highest — and urgency only breaks ties.
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
  return scored.sort((a, b) => b.s - a.s || byUrgency(a.r, b.r)).map((x) => x.r);
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

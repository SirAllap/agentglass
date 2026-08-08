/**
 * "The agent in this tab finished its turn" — the honest version of the signal
 * the tmux activity flag could not give.
 *
 * tmux's `#{window_activity}` only says "bytes came out of this window", which is
 * true of an agent WORKING, of nvim redrawing itself, and of every window at once
 * the instant the desk re-attaches. None of those is "done". What is actually
 * wanted is narrower and the cockpit already has it: a Claude/agent transcript
 * ends a turn with a `Stop` (a subagent with `SubagentStop`), and `pane_agent`
 * knows which pane each session sits in. So "done" = the pane's agent's most
 * recent event is a Stop, and the desk has not looked at that pane since.
 *
 * A pane running nvim or a plain shell has no `pane_agent` row, so it never
 * lights — which is the whole point of not using the activity flag.
 */
import { setEventHook } from "./db.ts";
import { paneAgentNote } from "./panewt.ts";

/** The most recent event per session, kept in memory and fed from the one place
 *  every event lands (insertEvent). Only the type and time matter here: is the
 *  latest thing this session did the end of a turn, and when. */
const latestBySession = new Map<string, { type: string; ts: number }>();

/** Per pane, the event time the desk has already acknowledged by looking at the
 *  window. A finish only lights the tab if it is strictly newer than this, so
 *  viewing the tab puts the dot out and a *second* finish lights it again. */
const seenByPane = new Map<string, number>();

/** The turn-ending event types. A `Stop` is an agent's own turn; a
 *  `SubagentStop` is one of its subagents finishing, which is still news on the
 *  tab the parent is running in. */
const DONE_TYPES = new Set(["Stop", "SubagentStop"]);

/** Feed the latest-event map. Called for every event insertEvent takes, live or
 *  backfilled, so it is kept by max timestamp rather than call order — a cold
 *  backfill replays history out of order and must not leave an old event as the
 *  "latest". Cheap enough (a Map set) to run on the hot ingest path. */
export function noteEvent(sessionId: string, type: string, ts: number): void {
  if (!sessionId || !type || !Number.isFinite(ts)) return;
  const cur = latestBySession.get(sessionId);
  if (!cur || ts >= cur.ts) latestBySession.set(sessionId, { type, ts });
}

/** True when the pane holds an agent whose most recent event ended a turn, and
 *  that finish is newer than the last time the desk looked at the pane. */
export function paneFinished(paneId: string): boolean {
  const note = paneAgentNote(paneId);
  if (!note) return false; // no agent here (nvim, a shell) — never lights
  const latest = latestBySession.get(note.session_id);
  if (!latest || !DONE_TYPES.has(latest.type)) return false; // idle-never-ran, or mid-work
  return latest.ts > (seenByPane.get(paneId) ?? 0);
}

/** The desk is looking at these panes now: acknowledge up to each agent's latest
 *  event, so the dot goes out and only a strictly newer finish relights it.
 *  Acknowledging the event *time* (not wall-clock) keeps this immune to the skew
 *  between a transcript's timestamps and this process's clock. */
export function markSeen(paneIds: Iterable<string>): void {
  for (const p of paneIds) {
    const note = paneAgentNote(p);
    const latest = note ? latestBySession.get(note.session_id) : undefined;
    if (latest) seenByPane.set(p, latest.ts);
  }
}

/** Test seam: forget everything, standing in for a fresh process. */
export function __resetAgentDone(): void {
  latestBySession.clear();
  seenByPane.clear();
}

// Register with the one place every event lands. Done at module load — terminal.ts
// imports paneFinished/markSeen, so this runs at startup, before the backfill
// sweep, and no event is missed.
setEventHook(noteEvent);

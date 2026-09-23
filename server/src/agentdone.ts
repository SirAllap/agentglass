/**
 * What the agent in a tab is doing — the honest version of the signal the tmux
 * activity flag could not give. It started as one bit, "finished its turn",
 * and is now the five states in `shared/windowStatus.ts`; the reasoning below
 * is why none of them comes from tmux.
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
import type { WindowStatus } from "../../shared/windowStatus.ts";

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

/**
 * The rest of what a tab's status needs, per session: when it last hit an error,
 * and which tool calls it has opened and not closed. A long build emits nothing
 * for minutes, and the open call is the only evidence it is working rather than
 * idle — the same reason the fleet keeps it (`derive.ts`).
 */
interface SessionExtra {
  lastErrorTs: number;
  /** Open tool calls by id (or `name:<tool>` when the agent sends no id), with
   *  when they opened. */
  open: Map<string, number>;
  /** Ids whose result already arrived. A cold backfill can replay a call's
   *  result before its start, and without this the start would open a call
   *  that finished long ago. Bounded, oldest out first. */
  closed: Set<string>;
  /** The last end of a turn: a call opened before it cannot still be running. */
  endedAt: number;
}
const extraBySession = new Map<string, SessionExtra>();
const OPEN_CAP = 64;
const CLOSED_CAP = 256;

/** Feed the latest-event map. Called for every event insertEvent takes, live or
 *  backfilled, so it is kept by max timestamp rather than call order — a cold
 *  backfill replays history out of order and must not leave an old event as the
 *  "latest". Cheap enough (a few Map sets) to run on the hot ingest path. */
export function noteEvent(
  sessionId: string, type: string, ts: number,
  extra?: { isError?: boolean; toolUseId?: string | null; toolName?: string | null; notice?: "permission" | "input" | null },
): void {
  if (!sessionId || !type || !Number.isFinite(ts)) return;
  /*
   * Only a Notification that is a BLOCKAGE counts as the session's latest
   * word. Claude Code also fires one about a minute after every Stop —
   * "waiting for your input" — which is the turn having ended, already said
   * by the Stop; taken as a question, it turned every finished tab into
   * "waiting for you" for half an hour, including the one being looked at,
   * and the switcher's waiting-first list into a list of finished agents.
   * News ("usage limit reset") says nothing about the session either.
   */
  if (type === "Notification" && extra?.notice !== "permission") return;
  const cur = latestBySession.get(sessionId);
  if (!cur || ts >= cur.ts) latestBySession.set(sessionId, { type, ts });

  let x = extraBySession.get(sessionId);
  if (!x) extraBySession.set(sessionId, (x = { lastErrorTs: 0, open: new Map(), closed: new Set(), endedAt: 0 }));
  if (extra?.isError && ts > x.lastErrorTs) x.lastErrorTs = ts;
  const key = extra?.toolUseId || (extra?.toolName ? `name:${extra.toolName}` : "");
  if (type === "PreToolUse" && key && !x.closed.has(key) && ts > x.endedAt) {
    x.open.set(key, ts);
    if (x.open.size > OPEN_CAP) x.open.delete(x.open.keys().next().value!);
  } else if ((type === "PostToolUse" || type === "PostToolUseFailure") && key) {
    x.open.delete(key);
    // Named calls are not unique — the next Bash reuses the key — so only ids
    // are remembered as closed.
    if (extra?.toolUseId) {
      x.closed.add(key);
      if (x.closed.size > CLOSED_CAP) x.closed.delete(x.closed.values().next().value!);
    }
  } else if (type === "Stop" || type === "SessionEnd") {
    if (ts > x.endedAt) x.endedAt = ts;
    for (const [k, at] of x.open) if (at <= ts) x.open.delete(k);
  }
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

/*
 * The thresholds are the fleet's (`web/src/lib/derive.ts`), copied rather than
 * shared because that file is the browser's and this one runs on the ingest
 * path. If one moves, the other should: a tab that says "working" while the
 * card says "idle" is two answers to one question.
 *
 * One difference, chosen: a question is `waiting` here for the fleet's
 * WAIT_STALE_MS (30 min), not its five-minute idle cut. The fleet card turns
 * an unanswered question grey and says "unanswered"; a tab has no second line
 * to say that on, and an agent stopped on a permission prompt is still
 * stopped on you at minute six.
 */
/** Quiet for this long with nothing open is no longer working. */
const STALL_MS = 20_000;
/** A question nobody answered for this long is abandoned, not waiting. */
const WAIT_STALE_MS = 30 * 60_000;
/** An open call older than this is lost, not long. */
const TOOL_RUN_MAX_MS = 30 * 60_000;
/** A turn that ends this soon after an error ended ON the error. */
const ERROR_TAIL_MS = 60_000;

const ASKED = new Set(["PermissionRequest", "Notification"]);

/**
 * What the agent in this pane is doing, or undefined when there is no agent in
 * it (nvim, a plain shell) — which is not the same answer as idle.
 *
 * The fleet's ladder, top to bottom: a question outranks everything; a turn
 * that ended is `done` until the desk looks (the same seen-rule as the green
 * name had), or `error` if it ended on one; a recent error is `error`; recent
 * events or an open tool call are `working`; the rest is `idle`.
 */
export function paneStatus(paneId: string, now = Date.now()): WindowStatus | undefined {
  const note = paneAgentNote(paneId);
  if (!note) return undefined;
  const latest = latestBySession.get(note.session_id);
  // The hook reported an agent here but no event has reached this process
  // since it started: an agent that ran before the restart and has not moved.
  if (!latest) return "idle";
  const x = extraBySession.get(note.session_id);
  const lastErrorTs = x?.lastErrorTs ?? 0;
  const since = now - latest.ts;
  const unseen = latest.ts > (seenByPane.get(paneId) ?? 0);

  if (ASKED.has(latest.type)) return since < WAIT_STALE_MS ? "waiting" : "idle";
  if (latest.type === "SessionEnd") return "idle";
  if (DONE_TYPES.has(latest.type)) {
    if (!unseen) return "idle";
    return lastErrorTs && latest.ts - lastErrorTs < ERROR_TAIL_MS ? "error" : "done";
  }
  if (lastErrorTs && now - lastErrorTs < STALL_MS) return "error";
  let running = false;
  if (x) for (const at of x.open.values()) if (now - at < TOOL_RUN_MAX_MS) { running = true; break; }
  if (since < STALL_MS || running) return "working";
  // Went quiet on an error without ever ending the turn: the run died.
  if (unseen && lastErrorTs && latest.ts - lastErrorTs < ERROR_TAIL_MS) return "error";
  return "idle";
}

/** Test seam: forget everything, standing in for a fresh process. */
export function __resetAgentDone(): void {
  latestBySession.clear();
  extraBySession.clear();
  seenByPane.clear();
}

// Register with the one place every event lands. Done at module load — terminal.ts
// imports paneStatus/markSeen, so this runs at startup, before the backfill
// sweep, and no event is missed.
setEventHook(noteEvent);

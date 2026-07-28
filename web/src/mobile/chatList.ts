// Which agents the Chats tab offers you, and in what order.
//
// The phone was listing every session the scanner had ever recorded: a hundred
// rows, most of them a day old, many named after their own id because they
// never wrote a first line. The desktop's Chats panel meanwhile lists the
// handful you are actually talking to. Same word, two different meanings, and
// the phone's meaning is the useless one — nobody opens a phone to scroll
// yesterday's telemetry.
//
// So the tab opens on the agents you could say something to now. History is
// still there, one tap or one search away, but it is not what you land on.

/** What the list is showing. */
export type ChatScope = "live" | "today" | "all";

export interface ListedSession {
  session_id: string;
  source_app?: string;
  ended_at?: number | null;
  last_seen: number;
  model_name?: string | null;
  cost_usd?: number;
  cwd_path?: string | null;
  project_path?: string | null;
  custom_title?: string | null;
  ai_title?: string | null;
  first_prompt?: string | null;
}

/** Sessions with a running owner (same rule the rest of the app uses). */
const LIVE_MS = 120_000;
const DAY_MS = 86_400_000;

/**
 * Whether this session can be picked up where it left off.
 *
 * A resume needs a directory to run in. Rows recorded before agentglass tracked
 * one cannot be resumed in place, and that is a fact about the record rather
 * than a reason to hide the conversation — the transcript is still worth
 * reading, and the screen says so and offers the next move.
 */
export function canResume(s: ListedSession): boolean {
  return !!(s.cwd_path || s.project_path);
}

/**
 * The sessions this scope shows, newest first.
 *
 * `live` is what is running right now, `today` adds the last 24 hours — the
 * working day you might still want to pick up — and `all` is the archive.
 *
 * Nothing is hidden any more. This used to drop every row whose `model_name`
 * was `<synthetic>`, on the reasoning that such rows are telemetry rollups with
 * no transcript behind them. The reasoning was right about what those rows are
 * and wrong about how to spot one: `model_name` is the last model-bearing line
 * in the transcript, and Claude Code writes `<synthetic>` for an injected or
 * interrupted turn. So a real conversation that happened to end on one
 * disappeared from EVERY scope, including "all", with nothing to say it had.
 *
 * A list you cannot trust to contain your chat is worse than a longer list, and
 * the wall of rows the filter was aimed at is what search and the two narrower
 * scopes are for.
 */
export function scopeSessions<T extends ListedSession>(
  sessions: readonly T[],
  scope: ChatScope,
  now = Date.now(),
): T[] {
  const live = (s: T) => !s.ended_at && now - s.last_seen < LIVE_MS;
  const kept = sessions.filter((s) => {
    if (scope === "live") return live(s);
    if (scope === "today") return now - s.last_seen < DAY_MS;
    return true;
  });
  return kept.sort((a, b) => b.last_seen - a.last_seen);
}

/**
 * Which scope to open on.
 *
 * Landing on an empty list is worse than landing on a longer one, so the tab
 * opens on the narrowest scope that has something in it.
 */
export function openingScope(sessions: readonly ListedSession[], now = Date.now()): ChatScope {
  if (scopeSessions(sessions, "live", now).length) return "live";
  if (scopeSessions(sessions, "today", now).length) return "today";
  return "all";
}

/**
 * Sessions matching a typed query.
 *
 * There was no search at all, and the list only ever held forty rows, so a chat
 * from three days ago was not reachable by any means — "All" meant "the newest
 * forty" and said "All".
 *
 * Matches the title, the project, the model and the id, because those are the
 * four things somebody actually remembers about a conversation. Every term must
 * match something, so typing two words narrows rather than widens.
 */
export function searchSessions<T extends ListedSession>(sessions: readonly T[], query: string): T[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...sessions];
  return sessions.filter((s) => {
    const hay = [
      s.custom_title, s.ai_title, s.first_prompt, s.cwd_path, s.project_path,
      s.model_name, s.source_app, s.session_id,
    ].filter(Boolean).join(" ").toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

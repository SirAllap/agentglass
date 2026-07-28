// Which agents the Chats tab offers you, and in what order.
//
// The phone was listing every session the scanner had ever recorded: a
// hundred rows, most of them a day old, many of them named after their own id
// because they never wrote a first line, some of them `<synthetic>` rows that
// are not conversations at all. The desktop's Chats panel meanwhile lists the
// handful you are actually talking to. Same word, two different meanings, and
// the phone's meaning is the useless one — nobody opens a phone to scroll
// yesterday's telemetry.
//
// So this narrows it to the same idea the desktop has: agents you could say
// something to now. History is still reachable, one tap away, but it is not
// what the tab opens on.

/** What the list is showing. */
export type ChatScope = "live" | "today" | "all";

export interface ListedSession {
  session_id: string;
  ended_at?: number | null;
  last_seen: number;
  model_name?: string | null;
  cost_usd?: number;
}

/** Sessions with a running owner (same rule the rest of the app uses). */
const LIVE_MS = 120_000;
const DAY_MS = 86_400_000;

/**
 * A row that is not a conversation.
 *
 * `<synthetic>` sessions are rolled up from telemetry with no transcript
 * behind them, so opening one shows an empty thread and a composer that cannot
 * resume anything. They belong in the fleet views, not in a list of people to
 * talk to.
 */
export function isTalkable(s: ListedSession): boolean {
  return s.model_name !== "<synthetic>";
}

/**
 * The sessions this scope shows, newest first.
 *
 * `live` is what is running right now, `today` adds the last 24 hours — which
 * is the working day you might still want to pick up — and `all` is the
 * archive, unchanged from what the tab used to show by default.
 */
export function scopeSessions<T extends ListedSession>(
  sessions: readonly T[],
  scope: ChatScope,
  now = Date.now(),
): T[] {
  const live = (s: T) => !s.ended_at && now - s.last_seen < LIVE_MS;
  const kept = sessions.filter((s) => {
    if (!isTalkable(s)) return false;
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

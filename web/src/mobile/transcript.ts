// Which turns the phone draws, and in which direction.
//
// `SessionDetail.conversation` arrives newest-first: the server orders it that
// way so its size budget drops the oldest turns rather than the ones you opened
// the session to read (server/src/db.ts). Every reader has to turn it back
// round before drawing it, and the phone did not — it rendered the array as it
// came and took `slice(-40)`, which on a newest-first list is the OLDEST forty.
// A long session therefore opened on ancient history, newest at the top, with
// the turn you had just sent pinned below all of it.
//
// A chat reads downwards. That is not a preference, it is what every messaging
// app on the device has taught the person holding it.

/** One turn, reduced to what the ordering cares about. */
export interface Turn {
  ts: number;
}

/**
 * The newest `limit` turns, oldest first.
 *
 * Take from the head (newest-first input), then reverse — the other way round
 * keeps the wrong end of a long session.
 */
export function recentTurns<T extends Turn>(conversation: readonly T[] | undefined, limit = 40): T[] {
  return (conversation ?? []).slice(0, limit).reverse();
}

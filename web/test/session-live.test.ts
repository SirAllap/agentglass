// The gate that decides whether a session may be resumed.
//
// Worth testing on its own because getting it wrong is silently destructive:
// resuming a session that still has a running owner puts a second `claude` on
// the same transcript, and the damage shows up later as a mangled history
// rather than as an error anyone can see at the time.
import { expect, test } from "bun:test";
import { sessionIsLive, SESSION_LIVE_MS } from "../src/lib/derive.ts";

const NOW = 1_700_000_000_000;

test("a session that recorded an end is never live", () => {
  // Even one that spoke a moment ago: an explicit end is the strongest signal
  // there is, and it outranks recency.
  expect(sessionIsLive({ ended_at: NOW - 10, last_seen: NOW }, NOW)).toBe(false);
});

test("silence, not an end marker, is what retires an open session", () => {
  expect(sessionIsLive({ ended_at: null, last_seen: NOW - 1000 }, NOW)).toBe(true);
  expect(sessionIsLive({ ended_at: null, last_seen: NOW - SESSION_LIVE_MS - 1 }, NOW)).toBe(false);
});

test("the boundary counts as live", () => {
  // Ties go to "still running" — the cheap failure is refusing a resume, not
  // allowing one onto a transcript someone else owns.
  expect(sessionIsLive({ ended_at: null, last_seen: NOW - SESSION_LIVE_MS + 1 }, NOW)).toBe(true);
});

test("a missing ended_at is treated like a null one", () => {
  // Rows from before the column existed omit it entirely; they must still be
  // judged by recency rather than falling through as ended.
  expect(sessionIsLive({ last_seen: NOW }, NOW)).toBe(true);
});

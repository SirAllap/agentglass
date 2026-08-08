/*
 * What Home says is running, and what it says each agent is doing.
 *
 * The states are boundaries in time, which is exactly the kind of thing that
 * looks right on a screenshot taken at one moment and is wrong at another. So
 * they are pinned here, at the second, on both sides of every edge.
 */
import { describe, expect, test } from "bun:test";
import type { PendingGate, SessionRollup } from "../../shared/types.ts";
import { QUIET_MS, STALE_MS } from "../src/model/nowQueue.ts";
import { needingSomebody, runningAgents } from "../src/model/machine.ts";

const NOW = 1_800_000_000_000;

function session(id: string, spokeAgo: number, over: Partial<SessionRollup> = {}): SessionRollup {
  return {
    session_id: id,
    source_app: "claude",
    model_name: "claude-opus-4",
    project_path: "/home/x/code/agentglass",
    started_at: NOW - 3_600_000,
    ended_at: null,
    last_seen: NOW - spokeAgo,
    event_count: 10, tool_count: 4, error_count: 0,
    input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0,
    cost_usd: 0.1,
    ...over,
  };
}

function gate(id: string, sessionId: string, createdAgo: number): PendingGate {
  return {
    id, session_id: sessionId, source_app: "claude",
    tool_name: "Bash", summary: "rm -rf build", created: NOW - createdAgo,
  };
}

describe("what counts as running", () => {
  test("a session that ended is not, however recently it spoke", () => {
    const ended = session("a", 1_000, { ended_at: NOW - 500 });
    expect(runningAgents([ended], [], NOW)).toEqual([]);
  });

  test("silence past the queue's own cutoff drops it", () => {
    // Twelve hours. Past that, "idle" stops being a credible reading of a
    // session with no ended_at — the process almost certainly died without
    // writing one, and this screen would be an archive.
    const justInside = session("in", STALE_MS - 1_000);
    const justOutside = session("out", STALE_MS + 1_000);
    expect(runningAgents([justInside, justOutside], [], NOW).map((a) => a.session.session_id))
      .toEqual(["in"]);
  });

  test("a clock that has gone backwards does not produce a negative age", () => {
    // The phone's clock and the machine's are two clocks. `last_seen` arriving
    // from the future is a skew, not an event, and "-4m" on a card is the sort
    // of thing that gets read as the app being broken.
    const [agent] = runningAgents([session("skew", -5_000)], [], NOW);
    expect(agent?.quiet).toBe(0);
    expect(agent?.doing).toBe("working");
  });
});

describe("what each one is doing", () => {
  test("the three boundaries, on both sides of each", () => {
    const LIVE = 120_000; // chatList.ts's window, which this borrows rather than restates
    const rows = runningAgents([
      session("live-in", LIVE - 1_000),
      session("live-out", LIVE + 1_000),
      session("quiet-in", QUIET_MS - 1_000),
      session("quiet-out", QUIET_MS + 1_000),
    ], [], NOW);
    const doing = Object.fromEntries(rows.map((r) => [r.session.session_id, r.doing]));
    expect(doing).toEqual({
      "live-in": "working",
      "live-out": "thinking",
      "quiet-in": "thinking",
      "quiet-out": "stopped",
    });
  });

  test("a held gate outranks everything, including being live", () => {
    // The one state where the agent is stopped BY us. A session that spoke a
    // second ago and is now sitting on an open hook request is not "working" —
    // it is waiting, and saying otherwise is the lie this row exists to stop.
    const rows = runningAgents([session("a", 1_000)], [gate("g1", "a", 30_000)], NOW);
    expect(rows[0]?.doing).toBe("blocked");
    expect(rows[0]?.gate?.id).toBe("g1");
  });

  test("an agent stacked up behind two gates reads the older one", () => {
    // Because the age drawn on the row is how long it has been blocked, and
    // that is the first gate's clock, not the second's.
    const rows = runningAgents([session("a", 1_000)], [
      gate("new", "a", 5_000),
      gate("old", "a", 90_000),
    ], NOW);
    expect(rows[0]?.gate?.id).toBe("old");
  });

  test("a gate for a session nobody is listing is not attached to another one", () => {
    const rows = runningAgents([session("a", 1_000)], [gate("g", "somebody-else", 5_000)], NOW);
    expect(rows[0]?.doing).toBe("working");
    expect(rows[0]?.gate).toBeUndefined();
  });
});

describe("the order", () => {
  test("how much each row wants a person, not how alive it is", () => {
    /*
     * `stopped` above `working` is the whole point. An agent that has been
     * waiting six minutes for direction is the reason somebody picked the phone
     * up; one that is happily working is the reason to put it down. Sorting by
     * recency alone puts them the other way round, every time.
     */
    const rows = runningAgents([
      session("working", 5_000),
      session("stopped", QUIET_MS + 60_000),
      session("thinking", 130_000),
      session("blocked", 2_000),
    ], [gate("g", "blocked", 10_000)], NOW);
    expect(rows.map((r) => r.session.session_id))
      .toEqual(["blocked", "stopped", "working", "thinking"]);
  });

  test("inside a band, the one that spoke last is first", () => {
    const rows = runningAgents([
      session("older", 40_000),
      session("newer", 5_000),
    ], [], NOW);
    expect(rows.map((r) => r.session.session_id)).toEqual(["newer", "older"]);
  });
});

describe("the count Home says out loud", () => {
  test("only the ones that want somebody", () => {
    // Not the queue's number: that one also holds red builds and dead
    // containers, which are real and are not agents.
    const rows = runningAgents([
      session("blocked", 1_000),
      session("stopped", QUIET_MS + 1_000),
      session("working", 1_000),
      session("thinking", 130_000),
    ], [gate("g", "blocked", 1_000)], NOW);
    expect(needingSomebody(rows)).toBe(2);
  });
});

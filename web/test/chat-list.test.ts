// The phone's Chats tab listed every session ever recorded, which on a real
// machine is a hundred rows of yesterday. These pin the narrowing.
import { describe, expect, test } from "bun:test";
import { scopeSessions, openingScope, canResume, searchSessions } from "../src/mobile/chatList.ts";

const NOW = 1_800_000_000_000;
const s = (id: string, agoMs: number, extra: Record<string, unknown> = {}) => ({
  session_id: id,
  last_seen: NOW - agoMs,
  ended_at: null,
  model_name: "claude-opus-5",
  cost_usd: 1,
  ...extra,
});

const MIN = 60_000;
const HOUR = 3_600_000;

describe("scopeSessions", () => {
  const fleet = [
    s("working", 30_000),
    s("an-hour-ago", 2 * HOUR),
    s("yesterday", 30 * HOUR),
    s("ended", 30_000, { ended_at: NOW - 20_000 }),
  ];

  test("live is what has a running owner", () => {
    expect(scopeSessions(fleet, "live", NOW).map((x) => x.session_id)).toEqual(["working"]);
  });

  test("today keeps the working day, not the archive", () => {
    expect(scopeSessions(fleet, "today", NOW).map((x) => x.session_id))
      .toEqual(["working", "ended", "an-hour-ago"]);
  });

  test("all keeps everything, newest first", () => {
    expect(scopeSessions(fleet, "all", NOW).map((x) => x.session_id))
      .toEqual(["working", "ended", "an-hour-ago", "yesterday"]);
  });

  test("a synthetic model name no longer hides a session", () => {
    /*
     * This asserted the opposite, and the reasoning behind it was half right:
     * some rows really are telemetry rollups with no transcript behind them,
     * and listing those is noise.
     *
     * The half that was wrong is how it spotted one. `model_name` is the last
     * model-bearing line in the transcript, and Claude Code writes
     * `<synthetic>` for an injected or interrupted turn — so a real
     * conversation that happened to end on one vanished from EVERY scope,
     * including "all", with nothing anywhere to say it had. A list you cannot
     * trust to contain your chat is worse than a longer list, and the wall of
     * rows this was aimed at is what search and the two narrower scopes are
     * for.
     */
    const withSynthetic = [...fleet, s("telemetry", 10_000, { model_name: "<synthetic>" })];
    expect(scopeSessions(withSynthetic, "all", NOW).some((x) => x.session_id === "telemetry")).toBe(true);
  });

  test("a session with nowhere to run is listed, and marked", () => {
    // It cannot be resumed in place; that is a fact about the record, not a
    // reason to hide the transcript.
    expect(canResume(s("orphan", 10_000))).toBe(false);
    expect(canResume(s("placed", 10_000, { cwd_path: "/home/x/code/app" }))).toBe(true);
    expect(scopeSessions([s("orphan", 10_000)], "all", NOW)).toHaveLength(1);
  });
});

describe("openingScope", () => {
  test("opens on what is working when something is", () => {
    expect(openingScope([s("a", 30 * MIN), s("b", 10_000)], NOW)).toBe("live");
  });

  test("falls back to today when nothing is running", () => {
    expect(openingScope([s("a", 3 * HOUR)], NOW)).toBe("today");
  });

  test("falls back to all rather than opening on an empty list", () => {
    expect(openingScope([s("a", 40 * HOUR)], NOW)).toBe("all");
    expect(openingScope([], NOW)).toBe("all");
  });
});

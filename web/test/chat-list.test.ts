// The phone's Chats tab listed every session ever recorded, which on a real
// machine is a hundred rows of yesterday. These pin the narrowing.
import { describe, expect, test } from "bun:test";
import { scopeSessions, openingScope, isTalkable } from "../src/mobile/chatList.ts";

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

  test("synthetic rollups are not conversations and never listed", () => {
    const withSynthetic = [...fleet, s("telemetry", 10_000, { model_name: "<synthetic>" })];
    expect(isTalkable(withSynthetic[4]!)).toBe(false);
    for (const scope of ["live", "today", "all"] as const) {
      expect(scopeSessions(withSynthetic, scope, NOW).some((x) => x.session_id === "telemetry")).toBe(false);
    }
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

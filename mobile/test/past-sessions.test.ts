/*
 * Past sessions: grouped, paged and searchable.
 *
 * The sheet used to draw eight rows and a sentence about the ones it had left.
 * A checkout that has run agents for a year has a hundred, and the one you want
 * is often the one you half remember — so paging past eight and a search that
 * reads titles, last lines and ids are both behaviour, not decoration.
 *
 * The chips are the third decision: they scope WHAT the search reads, and the
 * scope is a fact about the rows (this checkout, that one, the last week), never
 * a second request.
 *
 * Hand-built `AgentSessionRow`s, so a change in the route's shape cannot quietly
 * make this file pass.
 */
import { describe, expect, test } from "bun:test";
import type { AgentSessionRow } from "../../shared/types.ts";
import {
  PAGE, countLine, filterSessions, groupOf, groupsOf, matches, page, sessionLine,
} from "../src/model/pastSessions.ts";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const ROOT = "/home/dev/code/orbit";

const session = (id: string, over: Partial<AgentSessionRow> = {}): AgentSessionRow => ({
  id,
  title: "Add dark mode to the settings rail",
  opening: "make the settings rail follow the theme",
  last: "tests pass, three files changed",
  cwd: ROOT,
  at: NOW - 60 * 60_000,
  size: 1024,
  ...over,
});

/** Twelve in this checkout, plus one in a sibling worktree and one from last
 *  month: enough to page past eight and to see both chips work. */
const many: AgentSessionRow[] = [
  ...Array.from({ length: 12 }, (_, i) => session(`s${i}`, { at: NOW - i * 60_000 })),
  session("other", { cwd: "/home/dev/code/orbit-1050", title: "Keys: keep the last one on the bar", at: NOW - 2 * 60_000 }),
  session("old", { title: "Rename the phone's settings groups", at: NOW - 40 * 24 * 60 * 60_000 }),
];

describe("paging", () => {
  test("opens on eight and says how many are past it", () => {
    const rows = filterSessions(many, { chip: "all", root: ROOT, now: NOW });
    const first = page(rows);
    expect(first.rows.length).toBe(PAGE);
    expect(first.total).toBe(14);
    expect(first.more).toBe(6);
    expect(countLine(first)).toBe("8 of 14 shown");
  });

  test("a second press shows the rest and hides the line", () => {
    const rows = filterSessions(many, { chip: "all", root: ROOT, now: NOW });
    const second = page(rows, PAGE * 2);
    expect(second.rows.length).toBe(14);
    expect(second.more).toBe(0);
    expect(countLine(second)).toBe("14 sessions");
  });

  test("newest first, whatever order the route answered in", () => {
    const rows = filterSessions([...many].reverse(), { chip: "all", root: ROOT, now: NOW });
    expect(rows[0]?.id).toBe("s0");
    expect(rows.at(-1)?.id).toBe("old");
  });
});

describe("the chips", () => {
  test("this checkout excludes a sibling worktree of the same repository", () => {
    const rows = filterSessions(many, { chip: "checkout", root: ROOT, now: NOW });
    expect(rows.map((r) => r.id)).not.toContain("other");
    // Twelve today, plus the one from last month that also ran here.
    expect(rows.length).toBe(13);
  });

  test("all checkouts includes it", () => {
    const rows = filterSessions(many, { chip: "all", root: ROOT, now: NOW });
    expect(rows.map((r) => r.id)).toContain("other");
  });

  test("last 7 days drops a session from last month, and keeps the rest", () => {
    const rows = filterSessions(many, { chip: "week", root: ROOT, now: NOW });
    expect(rows.map((r) => r.id)).not.toContain("old");
    expect(rows.map((r) => r.id)).toContain("other");
  });
});

describe("search", () => {
  test("every word has to match, in any case", () => {
    expect(matches(session("s1"), "DARK rail")).toBe(true);
    expect(matches(session("s1"), "dark missing")).toBe(false);
  });

  test("reads the title, the opening line, the last line and the id", () => {
    expect(matches(session("s1", { title: "One" }), "three files")).toBe(true);
    expect(matches(session("s1", { opening: "the first ask" }), "first ask")).toBe(true);
    expect(matches(session("abc123"), "abc1")).toBe(true);
  });

  test("an empty query is every row, not none", () => {
    expect(matches(session("s1"), "   ")).toBe(true);
  });

  test("is scoped to the chip: a match in another checkout does not appear", () => {
    const query = "keys";
    const scoped = filterSessions(many, { chip: "checkout", root: ROOT, query, now: NOW });
    expect(scoped).toEqual([]);
    const wider = filterSessions(many, { chip: "all", root: ROOT, query, now: NOW });
    expect(wider.map((r) => r.id)).toEqual(["other"]);
  });
});

describe("groups", () => {
  test("a running session is filed as open now, whatever its age", () => {
    const running = session("open", {
      at: NOW - 40 * 24 * 60 * 60_000,
      openIn: {
        session: "work", sessionId: "$1", windowId: "@3", windowIndex: "3",
        windowName: "orbit-1042", paneId: "%9",
      },
    });
    expect(groupOf(running, NOW)).toBe("open");
  });

  test("today, this week and earlier are the local day, then six more", () => {
    expect(groupOf(session("a", { at: NOW - 60_000 }), NOW)).toBe("today");
    expect(groupOf(session("b", { at: NOW - 3 * 24 * 60 * 60_000 }), NOW)).toBe("week");
    expect(groupOf(session("c", { at: NOW - 20 * 24 * 60 * 60_000 }), NOW)).toBe("older");
  });

  test("only the groups with rows are drawn, in order", () => {
    const groups = groupsOf([
      session("today", { at: NOW - 60_000 }),
      session("old", { at: NOW - 20 * 24 * 60 * 60_000 }),
    ], NOW);
    expect(groups.map((g) => g.id)).toEqual(["today", "older"]);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Earlier"]);
  });
});

describe("the line under a session", () => {
  test("a running one says where, because that is what the tap does", () => {
    const running = session("s1", {
      openIn: {
        session: "work", sessionId: "$1", windowId: "@3", windowIndex: "3",
        windowName: "orbit-1042", paneId: "%9",
      },
    });
    expect(sessionLine(running, NOW)).toBe("open now in orbit-1042");
  });

  test("a finished one says the last thing said and how long ago", () => {
    expect(sessionLine(session("s1", { last: "three failures in web", at: NOW - 2 * 60 * 60_000 }), NOW))
      .toBe("three failures in web · 2h");
  });

  test("nothing said falls back to the first thing asked", () => {
    expect(sessionLine(session("s1", { last: "", at: NOW - 5 * 60_000 }), NOW))
      .toBe("make the settings rail follow the theme · 5m");
  });
});

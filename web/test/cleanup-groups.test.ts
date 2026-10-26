/*
 * CLEAN UP, GROUPED BY WHY.
 *
 * The day this is shaped from: fourteen servers left by a deleted checkout,
 * three apps started more than once, one nightly schedule whose time passed
 * fifty-one days ago. Invented ports and names; the shapes are the real ones.
 */
import { describe, expect, test } from "bun:test";
import { groupCleanup, stackShares, isDeadSchedule, CHIPS_SHOWN } from "../src/lib/cleanupGroups.ts";
import type { Forgotten } from "../src/lib/portsForgotten.ts";
import type { PortEntry } from "../../shared/types.ts";

const NOW = 1_800_000_000_000;
const DAY = 86_400;
let pid = 1000;
const port = (n: number, over: Partial<PortEntry> = {}): Forgotten => ({
  why: [],
  port: {
    port: n, addr: "127.0.0.1", proc: "bun", pid: pid++, cwd: "/home/a/code/orbit-web", mine: true, ageSec: DAY, fromAgent: false,
    cwdGone: false, ancestry: [], publicBind: false, exeGone: false, dir: "/home/a/code/orbit-web", tmpLeftover: false, duplicate: false, idleSec: null, ...over,
  },
});

describe("where each server goes", () => {
  test("a deleted checkout is Left behind, with the ports as chips and the pids the button stops", () => {
    const f = Array.from({ length: 14 }, (_, i) => port(3000 + i, { cwdGone: true, ageSec: 51 * DAY }));
    const { groups, total } = groupCleanup(f, [], NOW);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.kind).toBe("left-behind");
    expect(g.count).toBe(14);
    expect(g.button).toBe("Stop all 14");
    expect(g.sub).toBe("folder deleted");
    expect(g.chips.map((c) => c.label)).toEqual([":3000", ":3001", ":3002", ":3003", ":3004"]);
    expect(g.chips).toHaveLength(CHIPS_SHOWN);
    expect(g.more).toBe(9);
    expect(g.pids).toHaveLength(14);
    expect(g.oldestDays).toBe(51);
    expect(total).toBe(14);
  });

  test("a server is in ONE group: a duplicate whose folder is gone is left behind, not both", () => {
    const { groups, total } = groupCleanup([port(5173, { cwdGone: true, duplicate: true })], [], NOW);
    expect(groups.map((g) => g.kind)).toEqual(["left-behind"]);
    expect(total).toBe(1);
  });

  test("duplicates: the newest of each set stays, the rest are 'older'", () => {
    const f = [
      port(5173, { ageSec: 9 * DAY, duplicate: true, dir: "/w/a" }), port(5174, { ageSec: 2 * DAY, duplicate: true, dir: "/w/a" }), port(5175, { ageSec: 5 * DAY, duplicate: true, dir: "/w/a" }),
      port(4000, { ageSec: 4 * DAY, duplicate: true, dir: "/w/b", proc: "node" }), port(4001, { ageSec: 1 * DAY, duplicate: true, dir: "/w/b", proc: "node" }),
    ];
    const g = groupCleanup(f, [], NOW).groups[0]!;
    expect(g.kind).toBe("duplicates");
    expect(g.count).toBe(3);
    expect(g.button).toBe("Stop 3 older");
    expect(g.chips.map((c) => c.label)).toEqual([":5174 x3", ":4001 x2"]);
    /* The pids stopped are never the newest of a set. */
    const keep = [f[1]!.port.pid, f[4]!.port.pid];
    expect(g.pids.some((p) => keep.includes(p))).toBe(false);
    expect(g.pids).toHaveLength(3);
    expect(g.oldestDays).toBe(9);
  });

  test("a server that is only idle gets its own group, so it is not dropped", () => {
    const g = groupCleanup([port(6006, { idleSec: 3 * DAY })], [], NOW).groups[0]!;
    expect(g.kind).toBe("idle");
    expect(g.oldestDays).toBe(3);
  });

  test("a server with no pid is counted but never sent to the kill route", () => {
    const g = groupCleanup([port(3000, { cwdGone: true, pid: null }), port(3001, { cwdGone: true })], [], NOW).groups[0]!;
    expect(g.count).toBe(2);
    expect(g.pids).toHaveLength(1);
  });
});

describe("a schedule that will never fire", () => {
  const s = (id: string, due: number, firedAt: number | null = null) => ({ id, name: "Nightly dependency check", due, firedAt });
  test("unfired and well past its time is dead; fired, upcoming and just-late are not", () => {
    expect(isDeadSchedule(s("a", NOW - 51 * DAY * 1000), NOW)).toBe(true);
    expect(isDeadSchedule(s("b", NOW - 51 * DAY * 1000, NOW - 50 * DAY * 1000), NOW)).toBe(false);
    expect(isDeadSchedule(s("c", NOW + 3_600_000), NOW)).toBe(false);
    expect(isDeadSchedule(s("d", NOW - 60_000), NOW)).toBe(false);
  });
  test("it is a group of one, named for the schedule, with a Remove", () => {
    const g = groupCleanup([], [s("sch-1", NOW - 51 * DAY * 1000)], NOW).groups[0]!;
    expect(g).toMatchObject({ kind: "schedule", count: 1, title: "Dead schedule", sub: "Nightly dependency check", button: "Remove", scheduleIds: ["sch-1"], oldestDays: 51 });
  });
});

describe("the tile's bar", () => {
  test("one segment per kind, as a share of the total, never thinner than 2 percent", () => {
    const f = [
      ...Array.from({ length: 14 }, (_, i) => port(3000 + i, { cwdGone: true })),
      ...Array.from({ length: 3 }, (_, i) => port(5173 + i, { duplicate: true, ageSec: (i + 1) * DAY })),
    ];
    const { groups, total } = groupCleanup(f, [{ id: "x", name: "n", due: NOW - 5 * DAY * 1000, firedAt: null }], NOW);
    expect(total).toBe(14 + 2 + 1);
    const shares = stackShares(groups);
    expect(shares.map((x) => x.kind)).toEqual(["left-behind", "duplicates", "schedule"]);
    expect(shares[0]!.pct).toBe(82);
    expect(Math.min(...shares.map((x) => x.pct))).toBeGreaterThanOrEqual(2);
  });
  test("nothing to clean is no bar", () => {
    expect(stackShares([])).toEqual([]);
  });
});

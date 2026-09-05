/*
 * "At 08:00 start this agent" — a reminder whose firing is a start.
 */
import { describe, expect, test, beforeEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../src/db.ts";
import { whenFrom, addSchedule, cancelSchedule, listSchedules, drainDueSchedules } from "../src/agentschedule.ts";

const NOW = new Date(2026, 8, 5, 12, 0, 0, 0).getTime();
beforeEach(() => { db.exec("DELETE FROM agent_schedule"); });

describe("when", () => {
  test("a clock time is today, or tomorrow once it has passed; a delay adds; a civil date-time resolves; nonsense is null", () => {
    expect(whenFrom("15:30", NOW)).toBe(new Date(2026, 8, 5, 15, 30).getTime());
    expect(whenFrom("08:00", NOW)).toBe(new Date(2026, 8, 6, 8, 0).getTime());
    expect(whenFrom("+30m", NOW)).toBe(NOW + 30 * 60_000);
    expect(whenFrom("+2h", NOW)).toBe(NOW + 2 * 3_600_000);
    expect(whenFrom("+1d", NOW)).toBe(NOW + 86_400_000);
    expect(whenFrom("2026-09-06 08:00", NOW, "UTC")).toBe(Date.UTC(2026, 8, 6, 8, 0));
    expect(whenFrom("soonish", NOW)).toBeNull();
    expect(whenFrom("25:00", NOW)).toBeNull();
    expect(whenFrom("+0m", NOW)).toBeNull();
  });
});

/* The checkout the rows point at lives inside a workspace root this file
   sets itself. `bun test` runs every suite in one process and in whatever
   order the runner's filesystem returns; a suite before this one that left
   AGENTGLASS_ROOT set made "/tmp" fall outside the open project on the CI
   runner and not on a developer machine — the same test, two answers. */
let jail = "";
let WT = "";
let rootBefore: string | undefined;
beforeAll(() => {
  jail = mkdtempSync(join(tmpdir(), "agx-sched-"));
  WT = join(jail, "wt");
  mkdirSync(WT);
  rootBefore = process.env.AGENTGLASS_ROOT;
  process.env.AGENTGLASS_ROOT = jail;
});
afterAll(() => {
  if (rootBefore === undefined) delete process.env.AGENTGLASS_ROOT; else process.env.AGENTGLASS_ROOT = rootBefore;
  rmSync(jail, { recursive: true, force: true });
});

describe("the row", () => {
  test("refuses a bad name, a checkout outside the project, a past time, a far time, and yolo when Settings say no", () => {
    process.env.AGENTGLASS_CHAT_BYPASS = "0";
    expect(addSchedule({ name: "no good", cwd: WT, when: "+5m" }, NOW)).toMatchObject({ ok: false, error: expect.stringContaining("name") });
    expect(addSchedule({ name: "w", cwd: "/definitely/not/here", when: "+5m" }, NOW)).toMatchObject({ ok: false, error: expect.stringContaining("not in the open project") });
    const r1 = addSchedule({ name: "w", cwd: WT, when: "2020-01-01 08:00" }, NOW);
    expect(r1.ok).toBe(false);
    const r2 = addSchedule({ name: "w", cwd: WT, when: "+40d" }, NOW);
    expect(r2).toMatchObject({ ok: false, error: expect.stringContaining("month") });
    expect(addSchedule({ name: "w", cwd: WT, when: "+5m", yolo: true }, NOW)).toMatchObject({ ok: false, error: expect.stringContaining("Settings") });
    delete process.env.AGENTGLASS_CHAT_BYPASS;
  });
  test("is written, listed waiting first, and cancelled once — never twice", () => {
    const a = addSchedule({ name: "w1", cwd: WT, when: "+5m", prompt: "hello" }, NOW);
    expect(a.ok).toBe(true);
    const id = (a as { schedule: { id: string } }).schedule.id;
    const list = listSchedules();
    expect(list.map((s) => s.name)).toEqual(["w1"]);
    expect(list[0]).toMatchObject({ cwd: WT, prompt: "hello", yolo: false, firedAt: null, due: NOW + 5 * 60_000 });
    expect(cancelSchedule(id)).toBe(true);
    expect(cancelSchedule(id), "already cancelled").toBe(false);
    expect(listSchedules()).toEqual([]);
  });
});

describe("firing", () => {
  test("claims what is due, starts it by a free name, writes back what happened, and never fires twice", async () => {
    const insert = db.query("INSERT INTO agent_schedule (id, name, cwd, kind, prompt, yolo, due, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run("d1", "nightly", WT, "claude", "run it", 1, NOW - 1000, NOW - 60_000);
    insert.run("d2", "later", WT, "claude", "", 0, NOW + 60_000, NOW - 60_000);
    insert.run("d3", "gone", "/definitely/not/here", "claude", "", 0, NOW - 5 * 60_000, NOW - 60_000);
    const started: unknown[] = [];
    const deps = {
      alive: async () => [{ name: "nightly" }, { name: "nightly-2" }],
      start: (async (p: { name: string; cwd: string; prompt?: string; yolo?: boolean }) => {
        started.push(p);
        return { ok: true as const, agent: { name: p.name, kind: "claude", cwd: p.cwd, paneId: "%9", windowId: "@9", startedAt: NOW, endedAt: null } };
      }) as never,
    };
    const fired = await drainDueSchedules(NOW, deps);
    expect(fired.map((s) => s.id).sort()).toEqual(["d1", "d3"]);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ name: "nightly-3", cwd: WT, prompt: "run it", yolo: true });
    const rows = listSchedules();
    expect(rows.find((s) => s.id === "d1")!.result).toBe("started as nightly-3 in pane %9");
    expect(rows.find((s) => s.id === "d3")!.result).toContain("no longer in the open project");
    expect(rows.find((s) => s.id === "d3")!.result).toContain("min late");
    expect(rows.find((s) => s.id === "d2")!.firedAt).toBeNull();
    expect(await drainDueSchedules(NOW, deps), "nothing is claimed twice").toEqual([]);
  });
});

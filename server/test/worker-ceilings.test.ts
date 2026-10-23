/*
 * The ceiling on a worker's turn, against a real tmux on a socket of its own. A
 * fake that never exits is gone when the limit comes, every process under its
 * window with it (checked by PID, never by a pattern that could match
 * somebody else's), the row says why, and the seat is told once.
 *
 * The limit is armed with a few hundred milliseconds here; the policy's own
 * minimum is a minute and nothing in this file waits for one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const SOCKET = `agx-ceil-${process.pid}`;
const SAVED = { sock: process.env.AGENTGLASS_TMUX_SOCKET, tmp: process.env.TMUX_TMPDIR };
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
process.env.TMUX_TMPDIR = TMUX_TEST_TMPDIR;

const AO = await import("../src/agentops.ts");
const { tmux, tmuxCapability } = await import("../src/tmuxpane.ts");
const { arm, armedDeadline, disarm, __dropTimers } = await import("../src/agents/ceilings.ts");
const { workersAfterRestart } = await import("../src/agents/policystart.ts");
const { db } = await import("../src/db.ts");
const { prepareRun, runFiles, wrapped } = await import("../src/agents/headless.ts");
const { unreadReports } = await import("../src/seatreport.ts");

const have = tmuxCapability().available;
const ROOT = "/home/a/code/orbit-ceil";
let dir = "";

/** A turn that never ends and whose Bash tool left a child in a session of its own. */
const stuckScript = () => {
  const s = join(dir, "stuck.sh");
  writeFileSync(s, `#!/bin/sh\nsetsid sleep 300 &\necho $! > "${dir}/orphan.pid"\nwhile :; do sleep 1; done\n`, { mode: 0o755 });
  return s;
};

async function startStuck(name: string, now = Date.now(), by: unknown = null) {
  const files = prepareRun(name, "do the thing", "none");
  // The one before left its own: this turn's is the one to wait for.
  rmSync(join(dir, "orphan.pid"), { force: true });
  const r = await AO.startAgent({
    root: ROOT, name, cwd: dir, kind: "claude", exactArgv: wrapped(files, [stuckScript()]), keep: true,
    lockedRole: true, yoloAllowed: false, now,
    owner: { seatRoot: ROOT, model: "m", startedBy: by, resumeId: null },
  });
  if (!r.ok) throw new Error(`did not start: ${r.error}`);
  return r.agent;
}

/** Every process under the window's pane, the pane's own included. */
async function tree(paneId: string): Promise<number[]> {
  const pane = Number((await tmux(["display-message", "-p", "-t", paneId, "#{pane_pid}"])).stdout.trim());
  const ps = Bun.spawnSync(["ps", "-e", "-o", "pid=,ppid="]).stdout.toString().trim().split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number) as [number, number]);
  const out = new Set([pane]);
  for (let grew = true; grew;) { grew = false; for (const [p, pp] of ps) if (out.has(pp) && !out.has(p)) { out.add(p); grew = true; } }
  return [...out];
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async <T,>(f: () => T | undefined | false, ms = 8000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) { const v = f(); if (v) return v as T; if (Date.now() > end) throw new Error("timed out"); await Bun.sleep(50); }
};

/** A row the way a start leaves it, without a window: these tests are about the timer. */
function row(name: string, paneId: string, startedAt: number, o: { adopted?: boolean; by?: unknown } = {}) {
  db.query(`INSERT INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at, adopted, seat_root, started_by, exit_code, exit_line)
    VALUES (?1, 'claude', ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, NULL, NULL)
    ON CONFLICT(name) DO UPDATE SET pane_id = ?3, window_id = ?4, started_at = ?5, ended_at = NULL, adopted = ?6, seat_root = ?7, started_by = ?8, exit_code = NULL, exit_line = NULL`)
    .run(name, dir, paneId, paneId.replace("%", "@"), startedAt, o.adopted ? 1 : 0, o.adopted ? null : ROOT, o.by ? JSON.stringify(o.by) : null);
  return AO.agentNamed(name)!;
}
/** The wrapper's last act: the status, written aside and moved in whole. */
function leaveStatus(name: string, code: number, err = "") {
  const f = runFiles(name);
  if (err) writeFileSync(f.err, err);
  writeFileSync(join(f.dir, "part", "rc"), `${code}\n`);
  renameSync(join(f.dir, "part", "rc"), f.rc);
}
const BY = { headless: true, turn: 1, turnMinutes: 1, role: "builder", engine: "claude", model: "m", position: 0, because: [], scope: "global", rule: "base", envelope: {} };

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "agx-ceil-")); mkdirSync(join(dir, "x")); });
afterAll(async () => {
  if (have) await tmux(["kill-server"]);
  if (dir) rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of [["AGENTGLASS_TMUX_SOCKET", SAVED.sock], ["TMUX_TMPDIR", SAVED.tmp]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe("a turn that never ends", () => {
  test("is gone at the limit, with everything under its window, and the row says timeout", async () => {
    if (!have) return;
    const intervals: unknown[] = [];
    const realSet = globalThis.setInterval;
    globalThis.setInterval = ((...a: unknown[]) => { intervals.push(a); return (realSet as any)(...a); }) as typeof setInterval;
    try {
      const a = await startStuck("w-stuck");
      await until(() => existsSync(join(dir, "orphan.pid")));
      const pids = [...await tree(a.paneId), Number(readFileSync(join(dir, "orphan.pid"), "utf8"))];
      expect(pids.length).toBeGreaterThan(3);
      expect(pids.every(alive)).toBe(true);

      const woken: [string, string][] = [];
      arm(a, { deadline: Date.now() + 700, limitMinutes: 30, files: runFiles("w-stuck"), ended: () => {}, wake: async (r, n) => { woken.push([r, n]); return true; } });
      expect(armedDeadline("w-stuck")).not.toBeNull();

      const row = await until(() => { const r = AO.agentNamed("w-stuck"); return r?.exitCode !== undefined ? r : undefined; });
      expect(row.exitLine).toMatch(/^timeout/);
      expect(row.exitCode).toBe(124);
      await until(() => pids.every((p) => !alive(p)));
      await until(() => AO.agentNamed("w-stuck")?.endedAt !== null);
      expect(armedDeadline("w-stuck")).toBeNull();

      // One report to the seat, one wake: not one per step of the cleanup.
      await until(() => woken.length > 0);
      const reports = unreadReports(ROOT).filter((r) => r.agent === "w-stuck");
      expect(reports.length).toBe(1);
      expect(reports[0]!.blocked).toMatch(/limit/i);
      expect(woken).toEqual([[ROOT, "w-stuck"]]);
      // ...and arming, firing and cleaning up asked for no interval.
      expect(intervals).toEqual([]);
    } finally { globalThis.setInterval = realSet; }
  });

  test("a turn that ends first is left alone: no timeout row, no report, the timer is gone", async () => {
    if (!have) return;
    const a = await startStuck("w-early");
    let ended = "";
    arm(a, { deadline: Date.now() + 60_000, limitMinutes: 30, files: runFiles("w-early"), ended: (n) => { ended = `${n}:exit`; }, wake: async () => true });
    leaveStatus("w-early", 0);
    await until(() => ended);
    expect(ended).toBe("w-early:exit");
    expect(armedDeadline("w-early")).toBeNull();
    expect(AO.agentNamed("w-early")?.exitLine ?? "").not.toMatch(/timeout/);
    expect(unreadReports(ROOT).filter((r) => r.agent === "w-early")).toEqual([]);
    await AO.stopAgent(AO.agentNamed("w-early")!, Date.now(), true);
  });
});

describe("the timer itself", () => {
  test("one timeout to the deadline for a whole turn, and it is cleared when the worker is let go", async () => {
    const asked: number[] = [], cleared: unknown[] = [];
    const real = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
    // Counted by who asked: the suite shares one process, and its other files have timers of their own.
    globalThis.setTimeout = ((f: () => void, ms?: number, ...r: unknown[]) => {
      if (/agents\/ceilings\.ts/.test(new Error().stack ?? "")) asked.push(ms ?? 0);
      return (real.set as any)(f, ms, ...r);
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((t: unknown) => { cleared.push(t); return (real.clear as any)(t); }) as typeof clearTimeout;
    try {
      const a = row("w-quiet", "%900010", Date.now());
      prepareRun("w-quiet", "do the thing", "none");
      arm(a, { deadline: Date.now() + 60_000, limitMinutes: 1, files: runFiles("w-quiet"), ended: () => {}, wake: async () => true });
      // A second of a turn that has not ended: nothing looks again.
      await Bun.sleep(1000);
      expect(asked.length).toBe(1);
      expect(asked[0]).toBeGreaterThan(58_000);
      const before = cleared.length;
      disarm("w-quiet");
      expect(cleared.length - before).toBe(1);
      expect(armedDeadline("w-quiet")).toBeNull();
    } finally { globalThis.setTimeout = real.set; globalThis.clearTimeout = real.clear; }
  });

  test("the source asks for one timeout and no interval", async () => {
    const src = readFileSync(new URL("../src/agents/ceilings.ts", import.meta.url), "utf8").split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
    expect(src.match(/setTimeout\(/g)?.length).toBe(1);
    expect(src).not.toMatch(/setInterval/);
  });

  test("a status left whole is read at the one event it makes", async () => {
    const a = row("w-once", "%900011", Date.now());
    prepareRun("w-once", "do the thing", "none");
    let ended = 0;
    arm(a, { deadline: Date.now() + 60_000, limitMinutes: 1, files: runFiles("w-once"), ended: () => { ended++; }, wake: async () => true });
    leaveStatus("w-once", 3, "Error: could not read the config\n");
    await until(() => ended);
    expect(AO.agentNamed("w-once")).toMatchObject({ exitCode: 3, exitLine: "Error: could not read the config" });
    expect(armedDeadline("w-once")).toBeNull();
  });
  test("the second turn under a name is seen like the first: its folder is emptied, not made again", async () => {
    let ended = 0;
    for (const [turn, pane] of [[1, "%900012"], [2, "%900013"]] as const) {
      const a = row("w-twice", pane, Date.now() + turn);
      const f = prepareRun("w-twice", "do the thing", "none");
      expect(existsSync(f.rc)).toBe(false);
      arm(a, { deadline: Date.now() + 60_000, limitMinutes: 1, files: f, ended: () => { ended++; }, wake: async () => true });
      // Not at once: a status that is there when the watch goes up is found by the first look, not by the watch.
      await Bun.sleep(150);
      leaveStatus("w-twice", turn);
      await until(() => ended === turn);
      expect(AO.agentNamed("w-twice")?.exitCode).toBe(turn);
    }
  });
});

describe("a name that changes hands", () => {
  test("stopping a worker takes its timer with it", async () => {
    const a = row("w-let-go", "%900001", Date.now());
    prepareRun("w-let-go", "do the thing", "none");
    arm(a, { deadline: Date.now() + 60_000, limitMinutes: 1, files: runFiles("w-let-go"), ended: () => {}, wake: async () => true });
    await AO.stopAgent(a, Date.now(), false);
    expect(armedDeadline("w-let-go")).toBeNull();
  });

  test("a timer that outlived its worker does not touch whoever has the name at the deadline", async () => {
    const a = row("w-reused", "%900001", Date.now() - 5000);
    prepareRun("w-reused", "do the thing", "none");
    const woken: string[] = [];
    arm(a, { deadline: Date.now() + 300, limitMinutes: 1, files: runFiles("w-reused"), ended: () => {}, wake: async (_, n) => { woken.push(n); return true; } });
    // The name is somebody's own tab now, written past every path that would have cleared the timer.
    row("w-reused", "%900002", Date.now(), { adopted: true });
    await Bun.sleep(900);
    const now = AO.agentNamed("w-reused")!;
    expect(now.exitCode).toBeUndefined();
    expect(now.endedAt).toBeNull();
    expect(now.paneId).toBe("%900002");
    expect(woken).toEqual([]);
    expect(unreadReports(ROOT).filter((r) => r.agent === "w-reused")).toEqual([]);
    expect(armedDeadline("w-reused")).toBeNull();
  });

  test("a worker stopped by hand is not a timeout when its minutes run out", async () => {
    const a = row("w-by-hand", "%900003", Date.now());
    prepareRun("w-by-hand", "do the thing", "none");
    arm(a, { deadline: Date.now() + 300, limitMinutes: 1, files: runFiles("w-by-hand"), ended: () => {}, wake: async () => true });
    // Ended in the row with the timer still standing: what a stop looked like before it cleared one.
    db.query("UPDATE named_agent SET ended_at = ? WHERE name = 'w-by-hand'").run(Date.now());
    await Bun.sleep(900);
    expect(AO.agentNamed("w-by-hand")!.exitCode).toBeUndefined();
    expect(unreadReports(ROOT).filter((r) => r.agent === "w-by-hand")).toEqual([]);
  });
});

describe("a server restart", () => {
  test("never stops a worker by the ids it had before: the row says its ceiling was lost", async () => {
    if (!have) return;
    // Started two minutes ago under a one-minute limit: over it when the server comes back.
    const a = await startStuck("w-restart", Date.now() - 120_000, BY);
    await until(() => existsSync(join(dir, "orphan.pid")));
    // The pane's own process and the orphan only: the script's `sleep 1` loop children come and go
    // every second, and on a slow start one of them is in the tree here and gone by the check below.
    const pids = [(await tree(a.paneId))[0]!, Number(readFileSync(join(dir, "orphan.pid"), "utf8"))];
    __dropTimers();

    const back = await workersAfterRestart();
    expect(back.lost).toContain("w-restart");
    await Bun.sleep(1200);
    const now = AO.agentNamed("w-restart")!;
    expect(now.exitCode).toBeUndefined();
    expect(now.endedAt).toBeNull();
    expect(pids.every(alive)).toBe(true);
    expect(now.startedBy).toMatchObject({ ceilingLost: true });
    expect((now.startedBy as { because: string[] }).because.join("\n")).toMatch(/ceiling lost: restarted/);
    // No timer stands for it: only the end of its turn is still watched.
    expect(armedDeadline("w-restart")).toBeNull();
    // A second restart does not say it twice.
    await workersAfterRestart();
    expect((AO.agentNamed("w-restart")!.startedBy as { because: string[] }).because.filter((l) => /ceiling lost/.test(l))).toHaveLength(1);
    await AO.stopAgent(now, Date.now(), true);
  });

  test("a turn that failed while the server was away is settled without a word: no switch, no report", async () => {
    row("w-old", "%900020", Date.now() - 86_400_000, { by: BY });
    prepareRun("w-old", "do the thing", "none");
    leaveStatus("w-old", 1, "Error: rate limit reached, try again later\n");
    const back = await workersAfterRestart();
    expect(back.settled).toContain("w-old");
    await Bun.sleep(400);
    expect(AO.agentNamed("w-old")).toMatchObject({ exitCode: 1 });
    expect((AO.agentNamed("w-old")!.startedBy as { engine: string }).engine).toBe("claude");
    expect(unreadReports(ROOT).filter((r) => r.agent === "w-old")).toEqual([]);
  });
});

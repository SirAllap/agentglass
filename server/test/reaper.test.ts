/*
 * What a worker left behind is stopped; nothing else is.
 *
 * Measured on one machine on 2026-11-03: servers started from a worker's
 * `bash -c` were alive 28-37 h after its window closed, re-parented to
 * `systemd --user` and holding 8 GB. The halves are tested the way they fail: a
 * real process started with the launcher's own environment and orphaned the way
 * a `nohup … &` orphans it, a table for every clause of the rule, and a live
 * child that must survive because its owner's window is still on the engine.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OWNER_MIN_AGE_MS, OWNER_TMP_PREFIX, OWNER_TMP_VAR, OWNER_VAR, dropScratch, nobodyPids, ownScratchOf, ownerFromEnviron, ownerLaunch,
  ownerTmpDir, reapOwner, reapableOwned, reapOwned, scanOwned, startReaper, type OwnedProc,
} from "../src/reaper.ts";

const LINUX = process.platform === "linux";
const dirs: string[] = [];
const pids: number[] = [];

/** A directory this file made and must remove, not one an owner was given. */
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "reaper-test-"));
  dirs.push(d);
  return d;
}

afterAll(() => {
  // Nothing this file started outlives it, however far the test got.
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function gone(pid: number, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!alive(pid)) return true; await Bun.sleep(25); }
  return !alive(pid);
}

const row = (p: Partial<OwnedProc> & { pid: number }): OwnedProc => ({
  ppid: 1487, start: "1000", ageMs: 2 * 60 * 60_000, owner: "probe-a", tmp: "", mine: false, ...p,
});

const rule = { live: new Set<string>(), nobody: new Set([1, 1487]), minAgeMs: OWNER_MIN_AGE_MS };

describe("what the rule picks", () => {
  test("an orphaned process of an owner whose window is gone, older than an hour", () => {
    expect(reapableOwned([row({ pid: 10 })], rule).map((r) => r.pid)).toEqual([10]);
  });

  test("nothing while that owner's window is still on the engine", () => {
    const live = new Set(["probe-a"]);
    expect(reapableOwned([row({ pid: 10 })], { ...rule, live })).toEqual([]);
  });

  test("nothing younger than the hour: a worker still starting is not a leftover", () => {
    expect(reapableOwned([row({ pid: 10, ageMs: 59 * 60_000 })], rule)).toEqual([]);
    expect(reapableOwned([row({ pid: 10, ageMs: 61 * 60_000 })], rule).map((r) => r.pid)).toEqual([10]);
  });

  test("nothing whose parent is still there — a live launcher owns its children", () => {
    expect(reapableOwned([row({ pid: 10, ppid: 4242 })], rule)).toEqual([]);
  });

  test("nothing this server is, came from, or started", () => {
    expect(reapableOwned([row({ pid: 10, mine: true })], rule)).toEqual([]);
  });

  test("nothing with no owner said at all: a person's process is nobody's leftover", () => {
    expect(reapableOwned([row({ pid: 10, owner: "" })], rule)).toEqual([]);
  });

  test("one named owner, at any age, once its window is known to be gone", () => {
    const rows = [
      row({ pid: 10, owner: "probe-a", ageMs: 1_000 }),
      row({ pid: 11, owner: "probe-b", ageMs: 2 * 60 * 60_000 }),
    ];
    expect(reapableOwned(rows, { ...rule, only: "probe-a" }).map((r) => r.pid)).toEqual([10]);
  });
});

describe("the environment a launch stamps", () => {
  test("carries the owner and its own TMPDIR, on a directory under the temp dir", () => {
    const launched = ownerLaunch("probe-env");
    expect(launched.dir).toBe(ownerTmpDir("probe-env")!);
    expect(launched.env[OWNER_VAR]).toBe("probe-env");
    expect(launched.env.TMPDIR).toBe(launched.dir!);
    expect(existsSync(launched.dir!)).toBe(true);
    expect(statSync(launched.dir!).mode & 0o777).toBe(0o700);
    dirs.push(launched.dir!);
    rmSync(launched.dir!, { recursive: true, force: true });
  });

  test("is read back from /proc's NUL-separated environ, whatever else is in it", () => {
    const raw = `PATH=/usr/bin\u0000${OWNER_VAR}=probe-a\u0000${OWNER_TMP_VAR}=/tmp/${OWNER_TMP_PREFIX}probe-a\u0000`;
    expect(ownerFromEnviron(raw)).toEqual({ owner: "probe-a", tmp: `/tmp/${OWNER_TMP_PREFIX}probe-a` });
    expect(ownerFromEnviron("PATH=/usr/bin\u0000HOME=/home/dev\u0000")).toBeNull();
    expect(ownerFromEnviron(`${OWNER_VAR}=\u0000`)).toBeNull();
  });

  test("never names a path outside the temp dir, nor one this app did not make", () => {
    const mine = join(tmpdir(), OWNER_TMP_PREFIX + "probe-a");
    expect(ownScratchOf(mine, "probe-a")).toBe(mine);
    /* `AGX_OWNER_TMP` is inherited, so a window can carry the scratch of the
       worker that last ran in its session. Matching the prefix alone removed
       that worker's live scratch with its processes still writing in it. */
    expect(ownScratchOf(mine, "pr-12")).toBeNull();
    expect(ownScratchOf("/home/dev/code", "probe-a")).toBeNull();
    expect(ownScratchOf(`${tmpdir()}/not-ours`, "probe-a")).toBeNull();
    expect(ownScratchOf(join(tmpdir(), "..", "escape", OWNER_TMP_PREFIX + "probe-a"), "probe-a")).toBeNull();
    expect(ownScratchOf(mine, "../../etc")).toBeNull();
  });

  test("refuses a name that could not be a window, and leaves TMPDIR alone", () => {
    const launched = ownerLaunch("../../etc");
    expect(launched.dir).toBeNull();
    expect(launched.env.TMPDIR).toBeUndefined();
    expect(launched.env[OWNER_VAR]).toBe("../../etc");
  });
});

describe("a scratch a live process still holds", () => {
  test("is emptied at a start whose predecessor is gone, and left alone at one whose is not", () => {
    const dir = ownerTmpDir("probe-relaunch-kept")!;
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old"), "written by the run before");
    ownerLaunch("probe-relaunch-kept", () => true);
    expect(existsSync(join(dir, "old")), "the previous run's TMPDIR was emptied under it").toBe(true);
    ownerLaunch("probe-relaunch-kept", () => false);
    expect(existsSync(join(dir, "old"))).toBe(false);
  });

  test("is not removed by a launch whose window never opened, while one is still writing", () => {
    const dir = ownerTmpDir("probe-relaunch-drop")!;
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old"), "x");
    dropScratch(dir, () => true);
    expect(existsSync(join(dir, "old"))).toBe(true);
    dropScratch(dir, () => false);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("a liveness read that failed", () => {
  test("stops nothing, because an owner nobody could ask about is not a gone one", async () => {
    const sent: string[] = [];
    const removed: string[] = [];
    const mine = ownerTmpDir("probe-a")!;
    const yet = [row({ pid: 10, tmp: mine })];
    const deps = (live: () => ReadonlySet<string> | null) => ({
      live,
      scan: () => yet,
      nobody: () => new Set([1487]),
      signal: (p: number, sig: NodeJS.Signals) => { if (sig === "SIGTERM") sent.push(String(p)); },
      startOf: () => "1000",
      removeDir: (d: string) => { removed.push(d); },
      graceMs: 0,
    });
    // The premise, so the assertion below is not about a row the rule would
    // never have picked: this IS a leftover once the read says "no windows".
    expect((await reapOwned(deps(() => new Set()))).stopped).toBe(1);
    await Bun.sleep(20);
    expect(sent).toEqual(["10"]);
    expect(removed).toEqual([mine]);
    sent.length = 0;
    removed.length = 0;
    // And the same row is untouched when the read could not be made at all.
    const said = console.error;
    console.error = () => { /* the outage line is another test's subject */ };
    try {
      expect((await reapOwned(deps(() => null))).stopped).toBe(0);
      await Bun.sleep(20);
    } finally { console.error = said; }
    expect(sent).toEqual([]);
    expect(removed).toEqual([]);
  });

  test("says so once per outage, not once per look", async () => {
    const lines: string[] = [];
    const said = console.error;
    console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      // A read that works closes the outage; nothing counts before that.
      await reapOwned({ live: () => new Set(["probe-a"]), scan: () => [] });
      const unknown = () => ({ live: () => null, scan: () => [row({ pid: 10 })], signal: () => { /* nothing to send */ } });
      await reapOwned(unknown());
      await reapOwned(unknown());
      expect(lines.length).toBe(1);
      await reapOwned({ live: () => new Set(["probe-a"]), scan: () => [] });
      await reapOwned(unknown());
      expect(lines.length).toBe(2);
    } finally { console.error = said; }
  });

  test("still reaps an owner whose window is known gone: that path asks the engine nothing", async () => {
    const sent: string[] = [];
    const result = await reapOwned({
      only: "probe-a",
      live: () => null,
      scan: () => [row({ pid: 10 })],
      // Measured: without this the code reads /proc to find who is "nobody", and
      // the fixture's ppid 1487 is systemd --user only on the machine it was
      // written on; elsewhere nothing matches and 0 are stopped.
      nobody: () => new Set([1, 1487]),
      signal: (p) => { sent.push(String(p)); },
      startOf: () => "1000",
      removeDir: () => { /* the scratch is not what this test is about */ },
      graceMs: 0,
    });
    expect(result.stopped).toBe(1);
    expect(sent).toEqual(["10"]);
  });
});

/**
 * A process started the way a worker starts things, and orphaned the way a
 * `nohup … &` orphans it: the shell that launched it is gone, so it answers to
 * init or to this user's systemd. The pid comes from the process's own `echo`,
 * never from the shell that forked it, and its scratch is the one the launcher
 * gave that owner.
 */
async function orphan(owner: string): Promise<{ pid: number; dir: string }> {
  const launched = ownerLaunch(owner);
  if (!launched.dir) throw new Error("the owner name was refused");
  dirs.push(launched.dir);
  const pidFile = join(scratch(), "pid");
  const script = `setsid sh -c 'echo $$ > ${pidFile}; exec sleep 120' >/dev/null 2>&1 &`;
  const shell = Bun.spawn(["sh", "-c", script], {
    env: { ...process.env, ...launched.env },
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  await shell.exited;
  const end = Date.now() + 5_000;
  while (Date.now() < end) {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) { pids.push(pid); return { pid, dir: launched.dir }; }
    }
    await Bun.sleep(25);
  }
  throw new Error("the orphan never said its pid");
}

/** The parent the kernel gave it, which is what the rule reads. */
function ppidOf(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
}

describe.if(LINUX)("a real leftover", () => {
  test("is stopped and loses its scratch once its owner's window is gone", async () => {
    const { pid, dir } = await orphan("probe-dead");
    // The premise of the rule, measured rather than assumed: the launcher is
    // gone and the kernel handed this process to init or to systemd --user.
    expect(nobodyPids([ppidOf(pid)]).has(ppidOf(pid))).toBe(true);

    const seen = scanOwned().find((r) => r.pid === pid);
    expect(seen?.owner).toBe("probe-dead");
    expect(seen?.mine).toBe(false);
    expect(seen?.tmp).toBe(dir);

    const result = await reapOwner("probe-dead");
    expect(result.stopped).toBeGreaterThan(0);
    expect(await gone(pid)).toBe(true);
    expect(existsSync(dir)).toBe(false);
  }, 15_000);

  test("is left alone while its owner's window is still on the engine", async () => {
    const { pid, dir } = await orphan("probe-live");
    // A different owner, and then this one with its window on the engine: the
    // rule must not touch a process while there is anything still holding it.
    expect((await reapOwner("probe-elsewhere")).stopped).toBe(0);
    await reapOwned({ live: () => new Set(["probe-live"]), minAgeMs: 0 });
    expect(alive(pid)).toBe(true);
    expect(existsSync(dir)).toBe(true);
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }, 15_000);

  test("is not signalled when the pid no longer carries the start time we read", async () => {
    const { pid } = await orphan("probe-reuse");
    const sent: string[] = [];
    // A pid reused between the scan and the signal has another start time, and
    // the signal is what must not happen: the process it would land on is a
    // stranger. Verified twice, before the SIGTERM and again before the SIGKILL.
    await reapOwned({
      only: "probe-reuse",
      startOf: () => "-1",
      signal: (p, sig) => { sent.push(`${p}:${sig}`); },
      graceMs: 0,
    });
    expect(sent).toEqual([]);
    expect(alive(pid)).toBe(true);
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }, 15_000);
});

describe("the name rule", () => {
  test("gives every valid owner a scratch and refuses the rest", () => {
    expect(ownerTmpDir("proj1234-2")).toBe(join(tmpdir(), OWNER_TMP_PREFIX + "proj1234-2"));
    expect(ownerTmpDir("-nope")).toBeNull();
    expect(ownerTmpDir("a/b")).toBeNull();
    expect(ownerTmpDir("")).toBeNull();
  });
});

describe.if(LINUX)("the scratch a reap removes", () => {
  test("is the one the owner being reaped was given, not the one its environment names", async () => {
    // Measured: a window opened in a session whose last worker was `probe-owner-a`
    // carries `AGX_OWNER=pr-12` and `AGX_OWNER_TMP=/tmp/agx-owner-probe-owner-a`
    // together. Reaping `pr-12` must not take that worker's live scratch.
    const stray = ownerTmpDir("probe-owner-a")!;
    const removed: string[] = [];
    await reapOwned({
      only: "pr-12",
      scan: () => [row({ pid: 10, owner: "pr-12", tmp: stray })],
      nobody: () => new Set([1487]),
      signal: () => { /* a spy: nothing is started here */ },
      startOf: () => "1000",
      removeDir: (d) => { removed.push(d); },
      graceMs: 0,
    });
    expect(removed).not.toContain(stray);
    expect(removed).toContain(ownerTmpDir("pr-12")!);
  });

  test("survives a relaunch under the same name while the run before it still holds it", async () => {
    const { pid, dir } = await orphan("probe-relaunch");
    const writing = join(dir, "still-writing");
    writeFileSync(writing, "x");
    // The card is relaunched under its own name once the old window is gone
    // (agentops allows it), and the old run is still writing in its TMPDIR.
    expect(ownerLaunch("probe-relaunch").dir).toBe(dir);
    expect(existsSync(writing), "the previous run's TMPDIR was removed under it").toBe(true);
    dropScratch(dir);
    expect(existsSync(dir), "a launch that never opened must not either").toBe(true);
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    expect(await gone(pid)).toBe(true);
    dropScratch(dir);
    expect(existsSync(dir), "nothing holds it any more, so it goes").toBe(false);
  }, 15_000);
});

describe("the net on a clock", () => {
  test("sweeps once when it starts, on a rule that finds nothing in an empty scan", async () => {
    let sweeps = 0;
    startReaper({ scan: () => { sweeps++; return []; }, live: () => new Set() });
    await Bun.sleep(20);
    expect(sweeps).toBe(1);
  });
});

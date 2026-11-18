/**
 * How many children the server forks itself, counted through a fake Bun.spawn.
 *
 * Measured on the live app before this change: 55 `git rev-list --count
 * master..HEAD` in two minutes, forked by the server outside the spawn broker
 * (lantern.ts asked git for every worktree every 30 s with Bun.spawn). Here:
 * the same board facts asked every 5 s for two minutes, as the rail does.
 *
 * Before (from the code that was there, 30 s TTL, 3 git per worktree, plus a
 * `rev-parse --git-common-dir` per worktree per poll in boardNow): per
 * worktree 4 x 3 + 24 = 36 forks in 2 min, all from the server.
 * After: `status` every 30 s (4), the git dirs once (1), `rev-list` and `log`
 * once until a ref moves (2) = 7, and with the broker up, 0 from the server.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brokerSent, brokerUp, startBroker, stopBroker, brokerPid } from "../src/broker/brokerHost.ts";
import { runChild } from "../src/broker/brokerRun.ts";
import { __gitFactsFor, __resetGitFacts } from "../src/lantern.ts";

const until = async (ok: () => boolean, ms = 8000) => { for (let i = 0; i < ms / 25 && !ok(); i++) await Bun.sleep(25); return ok(); };

let dir = "";
const sh = (...a: string[]) => {
  const r = Bun.spawnSync(["git", "-C", dir, ...a], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};

/** Every Bun.spawn the code under test makes, and its argv. */
const forks: string[][] = [];
const realSpawn = Bun.spawn;
const counting = ((...a: Parameters<typeof Bun.spawn>) => {
  const argv = Array.isArray(a[0]) ? a[0] : (a[0] as { cmd: string[] }).cmd;
  forks.push(argv);
  return (realSpawn as (...x: unknown[]) => ReturnType<typeof Bun.spawn>)(...a);
}) as typeof Bun.spawn;
const gitForks = (verb: string) => forks.filter((f) => f[0]?.endsWith("git") && f.includes(verb)).length;

/** The rail's cadence: one board read every 5 s for two minutes. */
async function twoMinutesOfPolls(t0: number): Promise<number> {
  let ahead = -1;
  for (let i = 0; i < 24; i++) ahead = (await __gitFactsFor(dir, "main", t0 + i * 5_000))?.ahead ?? -1;
  return ahead;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "orbit-forks-"));
  sh("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  sh("add", "a.txt"); sh("commit", "-qm", "first");
  sh("switch", "-qc", "thing");
  writeFileSync(join(dir, "b.txt"), "b\n");
  sh("add", "b.txt"); sh("commit", "-qm", "ORBIT-1042 thing");
  (Bun as { spawn: typeof Bun.spawn }).spawn = counting;
});
afterAll(() => {
  (Bun as { spawn: typeof Bun.spawn }).spawn = realSpawn;
  rmSync(dir, { recursive: true, force: true });
});

describe("with no broker (boot): the board's git, counted", () => {
  test("two minutes of polls fork 7 times, not 36, and the answer is right", async () => {
    __resetGitFacts();
    forks.length = 0;
    expect(await twoMinutesOfPolls(1_000_000)).toBe(1);
    expect(gitForks("status")).toBe(4);
    expect(gitForks("rev-list")).toBe(1);
    expect(gitForks("log")).toBe(1);
    expect(forks.length).toBe(7);
  });

  test("a new commit moves the refs on disk, and only then is rev-list asked again", async () => {
    forks.length = 0;
    writeFileSync(join(dir, "c.txt"), "c\n");
    // The test's own git runs through the real spawn, not the counted one.
    sh("add", "c.txt"); sh("commit", "-qm", "second");
    const facts = await __gitFactsFor(dir, "main", 9_000_000);
    expect(facts?.ahead).toBe(2);
    expect(facts?.lastCommit?.subject).toBe("second");
    expect(gitForks("rev-list")).toBe(1);
  });
});

describe("with the broker up", () => {
  beforeAll(async () => {
    (Bun as { spawn: typeof Bun.spawn }).spawn = realSpawn;
    startBroker(() => {});
    expect(await brokerUp(15_000)).toBe(true);
    (Bun as { spawn: typeof Bun.spawn }).spawn = counting;
  }, 20_000);
  afterAll(async () => {
    stopBroker();
    await until(() => brokerPid() === null);
  });

  test("the same two minutes fork nothing from the server: every git goes to the broker", async () => {
    __resetGitFacts();
    forks.length = 0;
    const sent = brokerSent();
    expect(await twoMinutesOfPolls(20_000_000)).toBe(2);
    expect(forks.length).toBe(0);
    expect(brokerSent() - sent).toBe(7);
  }, 20_000);

  test("runChild sends to the broker; the server forks none", async () => {
    forks.length = 0;
    const r = await runChild(["git", "-C", dir, "rev-parse", "HEAD"], { timeoutMs: 10_000, read: true });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(forks.length).toBe(0);
  }, 20_000);
});

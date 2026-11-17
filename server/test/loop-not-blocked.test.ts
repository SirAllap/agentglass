/*
 * The routes the stall log named as loop blockers ("GET /flight-plan/plans",
 * "GET /understudy/sources") and the files-at-ref readers now spawn git and walk
 * the disk beside the loop. The proof is ordering: a 0 ms timer armed before the
 * call fires before the call's answer arrives. A blocking body resolves on the
 * microtask queue, ahead of every timer, so it fails this.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { landed, localBase } from "../src/flightPlan.ts";
import type { Plan } from "../src/flightPlanStore.ts";

const { findFiles, grepFiles, fileText } = await import("../src/files.ts");
const { listSourcesAsync } = await import("../src/understudy-sources.ts");

const box = mkdtempSync(join(tmpdir(), "agx-loop-"));
const hadRoot = process.env.AGENTGLASS_ROOT;
afterAll(() => {
  if (hadRoot === undefined) delete process.env.AGENTGLASS_ROOT;
  else process.env.AGENTGLASS_ROOT = hadRoot;
  rmSync(box, { recursive: true, force: true });
});
const env = { ...process.env, GIT_AUTHOR_NAME: "Ada Orbit", GIT_AUTHOR_EMAIL: "ada@orbit.test", GIT_COMMITTER_NAME: "Ada Orbit", GIT_COMMITTER_EMAIL: "ada@orbit.test", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...a: string[]) => { const r = Bun.spawnSync(["git", ...a], { cwd, env }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); return r.stdout.toString().trim(); };

const origin = join(box, "origin.git");
const repo = join(box, "orbit");
git(box, "init", "-q", "--bare", "-b", "main", origin);
git(box, "clone", "-q", origin, repo);
mkdirSync(join(repo, "src"), { recursive: true });
writeFileSync(join(repo, "src", "thing.ts"), "export const thing = 1;\n");
git(repo, "add", "src/thing.ts");
git(repo, "commit", "-q", "-m", "one");
git(repo, "push", "-q", "origin", "main");
const from = git(repo, "rev-parse", "HEAD");
git(repo, "branch", "flight-plan/footer");
// The builder moved off `from` and main took it: tip != from, so landed reaches
// its merge-base call, and local main holds origin/main, so localBase makes both of its calls.
git(repo, "checkout", "-q", "flight-plan/footer");
writeFileSync(join(repo, "src", "footer.ts"), "export const footer = 1;\n");
git(repo, "add", "src/footer.ts");
git(repo, "commit", "-q", "-m", "footer");
git(repo, "checkout", "-q", "main");
git(repo, "merge", "-q", "--ff-only", "flight-plan/footer");

/*
 * A `git` first on PATH that logs when each call starts and ends, holding 50 ms
 * after the real one. A ticker in this process writes to the same log: a call
 * made beside the loop has ticks between its start and end; a spawnSync holds
 * the loop the whole time and has none. One await before a sync call no longer
 * hides it, as it did when only the first timer was watched.
 */
const realGit = Bun.which("git")!;
const stubDir = join(box, "bin");
const log = join(box, "git.log");
mkdirSync(stubDir);
writeFileSync(join(stubDir, "git"), `#!/bin/sh\necho "start $*" >> "${log}"\n"${realGit}" "$@"; rc=$?\nsleep 0.05\necho end >> "${log}"\nexit $rc\n`);
chmodSync(join(stubDir, "git"), 0o755);

/** Each git call `call` made, in order, and whether a timer fired while it ran. */
async function gitCallsDuring(call: () => Promise<unknown>): Promise<{ args: string; ticked: boolean }[]> {
  writeFileSync(log, "");
  const path = process.env.PATH;
  process.env.PATH = `${stubDir}:${path}`;
  const ticker = setInterval(() => appendFileSync(log, "tick\n"), 2);
  try {
    await call();
  } finally {
    clearInterval(ticker);
    process.env.PATH = path;
  }
  const calls: { args: string; ticked: boolean; ended: boolean }[] = [];
  for (const line of readFileSync(log, "utf8").split("\n")) {
    const open = calls[calls.length - 1];
    if (line.startsWith("start ")) calls.push({ args: line.slice(6), ticked: false, ended: false });
    else if (line === "tick" && open && !open.ended) open.ticked = true;
    else if (line === "end" && open) open.ended = true;
  }
  return calls.map(({ args, ticked }) => ({ args, ticked }));
}

/** True when a timer armed before `call` fired before its answer. */
async function timerFiresDuring(call: () => Promise<unknown>): Promise<boolean> {
  const order: string[] = [];
  const t0 = performance.now();
  setTimeout(() => order.push("timer"), 0);
  await call().then(() => order.push("answer"));
  // A call that answered before the timer's first tick (a few files on a fast disk) held nothing: the loop had no time to be held. One that took longer and still lost to the timer held it.
  return order[0] === "timer" || performance.now() - t0 < 5;
}

describe("request paths do not hold the event loop", () => {
  test("GET /understudy/sources: listSourcesAsync surveys beside the loop", async () => {
    expect(await timerFiresDuring(() => listSourcesAsync({}, [{ id: "extra:orbit", path: repo }]))).toBe(true);
  });

  test("GET /flight-plan/plans: localBase asks git beside the loop, both calls", async () => {
    let base = "";
    const calls = await gitCallsDuring(async () => { base = await localBase(repo, "origin/main"); });
    expect(base).toBe("main");
    // One ref read, then the ancestry walk for this pair of tips.
    expect(calls.map((c) => c.args.match(/ (for-each-ref|rev-parse|merge-base) /)?.[1])).toEqual(["for-each-ref", "merge-base"]);
    expect(calls.map((c) => c.ticked)).toEqual([true, true]);
    // The same tips again: the walk is kept by SHA pair, only the ref read runs.
    const again = await gitCallsDuring(async () => { base = await localBase(repo, "origin/main"); });
    expect(base).toBe("main");
    expect(again.map((c) => c.args.match(/ (for-each-ref|rev-parse|merge-base) /)?.[1])).toEqual(["for-each-ref"]);
    expect(again.map((c) => c.ticked)).toEqual([true]);
  });

  test("GET /flight-plan/plans: landed asks git beside the loop, both calls", async () => {
    const p = { root: repo, launched: { at: 1, title: "Footer", branch: "flight-plan/footer", from } } as unknown as Plan;
    let done = false;
    const calls = await gitCallsDuring(async () => { done = await landed(p, "main"); });
    expect(done).toBe(true);
    // One ref read, then the ancestry walk for this pair of tips.
    expect(calls.map((c) => c.args.match(/ (for-each-ref|rev-parse|merge-base) /)?.[1])).toEqual(["for-each-ref", "merge-base"]);
    expect(calls.map((c) => c.ticked)).toEqual([true, true]);
    // The same tips again: the walk is kept by SHA pair, only the ref read runs.
    const again = await gitCallsDuring(async () => { done = await landed(p, "main"); });
    expect(done).toBe(true);
    expect(again.map((c) => c.args.match(/ (for-each-ref|rev-parse|merge-base) /)?.[1])).toEqual(["for-each-ref"]);
    expect(again.map((c) => c.ticked)).toEqual([true]);
  });

  test("GET /files/find, /files/grep and /files/read at a ref ask git beside the loop", async () => {
    process.env.AGENTGLASS_ROOT = box;
    expect(await timerFiresDuring(() => findFiles(repo, "thing", 50, "origin/main"))).toBe(true);
    expect(await timerFiresDuring(() => grepFiles(repo, "thing", 50, "origin/main"))).toBe(true);
    expect(await timerFiresDuring(() => fileText(repo, "src/thing.ts", "origin/main"))).toBe(true);
    expect((await fileText(repo, "src/thing.ts", "origin/main")).text).toContain("thing = 1");
  });
});

// gitwork.ts ran ~108 git calls with a blocking spawn on the server's only
// thread, so a slow git (index.lock contention, a cold disk) froze every
// terminal for as long as it took. They are awaited now. What is pinned here:
// a timer keeps firing while a slow git runs through gitwork, and the same
// slow git through the blocking helper does stop it — so the stub is slow
// enough for the test to tell the two apart.
//
// In a child process because the stub git goes on PATH, and PATH leaks across
// files in one `bun test` process (AGENTS.md).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-gitwork-loop-")));
const bin = join(dir, "bin");
const repo = join(dir, "repo");
const realGit = Bun.which("git")!;
const src = new URL("../src/", import.meta.url).pathname;

beforeAll(() => {
  mkdirSync(bin, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const run = (...a: string[]) => Bun.spawnSync([realGit, ...a], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  run("init", "-q", "-b", "main", ".");
  writeFileSync(join(repo, "a.txt"), "one\n");
  // Every git the child runs takes 300 ms before it does its work.
  writeFileSync(join(bin, "git"), `#!/bin/sh\nsleep 0.3\nexec "${realGit}" "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Ticks of a 20 ms timer while `call` runs in a child with the slow git first on PATH. */
async function ticksDuring(call: string): Promise<{ ticks: number; ms: number; out: string }> {
  const script = `
    const gw = await import(${JSON.stringify(join(src, "gitwork.ts"))});
    const g = await import(${JSON.stringify(join(src, "git.ts"))});
    let ticks = 0;
    const t = setInterval(() => { ticks++; }, 20);
    await new Promise((r) => setTimeout(r, 50));
    ticks = 0;
    const t0 = performance.now();
    const out = await (${call});
    const ms = performance.now() - t0;
    clearInterval(t);
    console.log(JSON.stringify({ ticks, ms, out: JSON.stringify(out) }));
  `;
  const env = {
    ...process.env,
    // A fixed PATH: other test files in the same run leave theirs changed.
    PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
    NODE_ENV: "test",
    XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
    AGENTGLASS_STATE_DIR: join(dir, "state"), AGENTGLASS_DB: join(dir, "agx.db"), TMUX_TMPDIR: join(dir, "tmux"),
    AGENTGLASS_ROOT: dir,
  };
  const p = Bun.spawn([process.execPath, "-e", script], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  const line = stdout.trim().split("\n").pop() ?? "";
  if (!line.startsWith("{")) throw new Error(`child failed: ${stderr.slice(-800)}`);
  return JSON.parse(line);
}

test("a timer fires while a slow git runs through gitwork", async () => {
  // stage: rev-parse for the root, then the guard's reads, then `git add`.
  const r = await ticksDuring(`gw.stage(${JSON.stringify(repo)}, ["a.txt"])`);
  expect(JSON.parse(r.out)).toMatchObject({ ok: true });
  expect(r.ms).toBeGreaterThan(550); // at least two slow gits ran
  expect(r.ticks).toBeGreaterThan((r.ms / 20) * 0.5);
}, 30_000);

test("the same slow git through the blocking helper stops the timer (the stub is slow enough)", async () => {
  const r = await ticksDuring(`g.git(${JSON.stringify(repo)}, ["status", "--porcelain"]).code`);
  expect(r.ms).toBeGreaterThan(280);
  expect(r.ticks).toBeLessThan(3);
}, 30_000);

test("git writes on one checkout take turns; another checkout does not wait", async () => {
  const { gitWriteTurn } = await import("../src/gitwork.ts");
  const order: string[] = [];
  const first = await gitWriteTurn(repo);
  const second = gitWriteTurn(repo).then((end) => { order.push("second"); return end; });
  const other = gitWriteTurn(join(dir, "elsewhere")).then((end) => { order.push("other"); return end; });
  await new Promise((r) => setTimeout(r, 30));
  expect(order).toEqual(["other"]);
  first();
  (await second)();
  (await other)();
  expect(order).toEqual(["other", "second"]);
});

// A `git` that never returns must not keep its slot.
//
// Every awaited git takes a slot from one shared pool (see spawnpool), which
// turned a bounded annoyance into an unbounded one: before, a git that hung was
// one hung request — bad, survivable, over when the user gave up. Now it also
// holds one of at most sixteen slots for the life of the process, and a slot
// that is never handed back is gone. Enough of them and nothing in the app can
// run git at all, which is precisely the freeze the pool was added to prevent,
// reached from the other side.
//
// Not a thought experiment: prs.ts fetches PR refs from a network remote
// through this path, and a remote that accepts the connection and then says
// nothing is an ordinary Tuesday on a laptop that changed networks.
//
// The hang here is deterministic and offline — no DNS, no reachable host, no
// waiting on a real timeout. git runs its ssh command through a shell, so `sh
// -c 'sleep 30'` swallows the host and command arguments git appends and simply
// sleeps.
//
// It is set as repo config rather than GIT_SSH_COMMAND on purpose, and the
// first draft of this file got that wrong in a way worth recording: with the
// environment variable, the test passed against the *unfixed* code in 104ms.
// Bun.spawn's default env does not pick up a variable the test sets at runtime,
// so only the fixed path — which passes `{...process.env}` explicitly — ever
// saw the sleep. The test was measuring its own fix. Config lives in the repo
// and reaches git either way, which is what makes the failure real.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-git-timeout-")));
const REPO = join(dir, "repo");

process.env.XDG_CONFIG_HOME = dir; // never inherit the developer's own scope
process.env.AGENTGLASS_DB = join(dir, "t.db");

function sh(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
}

let g: typeof import("../src/git.ts");
let pool: typeof import("../src/spawnpool.ts");
const saved = { budget: process.env.AGENTGLASS_GIT_TIMEOUT_SECONDS };

beforeAll(async () => {
  sh(dir, "init", "-q", "repo");
  sh(REPO, "config", "user.email", "t@example.com");
  sh(REPO, "config", "user.name", "t");
  sh(REPO, "commit", "-q", "--allow-empty", "-m", "root");
  sh(REPO, "remote", "add", "origin", "ssh://nowhere.invalid/repo.git");
  // Reaches git through the repo, not through our environment — see the header.
  sh(REPO, "config", "core.sshCommand", "sh -c 'sleep 30'");
  g = await import("../src/git.ts");
  pool = await import("../src/spawnpool.ts");
});

afterAll(() => {
  if (saved.budget === undefined) delete process.env.AGENTGLASS_GIT_TIMEOUT_SECONDS;
  else process.env.AGENTGLASS_GIT_TIMEOUT_SECONDS = saved.budget;
});

describe("a git that never answers", () => {
  test("is killed at the budget rather than running forever", async () => {
    process.env.AGENTGLASS_GIT_TIMEOUT_SECONDS = "1";

    const t0 = performance.now();
    const r = await g.gitAsync(REPO, ["fetch", "origin"]);
    const ms = performance.now() - t0;

    // The sleep is 30s. Anything near it means nothing killed the process, and
    // the generous ceiling here is deliberate: this asserts "bounded", not a
    // stopwatch reading that a loaded CI box could miss.
    expect(ms).toBeLessThan(15_000);
    expect(r.code).not.toBe(0);
  });

  test("gives its slot back, so the pool is not one short forever", async () => {
    process.env.AGENTGLASS_GIT_TIMEOUT_SECONDS = "1";

    await Promise.all([
      g.gitAsync(REPO, ["fetch", "origin"]),
      g.gitAsync(REPO, ["fetch", "origin"]),
      g.gitAsync(REPO, ["fetch", "origin"]),
    ]);

    // The whole point. Were the spawns still out there, this would count them.
    expect(pool.spawnPoolStats().inflight).toBe(0);

    // And the pool still runs work afterwards, which is what the user notices.
    // `rev-parse` is local, so the sleeping ssh command never comes into it.
    const ok = await g.gitAsync(REPO, ["rev-parse", "--is-inside-work-tree"]);
    expect(ok.code).toBe(0);
    expect(ok.stdout.trim()).toBe("true");
  });

  test("says something, because prs.ts shows stderr to the user verbatim", async () => {
    process.env.AGENTGLASS_GIT_TIMEOUT_SECONDS = "1";

    const r = await g.gitAsync(REPO, ["fetch", "origin"]);

    // `could not fetch the pull request: ` with nothing after the colon reads
    // as a bug in us rather than a remote that never answered.
    expect(r.stderr.trim().length).toBeGreaterThan(0);
  });
});

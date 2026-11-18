/*
 * The pill's read of one checkout must not hold the event loop.
 *
 * `/git/repo` resolves the checkout with `git rev-parse --show-toplevel`, and
 * that was a synchronous spawn: a cold or slow checkout froze the whole server
 * — the terminal it carries included — for as long as git took. Measured on an
 * isolated server with a 1.2 s rev-parse, `/health` behind it waited 1059 ms;
 * awaited, it answers in 3 ms while the route takes its 1.2 s.
 *
 * A wrapper `git` on PATH sleeps on that one verb once a flag file exists, so
 * the boots and the warm-up read are not slowed. The shape assertion is the
 * other half: the route still answers `{ repo: { root, branch, … } }`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { freePort } from "./freePort.ts";

const SLOW_MS = 1200;
let dir = "", repo = "", base = "", flag = "", proc: ReturnType<typeof Bun.spawn> | null = null;
const realGit = Bun.which("git") || "/usr/bin/git";
const git = (cwd: string, ...args: string[]) => Bun.spawnSync([realGit, ...args], { cwd, stdout: "pipe", stderr: "pipe" });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-repo-loop-"));
  repo = join(dir, "orbit");
  flag = join(dir, "slow.flag");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(dir, "init", "-q", "-b", "main", "orbit");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "x\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");

  mkdirSync(join(dir, "bin"));
  writeFileSync(
    join(dir, "bin", "git"),
    `#!/bin/sh\ncase " $* " in *" rev-parse "*) [ -f "${flag}" ] && sleep ${SLOW_MS / 1000};; esac\nexec "${realGit}" "$@"\n`,
  );
  chmodSync(join(dir, "bin", "git"), 0o755);

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
      HOME: dir,
      LANG: process.env.LANG || "C.UTF-8",
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      TMUX_TMPDIR: join(dir, "tmux"),
      AGENTGLASS_STATE_DIR: join(dir, "state"),
      AGENTGLASS_ROOT: repo,
      AGENTGLASS_DB: join(dir, "agents.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_AUTOFETCH_SECONDS: "0",
      AGENTGLASS_TMUX_SOCKET: `agx-repo-loop-${process.pid}`,
    },
    stdout: "ignore", stderr: "ignore",
  });
  let up = false;
  for (let i = 0; i < 200 && !up; i++) {
    try { up = (await fetch(base + "/health")).ok; } catch { /* not up yet */ }
    if (!up) await Bun.sleep(100);
  }
  if (!up) throw new Error("the server never answered /health");
  // Warm the checkout through the same route under another key, so the read
  // below is a cold root lookup rather than a cached one.
  expect((await fetch(`${base}/git/repo?root=${encodeURIComponent(repo)}`)).ok).toBe(true);
}, SERVER_BOOT_MS);

afterAll(() => {
  proc?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("a slow rev-parse behind the pill's read leaves the loop free", async () => {
  writeFileSync(flag, "1");
  const t0 = performance.now();
  const reading = fetch(`${base}/git/repo?root=${encodeURIComponent(join(repo, "src"))}`).then((r) => r.json());
  await Bun.sleep(150);
  const h0 = performance.now();
  await (await fetch(base + "/health")).text();
  const healthMs = Math.round(performance.now() - h0);
  const body = (await reading) as { repo: { root: string; branch: string; dirty: number } | null };
  const routeMs = Math.round(performance.now() - t0);

  expect(routeMs).toBeGreaterThan(SLOW_MS - 100);   // the git call really was slow
  expect(healthMs).toBeLessThan(300);               // and the loop answered anyway
  expect(body.repo?.root).toBe(repo);
  expect(body.repo?.branch).toBe("main");
  expect(body.repo?.dirty).toBe(0);
}, 20_000);

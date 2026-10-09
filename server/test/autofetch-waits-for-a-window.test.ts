/*
 * The background fetch has an audience.
 *
 * With no window connected the server still ran `git fetch --all` on the open
 * project every minute, plus two for-each-ref reads, for counts nobody was
 * looking at (measured: 1 fetch a minute on an idle server). A logging `git`
 * ahead of the real one on the server's PATH counts what it really spawns, and
 * the interval is shortened to a second so the test does not wait a minute.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;
let log: string;
const fetches = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => /(^| )fetch( |$)/.test(l)).length : 0);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-autofetch-"));
  log = join(dir, "git.log");
  const realGit = Bun.which("git") || "/usr/bin/git";
  const repo = join(dir, "repo");
  mkdirSync(repo);
  Bun.spawnSync([realGit, "init", "-q", repo]);
  Bun.spawnSync([realGit, "-C", repo, "-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "first"]);
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "git"), `#!/bin/sh\necho "$@" >> "${log}"\nexec "${realGit}" "$@"\n`);
  chmodSync(join(dir, "bin", "git"), 0o755);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
      TMUX_TMPDIR: TMUX_TEST_TMPDIR, HOME: dir, XDG_CONFIG_HOME: dir,
      AGENTGLASS_STATE_DIR: `${dir}/state`, AGENTGLASS_ROOT: repo, AGENTGLASS_DB: join(dir, "a.db"),
      AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port), AGENTGLASS_AUTOFETCH_SECONDS: "1",
    },
    stdout: "ignore", stderr: "pipe",
  });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(base + "/health")).ok; } catch { await Bun.sleep(100); }
  }
  if (!up) throw new Error("the server did not come up");
}, SERVER_BOOT_MS);

afterAll(() => {
  try { proc?.kill(); } catch { /* gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

test("no window, no fetch; the first window to connect gets one at once", async () => {
  await Bun.sleep(3500);                          // three ticks of the shortened clock
  expect(fetches(), "an idle server fetched for nobody").toBe(0);
  const ws = new WebSocket(base.replace("http", "ws") + "/stream");
  await new Promise((r) => ws.addEventListener("open", r));
  ws.send(JSON.stringify({ type: "hello", clientId: "autofetch" }));
  let n = 0;
  for (let i = 0; i < 20 && !n; i++) { await Bun.sleep(100); n = fetches(); }
  expect(n, "the window that connected got its counts refreshed").toBeGreaterThanOrEqual(1);
  await Bun.sleep(2500);
  expect(fetches(), "and while it is open the minute clock runs").toBeGreaterThan(n);
  ws.close();
}, 20_000);

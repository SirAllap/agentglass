/**
 * The stopped-tree refusal is asked inside the write turn, not before it.
 *
 * Asked before, a checkout from one tab passed the "is this tree mid-merge?"
 * check while a merge from another tab was still running, then waited for its
 * turn and ran on the tree that merge had left in conflict. Here the merge is
 * made slow so the checkout is sure to arrive while the merge holds the turn;
 * the checkout must come back with the refusal, not with git's own error.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

let dir = "", repo = "", base = "", proc: ReturnType<typeof Bun.spawn> | null = null;
const realGit = Bun.which("git") || "/usr/bin/git";
const git = (cwd: string, ...args: string[]) => Bun.spawnSync([realGit, ...args], { cwd, stdout: "pipe", stderr: "pipe" });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-write-turn-"));
  repo = join(dir, "orbit");
  git(dir, "init", "-q", "-b", "main", "orbit");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "base\n");
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "init");
  git(repo, "branch", "other");
  git(repo, "switch", "-qc", "feat");
  writeFileSync(join(repo, "a.txt"), "feat\n");
  git(repo, "commit", "-qam", "feat");
  git(repo, "switch", "-q", "main");
  writeFileSync(join(repo, "a.txt"), "main\n");
  git(repo, "commit", "-qam", "main");

  // A git whose `merge` takes a second, so the merge is still holding the
  // turn when the checkout comes in.
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "git"), `#!/bin/sh\ncase " $* " in *" merge "*) sleep 1;; esac\nexec "${realGit}" "$@"\n`);
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
      AGENTGLASS_TMUX_SOCKET: `agx-write-turn-${process.pid}`,
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    },
    stdout: "ignore", stderr: "ignore",
  });
  let up = false;
  for (let i = 0; i < 200 && !up; i++) {
    try { up = (await fetch(base + "/health")).ok; } catch { /* not up yet */ }
    if (!up) await Bun.sleep(100);
  }
  if (!up) throw new Error("the server never answered /health");
}, SERVER_BOOT_MS);

afterAll(() => {
  proc?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body: object) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ root: repo, ...body }) })
    .then((r) => r.json() as Promise<{ ok: boolean; error?: string }>);

test("a checkout sent while a merge is running waits, sees the conflict, and is refused", async () => {
  const merging = post("/git/merge", { name: "feat" });
  await Bun.sleep(200); // the merge has its turn and is inside the slow git
  const checkout = await post("/git/checkout", { name: "other" });
  const merge = await merging;
  expect(merge.ok).toBe(false);
  expect(checkout.ok).toBe(false);
  expect(checkout.error).toContain("mid-merge with 1 file still conflicted");
  expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD").stdout.toString().trim()).toBe("main");
}, 15_000);

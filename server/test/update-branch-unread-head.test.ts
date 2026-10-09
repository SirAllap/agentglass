import { afterAll, describe, expect, it } from "bun:test";

/*
 * "Update branch" may say "Synced - updated on GitHub" only when the branch
 * head was seen to move.
 *
 * A branch can have `branch.X.remote` / `branch.X.merge` set while no
 * refs/remotes/<remote>/X exists yet (never fetched). `@{upstream}` then fails,
 * the head lookup used to fall back to guessing origin, read nothing, and a
 * failed read was treated as "moved": the toast said Synced over a branch that
 * had not moved. Two cases are pinned, each against a fake `gh` that accepts
 * the update and moves nothing:
 *   - tracking configured, ref never fetched: the configured remote is read,
 *     the head is seen not to move, and the answer is "requested";
 *   - the remote cannot be read at all: still "requested", never "Synced".
 * The driver runs in a child bun so PATH (for the fake gh) applies to
 * Bun.which and the module's caches start empty.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "agx-update-unread-"));
const BIN = join(TMP, "bin");
const REPO = join(TMP, "repo");
const FORK = join(TMP, "fork.git");
const DRIVER = join(TMP, "driver.ts");

afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* fine */ } });

const DRIVER_SRC = `
const [repo] = process.argv.slice(2);
const P = await import(${JSON.stringify(join(import.meta.dir, "../src/prs.ts"))});
const out = {};
out.fetchedNever = await P.updateBranch(repo, 7, true);
out.unreadable = await P.updateBranch(repo, 8, true);
console.log(JSON.stringify(out));
`;

const read = await (async () => {
  await Bun.$`mkdir -p ${BIN} ${join(TMP, "state")}`.quiet();
  writeFileSync(join(BIN, "gh"), [
    "#!/usr/bin/env bash",
    `if [ "$1" = "pr" ] && [ "$2" = "view" ]; then`,
    `  if [ "$3" = "7" ]; then echo '{"baseRefName":"main","headRefName":"feat"}'; else echo '{"baseRefName":"main","headRefName":"feat2"}'; fi; exit 0; fi`,
    // Accepted, and nothing moves: the 202 that is only a queue entry.
    `if [ "$1" = "pr" ] && [ "$2" = "update-branch" ]; then echo "Update queued"; exit 0; fi`,
    "exit 1",
    "",
  ].join("\n"));
  chmodSync(join(BIN, "gh"), 0o755);
  writeFileSync(DRIVER, DRIVER_SRC);
  const sh = async (...a: string[]) => { await Bun.$`${a}`.quiet(); };
  await sh("git", "init", "-q", "--bare", FORK);
  await sh("git", "init", "-q", REPO);
  const g = (...a: string[]) => sh("git", "-C", REPO, "-c", "user.email=ada@example.test", "-c", "user.name=Ada Test", ...a);
  await g("commit", "-q", "--allow-empty", "-m", "one");
  await g("branch", "feat");
  await g("branch", "feat2");
  await g("push", "-q", FORK, "feat");
  // origin names the GitHub repo. The driver allows only the file protocol, so
  // a guess at origin is refused at once instead of going to the network.
  await g("remote", "add", "origin", "https://github.com/acme/demo.git");
  await g("remote", "add", "fork", FORK);
  await g("config", "branch.feat.remote", "fork");
  await g("config", "branch.feat.merge", "refs/heads/feat");
  await g("remote", "add", "gone", join(TMP, "no-such-remote.git"));
  await g("config", "branch.feat2.remote", "gone");
  await g("config", "branch.feat2.merge", "refs/heads/feat2");

  // The child starts from this process's env, and the files that run before
  // this one in the same process leave variables in it: alone this passed, in
  // the full server run both cases came back ok:false. Every AGENTGLASS_,
  // XDG_, GIT_ and GH_ variable is dropped and the ones the module reads are
  // set here (2 fail -> 0 in the full run); NODE_ENV=test and AGENTGLASS_DB
  // keep the child off the real database.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(AGENTGLASS_|XDG_|GIT_|GH_)/.test(k)) env[k] = v;
  }
  const proc = Bun.spawn(["bun", "run", DRIVER, REPO], {
    env: {
      ...env, NODE_ENV: "test", PATH: `${BIN}:${process.env.PATH}`, GIT_ALLOW_PROTOCOL: "file",
      AGENTGLASS_ROOT: TMP, AGENTGLASS_CACHE_DIR: join(TMP, "cache"), AGENTGLASS_STATE_DIR: join(TMP, "state"),
      AGENTGLASS_DB: join(TMP, "state", "agx.db"), XDG_CONFIG_HOME: join(TMP, "xdg", "config"),
      XDG_DATA_HOME: join(TMP, "xdg", "data"), XDG_CACHE_HOME: join(TMP, "xdg", "cache"), XDG_STATE_HOME: join(TMP, "xdg", "state"),
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  const line = stdout.trim().split("\n").pop() || "";
  try { return JSON.parse(line) as Record<string, { ok: boolean; requested?: boolean; detail?: string }>; } catch { throw new Error(`driver said: ${stdout}${stderr}`); }
})();

describe("Update branch with a head that cannot be seen to move", () => {
  it("tracking set but never fetched: answers requested, not Synced", () => {
    expect(read.fetchedNever).toMatchObject({ ok: true, requested: true });
    expect(read.fetchedNever!.detail).not.toMatch(/Synced|updated on GitHub/);
  });

  it("remote unreadable: answers requested, not Synced", () => {
    expect(read.unreadable).toMatchObject({ ok: true, requested: true });
    expect(read.unreadable!.detail).not.toMatch(/Synced|updated on GitHub/);
  });
});

import { afterAll, describe, expect, it } from "bun:test";

/*
 * Update branch tells the watch BEFORE it asks GitHub. The press takes seconds (the queue, a second look, the local
 * pull) and a notify armed in that window used to find no sync on record, so the old head's green fired at once.
 * The fake `gh` writes to the same log the callback does, so the order is read off the file, not assumed.
 * The driver runs in a child bun so PATH applies to Bun.which and the module's caches start empty.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "agx-update-flight-"));
const BIN = join(TMP, "bin");
const REPO = join(TMP, "repo");
const FORK = join(TMP, "fork.git");
const LOG = join(TMP, "order.log");
const DRIVER = join(TMP, "driver.ts");

afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* fine */ } });

const DRIVER_SRC = `
import { appendFileSync } from "node:fs";
const [repo, log] = process.argv.slice(2);
const P = await import(${JSON.stringify(join(import.meta.dir, "../src/prs.ts"))});
await P.updateBranch(repo, 7, false, async (before) => { appendFileSync(log, "began " + (before ? "with-head" : "no-head") + "\\n"); });
`;

const run = async (): Promise<string[]> => {
  await Bun.$`mkdir -p ${BIN}`.quiet();
  writeFileSync(join(BIN, "gh"), [
    "#!/usr/bin/env bash",
    `if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo '{"baseRefName":"main","headRefName":"feat"}'; exit 0; fi`,
    `if [ "$1" = "pr" ] && [ "$2" = "update-branch" ]; then echo "gh update-branch" >> ${LOG}; echo "Update queued"; exit 0; fi`,
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
  await g("push", "-q", FORK, "feat");
  await g("remote", "add", "origin", "https://github.com/acme/demo.git");
  await g("remote", "add", "fork", FORK);
  await g("config", "branch.feat.remote", "fork");
  await g("config", "branch.feat.merge", "refs/heads/feat");
  const p = Bun.spawn(["bun", DRIVER, REPO, LOG], {
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, GIT_ALLOW_PROTOCOL: "file", XDG_CONFIG_HOME: join(TMP, "cfg"), XDG_DATA_HOME: join(TMP, "data"), XDG_CACHE_HOME: join(TMP, "cache") },
    stdout: "pipe", stderr: "pipe",
  });
  await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  try { return readFileSync(LOG, "utf8").trim().split("\n"); } catch { return []; }
};

describe("Update branch begins before it asks GitHub", () => {
  it("the callback is told first, with the head the branch has now", async () => {
    expect(await run()).toEqual(["began with-head", "gh update-branch"]);
  });
});

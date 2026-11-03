/*
 * A session pushes a pull request's branch. The push is the event: it records
 * the branch and commit, drops what was read of the old head (the cached detail
 * and the list rows), and the board's rows for that branch carry the push, so
 * nothing is filed as green on the old head. No GitHub: the remote is only a
 * URL that names acme/orbit, and nothing here asks it anything.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-pushmark-"));
const saved: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries({
  XDG_CONFIG_HOME: join(dir, "c"), XDG_DATA_HOME: join(dir, "d"), XDG_CACHE_HOME: join(dir, "x"),
  AGENTGLASS_STATE_DIR: join(dir, "s"), AGENTGLASS_DB: join(dir, "db.sqlite"), TMUX_TMPDIR: join(dir, "t"),
})) { saved[k] = process.env[k]; process.env[k] = v; }

const { notePush } = await import("../src/pushSeen.ts");
const { repoIdFor, __seedDetail, __peekDetail, __peekPushed, markPushed } = await import("../src/prs.ts");

const git = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", ...a], {
  cwd, stdout: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t.test", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t.test" },
}).stdout.toString().trim();

const OLD = "1".repeat(40);
let work = "";
let key = "";
let tip = "";

beforeAll(async () => {
  work = join(dir, "work");
  Bun.spawnSync(["git", "init", "-q", "-b", "feature", work]);
  writeFileSync(join(work, "a.txt"), "a");
  git(work, "add", "a.txt"); git(work, "commit", "-qm", "one");
  git(work, "remote", "add", "origin", "https://github.com/acme/orbit.git");
  tip = git(work, "rev-parse", "HEAD");
  key = (await repoIdFor(work))!.key;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

const settled = async (f: () => unknown) => { for (let i = 0; i < 100 && !f(); i++) await Bun.sleep(20); };
const detail = { number: 478, headRefName: "feature", headSha: OLD, checksSha: OLD, updatedAt: "2026-10-27T10:00:00Z" } as never;

describe("git push from a session", () => {
  it("records the branch and commit, and drops the old head's cached detail", async () => {
    __seedDetail(`${key}#478`, detail);
    notePush(work, "git push origin feature");
    await settled(() => __peekPushed(`${key}\u0000feature`));
    expect(__peekPushed(`${key}\u0000feature`)?.sha).toBe(tip);
    expect(__peekDetail(`${key}#478`)).toBeUndefined();
  });

  it("marks the list's rows of that branch, and only that branch", () => {
    const rows = [{ number: 478, headRefName: "feature" }, { number: 9, headRefName: "other" }] as never;
    const out = markPushed(key, rows, 123) as { pushSeen?: { sha: string }; readAt?: number }[];
    expect([out[0]!.pushSeen?.sha, out[0]!.readAt, out[1]!.pushSeen]).toEqual([tip, 123, undefined]);
  });

  it("is not a push when the command only says so", async () => {
    __seedDetail(`${key}#478`, detail);
    notePush(work, "git push --dry-run origin feature");
    await Bun.sleep(100);
    expect(__peekDetail(`${key}#478`)).toBeDefined();
  });
});

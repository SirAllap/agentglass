/*
 * Builders are cut from the local trunk when it is ahead of origin: a worktree
 * cut from a stale origin/main starts behind every merge the project made
 * locally, and a branch merged locally never looks landed against it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBase } from "../src/flightPlan.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-lbase-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const env = { ...process.env, GIT_AUTHOR_NAME: "Ada Orbit", GIT_AUTHOR_EMAIL: "ada@orbit.test", GIT_COMMITTER_NAME: "Ada Orbit", GIT_COMMITTER_EMAIL: "ada@orbit.test", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...a: string[]) => { const r = Bun.spawnSync(["git", ...a], { cwd, env }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); return r.stdout.toString().trim(); };

const origin = join(dir, "origin.git");
const repo = join(dir, "orbit");
git(dir, "init", "-q", "--bare", "-b", "main", origin);
git(dir, "clone", "-q", origin, repo);
git(repo, "commit", "-q", "--allow-empty", "-m", "one");
git(repo, "push", "-q", "origin", "main");

describe("localBase", () => {
  test("level with the remote is the same commit either way, and the local ref follows later merges", () => {
    expect(localBase(repo, "origin/main")).toBe("main");
  });
  test("local trunk ahead of the remote is the base", () => {
    git(repo, "commit", "-q", "--allow-empty", "-m", "two, never pushed");
    expect(localBase(repo, "origin/main")).toBe("main");
  });
  test("a diverged local trunk keeps the remote ref", () => {
    git(repo, "reset", "-q", "--hard", "origin/main");
    git(repo, "commit", "-q", "--allow-empty", "-m", "local only");
    const other = join(dir, "other");
    git(dir, "clone", "-q", origin, other);
    git(other, "commit", "-q", "--allow-empty", "-m", "remote only");
    git(other, "push", "-q", "origin", "main");
    git(repo, "fetch", "-q", "origin");
    expect(localBase(repo, "origin/main")).toBe("origin/main");
  });
  test("a base that is not an origin ref passes through", () => {
    expect(localBase(repo, "main")).toBe("main");
  });
});

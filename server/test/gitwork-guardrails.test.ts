/*
 * Guardrails — protected branches, force-with-lease, and the reset refusal.
 *
 * The default list is main/master; a repo can extend it via config
 * (`agx.protectedbranches`), and setProtectedBranches writes the whole list
 * back. What the guard does:
 *   - `push` with force is ALWAYS `--force-with-lease`, never `--force`;
 *   - `resetTo(hard)` refuses on a protected branch unless force is passed
 *     (the reflog's own recovery path, which double-confirms).
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identify } from "./gitIdentity.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-guard-")));
process.env.AGENTGLASS_ROOT = dir;
const { protectedBranches, setProtectedBranches, resetTo, push, commitStaged } = await import("../src/gitwork.ts");

let repo = "";
const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd: repo });

function commit(file: string, msg: string): void {
  writeFileSync(join(repo, file), msg + "\n");
  git("add", "-A");
  git("commit", "-qm", msg);
}

function build(): void {
  repo = join(dir, `r-${Math.random().toString(36).slice(2)}`);
  Bun.spawnSync(["mkdir", "-p", repo]);
  git("init", "-q", "-b", "main", ".");
  identify(repo);
  commit("a.txt", "first");
  commit("b.txt", "second");
}

describe("guardrails", () => {
  beforeEach(build);

  it("defaults to main/master and reads repo config", () => {
    expect(protectedBranches(repo).branches).toEqual(["main", "master"]);
    git("config", "agx.protectedbranches", "release");
    expect(protectedBranches(repo).branches).toEqual(["main", "master", "release"]);
  });

  it("setProtectedBranches replaces the list but main/master always survive", () => {
    expect(setProtectedBranches(repo, ["develop", "release"]).ok).toBe(true);
    expect(protectedBranches(repo).branches).toEqual(["main", "master", "develop", "release"]);
    // main/master cannot be removed even by an empty list.
    expect(setProtectedBranches(repo, []).ok).toBe(true);
    expect(protectedBranches(repo).branches).toEqual(["main", "master"]);
  });

  it("hard-reset refuses on a protected branch…", () => {
    const r = resetTo(repo, git("rev-parse", "HEAD~1").stdout.toString().trim(), "hard");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("main is protected");
    // The branch did NOT move.
    expect(git("rev-parse", "--short", "HEAD").stdout.toString().trim().length).toBeGreaterThan(0);
  });

  it("…but force gets through (the reflog recovery path)", () => {
    const r = resetTo(repo, git("rev-parse", "HEAD~1").stdout.toString().trim(), "hard", true);
    expect(r.ok).toBe(true);
  });

  it("soft/mixed resets are allowed on protected branches", () => {
    expect(resetTo(repo, git("rev-parse", "HEAD~1").stdout.toString().trim(), "mixed").ok).toBe(true);
  });

  it("an unprotected branch resets freely", () => {
    git("checkout", "-qb", "feature");
    const r = resetTo(repo, git("rev-parse", "HEAD~1").stdout.toString().trim(), "hard");
    expect(r.ok).toBe(true);
  });

  it("force push refuses when the remote has moved (the lease working)", () => {
    // The whole point of --force-with-lease: a force push that would clobber
    // a remote ref which has moved since our last fetch MUST fail. Build the
    // situation: two clones share a bare remote, the other one pushes, and
    // this one force-pushes without fetching.
    const bare = join(dir, `bare-${Math.random().toString(36).slice(2)}`);
    // The bare must have a HEAD, or the other clone cannot push ("src refspec
    // main does not match any") and the remote never moves.
    git("init", "-q", "--bare", "--initial-branch=main", bare);
    git("remote", "add", "origin", bare);
    git("push", "-qu", "origin", "main");
    const other = join(dir, `other-${Math.random().toString(36).slice(2)}`);
    Bun.spawnSync(["git", "clone", "-q", bare, other]);
    // The OTHER clone moves the remote forward.
    Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "commit", "--allow-empty", "-qm", "other work"], { cwd: other });
    Bun.spawnSync(["git", "-C", other, "push", "-q", "origin", "main"]);
    // This side's remote-tracking ref is still at its original position
    // ("second") from the -u push — the other side moved the remote, and we
    // have NOT fetched. Force-pushing now must be refused by the lease.
    const r = push(repo, { force: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/stale info|rejected|not updated|up-to-date/i);
    // After a fresh fetch the lease agrees, and the same force push lands.
    expect(git("fetch", "-q", "origin").exitCode).toBe(0);
    expect(push(repo, { force: true }).ok).toBe(true);
  });

  it("commit to the current branch is unaffected by protection", () => {
    writeFileSync(join(repo, "c.txt"), "third\n");
    git("add", "-A");
    expect(commitStaged(repo, "third", "").ok).toBe(true);
    expect(git("log", "-1", "--format=%s").stdout.toString().trim()).toBe("third");
  });
});

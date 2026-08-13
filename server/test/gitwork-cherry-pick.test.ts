/*
 * The cherry-pick trigger, and the one thing it must never do.
 *
 * Everything after the trigger — the paused state, the two sides, continue and
 * abort — already existed for merges and had cherry-picking cases added to it
 * when that state was discovered by `treeState()`. So this file is not about
 * the conflict machinery; it is about the two decisions the trigger itself
 * makes:
 *
 *  1. The whole set goes in ONE sequencer run (`cherry-pick h1 h2 h3`), so a
 *     conflict pauses the series instead of pretending each commit is an
 *     independent, individually-abortable attempt.
 *
 *  2. It refuses to start when anything else is in progress. Two sequencer
 *     runs cannot share a repo, and git's error for it — "you have not
 *     concluded your previous cherry-pick" — is a description of what went
 *     wrong, not a way out. The refusal names the state so the banner can.
 *
 * The fixture shape: a main branch with its own commit on the same file, and a
 * feature branch whose middle commit collides with it. That makes both the
 * happy path and the conflict reachable from one repo, and the conflict comes
 * mid-series — the case a `cherry-pick c1 c2 c3` run is actually for.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Static, and it has no side effects — the dynamic imports below are ordered
// after AGENTGLASS_ROOT is set and this one must not disturb that.
import { identify } from "./gitIdentity.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-cherry-")));
process.env.AGENTGLASS_ROOT = dir;
const { cherryPick, cherryPickContinue, cherryPickAbort, conflicts, resolveWith, mergeContinue } =
  await import("../src/gitwork.ts");

let repo = "";
const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd: repo });

const subject = (ref = "HEAD") => git("log", "-1", "--format=%s", ref).stdout.toString().trim();
const read = (f: string) => readFileSync(join(repo, f), "utf8");

/**
 * main: seed, then "ours" on a.txt.
 * feat: seed, then "theirs" on a.txt (commit F1), then two commits that touch
 * only their own files (F2, F3). F1 collides with main's own commit; F2/F3
 * apply cleanly to anything. Picking F2..F3 lands clean; picking F1..F3
 * stops on F1, and continue replays F2 and F3 after the resolution.
 */
function build(): void {
  repo = join(dir, `r-${Math.random().toString(36).slice(2)}`);
  Bun.spawnSync(["mkdir", "-p", repo]);
  git("init", "-q", "-b", "main", ".");
  identify(repo);
  writeFileSync(join(repo, "a.txt"), "base\n");
  git("add", "-A"); git("commit", "-qm", "seed");

  git("checkout", "-q", "-b", "feat");
  writeFileSync(join(repo, "a.txt"), "theirs\n");
  git("add", "-A"); git("commit", "-qm", "feat one");
  writeFileSync(join(repo, "b.txt"), "b\n");
  git("add", "-A"); git("commit", "-qm", "feat two");
  writeFileSync(join(repo, "c.txt"), "c\n");
  git("add", "-A"); git("commit", "-qm", "feat three");

  git("checkout", "-q", "main");
  writeFileSync(join(repo, "a.txt"), "ours\n");
  git("add", "-A"); git("commit", "-qm", "main own");
}

const F1 = () => git("rev-parse", "feat~2").stdout.toString().trim();
const F2 = () => git("rev-parse", "feat~1").stdout.toString().trim();
const F3 = () => git("rev-parse", "feat").stdout.toString().trim();

beforeEach(build);
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("cherry-pick engine", () => {
  it("replays a clean set in one run, oldest first", () => {
    const r = cherryPick(repo, [F2(), F3()]);
    expect(r.ok).toBe(true);
    expect(subject()).toBe("feat three");
    const log = git("log", "--format=%s", "-3").stdout.toString().split("\n");
    expect(log).toContain("feat two");
    expect(log).toContain("feat three");
  });

  it("pauses mid-series on a conflict, and continue finishes it", () => {
    const r = cherryPick(repo, [F1(), F2(), F3()]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("could not apply");
    expect(conflicts(repo).state).toBe("cherry-picking");
    expect(conflicts(repo).files).toEqual([join(repo, "a.txt")]);

    // The shared resolution path is the one the panel uses for merges.
    const res = resolveWith(repo, "a.txt", "theirs");
    expect(res.ok).toBe(true);
    const fin = mergeContinue(repo);
    expect(fin.ok).toBe(true);
    expect(conflicts(repo).state).toBe("clean");
    // F1 stopped the run; continue replays F2 and F3 after it.
    expect(subject()).toBe("feat three");
    expect(read("a.txt")).toBe("theirs\n");
  });

  it("abort restores the branch to where it was", () => {
    const before = subject();
    cherryPick(repo, [F1(), F2(), F3()]);
    const a = cherryPickAbort(repo);
    expect(a.ok).toBe(true);
    expect(conflicts(repo).state).toBe("clean");
    expect(subject()).toBe(before);
  });

  it("-n stages the change without committing", () => {
    const headBefore = subject();
    const r = cherryPick(repo, [F2()], true);
    expect(r.ok).toBe(true);
    expect(subject()).toBe(headBefore);
    const staged = git("diff", "--cached", "--name-only").stdout.toString().trim();
    expect(staged).toContain("b.txt");
  });

  it("refuses when a pick is already in progress", () => {
    cherryPick(repo, [F1(), F2(), F3()]);
    const r = cherryPick(repo, [F3()]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("cherry-pick");
  });

  it("refuses bogus hashes instead of handing them to git", () => {
    const r = cherryPick(repo, ["HEAD", "main"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no valid commit hashes");
  });

  it("cherryPickContinue only acts when there is a pick to continue", () => {
    const r = cherryPickContinue(repo);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("nothing to continue");
  });
});

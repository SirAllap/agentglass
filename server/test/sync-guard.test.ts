import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Whether a branch's upstream is its own remote copy or the base branch itself.
 *
 * The panel refuses "merge the base in" while you are behind upstream, because
 * a remote copy of your branch may already contain that merge. That reasoning
 * does not apply to a branch tracking the trunk directly — there upstream IS
 * the base, and merging it is the only way to close the gap. Getting this wrong
 * disabled the button on exactly the branches that needed it, so it is tested
 * against real clones with real tracking refs.
 */
let origin: string, work: string, other: string, gw: typeof import("../src/gitwork.ts");

const run = (dir: string, ...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), "agx-guard-"));
  origin = join(base, "origin.git");
  work = join(base, "work");
  other = join(base, "other");

  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin], { encoding: "utf8" });
  spawnSync("git", ["clone", "-q", origin, work], { encoding: "utf8" });
  run(work, "config", "user.email", "t@example.com");
  run(work, "config", "user.name", "t");
  writeFileSync(join(work, "a.txt"), "one\n");
  run(work, "add", "-A");
  run(work, "commit", "-qm", "first");
  run(work, "push", "-q", "-u", "origin", "main");

  // The reads below meet the scope guard, which otherwise reads the running
  // machine's config. Point it at the fixture, before gitwork is imported.
  process.env.AGENTGLASS_ROOT = work;

  // A second clone stands in for "somebody else pushed", so the fixture's own
  // branches can fall behind without rewriting anything.
  spawnSync("git", ["clone", "-q", origin, other], { encoding: "utf8" });
  run(other, "config", "user.email", "u@example.com");
  run(other, "config", "user.name", "u");

  gw = await import("../src/gitwork.ts");
});

afterAll(() => {
  for (const d of [work, other, origin]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* fine */ } }
});

/** Move the trunk on the server, then make `work` aware of it. Puts the second
 *  clone back on main first: a case that left it on a branch would otherwise
 *  commit there and push a trunk that never moved. */
const advanceTrunk = (file: string) => {
  run(other, "checkout", "-q", "main");
  run(other, "pull", "-q", "--ff-only", "origin", "main");
  writeFileSync(join(other, file), "more\n");
  run(other, "add", "-A");
  run(other, "commit", "-qm", `trunk ${file}`);
  run(other, "push", "-q", "origin", "main");
  run(work, "fetch", "-q", "origin");
};

describe("upstream is the base", () => {
  it("says so for a local-only branch that tracks the trunk", async () => {
    // The shape every `git branch --track main` produces, and every worktree
    // cut from one: no remote copy of this branch exists at all.
    run(work, "checkout", "-q", "-b", "local-only", "--track", "origin/main");
    writeFileSync(join(work, "mine.txt"), "local work\n");
    run(work, "add", "-A");
    run(work, "commit", "-qm", "local work");
    advanceTrunk("b.txt");

    const b = (await gw.workingTree(work)).branch;
    expect(b.upstream).toBe("origin/main");
    expect(b.behind).toBeGreaterThan(0);
    expect(b.ahead).toBeGreaterThan(0); // diverged, so `pull --ff-only` cannot run
    expect(b.upstreamIsBase).toBe(true);
  });

  it("says no when the branch has a remote copy of its own", async () => {
    // Here being behind really does mean "your remote branch has commits you
    // do not", which is the case the guard was written for.
    run(work, "checkout", "-q", "-b", "twin");
    run(work, "push", "-q", "-u", "origin", "twin");
    run(other, "fetch", "-q", "origin");
    run(other, "checkout", "-q", "-b", "twin", "origin/twin");
    writeFileSync(join(other, "theirs.txt"), "from elsewhere\n");
    run(other, "add", "-A");
    run(other, "commit", "-qm", "their work");
    run(other, "push", "-q", "origin", "twin");
    advanceTrunk("c.txt");

    const b = (await gw.workingTree(work)).branch;
    expect(b.upstream).toBe("origin/twin");
    expect(b.behind).toBeGreaterThan(0);
    expect(b.upstreamIsBase).toBe(false);
  });

  it("does not ask while the branch is level with its upstream", async () => {
    // Nothing is blocked when behind is zero, so the two rev-parses it costs
    // would buy nothing on every poll of every repo.
    run(work, "checkout", "-q", "main");
    run(work, "merge", "-q", "--ff-only", "origin/main");

    const b = (await gw.workingTree(work)).branch;
    expect(b.behind).toBe(0);
    expect(b.upstreamIsBase).toBeUndefined();
  });

  it("is not fooled by a slash in the branch name", async () => {
    // Naive prefix-stripping turns `native/egui-shell` into `egui-shell` and
    // compares that against the trunk, which is how this gets quietly wrong.
    run(work, "checkout", "-q", "-b", "native/egui-shell", "--track", "origin/main");
    writeFileSync(join(work, "native.txt"), "shell\n");
    run(work, "add", "-A");
    run(work, "commit", "-qm", "native work");
    advanceTrunk("d.txt");

    const b = (await gw.workingTree(work)).branch;
    expect(b.name).toBe("native/egui-shell");
    expect(b.upstreamIsBase).toBe(true);
  });
});

/*
 * WIP snapshots — the safety net.
 *
 * The core property: a snapshot is a commit made with `stash create` that
 * touches the working tree NOT AT ALL, hung off refs/agx/wip/*. So:
 *   - create does not disturb the dirty tree;
 *   - restore brings it back (via stash-apply machinery), and can be done
 *     again — restore is not a one-shot;
 *   - the cap prunes the oldest past 30;
 *   - auto-stash wraps surgery: dirty tree → stash → op → pop, and the
 *     failure path leaves the stash where the error message says it is.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identify } from "./gitIdentity.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-snap-")));
process.env.AGENTGLASS_ROOT = dir;
const { createSnapshot, listSnapshots, restoreSnapshot, deleteSnapshot, withAutoStash } = await import("../src/gitwork.ts");

let repo = "";
const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd: repo });

function build(): void {
  repo = join(dir, `r-${Math.random().toString(36).slice(2)}`);
  Bun.spawnSync(["mkdir", "-p", repo]);
  git("init", "-q", "-b", "main", ".");
  identify(repo);
  writeFileSync(join(repo, "a.txt"), "seed\n");
  git("add", "-A");
  git("commit", "-qm", "seed");
}

describe("WIP snapshots", () => {
  beforeEach(build);

  it("round-trips: snapshot a dirty tree, clean it, restore the mess", () => {
    writeFileSync(join(repo, "a.txt"), "work in progress\n");
    const c = createSnapshot(repo, "before the experiment");
    expect(c.ok).toBe(true);
    expect(c.sha).toMatch(/^[0-9a-f]{40}$/);
    // Creating a snapshot touched NOTHING — the tree is still dirty.
    expect(git("status", "--porcelain").stdout.toString()).toContain("a.txt");
    // Empty the tree for real.
    git("checkout", "-f");
    git("clean", "-f", "-q");
    expect(git("status", "--porcelain").stdout.toString().trim()).toBe("");
    const r = restoreSnapshot(repo, c.sha!);
    expect(r.ok).toBe(true);
    expect(Bun.spawnSync(["cat", join(repo, "a.txt")], {}).stdout.toString()).toBe("work in progress\n");
    // The snapshot is still there — restore is not a one-shot ticket: revert
    // the tree and the same snapshot applies again.
    expect(listSnapshots(repo).snapshots!.length).toBe(1);
    git("checkout", "-f");
    git("clean", "-f", "-q");
    expect(restoreSnapshot(repo, c.sha!).ok).toBe(true);
    expect(Bun.spawnSync(["cat", join(repo, "a.txt")], {}).stdout.toString()).toBe("work in progress\n");
  });

  it("labels snapshots and lists them newest-first", () => {
    writeFileSync(join(repo, "a.txt"), "one\n");
    const c1 = createSnapshot(repo, "first");
    writeFileSync(join(repo, "a.txt"), "two\n");
    const c2 = createSnapshot(repo, "second");
    expect(c1.ok && c2.ok).toBe(true);
    const l = listSnapshots(repo);
    expect(l.ok).toBe(true);
    expect(l.snapshots!.map((s) => s.label)).toEqual(["second", "first"]);
    expect(l.snapshots![0]!.sha).toBe(c2.sha!);
  });

  it("delete removes exactly the named snapshot", () => {
    writeFileSync(join(repo, "a.txt"), "one\n");
    const c1 = createSnapshot(repo, "first");
    writeFileSync(join(repo, "a.txt"), "two\n");
    const c2 = createSnapshot(repo, "second");
    expect(deleteSnapshot(repo, c1.sha!).ok).toBe(true);
    const l = listSnapshots(repo);
    expect(l.snapshots!.map((s) => s.label)).toEqual(["second"]);
    // Deleting again reports the missing snapshot.
    expect(deleteSnapshot(repo, c1.sha!).ok).toBe(false);
    expect(listSnapshots(repo).snapshots!.length).toBe(1);
    void c2;
  });

  it("refuses a clean tree", () => {
    const c = createSnapshot(repo, "nothing to see");
    expect(c.ok).toBe(false);
    expect(c.error).toContain("clean");
  });

  it("prunes past the 30-snapshot cap, keeping the newest", () => {
    for (let i = 0; i < 35; i++) {
      writeFileSync(join(repo, "a.txt"), `work ${i}\n`);
      const c = createSnapshot(repo, `snap ${i}`);
      expect(c.ok).toBe(true);
    }
    const l = listSnapshots(repo);
    expect(l.snapshots!.length).toBe(30);
    expect(l.snapshots![0]!.label).toBe("snap 34");
    // The pruned old ones are gone from the ref namespace entirely.
    const refs = git("for-each-ref", "refs/agx/wip").stdout.toString().trim().split("\n").filter(Boolean);
    expect(refs.length).toBe(30);
  });

  it("auto-stash lets surgery run on a dirty tree and restores after", () => {
    writeFileSync(join(repo, "a.txt"), "dirty\n");
    const r = withAutoStash(repo, () => {
      // The op sees a clean tree — that is the point.
      if (git("status", "--porcelain").stdout.toString().trim() !== "") return { ok: false, error: "tree was dirty inside the op" };
      return { ok: true, output: "ok" };
    });
    expect(r.ok).toBe(true);
    // And the WIP came back after.
    expect(Bun.spawnSync(["cat", join(repo, "a.txt")], {}).stdout.toString()).toBe("dirty\n");
    expect(git("stash", "list").stdout.toString().trim()).toBe("");
  });

  it("auto-stash failure leaves the stash where the error says", () => {
    writeFileSync(join(repo, "a.txt"), "dirty\n");
    const r = withAutoStash(repo, () => ({ ok: false, error: "boom" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("stash@{0}");
    expect(git("stash", "list").stdout.toString()).toContain("agx: auto-stash");
  });
});

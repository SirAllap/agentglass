// Three server doors the Git panel's dead controls needed: fetch one named
// remote, compare a commit with the working tree, and a stash's commit hash.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identify } from "./gitIdentity.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-g1a-")));
process.env.AGENTGLASS_ROOT = dir;
const { fetch: fetchRemote, compareRefs, stashList, createBranch } = await import("../src/gitwork.ts");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sh = (cwd: string, ...a: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false", "-C", cwd, ...a]);
const out = (cwd: string, ...a: string[]) => sh(cwd, ...a).stdout.toString().trim();

// orbit: a work clone with two remotes, each with a branch the clone has not seen.
const w = join(dir, "orbit");
sh(dir, "init", "-q", "-b", "main", w); identify(w);
writeFileSync(join(w, "a.txt"), "one\ntwo\nthree\n"); sh(w, "add", "-A"); sh(w, "commit", "-qm", "base");
const first = out(w, "rev-parse", "HEAD");
for (const n of ["o1", "o2"]) { sh(dir, "init", "-q", "--bare", `${n}.git`); sh(w, "remote", "add", n, join(dir, `${n}.git`)); sh(w, "push", "-q", n, "main"); }
for (const n of ["o1", "o2"]) {
  const other = join(dir, `${n}-clone`);
  sh(dir, "clone", "-q", join(dir, `${n}.git`), other); identify(other);
  sh(other, "checkout", "-qb", `${n}-topic`); writeFileSync(join(other, `${n}.txt`), n); sh(other, "add", "-A"); sh(other, "commit", "-qm", n);
  sh(other, "push", "-q", "origin", `${n}-topic`);
}
const remoteRefs = () => out(w, "for-each-ref", "--format=%(refname:short)", "refs/remotes");

describe("/git/fetch with a remote name", () => {
  it("moves only that remote", () => {
    expect(fetchRemote(w, "o1").ok).toBe(true);
    expect(remoteRefs()).toContain("o1/o1-topic");
    expect(remoteRefs()).not.toContain("o2/o2-topic");
  });
  it("refuses a name git remote does not list, and an option-shaped one", () => {
    expect(fetchRemote(w, "nope")).toMatchObject({ ok: false, error: "no such remote: nope" });
    expect(fetchRemote(w, "--all").ok).toBe(false);
  });
  it("without a name still fetches every remote", () => {
    expect(fetchRemote(w).ok).toBe(true);
    expect(remoteRefs()).toContain("o2/o2-topic");
  });
});

describe("/git/compare with @worktree", () => {
  it("diffs the commit against the dirty file, with counts", () => {
    writeFileSync(join(w, "a.txt"), "one\nTWO\nthree\nfour\n");
    const r = compareRefs(w, first, "@worktree");
    expect(r.ok).toBe(true);
    expect(r.ahead).toEqual([]); expect(r.behind).toEqual([]);
    expect(r.diff).toHaveLength(1);
    expect(r.diff![0]).toMatchObject({ additions: 2, deletions: 1 });
  });
  it("still demands a real base", () => {
    expect(compareRefs(w, "nope", "@worktree").ok).toBe(false);
  });
});

describe("stash list and branch-from", () => {
  it("returns the stash commit's hash", () => {
    sh(w, "stash", "push", "-qm", "wip");
    const [s] = stashList(w);
    expect(s.hash).toBe(out(w, "rev-parse", "stash@{0}"));
  });
  it("creates a branch at the commit asked for", () => {
    expect(createBranch(w, "from-first", first).ok).toBe(true);
    expect(out(w, "rev-parse", "HEAD")).toBe(first);
    expect(createBranch(w, "x", "--evil").ok).toBe(false);
  });
});

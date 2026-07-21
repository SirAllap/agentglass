import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * The update path, which is the most dangerous code in the app: it runs
 * whatever the tag contains, as the user.
 *
 * The rule being tested is that a RELEASE is a tag somebody chose to publish,
 * never a branch tip. A branch tip is wherever development happened to stop, so
 * updating to it ships half-finished work to the machine the developer relies
 * on — which is the whole reason this tracks tags at all.
 */
let remote = "";
let work = "";
const git = (dir: string, ...a: string[]) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });

function makeRemote() {
  remote = mkdtempSync(join(tmpdir(), "agx-remote-"));
  spawnSync("git", ["init", "-q", "--bare", remote]);
  work = mkdtempSync(join(tmpdir(), "agx-work-"));
  spawnSync("git", ["init", "-q", "-b", "main", work]);
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "T");
  writeFileSync(join(work, "a.txt"), "one");
  git(work, "add", "-A"); git(work, "commit", "-qm", "one");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "-q", "-u", "origin", "main");
}

function release(tag: string) {
  writeFileSync(join(work, `${tag}.txt`), tag);
  git(work, "add", "-A"); git(work, "commit", "-qm", tag);
  git(work, "tag", tag);
  const p = git(work, "push", "-q", "--tags", "origin", "main");
  if (p.status !== 0) throw new Error(`fixture push failed: ${p.stderr}`);
}

/** Provenance as build.mjs writes it, in a directory that is not a repo. */
function installedAs(version: string, origin = remote, baseTag = "", distance = 0) {
  const dir = mkdtempSync(join(tmpdir(), "agx-installed-"));
  mkdirSync(join(dir, "electron", "staging"), { recursive: true });
  writeFileSync(join(dir, "electron", "staging", "build-info.json"), JSON.stringify({
    version, commit: "abc1234", builtAt: new Date(0).toISOString(), source: "/gone", origin, baseTag, distance,
  }));
  process.chdir(dir);
  return dir;
}

const load = async () => await import(`../src/selfupdate.ts?u=${Math.random()}`);

let cwd0 = "";
const trash: string[] = [];
beforeEach(() => { cwd0 = process.cwd(); makeRemote(); });
afterEach(() => {
  process.chdir(cwd0);
  for (const d of [remote, work, ...trash.splice(0)]) rmSync(d, { recursive: true, force: true });
});

describe("self update", () => {
  it("orders releases numerically, not lexically", async () => {
    const u = await load();
    // The bug this prevents: "v0.9.0" > "v0.10.0" as strings, so the newest
    // release would look older and the app would offer a downgrade.
    expect(u.cmpTag("v0.10.0", "v0.9.0")).toBeGreaterThan(0);
    expect(u.cmpTag("v1.0.0", "v0.99.9")).toBeGreaterThan(0);
    expect(u.cmpTag("v0.2.1", "v0.2.1")).toBe(0);
  });

  it("sees only published releases, and the newest first", async () => {
    release("v0.1.0"); release("v0.2.0"); release("v0.10.0");
    git(work, "tag", "wip-scratch"); git(work, "push", "-q", "--tags", "origin");
    const u = await load();
    const tags = u.remoteTags(remote);
    expect(tags).toEqual(["v0.10.0", "v0.2.0", "v0.1.0"]);
    expect(tags).not.toContain("wip-scratch"); // a private tag is not a release
  });

  it("offers the newer release and counts how many there are", async () => {
    release("v0.2.0"); release("v0.3.0"); release("v0.4.0");
    trash.push(installedAs("0.2.0"));
    const u = await load();
    const st = u.updateStatus();
    expect(st.available).toBe(true);
    expect(st.branch).toBe("v0.4.0");
    expect(st.behind).toBe(2);
    expect(st.incoming.map((c: { sha: string }) => c.sha)).toEqual(["v0.4.0", "v0.3.0"]);
    expect(st.blocked).toBeUndefined();
  });

  it("says up to date when it is already on the newest release", async () => {
    release("v0.2.0");
    trash.push(installedAs("0.2.0"));
    const u = await load();
    const st = u.updateStatus();
    expect(st.behind).toBe(0);
    expect(st.blocked).toBeUndefined();
    expect(u.startUpdate().ok).toBe(false);
  });

  it("NEVER offers a branch tip — commits after the tag are not an update", async () => {
    // The point of the whole design: work pushed after the last release must
    // not reach the installed app until somebody tags it.
    release("v0.2.0");
    writeFileSync(join(work, "wip.txt"), "half a feature");
    git(work, "add", "-A"); git(work, "commit", "-qm", "wip: not ready");
    git(work, "push", "-q", "origin", "main");
    trash.push(installedAs("0.2.0"));
    const u = await load();
    const st = u.updateStatus();
    expect(st.behind).toBe(0);
    expect(u.startUpdate().ok).toBe(false);
  });

  it("treats a build ahead of every release as up to date, not as a downgrade", async () => {
    // The developer's own machine, mid-cycle: nothing published is newer, and
    // offering to move backwards would be worse than useless.
    release("v0.2.0");
    trash.push(installedAs("0.9.0"));
    const u = await load();
    const st = u.updateStatus();
    expect(st.behind).toBe(0);
    expect(u.startUpdate().ok).toBe(false);
  });

  it("does not offer a downgrade when package.json was never bumped", async () => {
    // The real case, caught on the author's own machine: package.json read
    // 0.2.0 both at tag v0.2.1 and 48 commits past it, so comparing versions
    // made the tag look newer — one click from replacing a current build with
    // one 48 commits older. What git describes the build as is the truth.
    release("v0.2.0"); release("v0.2.1");
    trash.push(installedAs("0.2.0", remote, "v0.2.1", 48));
    const u = await load();
    const st = u.updateStatus();
    expect(st.behind).toBe(0);
    expect(st.incoming).toEqual([]);
    expect(u.startUpdate().ok).toBe(false);
  });

  it("still offers a genuinely newer release to a build past an older tag", async () => {
    release("v0.2.0"); release("v0.2.1"); release("v0.3.0");
    trash.push(installedAs("0.2.0", remote, "v0.2.1", 48));
    const u = await load();
    const st = u.updateStatus();
    expect(st.branch).toBe("v0.3.0");
    expect(st.behind).toBe(1);
  });

  it("says so when nothing has been released yet", async () => {
    trash.push(installedAs("0.2.0"));
    const u = await load();
    const st = u.updateStatus();
    expect(st.behind).toBe(0);
    expect(st.blocked).toContain("no releases");
    expect(u.startUpdate().ok).toBe(false);
  });

  it("cannot update a build that records no origin", async () => {
    release("v0.3.0");
    trash.push(installedAs("0.2.0", ""));
    const u = await load();
    const st = u.updateStatus();
    expect(st.available).toBe(false);
    expect(st.blocked).toContain("no origin");
    expect(u.startUpdate().ok).toBe(false);
  });

  it("degrades rather than throwing when the remote is unreachable", async () => {
    trash.push(installedAs("0.2.0", join(tmpdir(), "no-such-remote-" + Math.random())));
    const u = await load();
    const st = u.updateStatus();
    expect(st.ok).toBe(true);
    expect(st.behind).toBe(0);
    expect(st.blocked).toBeTruthy();
  });

  it("never touches the developer's checkout", async () => {
    // The first version pulled in the working directory. Whatever else changes,
    // this must not: the update reads the remote and nothing local.
    release("v0.3.0");
    const before = git(work, "rev-parse", "HEAD").stdout.trim();
    writeFileSync(join(work, "uncommitted.txt"), "in progress");
    trash.push(installedAs("0.2.0"));
    const u = await load();
    u.updateStatus();
    expect(git(work, "rev-parse", "HEAD").stdout.trim()).toBe(before);
    expect(readFileSync(join(work, "uncommitted.txt"), "utf8")).toBe("in progress");
    expect(git(work, "status", "--porcelain").stdout).toContain("uncommitted.txt");
  });

  it("ships an update script that refuses anything but a release tag", () => {
    // Resolved from this file, never from process.cwd(): the suite is run from
    // the repo root by hand and from `server/` by CI, and a path that depends
    // on which one passed locally and failed in CI.
    const real = join(import.meta.dir, "..", "..", "electron", "self-update.sh");
    expect(existsSync(real)).toBe(true);
    const text = readFileSync(real, "utf8");
    expect(text).toContain("refusing a tag that is not a release");
    expect(text).toContain("--detach");
    expect(text).toContain(".cache/agentglass/source");
  });
});

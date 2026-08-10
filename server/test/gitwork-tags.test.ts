/*
 * Tags power-ups: create (lightweight + annotated), delete (with the local
 * ownership check), push and remote-delete. The fixture is a bare remote that
 * the working repo tracks, so pushes are hermetic.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identify } from "./gitIdentity.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-tags-")));
process.env.AGENTGLASS_ROOT = dir;
const { createTag, deleteTag, pushTag, deleteRemoteTag, tags } = await import("../src/gitwork.ts");

let repo = "";
let remote = "";
const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd: repo });

function build(): void {
  repo = join(dir, `r-${Math.random().toString(36).slice(2)}`);
  remote = join(dir, `remote-${Math.random().toString(36).slice(2)}.git`);
  Bun.spawnSync(["mkdir", "-p", repo]);
  git("init", "-q", "-b", "main", ".");
  identify(repo);
  git("init", "-q", "--bare", remote);
  git("remote", "add", "origin", remote);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "first");
  git("push", "-q", "origin", "main");
}

beforeEach(build);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const tagNames = async () => (await tags(repo)).map((t) => t.name);

describe("tags", () => {
  it("creates a lightweight tag on HEAD", async () => {
    const r = createTag(repo, "v1.0");
    expect(r.ok).toBe(true);
    expect(await tagNames()).toEqual(["v1.0"]);
    expect(git("tag", "-l").stdout.toString().trim()).toBe("v1.0");
  });

  it("annotated tag round-trips its message", async () => {
    const r = createTag(repo, "v1.0", { annotated: true, message: "the big one" });
    expect(r.ok).toBe(true);
    const out = git("for-each-ref", "refs/tags", "--format=%(objecttype)|%(contents:subject)").stdout.toString().trim();
    expect(out).toBe("tag|the big one");
  });

  it("annotated tag without a message is refused", () => {
    const r = createTag(repo, "v1.0", { annotated: true });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("needs a message");
  });

  it("refuses to double-tag", () => {
    createTag(repo, "v1.0");
    const r = createTag(repo, "v1.0");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("already exists");
  });

  it("refuses an invalid name", () => {
    const r = createTag(repo, "..");
    expect(r.ok).toBe(false);
  });

  it("deletes a local tag, and only a local one", async () => {
    createTag(repo, "v1.0");
    expect(deleteTag(repo, "v1.0").ok).toBe(true);
    expect(await tagNames()).toEqual([]);
    // Not a local tag — `-d` must refuse rather than touch anything.
    const r = deleteTag(repo, "origin/main");
    expect(r.ok).toBe(false);
    expect(git("branch", "-r").stdout.toString()).toContain("origin/main");
  });

  it("push sends the tag to the remote; remote-delete removes it", async () => {
    createTag(repo, "v1.0");
    const p = pushTag(repo, "v1.0");
    expect(p.ok).toBe(true);
    expect(git("ls-remote", "--tags", remote).stdout.toString()).toContain("refs/tags/v1.0");
    const d = deleteRemoteTag(repo, "v1.0");
    expect(d.ok).toBe(true);
    expect(git("ls-remote", "--tags", remote).stdout.toString()).not.toContain("v1.0");
    // Local tag survives the remote delete.
    expect(await tagNames()).toEqual(["v1.0"]);
  });

  it("push refuses a tag that is not local, and a remote that is not there", async () => {
    expect(pushTag(repo, "nope").ok).toBe(false);
    createTag(repo, "v1.0");
    const r = pushTag(repo, "v1.0", "nowhere");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("no such remote");
  });
});

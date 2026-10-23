/*
 * GET /prs/tree-at: a commit of a local checkout as a tar, for a reviewer that
 * must not call `gh`. Asserted against a real temp repository where git decides;
 * the head sha is seeded into the detail cache, the one input taken from GitHub.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agx-treeat-home-"));
process.env.XDG_CONFIG_HOME = join(home, "config");
process.env.XDG_DATA_HOME = join(home, "data");
process.env.XDG_CACHE_HOME = join(home, "cache");
process.env.AGENTGLASS_STATE_DIR = join(home, "state");
process.env.AGENTGLASS_DB = join(home, "s.db");

const prs = await import("../src/prs.ts");
const { treeAtTar, dropEscapingLinks, TREE_AT_CAPS } = await import("../src/treeAt.ts");
const { exportTree } = await import("../src/treeExport.ts");
const INDEX = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();

let dir = "";
const sha: Record<string, string> = {};
const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
  return new TextDecoder().decode(r.stdout).trim();
};
const commit = (name: string, msg: string) => { git("add", "-A"); git("commit", "-qm", msg); sha[name] = git("rev-parse", "HEAD"); };
const treeLeftovers = () => readdirSync(tmpdir()).filter((n) => n.startsWith("agx-treeat-") && !n.startsWith("agx-treeat-home-"));
const tarList = async (body: ReadableStream<Uint8Array>) => {
  const f = join(home, "out.tar");
  await Bun.write(f, await new Response(body).arrayBuffer());
  const r = Bun.spawnSync(["tar", "-tvf", f]);
  return new TextDecoder().decode(r.stdout);
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-treeat-repo-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("remote", "add", "origin", "https://github.com/acme/orbit.git");
  writeFileSync(join(dir, "a.txt"), "one\n");
  commit("base", "base");
  git("checkout", "-q", "-b", "feature");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "b.txt"), "new\n");
  writeFileSync(join(dir, "pic.bin"), Buffer.from([0, 1, 2, 0, 255, 0]));
  symlinkSync("src/b.txt", join(dir, "inside"));
  symlinkSync("../../etc/passwd", join(dir, "up"));
  symlinkSync("/etc/passwd", join(dir, "abs"));
  commit("c1", "c1");
  git("checkout", "-q", "-b", "elsewhere", sha.base);
  writeFileSync(join(dir, "z.txt"), "z\n");
  commit("stray", "stray");
  git("checkout", "-q", "feature");
  const repo = await prs.repoIdFor(dir);
  expect(repo, "the temp repo resolves to acme/orbit").not.toBeNull();
  prs.__seedDetail(`${repo!.key}#7`, { number: 7, headSha: sha.c1, baseSha: sha.base } as never);
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

describe("treeAtTarget", () => {
  test("a checkout and a commit it holds resolve to the full oid", async () => {
    const t = await prs.treeAtTarget(dir, sha.c1.slice(0, 9));
    expect(t).toEqual({ ok: true, root: dir, sha: sha.c1 });
  });

  test("a sha that is not 7-40 hex is refused before git is asked", async () => {
    for (const bad of ["", "abc", "HEAD", "--output=/tmp/x", `${sha.c1}0`, "main"]) {
      const t = await prs.treeAtTarget(dir, bad);
      expect(t, bad).toEqual({ ok: false, error: "invalid commit" });
    }
  });

  test("a commit the checkout does not hold is `missing` and nothing is fetched", async () => {
    const t = await prs.treeAtTarget(dir, "a".repeat(40));
    expect(t.ok).toBe(false);
    expect((t as { missing?: string }).missing).toBe("a".repeat(40));
  });

  test("with a number, a commit outside that pull request's history is refused", async () => {
    expect((await prs.treeAtTarget(dir, sha.c1, 7)).ok).toBe(true);
    expect((await prs.treeAtTarget(dir, sha.base, 7)).ok).toBe(true);
    const t = await prs.treeAtTarget(dir, sha.stray, 7);
    expect(t.ok).toBe(false);
    expect((t as { error: string }).error).toContain("is not part of this pull request");
    expect((await prs.treeAtTarget(dir, sha.c1, "x")).ok).toBe(false);
  });

  test("a `gh:` root has no checkout and gets the existing message", async () => {
    expect(await prs.treeAtTarget("gh:acme/orbit", sha.c1)).toEqual({ ok: false, error: "not a git checkout" });
  });

  test("a root outside the scope the token reaches is refused", async () => {
    const outside = mkdtempSync(join(tmpdir(), "agx-treeat-out-"));
    try {
      Bun.spawnSync(["git", "-C", outside, "init", "-q"]);
      process.env.AGENTGLASS_ROOT = dir;
      const t = await prs.treeAtTarget(outside, sha.c1);
      expect(t).toEqual({ ok: false, error: "that checkout is outside the open project" });
    } finally {
      delete process.env.AGENTGLASS_ROOT;
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("treeAtTar", () => {
  test("happy path: the commit's files, binary kept, an inside link kept, escaping links dropped, no leftovers", async () => {
    const before = treeLeftovers();
    const t = await treeAtTar(dir, sha.c1);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(t.files).toBe(6);
    const list = await tarList(t.body);
    expect(list).toContain("src/b.txt");
    expect(list).toContain("pic.bin");
    expect(list).toMatch(/inside -> src\/b\.txt/);
    expect(list).not.toContain("up ->");
    expect(list).not.toContain("abs ->");
    expect(treeLeftovers()).toEqual(before);
  });

  test("the checkout is not written to", async () => {
    const status = git("status", "--porcelain");
    const t = await treeAtTar(dir, sha.base);
    if (t.ok) await t.body.cancel();
    expect(git("status", "--porcelain")).toBe(status);
    expect(git("rev-parse", "HEAD")).toBe(sha.c1);
  });

  test("a cancelled stream cleans up", async () => {
    const before = treeLeftovers();
    const t = await treeAtTar(dir, sha.c1);
    expect(t.ok).toBe(true);
    if (t.ok) await t.body.cancel();
    expect(treeLeftovers()).toEqual(before);
  });

  test("past the file-count cap the error names the cap and nothing is left", async () => {
    const before = treeLeftovers();
    const r = await exportTree(dir, sha.c1, join(home, "capped"), { caps: { ...TREE_AT_CAPS, entries: 2 } });
    expect(r).toBe("the commit has more than 2 files");
    const big = await exportTree(dir, sha.c1, join(home, "capped2"), { caps: { ...TREE_AT_CAPS, blob: 3 } });
    expect(big).toMatch(/^a file in the commit is over /);
    const all = await exportTree(dir, sha.c1, join(home, "capped3"), { caps: { ...TREE_AT_CAPS, total: 10 } });
    expect(all).toMatch(/in all$/);
    expect(treeLeftovers()).toEqual(before);
  });

  test("a failed export leaves no folder behind", async () => {
    const before = treeLeftovers();
    const r = await treeAtTar(dir, "b".repeat(40));
    expect(r.ok).toBe(false);
    expect(treeLeftovers()).toEqual(before);
  });

  test("dropEscapingLinks keeps a link inside, drops one out, even through another link", () => {
    const t = mkdtempSync(join(tmpdir(), "agx-treeat-links-"));
    try {
      mkdirSync(join(t, "tree", "d"), { recursive: true });
      writeFileSync(join(t, "tree", "d", "f"), "x");
      symlinkSync("d/f", join(t, "tree", "ok"));
      symlinkSync("..", join(t, "tree", "up"));
      symlinkSync("up/x", join(t, "tree", "via"));
      symlinkSync("../gone", join(t, "tree", "dangling-out"));
      dropEscapingLinks(join(t, "tree"));
      expect(existsSync(join(t, "tree", "ok"))).toBe(true);
      expect(lstatSync(join(t, "tree", "d")).isDirectory()).toBe(true);
      const left = readdirSync(join(t, "tree")).sort();
      expect(left).toEqual(["d", "ok", "via"]);
    } finally { rmSync(t, { recursive: true, force: true }); }
  });
});

describe("the route", () => {
  test("exists, guards with treeAtTarget, and sends the two headers", () => {
    const at = INDEX.indexOf('pathname === "/prs/tree-at"');
    expect(at).toBeGreaterThan(0);
    const block = INDEX.slice(at, INDEX.indexOf("/prs/commit-diff", at));
    expect(block).toContain("treeAtTarget(");
    expect(block).toContain("x-tree-sha");
    expect(block).toContain("x-tree-files");
    expect(block).not.toContain("mayReadForeignRoot");
  });
});

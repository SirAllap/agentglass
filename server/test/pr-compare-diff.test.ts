/*
 * The diff between two commits of a pull request, the head shas the detail carries,
 * and the label filter on the list: the three reads a plugin that reviews pull
 * requests leans on, asserted against a real repository where git decides.
 *
 * The detail is seeded rather than fetched: the head sha is the one input
 * compareDiff takes from GitHub, and a test that reached for the network would
 * only prove that the network was there.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agx-cmp-home-"));
process.env.XDG_CONFIG_HOME = join(home, "config");
process.env.XDG_DATA_HOME = join(home, "data");
process.env.XDG_CACHE_HOME = join(home, "cache");
process.env.AGENTGLASS_STATE_DIR = join(home, "state");
process.env.AGENTGLASS_DB = join(home, "s.db");

const prs = await import("../src/prs.ts");
const SRC = await Bun.file(new URL("../src/prs.ts", import.meta.url)).text();
const INDEX = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();

let dir = "";
const sha: Record<string, string> = {};
const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
  return new TextDecoder().decode(r.stdout).trim();
};
const commit = (name: string, msg: string) => { git("add", "-A"); git("commit", "-qm", msg); sha[name] = git("rev-parse", "HEAD"); };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-cmp-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("remote", "add", "origin", "https://github.com/acme/orbit.git");
  writeFileSync(join(dir, "a.txt"), "one\n");
  commit("base", "base");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "a.txt"), "two\n");
  commit("c1", "c1");
  writeFileSync(join(dir, "b.txt"), "new\n");
  writeFileSync(join(dir, "pic.bin"), Buffer.from([0, 1, 2, 0, 255, 0]));
  commit("c2", "c2");
  // A commit on a branch that is not the pull request's.
  git("checkout", "-q", "-b", "elsewhere", sha.base);
  writeFileSync(join(dir, "z.txt"), "z\n");
  commit("stray", "stray");
  git("checkout", "-q", "feature");
  const repo = await prs.repoIdFor(dir);
  expect(repo, "the temp repo resolves to acme/orbit").not.toBeNull();
  prs.__seedDetail(`${repo!.key}#7`, { number: 7, headSha: sha.c2, baseSha: sha.base } as never);
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

describe("compareDiff", () => {
  test("happy path: the unified diff between two commits, binary as git's own line", async () => {
    const r = await prs.compareDiff(dir, 7, sha.c1, sha.c2);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("diff --git a/b.txt b/b.txt");
    expect(r.text).toContain("+new");
    expect(r.text).toMatch(/Binary files .*pic\.bin.* differ/);
    expect(r.text).not.toContain("a.txt");
  });

  test("abbreviated shas work and the same diff comes back", async () => {
    const full = await prs.compareDiff(dir, 7, sha.c1, sha.c2);
    const short = await prs.compareDiff(dir, 7, sha.c1.slice(0, 7), sha.c2.slice(0, 12));
    expect(short.text).toBe(full.text);
  });

  test("a sha that is not 7-40 hex is refused before git is asked", async () => {
    for (const bad of ["", "abc", "xyz1234", "HEAD", "--output=/tmp/x", `${sha.c1}0`, "main"]) {
      const r = await prs.compareDiff(dir, 7, bad, sha.c2);
      expect(r.ok, bad).toBe(false);
      expect(r.error, bad).toBe("invalid commit");
    }
    expect((await prs.compareDiff(dir, 0, sha.c1, sha.c2)).error).toBe("invalid pull request number");
  });

  test("a commit of the repository that is not in the pull request's history is refused", async () => {
    const r = await prs.compareDiff(dir, 7, sha.c1, sha.stray);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("is not part of this pull request");
  });

  test("a commit the clone does not hold is `missing`, and nothing is fetched", async () => {
    const r = await prs.compareDiff(dir, 7, "a".repeat(40), sha.c2);
    expect(r.ok).toBe(true);
    expect(r.missing).toBe("a".repeat(40));
    expect(r.text).toBeUndefined();
  });

  test("a diff over the cap is refused whole, not cut", async () => {
    writeFileSync(join(dir, "big.txt"), "x".repeat(40) + "\n" + "y".repeat(7 * 1024 * 1024) + "\n");
    commit("big", "big");
    const repo = await prs.repoIdFor(dir);
    prs.__seedDetail(`${repo!.key}#8`, { number: 8, headSha: sha.big, baseSha: sha.base } as never);
    const r = await prs.compareDiff(dir, 8, sha.c2, sha.big);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("larger than 6 MB");
    expect(r.text).toBeUndefined();
  });

  test("a root with no checkout is refused", async () => {
    const r = await prs.compareDiff("gh:acme/orbit", 7, sha.c1, sha.c2);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not a git checkout");
  });

  test("the route exists and sits behind the generic foreign-root gate, not a private one", () => {
    expect(INDEX).toContain('pathname === "/prs/compare-diff"');
    const at = INDEX.indexOf('pathname === "/prs/compare-diff"');
    const block = INDEX.slice(at, INDEX.indexOf("/prs/commit-diff", at));
    expect(block).toContain("compareDiff(");
    expect(block).not.toContain("mayReadForeignRoot");
  });
});

describe("headSha and baseSha on the detail", () => {
  test("ride the detail query's own node, and no second request asks for them", () => {
    const q = prs.DETAIL_QUERY;
    expect(q).toContain("headRefOid");
    expect(q).toContain("baseRefOid");
    const from = SRC.indexOf("const detail: PrDetail = {");
    const body = SRC.slice(from, SRC.indexOf("\n  };", from));
    expect(body).toContain("headSha: p.headRefOid");
    expect(body).toContain("baseSha: p.baseRefOid");
  });
});

describe("the label filter on the list", () => {
  const repo = { key: "github.com/acme/orbit", host: "github.com", owner: "acme", name: "orbit", nameWithOwner: "acme/orbit" } as never;

  test("each label becomes a qualifier, so GitHub ANDs them", () => {
    const q = prs.labelQuery(["review:caveman", "bug fix"]);
    expect(q).toBe('label:"review:caveman" label:"bug fix"');
    const e = prs.__test_searchExpr(repo, "all", "open", q);
    // Quoted by the search grammar only when it has a space in it.
    expect(e).toContain("label:review:caveman");
    expect(e).toContain('label:"bug fix"');
  });

  test("a quote cannot end the qualifier early; blanks and repeats drop; ten at most", () => {
    expect(prs.labelQuery(['a" author:evil'])).toBe('label:"a  author:evil"');
    expect(prs.labelQuery(["", "  ", "x", "x"])).toBe('label:"x"');
    expect(prs.labelQuery(Array.from({ length: 30 }, (_, i) => `l${i}`)).split(" label:").length).toBe(10);
    expect(prs.labelQuery(undefined)).toBe("");
  });

  test("it joins the typed filter and so is part of the cache key", () => {
    const from = SRC.indexOf("export async function listPrs(");
    const body = SRC.slice(from, SRC.indexOf("\n}\n", from));
    expect(body).toContain("labelQuery(labelsIn)");
    expect(body.indexOf("labelQuery(labelsIn)")).toBeLessThan(body.indexOf("cacheKey(repo, filter, state, after, query)"));
  });

  test("the route passes every `label` and a labelled read is not the whole list", () => {
    const from = INDEX.indexOf('pathname === "/prs/list"');
    const block = INDEX.slice(from, INDEX.indexOf('pathname === "/prs/files-since"', from));
    expect(block).toContain('getAll("label")');
    expect(block).toMatch(/!url\.searchParams\.getAll\("label"\)\.length/);
  });
});

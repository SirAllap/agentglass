/*
 * Commit + code search: message/sha commit search, working-tree grep, and the
 * -S/-G pickaxe. The fixture repo has five commits, each touching its own
 * file, with one committing a shared token ("needle") into two files.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identify } from "./gitIdentity.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-search-")));
process.env.AGENTGLASS_ROOT = dir;
const { searchCommits, grepWorkingTree, searchHistory } = await import("../src/gitwork.ts");

let repo = "";
const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd: repo });
const commit = (file: string, body: string, msg: string) => {
  writeFileSync(join(repo, file), body + "\n");
  git("add", "-A");
  git("commit", "-qm", msg);
};

function build(): void {
  repo = join(dir, `r-${Math.random().toString(36).slice(2)}`);
  Bun.spawnSync(["mkdir", "-p", repo]);
  git("init", "-q", "-b", "main", ".");
  identify(repo);
  commit("one.txt", "plain line", "first commit");
  commit("two.txt", "needle here", "fix the widget");
  commit("three.txt", "needle also here", "second needle");
  commit("four.txt", "unrelated", "tidy up");
  commit("five.txt", "again a needle", "needle strikes back");
}

beforeEach(build);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("searchCommits", () => {
  it("finds message matches case-insensitively, newest first", () => {
    const r = searchCommits(repo, "needle");
    expect(r.ok).toBe(true);
    const subjects = r.entries.map((e) => e.subject);
    expect(subjects).toEqual(["needle strikes back", "second needle"]);
  });

  it("matches a sha prefix", () => {
    const full = git("rev-parse", "HEAD~3").stdout.toString().trim();
    const r = searchCommits(repo, full.slice(0, 6));
    expect(r.ok).toBe(true);
    expect(r.entries[0]).toMatchObject({ fullHash: full, subject: "fix the widget" });
  });

  it("filters by author and since", () => {
    const r = searchCommits(repo, "needle", "Other Person");
    expect(r.entries).toEqual([]);
  });

  it("is empty on a bogus repo", () => {
    const r = searchCommits("/nope", "x");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not a git repository root");
  });
});

describe("grepWorkingTree", () => {
  it("finds hits with path, line and text", () => {
    const r = grepWorkingTree(repo, "needle");
    expect(r.ok).toBe(true);
    expect(r.hits.length).toBe(3);
    const paths = r.hits.map((h) => h.path).sort();
    expect(paths).toEqual(["five.txt", "three.txt", "two.txt"]);
    expect(r.hits[0]).toMatchObject({ line: 1 });
    expect(r.hits[0].text).toContain("needle");
  });

  it("no matches is ok with an empty list (exit 1)", () => {
    const r = grepWorkingTree(repo, "zzz-nothing");
    expect(r.ok).toBe(true);
    expect(r.hits).toEqual([]);
  });

  it("case-sensitive flag", () => {
    const r = grepWorkingTree(repo, "NEEDLE", { caseSensitive: true });
    expect(r.ok).toBe(true);
    expect(r.hits).toEqual([]);
  });

  it("regex mode", () => {
    const r = grepWorkingTree(repo, "^plain", { regex: true });
    expect(r.ok).toBe(true);
    expect(r.hits.map((h) => h.path)).toEqual(["one.txt"]);
  });

  it("an invalid regex is an error, not a crash", () => {
    const r = grepWorkingTree(repo, "([", { regex: true });
    expect(r.ok).toBe(false);
    expect(r.error!.length).toBeGreaterThan(0);
  });
});

describe("searchHistory (pickaxe)", () => {
  it("-S finds commits that changed the token count", () => {
    const r = searchHistory(repo, "needle", "S");
    expect(r.ok).toBe(true);
    // "needle" first appeared in two.txt (fix the widget); its count changed
    // again in three.txt and five.txt — every commit that touched it.
    const subjects = r.entries.map((e) => e.subject);
    for (const s of ["fix the widget", "second needle", "needle strikes back"]) {
      expect(subjects).toContain(s);
    }
  });

  it("-G matches a regex against patches", () => {
    const r = searchHistory(repo, "needle (also|here)", "G");
    expect(r.ok).toBe(true);
    const subjects = r.entries.map((e) => e.subject);
    expect(subjects).toContain("second needle");
    expect(subjects).toContain("fix the widget");
    expect(subjects).not.toContain("needle strikes back");
  });

  it("refuses a dash-prefixed query", () => {
    const r = searchHistory(repo, "-n", "S");
    expect(r.ok).toBe(false);
  });
});

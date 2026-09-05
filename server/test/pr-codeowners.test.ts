/*
 * Reading the repository's own CODEOWNERS.
 *
 * The rule with a consequence is which FILE is read: GitHub looks in `.github/`,
 * then the root, then `docs/`, and the first one that exists wins even when it is
 * empty. A repository with a stale root file and a live `.github/` one behaves
 * differently depending on which you read, and the one it enforces is the one to
 * show.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeowners } from "../src/prs.ts";

let dir = "";
const repo = () => {
  dir = mkdtempSync(join(tmpdir(), "agx-owners-"));
  Bun.spawnSync(["git", "-C", dir, "init", "-q"]);
  return dir;
};
const write = (rel: string, text: string) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
};

beforeEach(() => { repo(); });
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("codeowners", () => {
  test("reads the rules, with their owners", async () => {
    write(".github/CODEOWNERS", "# who\n*       @everyone\n/src/billing/  @acme/payments @acme/backend\n");
    const r = await codeowners(dir);
    expect(r.ok).toBe(true);
    expect(r.path).toBe(".github/CODEOWNERS");
    expect(r.rules).toEqual([
      { pattern: "*", owners: ["@everyone"] },
      { pattern: "/src/billing/", owners: ["@acme/payments", "@acme/backend"] },
    ]);
  });

  test("takes the first place GitHub looks, even when a later one has more in it", async () => {
    write(".github/CODEOWNERS", "* @from-github-dir\n");
    write("CODEOWNERS", "* @from-root\n/a @also-root\n");
    const r = await codeowners(dir);
    expect(r.path).toBe(".github/CODEOWNERS");
    expect(r.rules).toEqual([{ pattern: "*", owners: ["@from-github-dir"] }]);
  });

  test("and falls through to the root, then to docs", async () => {
    write("docs/CODEOWNERS", "* @writers\n");
    const r = await codeowners(dir);
    expect(r.path).toBe("docs/CODEOWNERS");
  });

  // A pattern with nobody after it takes the path back off whoever owned it.
  test("keeps a rule that names nobody, because it means something", async () => {
    write("CODEOWNERS", "* @everyone\n/vendor/\n");
    const r = await codeowners(dir);
    expect(r.rules?.[1]).toEqual({ pattern: "/vendor/", owners: [] });
  });

  test("drops comments and blank lines, and a trailing comment on a rule", async () => {
    write("CODEOWNERS", "\n# a comment\n\n*.sql @dba # the database people\n");
    const r = await codeowners(dir);
    expect(r.rules).toEqual([{ pattern: "*.sql", owners: ["@dba"] }]);
  });

  test("a repository with no CODEOWNERS answers with none, not with an error", async () => {
    const r = await codeowners(dir);
    expect(r).toEqual({ ok: true, rules: [] });
  });

  test("and somewhere that is not a checkout is refused", async () => {
    const r = await codeowners("/definitely/not/a/repo/anywhere");
    expect(r.ok).toBe(false);
  });
});

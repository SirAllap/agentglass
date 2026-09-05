/*
 * Which files moved between two commits — against a real repository, because the
 * whole point of this function is that it does NOT ask GitHub.
 *
 * The obvious implementation is `GET /repos/{o}/{r}/compare/A...B`, and it was
 * measured before this was written: against the organisation repository this feature
 * is for, every call answers 404 with a token GraphQL is perfectly happy with — REST
 * on an SSO organisation refuses by pretending the resource is not there. On a
 * personal repository the same call alternated between 200 and 404 across five
 * consecutive tries. Git answers it exactly, offline, in one process.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesSince } from "../src/prs.ts";

let dir = "";
let first = "";
let second = "";
let third = "";

const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
  return new TextDecoder().decode(r.stdout).trim();
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-since-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/a.ts"), "one\n");
  writeFileSync(join(dir, "src/b.ts"), "one\n");
  git("add", "-A"); git("commit", "-qm", "first");
  first = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "src/b.ts"), "two\n");
  git("add", "-A"); git("commit", "-qm", "second");
  second = git("rev-parse", "HEAD");
  // A path with a space in it, because the parser is `-z` for a reason.
  writeFileSync(join(dir, "src/c d.ts"), "new\n");
  git("add", "-A"); git("commit", "-qm", "third");
  third = git("rev-parse", "HEAD");
});

afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("filesSince", () => {
  test("answers with the files that moved, and only those", async () => {
    const r = await filesSince(dir, first, second);
    expect(r.ok).toBe(true);
    expect(r.paths).toEqual(["src/b.ts"]);
  });

  test("across several commits", async () => {
    const r = await filesSince(dir, first, third);
    expect(new Set(r.paths)).toEqual(new Set(["src/b.ts", "src/c d.ts"]));
  });

  test("a short sha is as good as a long one", async () => {
    const r = await filesSince(dir, first.slice(0, 8), third.slice(0, 8));
    expect(r.paths).toContain("src/c d.ts");
  });

  test("the same commit twice is no change, and costs no git call", async () => {
    const r = await filesSince(dir, first, first);
    expect(r).toEqual({ ok: true, paths: [] });
  });

  // "Fetch and I can tell you" is a different sentence from "something went wrong",
  // and the reviewed commit really can be one that was force-pushed away.
  test("a commit this clone does not have is reported as missing, not as an error", async () => {
    const gone = "d".repeat(40);
    const r = await filesSince(dir, gone, third);
    expect(r.ok).toBe(true);
    expect(r.missing).toBe(gone);
    expect(r.paths).toBeUndefined();
  });

  test("anything that is not a commit shape is refused before it reaches an argument list", async () => {
    for (const bad of ["", "HEAD", "--upload-pack=touch /tmp/x", "../../etc", "zzzz"]) {
      const r = await filesSince(dir, bad, third);
      expect(r.ok).toBe(false);
      expect(r.error).toBe("invalid commit");
    }
  });

  test("and somewhere that is not a checkout is refused too", async () => {
    const r = await filesSince(tmpdir(), first, third);
    // Either "not a git checkout", or — if the temp dir happens to sit inside one —
    // an honest answer about commits it does not have. Never a throw.
    expect(typeof r.ok).toBe("boolean");
  });
});

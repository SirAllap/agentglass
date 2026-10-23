/*
 * Expanding a diff reads the file at the pull request's commit. The checkout
 * usually has that commit, and a blob read from it costs no request; anything
 * it cannot answer (no such commit, a binary, a path that climbs out of the
 * tree) must come back null so the caller asks GitHub instead of failing.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localText } from "../src/prs.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-blob-"));
let sha = "";

beforeAll(() => {
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  git("init", "-q");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.ts"), "one\ntwo\nthree\n");
  writeFileSync(join(dir, "bin.dat"), Buffer.from([1, 2, 0, 3]));
  git("add", ".");
  git("commit", "-q", "-m", "init");
  sha = git("rev-parse", "HEAD").stdout.toString().trim();
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

test("a file at a commit the checkout has comes back as text", async () => {
  expect(await localText(dir, sha, "src/a.ts")).toBe("one\ntwo\nthree\n");
});

test("what the checkout cannot answer is null, so the caller falls back to GitHub", async () => {
  expect(await localText(dir, "0".repeat(40), "src/a.ts")).toBeNull(); // commit not fetched
  expect(await localText(dir, sha, "src/missing.ts")).toBeNull();
  expect(await localText(dir, sha, "bin.dat")).toBeNull(); // binary
  expect(await localText(dir, sha, "../etc/passwd")).toBeNull();
  expect(await localText(dir, "HEAD", "src/a.ts")).toBeNull(); // only a full sha is a commit GitHub named
  expect(await localText("/definitely/not/a/repo", sha, "src/a.ts")).toBeNull();
});

test("a ref that is not a sha never reaches git as an option", async () => {
  expect(await localText(dir, "--output=/tmp/x", "src/a.ts")).toBeNull();
});

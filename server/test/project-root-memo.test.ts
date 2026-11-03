/*
 * `projectRootOf` runs inside a polling route: the settings tray resolves a
 * card's root on every read, and the resolver spawns `git rev-parse`
 * synchronously. A card rooted at a worktree or a subdirectory reaches the
 * spawn every time, so the second read of one directory must not spawn again.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectRootOf } from "../src/git.ts";

test("a second read of the same directory does not spawn git again", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-rootmemo-")));
  Bun.spawnSync(["git", "init", "-q", dir], { stdout: "ignore", stderr: "ignore" });
  const real = Bun.spawnSync;
  let revParse = 0;
  Bun.spawnSync = ((...args: Parameters<typeof real>) => {
    const cmd = args[0];
    const argv: readonly string[] = Array.isArray(cmd) ? cmd : "cmd" in (cmd as object) ? (cmd as { cmd: string[] }).cmd : [];
    if (argv.includes("--git-common-dir")) revParse++;
    return real(...args);
  }) as typeof real;
  const deep = join(dir, "apps", "orbit");
  mkdirSync(deep, { recursive: true });
  try {
    expect(projectRootOf(deep)).toBe(dir);
    expect(projectRootOf(deep)).toBe(dir);
    expect(revParse).toBe(1);
  } finally {
    Bun.spawnSync = real;
    rmSync(dir, { recursive: true, force: true });
  }
});

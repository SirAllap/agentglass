/*
 * The check that reads the commit instead of your desk.
 *
 * On 2026-08-06 commit 5d2ac02 imported `PanesResponse` from a shared/types.ts
 * that, at that commit, did not export it — `git add -A` in this shared
 * worktree had swept up half of another session's work and left the other half
 * behind. It stayed invisible for a day: every session had the good types.ts
 * sitting uncommitted on disk, so `bun run typecheck` was green for everybody
 * and only a clean checkout disagreed. work-2026-08-05 is the trunk every
 * session rebuilds from, so what was broken was the thing everyone pulls.
 *
 * What is pinned here is not "tsc finds type errors" — tsc does that already
 * and did it that day, correctly, on the wrong files. It is that the working
 * tree cannot answer for the commit, in EITHER direction:
 *
 *   1. a tree carrying the fix cannot make a broken commit look green;
 *   2. a broken tree cannot make a good commit look red;
 *   3. if the compiler does reach a file outside the extraction, the run is
 *      reported as untrustworthy rather than as a pass — the borrowed
 *      node_modules symlinks are the only route back out, and a leak wearing a
 *      green tick is the original bug again.
 *
 * Driven against the real scripts/headcheck.ts in throwaway git repositories,
 * because every one of those properties is about what git was asked and what
 * was on disk. Asserting on the source text would pass against a version that
 * quietly reads the working tree.
 *
 * TMPDIR is pointed at a directory owned by each test so the sandbox's removal
 * can be asserted without racing the other sessions running this on the same
 * machine.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const HEADCHECK = join(REPO, "scripts", "headcheck.ts");

const trash: string[] = [];
afterEach(() => { for (const d of trash.splice(0)) rmSync(d, { recursive: true, force: true }); });

const git = (dir: string, ...a: string[]) => {
  const r = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

function write(dir: string, rel: string, body: string) {
  mkdirSync(join(dir, dirname(rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

/**
 * A repository shaped like this one at its narrowest: a `shared/` that declares
 * types and a `server/` that imports them across the directory boundary. That
 * boundary is where the real breakage lived — the use and the declaration were
 * in different files, and the commit took one of them.
 *
 * `types: []` so tsc needs no packages of its own; the borrowed node_modules
 * are here for the compiler binary, which is the whole point of borrowing them
 * rather than installing.
 */
function fixture(): { repo: string; tmp: string } {
  const base = mkdtempSync(join(tmpdir(), "agx-headcheck-test-"));
  trash.push(base);
  const repo = join(base, "repo");
  const tmp = join(base, "tmp");
  mkdirSync(repo, { recursive: true });
  mkdirSync(tmp, { recursive: true });

  write(repo, ".gitignore", "node_modules\nnode_modules/\nleak.ts\n");
  write(repo, "shared/types.ts", "export type Ping = { at: number };\n");
  write(repo, "server/tsconfig.json", JSON.stringify({
    compilerOptions: {
      target: "ESNext", module: "ESNext", moduleResolution: "bundler",
      allowImportingTsExtensions: true, noEmit: true, strict: true,
      skipLibCheck: true, types: [],
    },
  }));
  write(repo, "server/src/index.ts",
    'import type { Ping } from "../../shared/types.ts";\nexport const now = (): Ping => ({ at: 0 });\n');

  // Borrowed exactly as headcheck borrows them, and for the same reason: the
  // fixture must not spend a `bun install` to own a compiler.
  symlinkSync(join(REPO, "node_modules"), join(repo, "node_modules"));
  symlinkSync(join(REPO, "server", "node_modules"), join(repo, "server", "node_modules"));

  git(repo, "init", "--quiet", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "add", ".gitignore", "shared", "server");
  git(repo, "commit", "--quiet", "-m", "green");
  return { repo, tmp };
}

/** Runs the real script, and proves on every single call that it took its
 *  sandbox away with it — a checker that litters /tmp with 17MB trees per run
 *  is a checker people disable. */
function headcheck(repo: string, tmp: string, ...args: string[]) {
  const r = spawnSync("bun", [HEADCHECK, "--repo", repo, ...args], {
    encoding: "utf8", cwd: repo, env: { ...process.env, TMPDIR: tmp, NO_COLOR: "1" },
  });
  // Only its own sandboxes: bun drops a `node-compile-cache` into whatever
  // TMPDIR it is handed, and that is not litter this script made.
  expect(readdirSync(tmp).filter((e) => e.startsWith("agx-headcheck-"))).toEqual([]);
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("headcheck — the commit answers for itself", () => {
  test("a tree carrying the fix cannot make a broken commit look green", () => {
    const { repo, tmp } = fixture();

    // 5d2ac02 in miniature: the USE is committed, the DECLARATION is not.
    write(repo, "server/src/index.ts",
      'import type { Ping, Pong } from "../../shared/types.ts";\n' +
      "export const now = (): Ping => ({ at: 0 });\nexport const back = (p: Pong) => p;\n");
    write(repo, "shared/types.ts",
      "export type Ping = { at: number };\nexport type Pong = { ok: boolean };\n");
    git(repo, "add", "server/src/index.ts"); // …and NOT shared/types.ts. That was the bug.
    git(repo, "commit", "--quiet", "-m", "half of it");

    // The working tree still has the declaration on disk, so the repo's own
    // typecheck is green — which is precisely what happened all day.
    const onDisk = spawnSync("bun", ["--bun", "x", "--no-install", "tsc", "--noEmit"], {
      cwd: join(repo, "server"), encoding: "utf8",
    });
    expect(onDisk.status).toBe(0);

    const { code, out } = headcheck(repo, tmp);
    expect(code).toBe(1);
    expect(out).toContain("server/src/index.ts");
    expect(out).toContain("Pong");
    expect(out).toContain("does NOT compile on its own");
  }, 30000);

  test("a broken tree cannot make a good commit look red", () => {
    const { repo, tmp } = fixture();
    const head = git(repo, "rev-parse", "--short", "HEAD").trim();

    // Uncommitted wreckage of the kind a session has open all the time.
    write(repo, "shared/types.ts", "export type Ping = { at: number }\nthis is not typescript(((\n");

    const { code, out } = headcheck(repo, tmp);
    expect(code).toBe(0);
    expect(out).toContain(`${head} compiles on its own.`);
  }, 30000);

  test("reaching outside the extraction is reported as untrustworthy, not as a pass", () => {
    const { repo, tmp } = fixture();

    // The leak this guard exists for, made deliberate: a committed tsconfig
    // that names an absolute path back into the working tree. The file it
    // names is untracked, so it is only reachable from the checkout — if the
    // run comes back green, the sandbox was never a sandbox.
    write(repo, "leak.ts", "export const fromYourDesk = 1;\n");
    write(repo, "server/tsconfig.json", JSON.stringify({
      compilerOptions: {
        target: "ESNext", module: "ESNext", moduleResolution: "bundler",
        allowImportingTsExtensions: true, noEmit: true, strict: true,
        skipLibCheck: true, types: [],
      },
      files: ["src/index.ts", join(repo, "leak.ts")],
    }));
    git(repo, "add", "server/tsconfig.json");
    git(repo, "commit", "--quiet", "-m", "a config that reaches out");

    const { code, out } = headcheck(repo, tmp);
    expect(code).toBe(2);
    expect(code).not.toBe(0);
    expect(out).toContain("outside the extraction");
    expect(out).toContain("leak.ts");
  }, 30000);

  test("a commit with nothing to check fails rather than passing quietly", () => {
    const { repo, tmp } = fixture();
    git(repo, "rm", "--quiet", "-r", "server");
    git(repo, "commit", "--quiet", "-m", "no projects left");

    const { code, out } = headcheck(repo, tmp);
    expect(code).toBe(2);
    expect(out).toContain("nothing was checked");
  }, 30000);
});

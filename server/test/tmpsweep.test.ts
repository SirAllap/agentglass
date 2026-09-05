/*
 * The suite takes its scratch directories with it when it goes.
 *
 * 383 `mkdtempSync(join(tmpdir(), "agx-…"))` calls across 182 files, and almost
 * none of them remove anything. Measured on the machine this was written for:
 * 14,096 stale directories in /tmp, 8.5 GB — and /tmp there is a tmpfs, so all
 * of it was RAM that had been pushed into swap. The desktop raised an
 * out-of-memory warning with 1.9 GiB of swap left.
 *
 * The cleanup is a preload (see tmpsweep.ts), which means it cannot be checked
 * from inside a test: it runs after the last one. So this runs a fixture in a
 * child `bun test` and looks at what the child left behind — the only place the
 * question can actually be answered.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const report = join(mkdtempSync(join(tmpdir(), "agx-sweepcheck-")), "paths.txt");

const child = Bun.spawnSync(
  ["bun", "test", "--preload", "./test/tmpsweep.ts", "./test/fixtures/tmpsweep-fixture.ts"],
  { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, TMPSWEEP_REPORT: report } }
);

describe("what a run leaves in /tmp", () => {
  test("the fixture ran at all", () => {
    expect(child.exitCode).toBe(0);
    expect(existsSync(report)).toBe(true);
  });

  test("nothing it created is still there", () => {
    const [scratch, fixed, socket] = readFileSync(report, "utf8").trim().split("\n");
    // The mkdtemp scratch space…
    expect(existsSync(scratch!)).toBe(false);
    // …a fixed-name directory `server/src` would have made for itself…
    expect(existsSync(fixed!)).toBe(false);
    // …and a file stamped with the child's pid, which is how the tmux suites
    // name the sockets tmux (not node) creates for them.
    expect(existsSync(socket!)).toBe(false);
  });

  test("and it did not touch anything of this process's", () => {
    // The rule that makes the pid sweep safe: several agents run this suite at
    // once on this machine, so a sweep that went by name pattern would delete
    // another run's directories out from under it, mid-test.
    expect(existsSync(report)).toBe(true);
  });
});

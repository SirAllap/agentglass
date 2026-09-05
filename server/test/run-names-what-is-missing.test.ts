/*
 * WHEN A RUN DIES, THE ROW HAS TO NAME THE RIGHT THING.
 *
 * `Bun.spawn` reports a missing working directory with exactly the sentence it
 * reports a missing program:
 *
 *     ENOENT: no such file or directory, posix_spawn '/home/…/bun'
 *
 * Measured both ways in one process — a good binary with a cwd that does not
 * exist, and a binary that does not exist — and the two messages are
 * indistinguishable. Four rows in this register have blamed `bun` for a
 * checkout that had been removed from under the run, and each one sent
 * somebody to check a binary that was on the machine the whole time.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whyItDied } from "../src/understudy-loop.ts";

describe("the two ENOENTs", () => {
  test("a good program with a gone directory says the same as a missing program", () => {
    const bun = process.execPath;
    const gone = join(tmpdir(), "understudy-not-here-at-all");
    rmSync(gone, { recursive: true, force: true });
    let badCwd = "";
    try { Bun.spawnSync({ cmd: [bun, "--version"], cwd: gone }); } catch (e) { badCwd = String((e as Error).message); }
    let badProgram = "";
    const dir = mkdtempSync(join(tmpdir(), "understudy-cwd-"));
    try { Bun.spawnSync({ cmd: [`${bun}-does-not-exist`, "--version"], cwd: dir }); } catch (e) { badProgram = String((e as Error).message); }
    rmSync(dir, { recursive: true, force: true });

    expect(badCwd).toContain("ENOENT");
    expect(badProgram).toContain("ENOENT");
    /* Both name the program. Only one of them is about the program. This is
       the whole reason the loop has to ask the directory itself. */
    expect(badCwd).toContain("posix_spawn");
    expect(badProgram).toContain("posix_spawn");
    expect(badCwd.replace(bun, "X")).toBe(badProgram.replace(`${bun}-does-not-exist`, "X"));
  });

  test("so the loop asks the checkout, and says which of the two it was", () => {
    const spawnSaid = "ENOENT: no such file or directory, posix_spawn '/home/x/.bun/bin/bun'";
    /* The checkout was taken out from under it: the program is a red herring. */
    const gone = whyItDied(spawnSaid, "/code/app-feat-x", false);
    expect(gone).toContain("/code/app-feat-x");
    expect(gone).toContain("checkout is gone");
    /* The checkout is there, so the program really is the missing thing and
       the row must not invent a directory problem. */
    expect(whyItDied(spawnSaid, "/code/app-feat-x", true)).toBe(spawnSaid);
    /* And anything that is not an ENOENT is passed through untouched. */
    expect(whyItDied("the agent never wrote a word", "/code/app-feat-x", false))
      .toBe("the agent never wrote a word");
  });
});

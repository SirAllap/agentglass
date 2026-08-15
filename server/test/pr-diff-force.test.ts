import { afterAll, describe, expect, it } from "bun:test";

/*
 * "The head moved" has to beat "I have one of those".
 *
 * The diff is fetched once per pull request the panel has open and then held —
 * in the renderer, and behind it in this module's five-minute cache with a
 * stale-while-revalidate on top. That is right for the case it was written for
 * (re-opening a pull request nobody pushed to) and wrong for the one that
 * happens all afternoon: somebody pushes, the detail is re-read because Refresh
 * and the list poll force it, and the file LIST gains a file the diff TEXT has
 * never heard of. On screen that file had a row, a +42 −0, and "No textual diff
 * — binary, renamed, or too large to show", which is three wrong answers to a
 * question nobody asked.
 *
 * So `prDiff` takes a force, and this pins what force means: not "prefer
 * fresh", not "revalidate in the background" — ask GitHub now, and answer with
 * what it said.
 *
 * The fake `gh` is a script on PATH rather than a mock, and rewriting it
 * between calls is the closest thing to "somebody pushed" a test can have. It
 * runs in a CHILD bun, because `Bun.which` reads the PATH the process started
 * with: measured here, setting `process.env.PATH` first and calling
 * `Bun.which("gh")` after still answers /usr/bin/gh, and the real gh then goes
 * to the network. A child is also the only way to be sure the module under test
 * evaluates fresh, caches and all.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "agx-diff-force-"));
const BIN = join(TMP, "bin");
const REPO = join(TMP, "repo");
const CACHE_DIR = join(TMP, "cache");
const DRIVER = join(TMP, "driver.ts");
const SAYS = join(TMP, "gh-says");

afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* fine */ } });

/*
 * The script reads what to print from a file, so the parent can change GitHub's
 * answer mid-run without writing an executable twice.
 */
function fakeGh(): void {
  writeFileSync(join(BIN, "gh"), [
    "#!/usr/bin/env bash",
    // Only `pr diff` answers. Anything else exits non-zero, so a test that
    // starts depending on some other gh call fails loudly rather than reading
    // this string.
    `if [ "$1" = "pr" ] && [ "$2" = "diff" ]; then cat ${JSON.stringify(SAYS)}; exit 0; fi`,
    "exit 1",
    "",
  ].join("\n"));
  chmodSync(join(BIN, "gh"), 0o755);
}

/*
 * Three reads with a push in the middle, in one process because the cache under
 * test only exists inside one:
 *   1. cold        — must be what gh said
 *   2. after push  — must still be the held text, since nobody claimed it moved
 *   3. forced      — must be the new text
 *   4. after force — must still be the new text, or the next tab switch puts
 *                    the stale one back on screen
 */
const DRIVER_SRC = `
const [repo, says] = process.argv.slice(2);
const P = await import(${JSON.stringify(join(import.meta.dir, "../src/prs.ts"))});
const out = {};
out.cold = (await P.prDiff(repo, 7)).text;
await Bun.write(says, "SECOND");
out.held = (await P.prDiff(repo, 7)).text;
out.forced = (await P.prDiff(repo, 7, true)).text;
out.kept = (await P.prDiff(repo, 7)).text;
console.log(JSON.stringify(out));
`;

const read = await (async () => {
  await Bun.$`mkdir -p ${BIN} ${REPO} ${CACHE_DIR}`.quiet();
  writeFileSync(SAYS, "FIRST");
  writeFileSync(DRIVER, DRIVER_SRC);
  fakeGh();
  await Bun.$`git init -q ${REPO}`.quiet();
  await Bun.$`git -C ${REPO} remote add origin https://github.com/acme/demo.git`.quiet();

  const proc = Bun.spawn(["bun", "run", DRIVER, REPO, SAYS], {
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, AGENTGLASS_CACHE_DIR: CACHE_DIR },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  const line = stdout.trim().split("\n").pop() || "";
  try { return JSON.parse(line) as Record<string, string | undefined>; } catch { throw new Error(`driver said: ${stdout}${stderr}`); }
})();

describe("a diff after somebody pushes", () => {
  it("comes from GitHub the first time", () => {
    expect(read.cold).toBe("FIRST");
  });

  it("is served from the cache when nothing says it moved", () => {
    expect(read.held).toBe("FIRST");
  });

  it("is re-read when the caller forces it", () => {
    expect(read.forced).toBe("SECOND");
  });

  it("leaves the new text behind for the next reader", () => {
    expect(read.kept).toBe("SECOND");
  });
});

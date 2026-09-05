/*
 * THE FENCE FAILED OPEN, AND IT WAS FOUND ON THE RUNNING SERVER.
 *
 * `openProjectName` fell back to the last segment of the working directory
 * when the process was not inside a git checkout. The installed server runs
 * with cwd `/home/you` — the home directory — so the open project became
 * the user's own name, and `isOpenProjectPath` is a SEGMENT test: it then
 * matched `/home/you/anything`.
 *
 * The fence listed thirty checkouts of his employer's work. Measured, not
 * imagined: `/understudy/work/ask` returned them.
 *
 * A fence that cannot tell where it is has one safe answer and it is not a
 * guess. Empty means no checkout matches, the loop declines every task, and
 * the Work tab says so in red — loud, and harmless.
 */
import { describe, expect, test } from "bun:test";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Its own store: this file calls into the real module, and the settings file
// is not moved by AGENTGLASS_DB. See understudy-fence-name.test.ts.
(await import("../src/understudy.ts")).__setUnderstudyStorePath(
  join(mkdtempSync(join(tmpdir(), "agx-fence2-")), "understudy.json"));

const src = await Bun.file(new URL("../src/understudy.ts", import.meta.url)).text();
const fn = (() => {
  const from = src.indexOf("export function openProjectName(");
  return src.slice(from, src.indexOf("\n}", from));
})();

describe("a fence that does not know where it is stays shut", () => {
  test("no git root means no open project", () => {
    const code = fn.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
    expect(code).toContain("if (!openProjectRoot?.root) return \"\";");
    // And specifically NOT the old fallback, which is what opened it.
    expect(code).not.toContain("?? cwd).split");
  });

  test("a name that would match the home directory is refused", async () => {
    /*
     * The second route to the same place: a git checkout at or above $HOME —
     * dotfiles, which plenty of people keep — would name the project after a
     * segment of the home path and put the whole disk inside the fence again.
     */
    /*
     * The predicate moved into `wouldMatchEverything`, shared with the
     * explicit setter — which is the point. It used to live only here, so the
     * one path with a check was the one that could not be reached while a name
     * was set, and the setter that wins had none. It is also stronger now: it
     * bans every segment ABOVE a known checkout, not just segments of $HOME,
     * because `code` is neither and matches every project on this machine.
     */
    const code = fn.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
    expect(code).toContain("wouldMatchEverything(name)");

    const U = await import("../src/understudy.ts");
    const known = ["/home/someone/code/orbit", "/home/someone/code/atlas"];
    expect(U.openProjectNameAllowed("home", known)).toBe(false);
    expect(U.openProjectNameAllowed("someone", known)).toBe(false);
    expect(U.openProjectNameAllowed("code", known)).toBe(false);
    expect(U.openProjectNameAllowed("orbit", known)).toBe(true);
  });

  test("the matcher is still a segment test, which is why the name matters", () => {
    // `thing` must match `thing`, `thing-feature` and `thing/server`, and must
    // not match `thingamabob`. That is correct — and it is exactly what makes
    // a wrong NAME catastrophic rather than merely useless.
    const matcher = src.slice(src.indexOf("export function isOpenProjectPath("));
    expect(matcher).toContain("(^|[/-])");
  });

  test("an explicit setting still wins, so it can be pointed anywhere on purpose", () => {
    expect(fn).toContain("const set = load().openProject?.trim();");
    expect(fn).toContain("if (set) return set;");
  });
});

describe("the app's scope is not the fence", () => {
  /*
   * The other half of the same fault. Naming the project by inference is what
   * opened the fence; the fix for the empty case is not more inference, it is
   * to read what somebody actually configured.
   *
   * `workspaceRoot()` is AGENTGLASS_ROOT or `root` in the config file — set on
   * purpose by whoever launched the server, and printed at startup as
   * "Project →". The working directory has never been that.
   */
  test("the name is NOT taken from the root the app was launched with", () => {
    /*
     * THE OBVIOUS FIX, AND IT WAS WORSE THAN THE BUG. `workspaceRoot()` is
     * AGENTGLASS_ROOT or `root` in the config — set on purpose, printed at
     * startup as "Project →" — so it reads as the one trustworthy answer here.
     *
     * Measured on this machine: it returns the EMPLOYER'S repository, because
     * that is what the application is pointed at, so the fence would have been
     * named after it. The previous fault opened the fence by accident; this
     * one would have aimed it.
     *
     * "What the app is watching" and "where something may act for me" are
     * different questions. The second is answered by an explicit setting, or
     * not at all.
     */
    // Code, not prose: the comment above the fix names what it stopped using.
    const code = fn.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
    expect(code).not.toContain("workspaceRoot");
    expect(code).toContain("const cwd = process.cwd();");
  });

  test("and the allow-list counts that root too, still filtered", async () => {
    /*
     * Checkouts are discovered from telemetry — files that have been touched —
     * so a day spent in another repository finds none of this one, and the
     * fence was correct and EMPTY: every task declined while the tab read "no
     * checkout matches". Adding the scoped root fixes the common case without
     * widening anything, because it passes the same filter as the rest.
     */
    const src2 = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const from = src2.indexOf("async function openProjectRepos(");
    const block = src2.slice(from, src2.indexOf("\n}", from));
    // Same reasoning as above: the app's own scope is not this fence's source.
    const code = block.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
    expect(code).not.toContain("workspaceRoot()");
    expect(code).toContain("roots.filter((r) => isOpenProjectPath(r) && fsExists(r))");
  });
});

/*
 * A fence name that matches everything is not a fence.
 *
 * `isOpenProjectPath` is a SEGMENT test — `orbit` matches `orbit`,
 * `orbit-feature` and `orbit/server` — which is what makes it useful and what
 * makes a bad name catastrophic. Any segment of a directory that CONTAINS
 * projects matches every project inside it.
 *
 * The derived name already refused those. The EXPLICIT setting did not, and
 * the explicit setting is the one that wins: `openProjectName` returns it
 * before it derives anything. So the only path with a check was the one that
 * could not be reached while the other was set.
 *
 * Measured before the fix, on this machine, each of these made
 * `isOpenProjectPath("/home/…/code/<somebody-elses-project>")` true.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const U = await import("../src/understudy.ts");

/*
 * ITS OWN STORE, and leaving this out broke three unrelated tests.
 *
 * `setOpenProject` writes to the understudy's settings file, which lives under
 * XDG_CONFIG_HOME — `AGENTGLASS_DB` does not move it. Without this line these
 * tests set the REAL open project, and the ingest tests that ran afterwards
 * partitioned their material against whatever name was left behind. They
 * passed alone and failed in the suite, which is the shape that costs an hour.
 */
U.__setUnderstudyStorePath(join(mkdtempSync(join(tmpdir(), "agx-fence-")), "understudy.json"));

// A machine's worth of checkouts, all under one folder — which is the shape
// that makes the folder's name dangerous and the project names fine.
const KNOWN = [
  "/home/someone/code/orbit",
  "/home/someone/code/orbit-feature",
  "/home/someone/code/atlas",
];

describe("names that would match every repository", () => {
  test("a folder that contains projects is refused", () => {
    // `code` is not a segment of $HOME — the first version of this check
    // tested $HOME alone and let it through. It is the folder they all sit in.
    expect(U.openProjectNameAllowed("code", KNOWN)).toBe(false);
    expect(U.openProjectNameAllowed("someone", KNOWN)).toBe(false);
    expect(U.openProjectNameAllowed("home", KNOWN)).toBe(false);
  });

  test("a project's own name is not", () => {
    expect(U.openProjectNameAllowed("orbit", KNOWN)).toBe(true);
    expect(U.openProjectNameAllowed("atlas", KNOWN)).toBe(true);
  });

  test("a name nobody has a checkout for is allowed", () => {
    // Naming a project before cloning it is normal, and refusing it would make
    // the fence harder to point than to leave wrong.
    expect(U.openProjectNameAllowed("nothing-here-yet", KNOWN)).toBe(true);
  });

  test("empty is allowed, because empty means nothing is open", () => {
    expect(U.openProjectNameAllowed("", KNOWN)).toBe(true);
  });
});

describe("the refusal is a refusal, not a shrug", () => {
  test("setting a banned name leaves the previous one in force", async () => {
    /*
     * It returns the name IN FORCE afterwards, which is the old one when the
     * new one was refused. A caller that assumed its value took hold would
     * report a fence it does not have — and this one is reported on screen.
     */
    U.setOpenProject("orbit", KNOWN);
    expect(U.setOpenProject("code", KNOWN)).toBe("orbit");
    expect(U.openProjectName()).toBe("orbit");
  });

  test("and the route says why rather than answering ok", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const from = src.indexOf('pathname === "/understudy/open-project"');
    const next = src.indexOf("if (pathname ===", from + 20);
    const route = src.slice(from, next === -1 ? from + 1500 : next);
    expect(route).toContain("openProjectNameAllowed(asked, known)");
    expect(route).toContain("would match every repository on this machine");
    // Answered from this machine's checkouts, not from an assumption about
    // where people keep their code.
    expect(route).toContain("knownProjects()");
  });
});

test("the folder projects live in is refused on a database that knows nothing", () => {
  /*
   * Every other test in this guard needs a list of checkouts to reason from,
   * and that list comes from the transcript table — empty on a fresh install,
   * after a reset, or before the first scan. On such a machine
   * `setOpenProject("code")` was accepted, and `code` is a segment of every
   * repository path on this one: the fence would have admitted a checkout of
   * somebody's employer two directories away.
   *
   * Refused without needing to be discovered. A real project called `src` is a
   * price worth paying against a fence that opens by accident.
   */
  for (const name of ["code", "src", "repos", "projects", "work", "dev", "git", "workspace"]) {
    expect(U.openProjectNameAllowed(name, []), `${name} was allowed with no checkouts known`).toBe(false);
  }
  // And a real project name still is one.
  expect(U.openProjectNameAllowed("agentglass", [])).toBe(true);
});

/*
 * A project reached through a symlink is still that project.
 *
 * ── the bug ──────────────────────────────────────────────────────────────
 * `resolveScope` asks git which repository a path belongs to, so that pointing
 * the cockpit at `monorepo/packages/api` scopes it to `monorepo`. git answers
 * with the REAL path. But the answer is not used as a path — it is used as a
 * PREFIX, matched against `project_path` and `cwd_path` on rows written by
 * hooks, which spell the directory however the agent was launched with it.
 *
 * So when the project is reached through a link — `~/code` on another volume, a
 * home directory behind an automounter, `os.tmpdir()` on a machine that is not
 * ours — the scope came back in one spelling and every row was written in the
 * other. Two spellings of one directory share no prefix, so the filter excluded
 * everything it existed to select and the cockpit came up empty with nothing to
 * say about why.
 *
 * It was found the expensive way: a suite that had passed for months failed on
 * an unchanged commit, on ten of its twelve tests, because the machine running
 * it moved its temp directory behind a link. Nothing in the repository had
 * changed, which is the signature of a bug that reads the world instead of the
 * tree.
 *
 * ── why the fixture is built rather than mocked ──────────────────────────
 * The whole defect lives in the disagreement between what git prints and what
 * `resolve()` produces, so a test that stubs either one asserts the bug away.
 * These are real directories, a real symlink and a real `git init`.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-link-")));

/** The repository, and a link that points at it. */
const REAL = join(dir, "real-project");
const PKG = join(REAL, "packages", "api");
const LINK = join(dir, "linked-project");

let config: typeof import("../src/config.ts");

beforeAll(async () => {
  mkdirSync(PKG, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", REAL], { stdout: "ignore", stderr: "ignore" });
  symlinkSync(REAL, LINK);
  process.env.XDG_CONFIG_HOME = dir;
  config = await import("../src/config.ts");
});

describe("a scope asked for through a symlink", () => {
  test("comes back in the spelling it was asked in", () => {
    /* The load-bearing assertion. Before the fix this returned REAL — correct
       as a path, useless as a prefix, because nothing on the machine that
       launched an agent through LINK has ever written REAL anywhere. */
    process.env.AGENTGLASS_ROOT = LINK;
    expect(config.workspaceRoot()).toBe(LINK);
  });

  test("and a package inside it still resolves to the repository, not the package", () => {
    // The feature this must not break: git's answer to "how much of this path
    // is the repository" is still the one being used. Only its spelling is not.
    process.env.AGENTGLASS_ROOT = join(LINK, "packages", "api");
    expect(config.workspaceRoot()).toBe(LINK);
  });

  test("a path with no link in it is unaffected", () => {
    process.env.AGENTGLASS_ROOT = PKG;
    expect(config.workspaceRoot()).toBe(REAL);
  });

  test("work recorded under the link is inside the scope", () => {
    /* What the bug actually cost: this was false, so every scoped read
       returned nothing and the screen said the project was empty. */
    process.env.AGENTGLASS_ROOT = LINK;
    const scope = config.workspaceRoot();
    expect(config.sessionInScope({ project_path: join(LINK, "packages", "api") }, scope)).toBe(true);
  });

  test("and a directory that is genuinely elsewhere is still out", () => {
    // The fix widens a spelling, never the boundary.
    process.env.AGENTGLASS_ROOT = LINK;
    const scope = config.workspaceRoot();
    expect(config.sessionInScope({ project_path: join(dir, "somewhere-else") }, scope)).toBe(false);
  });
});

/* A push with no destination: where it lands is read from the branch and its config. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pushLandsOnProtected } from "../src/pushLanding.ts";

let dir = "";
let repo = "";
const g = (...a: string[]) => {
  const r = spawnSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.x" } });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "push-landing-"));
  repo = join(dir, "work");
  spawnSync("git", ["init", "--bare", "-b", "main", join(dir, "remote.git")]);
  spawnSync("git", ["init", "-b", "main", repo]);
  g("remote", "add", "origin", join(dir, "remote.git"));
  g("commit", "--allow-empty", "-m", "one");
  g("push", "origin", "main");
  g("branch", "feat-up-main"); g("config", "branch.feat-up-main.remote", "origin"); g("config", "branch.feat-up-main.merge", "refs/heads/main");
  g("branch", "feat"); g("config", "branch.feat.remote", "origin"); g("config", "branch.feat.merge", "refs/heads/feat");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("pushLandsOnProtected", () => {
  test("on main, a bare push is refused", () => {
    g("checkout", "main");
    for (const c of ["git push", "git push origin", "git push -u origin HEAD", `git -C ${repo} push`])
      expect(pushLandsOnProtected(c, c.startsWith("git -C") ? "/" : repo)).toContain("lands on main");
  });
  test("on feat tracking origin/main, a bare push is refused", () => {
    g("checkout", "feat-up-main");
    g("config", "push.default", "upstream");
    expect(pushLandsOnProtected("git push", repo)).toContain("lands on main");
    g("config", "--unset", "push.default");
  });
  test("on feat tracking origin/feat, a bare push is allowed", () => {
    g("checkout", "feat");
    expect(pushLandsOnProtected("git push", repo)).toBeNull();
    expect(pushLandsOnProtected("git push -u origin HEAD", repo)).toBeNull();
  });
  test("a detached HEAD is refused: cannot tell", () => {
    g("checkout", "--detach");
    expect(pushLandsOnProtected("git push", repo)).toContain("cannot tell where this push lands");
  });
  test("a push naming its destination, or no push, is not this gate's", () => {
    g("checkout", "main");
    expect(pushLandsOnProtected("git push origin feat", repo)).toBeNull();
    expect(pushLandsOnProtected("git status", repo)).toBeNull();
  });
});

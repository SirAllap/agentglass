import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { repoNow } from "../src/gitwork.ts";

// The pill under a terminal pane reads one checkout through repoNow. It has to
// answer from git every time: the sweep it replaced was held 15 s, and a rename
// or a new file took that long to show.
let dir = "";
let wt = "";
const saved = { root: process.env.AGENTGLASS_ROOT, cfg: process.env.GIT_CONFIG_GLOBAL };
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: process.env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
};

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-repo-now-")));
  process.env.AGENTGLASS_ROOT = dir;
  const cfg = join(dir, ".gitconfig");
  writeFileSync(cfg, "[user]\n\temail = t@t\n\tname = T\n[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = cfg;
  const main = join(dir, "orbit");
  mkdirSync(main);
  git(main, "init", "-q");
  writeFileSync(join(main, "a.txt"), "x\n");
  git(main, "add", "a.txt");
  git(main, "commit", "-qm", "init");
  wt = join(dir, "orbit-wt");
  git(main, "worktree", "add", "-q", "-b", "fix-thing", wt);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (saved.root === undefined) delete process.env.AGENTGLASS_ROOT; else process.env.AGENTGLASS_ROOT = saved.root;
  if (saved.cfg === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.cfg;
});

describe("repoNow", () => {
  test("a new file, a rename and an edit show on the very next read", async () => {
    expect(await repoNow(wt)).toMatchObject({ root: wt, branch: "fix-thing", dirty: 0, worktreeOf: join(dir, "orbit") });
    writeFileSync(join(wt, "b.txt"), "new\n");
    expect((await repoNow(wt))?.dirty).toBe(1);
    git(wt, "branch", "-m", "fix-other");
    expect((await repoNow(wt))?.branch).toBe("fix-other");
    writeFileSync(join(wt, "a.txt"), "edited\n");
    expect((await repoNow(wt))?.dirty).toBe(2);
  });

  test("a folder that is not a checkout answers nothing", async () => {
    const plain = join(dir, "plain");
    mkdirSync(plain);
    expect(await repoNow(plain)).toBeNull();
    expect(await repoNow("")).toBeNull();
  });
});

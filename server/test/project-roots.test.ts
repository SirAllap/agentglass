/*
 * The folders a person's projects live in, and the picker that lists only them.
 *
 * On a fresh install the picker used to fill itself from wherever an agent had
 * ever run, which on a real machine is a dotfiles checkout, an editor's config
 * repo and whatever else a session was opened in once. None of those are
 * projects anybody chose. The picker now lists what is under the folders the
 * person added and nothing else; with none added it lists nothing, and the old
 * sweep is still there behind an explicit "look for projects" — never by
 * default.
 *
 * Settings go to a scratch XDG_CONFIG_HOME, and discovery is asked through the
 * real module against real repositories in a temp directory.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredRepoDirs, repoDirsUnstated, seedRepoDirs, setRepoDir, setWorkspaceRoots, workspaceRoots } from "../src/config.ts";
import { discoverRepos, invalidateRepos, knownProjectRoots } from "../src/gitwork.ts";

const saved0 = {
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  AGENTGLASS_ROOT: process.env.AGENTGLASS_ROOT,
  AGENTGLASS_REPO_DIRS: process.env.AGENTGLASS_REPO_DIRS,
  AGENTGLASS_REPOS: process.env.AGENTGLASS_REPOS,
};
afterAll(() => {
  for (const [k, v] of Object.entries(saved0)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

let dir = "", code = "", cfg = "";
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-roots-")));
  code = join(dir, "code");
  mkdirSync(code, { recursive: true });
  process.env.XDG_CONFIG_HOME = dir;
  cfg = join(dir, "agentglass", "config.json");
  for (const k of ["AGENTGLASS_ROOT", "AGENTGLASS_REPO_DIRS", "AGENTGLASS_REPOS"]) delete process.env[k];
  invalidateRepos();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const git = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", "-C", cwd, ...a], { stdout: "ignore", stderr: "ignore" });
function makeRepo(p: string): string {
  mkdirSync(p, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", "-b", "main", p]);
  git(p, "config", "user.email", "t@example.com");
  git(p, "config", "user.name", "t");
  writeFileSync(join(p, "README.md"), "# x\n");
  git(p, "add", "-A");
  git(p, "commit", "-qm", "first");
  return p;
}
const picker = async (scan = false) =>
  (await discoverRepos([], [], { ignoreScope: true, rootsOnly: !scan })).map((r) => r.root);

describe("adding and removing a folder", () => {
  test("an added folder is remembered, as an absolute path", async () => {
    const r = setRepoDir(code, true);
    expect(r.ok).toBe(true);
    expect(r.roots).toEqual([code]);
    expect(configuredRepoDirs()).toEqual([code]);
    expect(JSON.parse(readFileSync(cfg, "utf8")).repoDirs).toEqual([code]);
  });

  test("adding it twice is one entry, however it is spelled", () => {
    setRepoDir(code, true);
    expect(setRepoDir(code + "/", true).roots).toEqual([code]);
  });

  test("removing it forgets the folder and touches nothing on disk", () => {
    const repo = makeRepo(join(code, "orbit"));
    setRepoDir(code, true);
    expect(setRepoDir(code, false).roots).toEqual([]);
    // Kept as an empty list rather than dropped: no key at all is what a
    // config from before the picker had folders looks like, and the next start
    // would seed the list all over again. See seedRepoDirs.
    expect(JSON.parse(readFileSync(cfg, "utf8")).repoDirs).toEqual([]);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("# x\n");
  });

  test("a folder that is not there is refused, not remembered", () => {
    const r = setRepoDir(join(dir, "nowhere"), true);
    expect(r.ok).toBe(false);
    expect(configuredRepoDirs()).toEqual([]);
  });

  test("an entry written by hand as ~/… is removed by its absolute path", () => {
    mkdirSync(join(dir, "agentglass"), { recursive: true });
    writeFileSync(cfg, JSON.stringify({ repoDirs: [code, "/elsewhere/not-here"] }));
    expect(setRepoDir(code, false).roots).toEqual(["/elsewhere/not-here"]);
  });

  test("two servers on one config file do not drop each other's folders", async () => {
    // Two processes, each with its own cached copy of the file.
    const a = await import("../src/config.ts?a" + Math.random().toString(36).slice(2));
    const b = await import("../src/config.ts?b" + Math.random().toString(36).slice(2));
    const work = join(dir, "work");
    mkdirSync(work);
    expect(a.configuredRepoDirs()).toEqual([]); // A has read the file, and holds it
    b.setRepoDir(code, true);
    a.setRepoDir(work, true);
    expect(JSON.parse(readFileSync(cfg, "utf8")).repoDirs).toEqual([code, work]);
  });

  test("with the folders set in the environment, the answer says the file is not what is read", () => {
    process.env.AGENTGLASS_REPO_DIRS = code;
    const r = setRepoDir(code, true);
    expect(r.ok).toBe(true);
    expect(r.note).toContain("AGENTGLASS_REPO_DIRS");
  });
});

describe("what the picker lists", () => {
  test("nothing added is an empty list, however much the app has seen", async () => {
    const seen = makeRepo(join(dir, "dotfiles"));
    // A repo an agent ran in, and one a transcript named: both used to appear.
    expect(await discoverRepos([join(seen, "README.md")], [seen], { ignoreScope: true, rootsOnly: true })).toEqual([]);
  });

  test("every repo under an added folder is listed, and a repo beside it is not", async () => {
    makeRepo(join(code, "orbit"));
    makeRepo(join(code, "work", "lander"));
    const outside = makeRepo(join(dir, "config", "editor"));
    setRepoDir(code, true);
    const roots = (await discoverRepos([join(outside, "README.md")], [outside], { ignoreScope: true, rootsOnly: true })).map((r) => r.root);
    expect(roots.sort()).toEqual([join(code, "orbit"), join(code, "work", "lander")]);
  });

  test("a folder that is itself a repo is listed as that one project", async () => {
    const one = makeRepo(join(dir, "solo"));
    setRepoDir(one, true);
    expect(await picker()).toEqual([one]);
  });

  test("an open project outside every added folder still has its row", async () => {
    const open = makeRepo(join(dir, "elsewhere", "opened"));
    makeRepo(join(code, "orbit"));
    setRepoDir(code, true);
    setWorkspaceRoots([open]);
    expect(await picker()).toContain(open);
    setWorkspaceRoots([]);
  });

  test("opening a project outside the folders gives it a row on the very next read", async () => {
    const open = makeRepo(join(dir, "elsewhere", "opened"));
    makeRepo(join(code, "orbit"));
    setRepoDir(code, true);
    expect(await picker()).toEqual([join(code, "orbit")]);
    // Scoped from somewhere other than the picker, so no folder was added.
    setWorkspaceRoots([open]);
    expect(await picker()).toContain(open);
    setWorkspaceRoots([]);
  });

  test("looking for projects is still there when it is asked for", async () => {
    const known = makeRepo(join(dir, "known"));
    const found = (await discoverRepos([], [known], { ignoreScope: true })).map((r) => r.root);
    expect(found).toContain(known);
  });

  test("looking for projects with folders added still looks outside them", async () => {
    makeRepo(join(code, "orbit"));
    setRepoDir(code, true);
    const known = makeRepo(join(dir, "elsewhere", "known"));
    const found = (await discoverRepos([], [known], { ignoreScope: true })).map((r) => r.root);
    expect(found).toContain(known);
  });

  test("adding a folder shows up at once, not after the list's cache expires", async () => {
    makeRepo(join(code, "orbit"));
    expect(await picker()).toEqual([]);
    setRepoDir(code, true);
    expect(await picker()).toEqual([join(code, "orbit")]);
  });
});

/*
 * An upgrade loses nothing.
 *
 * Before the picker had folders, a config carried at most a `root` — one
 * project, several, or a folder like ~/code that "everything in it" was opened
 * from — and the picker listed every project the app had seen. A config with
 * no `repoDirs` key is that shape. Read with the new rules and nothing else, a
 * folder scope listed its projects with none of them open, the first click
 * narrowed it to one of them for good, and everybody else got the first-run
 * screen over the project they had open. So the first read seeds the folders
 * from what the old config and the old list knew, once.
 */
describe("an upgrade from a config without folders", () => {
  const write = (c: object) => {
    mkdirSync(join(dir, "agentglass"), { recursive: true });
    writeFileSync(cfg, JSON.stringify(c));
  };
  const onDisk = () => JSON.parse(readFileSync(cfg, "utf8"));

  test("a folder scope becomes a folder, and every project in it is listed again", async () => {
    const orbit = makeRepo(join(code, "orbit"));
    const lander = makeRepo(join(code, "lander"));
    write({ root: code });
    expect(repoDirsUnstated()).toBe(true);
    const r = seedRepoDirs(workspaceRoots());
    expect(r.ok).toBe(true);
    expect(onDisk()).toEqual({ root: code, repoDirs: [code] });
    expect((await picker()).sort()).toEqual([lander, orbit].sort());
  });

  test("one open project and the projects the app knew are all seeded, the open one first", () => {
    const orbit = makeRepo(join(code, "orbit"));
    const known = makeRepo(join(dir, "elsewhere", "handbook"));
    write({ root: orbit });
    seedRepoDirs([...workspaceRoots(), known]);
    expect(onDisk().repoDirs).toEqual([orbit, known]);
  });

  test("a project inside a seeded folder is not seeded again beside it", () => {
    const orbit = makeRepo(join(code, "orbit"));
    write({ root: [code] });
    seedRepoDirs([...workspaceRoots(), orbit]);
    expect(onDisk().repoDirs).toEqual([code]);
  });

  test("nothing to seed still says so, so a later start does not seed what the app learns since", () => {
    expect(repoDirsUnstated()).toBe(true); // no file at all: a fresh install
    seedRepoDirs([]);
    expect(onDisk().repoDirs).toEqual([]);
    expect(repoDirsUnstated()).toBe(false);
  });

  test("folders already stated are left exactly as they are", () => {
    const orbit = makeRepo(join(code, "orbit"));
    write({ root: orbit, repoDirs: [] });
    expect(repoDirsUnstated()).toBe(false);
    seedRepoDirs([orbit]);
    expect(onDisk().repoDirs).toEqual([]);
  });

  test("folders set in the environment are stated too", () => {
    process.env.AGENTGLASS_REPO_DIRS = code;
    expect(repoDirsUnstated()).toBe(false);
  });

  test("a seeded folder that is gone by then is skipped, not saved", () => {
    const orbit = makeRepo(join(code, "orbit"));
    seedRepoDirs([join(dir, "gone"), orbit]);
    expect(onDisk().repoDirs).toEqual([orbit]);
  });
});

describe("the projects the app knew", () => {
  test("each is its project's top, worktrees fold into their project, and removed ones stay removed", async () => {
    const orbit = makeRepo(join(code, "orbit"));
    const lander = makeRepo(join(code, "lander"));
    const handbook = makeRepo(join(code, "handbook"));
    const wt = join(code, "orbit-ORBIT-1042");
    git(orbit, "worktree", "add", "-q", "-b", "orbit-1042", wt);
    mkdirSync(join(lander, "src"));
    const found = await knownProjectRoots(
      [join(lander, "src", "main.ts")],
      [wt, handbook, join(dir, "gone")],
      [handbook],
    );
    expect(found.sort()).toEqual([lander, orbit].sort());
  });
});

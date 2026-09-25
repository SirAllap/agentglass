// A symlink inside the open project is not a door out of it.
//
// Every file route judges a path by where it resolves, not by how it is
// spelled: /files/read, /files/tree, /files/exist and the line counter refuse
// a link whose target is outside the project, and keep working for a link
// that stays inside it.
//
// The fixture is real directories and real links, because the defect lives in
// the gap between the spelling of a path and what the kernel opens; stubbing
// either side asserts the bug away.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT0 = process.env.AGENTGLASS_ROOT;
let box: string;     // the workspace
let repo: string;    // a checkout inside it
let outside: string; // somewhere the workspace does not reach

beforeAll(() => {
  box = realpathSync(mkdtempSync(join(tmpdir(), "agx-symesc-")));
  repo = join(box, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  outside = realpathSync(mkdtempSync(join(tmpdir(), "agx-symesc-out-")));
  mkdirSync(join(outside, "config"));
  writeFileSync(join(outside, "config", "token"), "fake-token-0000\n");
  // A link to a directory outside, one to a file outside, one to nothing
  // outside, a link to a directory that itself holds the escape, and a link
  // that stays home.
  symlinkSync(outside, join(repo, "escape"));
  symlinkSync(join(outside, "config", "token"), join(repo, "leak"));
  symlinkSync(join(outside, "not-yet"), join(repo, "dangle"));
  symlinkSync(join(repo, "src", "a.ts"), join(repo, "alias.ts"));
  symlinkSync(join(repo, "src"), join(repo, "src-link"));
  process.env.AGENTGLASS_ROOT = box;
});

afterAll(() => {
  if (ROOT0 === undefined) delete process.env.AGENTGLASS_ROOT; else process.env.AGENTGLASS_ROOT = ROOT0;
  rmSync(box, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** Imported lazily: config.ts caches the scope on first read. */
const files = async () => await import("../src/files.ts");

describe("a link out of the checkout is refused", () => {
  test("reading through a linked directory", async () => {
    const { fileText } = await files();
    const r = fileText(repo, "escape/config/token");
    expect(r.ok).toBe(false);
    expect(r.text).toBe("");
  });

  test("reading a linked file", async () => {
    const { fileText } = await files();
    const r = fileText(repo, "leak");
    expect(r.ok).toBe(false);
    expect(r.text).toBe("");
  });

  test("a dangling link is judged by where it points, not by its name", async () => {
    const { fileText } = await files();
    const r = fileText(repo, "dangle");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("outside");
  });

  test("listing through a link, as the path or as the root", async () => {
    const { fileTree } = await files();
    expect(fileTree(repo, "escape").ok).toBe(false);
    expect(fileTree(repo, "escape/config").ok).toBe(false);
    expect(fileTree(join(repo, "escape"), "").ok).toBe(false);
    expect(fileTree(join(repo, "escape"), "config").ok).toBe(false);
  });

  test("the existence oracle says nothing about what is out there", async () => {
    const { filesExist } = await files();
    const r = filesExist(repo, ["escape/config/token", "leak", "src/a.ts"]);
    expect(r.here).toEqual(["src/a.ts"]);
  });

  test("the line counter does not measure it", async () => {
    const { measureFile } = await import("../src/filemeasure.ts");
    expect((await measureFile(join(repo, "leak"))).ok).toBe(false);
    expect((await measureFile(join(repo, "escape", "config", "token"))).ok).toBe(false);
    expect((await measureFile(join(repo, "src", "a.ts"))).ok).toBe(true);
  });

  test("the change view does not render an untracked link as an added file", async () => {
    const { fileDiff } = await import("../src/changerows.ts");
    const d = await fileDiff(repo, "leak", "working");
    expect(d.error).toBeTruthy();
    expect(JSON.stringify(d.hunks)).not.toContain("fake-token");
  });

  test("the scope check itself follows the link", async () => {
    const { inScopeReal } = await import("../src/config.ts");
    expect(inScopeReal(join(repo, "escape", "config", "token"))).toBe(false);
    expect(inScopeReal(join(repo, "dangle"))).toBe(false);
    expect(inScopeReal(join(repo, "src", "a.ts"))).toBe(true);
    expect(inScopeReal(join(repo, "src", "not-written-yet.ts"))).toBe(true);
  });
});

describe("a link that stays in the checkout still works", () => {
  test("a file linked to another file of the same repo reads", async () => {
    const { fileText } = await files();
    const r = fileText(repo, "alias.ts");
    expect(r.ok).toBe(true);
    expect(r.text).toBe("export const a = 1;\n");
  });

  test("a directory linked inside the repo lists and reads", async () => {
    const { fileTree, fileText } = await files();
    expect(fileTree(repo, "src-link").ok).toBe(true);
    expect(fileText(repo, "src-link/a.ts").ok).toBe(true);
  });
});

// This app's own directories hold its credentials. No scope puts them in reach
// of a read route: not a project that contains them, and not the whole-machine
// mode.
describe("the app's own directories are never readable", () => {
  let cfg: string;
  let data: string;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["AGENTGLASS_ROOT", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "AGENTGLASS_STATE_DIR", "AGENTGLASS_DB"] as const;

  beforeAll(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    cfg = join(outside, "cfg");
    data = join(outside, "data");
    mkdirSync(join(cfg, "agentglass"), { recursive: true });
    mkdirSync(join(data, "agentglass-orbit"), { recursive: true });
    writeFileSync(join(cfg, "agentglass", "token"), "fake-token-0000\n");
    writeFileSync(join(data, "agentglass-orbit", "state.json"), "{}\n");
    writeFileSync(join(outside, "moved.db"), "not a db\n");
    writeFileSync(join(outside, "moved.db-wal"), "not a wal\n");
    writeFileSync(join(outside, "notes.txt"), "fine to read\n");
    process.env.XDG_CONFIG_HOME = cfg;
    process.env.XDG_DATA_HOME = data;
    process.env.AGENTGLASS_DB = join(outside, "moved.db");
  });

  afterAll(() => {
    for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  });

  for (const [mode, root] of [["no project open", ""], ["a project that contains them", "OUTSIDE"]] as const) {
    test(`with ${mode}`, async () => {
      if (root) process.env.AGENTGLASS_ROOT = outside; else delete process.env.AGENTGLASS_ROOT;
      const { fileText, fileTree, filesExist } = await files();
      const { measureFile } = await import("../src/filemeasure.ts");
      expect(fileText(join(cfg, "agentglass"), "token").ok).toBe(false);
      expect(fileText(cfg, "agentglass/token").ok).toBe(false);
      expect(fileTree(cfg, "agentglass").ok).toBe(false);
      expect(fileText(data, "agentglass-orbit/state.json").ok).toBe(false);
      expect(fileText(outside, "moved.db").ok).toBe(false);
      expect(fileText(outside, "moved.db-wal").ok).toBe(false);
      expect(filesExist(cfg, ["agentglass/token"]).here).toEqual([]);
      expect((await measureFile(join(cfg, "agentglass", "token"))).ok).toBe(false);
      // Through a link, too.
      expect(fileText(repo, "escape/cfg/agentglass/token").ok).toBe(false);
      // The preview door too, which has its own project check.
      const { browseReal } = await import("../src/browse.ts");
      expect(browseReal(join(cfg, "agentglass", "token"))).toBeNull();
      // And the rest of that project is still a project.
      expect(fileText(outside, "notes.txt").ok).toBe(true);
    });
  }
});

// The readers bound to one repository — conflicts, CODEOWNERS, the change view —
// checked their path as a string and then opened it, so a tracked link read
// whatever it pointed at.
describe("repository readers do not follow a link out", () => {
  let git: string;
  const run = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=Orbit", "-c", "user.email=orbit@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd: git, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };

  beforeAll(() => {
    git = join(box, "gitrepo");
    mkdirSync(join(git, ".github"), { recursive: true });
    run("init", "-q");
    writeFileSync(join(git, "README.md"), "# orbit\n");
    symlinkSync(join(outside, "config", "token"), join(git, ".github", "CODEOWNERS"));
    symlinkSync(join(outside, "config", "token"), join(git, "tracked-link"));
    run("add", "-A");
    run("commit", "-q", "-m", "init");
    symlinkSync(join(outside, "config", "token"), join(git, "untracked-link"));
  });

  test("a conflict view", async () => {
    const { conflictFile, conflictBlocks } = await import("../src/gitwork.ts");
    const f = conflictFile(git, "tracked-link");
    expect(f.ok).toBe(false);
    expect(JSON.stringify(f)).not.toContain("fake-token");
    expect(conflictBlocks(git, "tracked-link").ok).toBe(false);
  });

  test("CODEOWNERS", async () => {
    const { codeowners } = await import("../src/prs.ts");
    expect(JSON.stringify(await codeowners(git))).not.toContain("fake-token");
  });

  test("the change view: an untracked link is refused, a tracked one is still git's to diff", async () => {
    const { fileDiff } = await import("../src/changerows.ts");
    const u = await fileDiff(git, "untracked-link", "working");
    expect(u.error).toBe("path outside the repository");
    const t = await fileDiff(git, "tracked-link", "committed");
    expect(t.error).toBeUndefined();
    expect(JSON.stringify(t)).not.toContain("fake-token");
  });

  test("the change view outside a repository reads nothing", async () => {
    const { fileDiff } = await import("../src/changerows.ts");
    const d = await fileDiff(outside, "config/token", "working");
    expect(d.error).toBe("not a git repository");
    expect(JSON.stringify(d)).not.toContain("fake-token");
  });
});

describe("the /files/ narrowing judges the path that is opened", () => {
  test("an absolute rel is judged as itself, not glued onto the root", async () => {
    const { filesReach } = await import("../src/files.ts");
    const q = new URLSearchParams({ root: "/home", rel: "/home/orbit/.ssh/id_orbit" });
    expect(filesReach("/files/read", q)).toContain("/home/orbit/.ssh/id_orbit");
    const e = new URLSearchParams([["root", "/home"], ["rel", "/home/orbit/.ssh/id_orbit"]]);
    expect(filesReach("/files/exist", e)).toContain("/home/orbit/.ssh/id_orbit");
  });
});

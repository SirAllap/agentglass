/*
 * A cockpit opened on several projects at once.
 *
 * The scope used to be one directory or none, so "these three repos" had two
 * answers and both were wrong: the parent folder, which drags in every sibling
 * nobody chose, or the whole machine. The scope is a list now. These tests hold
 * the two halves of that together — what is read from the config file, and
 * what the enforcement helpers do with more than one root — because a list that
 * is persisted but only its first entry enforced is a cockpit that shows three
 * projects and refuses a shell in two of them.
 *
 * Settings go to a scratch XDG_CONFIG_HOME; config.ts refuses any other path
 * under test. Each test imports config.ts fresh, since it caches the parsed file.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const XDG0 = process.env.XDG_CONFIG_HOME;
const ROOT0 = process.env.AGENTGLASS_ROOT;
afterAll(() => {
  if (XDG0 === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = XDG0;
  if (ROOT0 === undefined) delete process.env.AGENTGLASS_ROOT; else process.env.AGENTGLASS_ROOT = ROOT0;
});

let dir = "", cfg = "", A = "", B = "", C = "";
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-multi-")));
  process.env.XDG_CONFIG_HOME = dir;
  delete process.env.AGENTGLASS_ROOT;
  cfg = join(dir, "agentglass", "config.json");
  // Plain folders, not repos: scope resolution asks git which repo a path is
  // in, and a folder that is not one is still a scope — which keeps these tests
  // about the list rather than about git.
  A = join(dir, "code", "orbit");
  B = join(dir, "code", "lander");
  C = join(dir, "code", "unchosen");
  for (const p of [A, B, C]) mkdirSync(p, { recursive: true });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const load = async () => await import("../src/config.ts?" + Math.random().toString(36).slice(2));
const writeCfg = (o: unknown) => {
  mkdirSync(join(dir, "agentglass"), { recursive: true });
  writeFileSync(cfg, JSON.stringify(o));
};

describe("the scope is a list", () => {
  test("a list in the config file is every root, and the first is the primary one", async () => {
    writeCfg({ root: [A, B] });
    const c = await load();
    expect(c.workspaceRoots()).toEqual([A, B]);
    expect(c.workspaceRoot()).toBe(A);
  });

  test("a single string still reads as a one-project scope", async () => {
    writeCfg({ root: A });
    const c = await load();
    expect(c.workspaceRoots()).toEqual([A]);
    expect(c.workspaceRoot()).toBe(A);
  });

  test("nothing set is unscoped, not an empty project", async () => {
    const c = await load();
    expect(c.workspaceRoots()).toEqual([]);
    expect(c.workspaceRoot()).toBeNull();
    expect(c.inScope(C)).toBe(true);
  });

  test("a hand-edited list with junk in it keeps the paths and drops the rest", async () => {
    writeCfg({ root: [A, 42, "", B, A] });
    const c = await load();
    expect(c.workspaceRoots()).toEqual([A, B]);
  });

  test("every chosen root is in scope — not only the first — and nothing else is", async () => {
    writeCfg({ root: [A, B] });
    const c = await load();
    expect(c.inScope(join(A, "src", "x.ts"))).toBe(true);
    expect(c.inScope(join(B, "README.md"))).toBe(true);
    expect(c.inScope(C)).toBe(false);
    expect(c.sessionInScope({ project_path: B })).toBe(true);
    expect(c.sessionInScope({ project_path: C, cwd_path: C })).toBe(false);
    expect(c.scopeRoots()).toEqual(expect.arrayContaining([A, B]));
  });

  test("an explicit scope argument can be a list too", async () => {
    const c = await load();
    expect(c.inScope(join(B, "x"), [A, B])).toBe(true);
    expect(c.inScope(join(C, "x"), [A, B])).toBe(false);
  });
});

describe("choosing several projects", () => {
  test("several are persisted as a list, and applied at once", async () => {
    const c = await load();
    const r = c.setWorkspaceRoots([A, B]);
    expect(r.ok).toBe(true);
    expect(r.workspaces).toEqual([A, B]);
    expect(c.workspaceRoots()).toEqual([A, B]);
    expect(JSON.parse(readFileSync(cfg, "utf8")).root).toEqual([A, B]);
  });

  test("one is persisted as the plain string an older build can still read", async () => {
    const c = await load();
    c.setWorkspaceRoots([A]);
    expect(JSON.parse(readFileSync(cfg, "utf8")).root).toBe(A);
  });

  test("the same folder twice is one root", async () => {
    const c = await load();
    expect(c.setWorkspaceRoots([A, A + "/", B]).workspaces).toEqual([A, B]);
  });

  test("an empty list or null is the unscoped cockpit, and clears the key", async () => {
    writeCfg({ root: [A, B], repoDirs: ["~/code"] });
    const c = await load();
    expect(c.setWorkspaceRoots([]).workspaces).toEqual([]);
    const saved = JSON.parse(readFileSync(cfg, "utf8"));
    expect(saved.root).toBeUndefined();
    // Everything else in the file survives the rewrite.
    expect(saved.repoDirs).toEqual(["~/code"]);
  });

  test("one bad path refuses the whole choice rather than opening half of it", async () => {
    const c = await load();
    const r = c.setWorkspaceRoots([A, join(dir, "gone")]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("does not exist");
    expect(c.workspaceRoots()).toEqual([]);
  });

  test("the single-root setter still works for the callers that only have one", async () => {
    const c = await load();
    expect(c.setWorkspaceRoot(B).workspace).toBe(B);
    expect(c.workspaceRoots()).toEqual([B]);
  });
});

describe("what several open projects bring with them", () => {
  const git = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", "-C", cwd, ...a], { stdout: "ignore", stderr: "ignore" });
  const makeRepo = (p: string) => {
    Bun.spawnSync(["git", "init", "-q", "-b", "main", p]);
    git(p, "config", "user.email", "t@example.com");
    git(p, "config", "user.name", "t");
    writeFileSync(join(p, "README.md"), "# x\n");
    git(p, "add", "-A");
    git(p, "commit", "-qm", "first");
  };

  test("the scoped repo list is every chosen project, and not the one beside them", async () => {
    for (const p of [A, B, C]) makeRepo(p);
    writeCfg({ root: [A, B] });
    const gw = await import("../src/gitwork.ts");
    gw.invalidateRepos();
    const roots = (await gw.discoverRepos([], [C])).map((r) => r.root);
    expect(roots).toEqual(expect.arrayContaining([A, B]));
    expect(roots).not.toContain(C);
  });

  test("a container belongs to any of the open projects, not only the first", async () => {
    const { ownerOf } = await import("../src/dockerowner.ts");
    expect(ownerOf(join(B, "svc"), [A, B], [A, B])?.foreign).toBe(false);
    expect(ownerOf(join(C, "svc"), [A, B], [A, B])?.foreign).toBe(true);
    // The single-root shape still means what it meant.
    expect(ownerOf(join(B, "svc"), [A, B], A)?.foreign).toBe(true);
  });

  test("an empty list marks nothing as outside — it is the unscoped cockpit", async () => {
    makeRepo(A);
    writeFileSync(join(A, "README.md"), "# changed\n");
    const { changeRows } = await import("../src/changerows.ts");
    const { rows } = await changeRows([{ root: A, branch: "main", name: "orbit" } as never], "working", []);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => !r.outside)).toBe(true);
    const narrowed = await changeRows([{ root: A, branch: "main", name: "orbit" } as never], "working", [B]);
    expect(narrowed.rows.every((r) => r.outside)).toBe(true);
  });
});

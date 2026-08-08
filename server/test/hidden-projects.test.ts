/*
 * Taking a project off the picker's list.
 *
 * The distinction this has to keep is the whole feature: hidden is not deleted
 * and not forgotten. Nothing here may touch the filesystem beyond the config
 * file, and the path has to stay remembered — an implementation that dropped
 * the entry instead would look identical until the next sweep found the folder
 * again and put it straight back.
 *
 * Settings are written to a scratch XDG_CONFIG_HOME, which is also the rule the
 * writer enforces for itself: under test it refuses any path outside the temp
 * directory, so a suite cannot rewrite the settings of the machine it runs on.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "", cfg = "";

/** Put the machine's own setting back when this file is done. `bun test` shares
 *  one process across files, so a suite that leaves XDG_CONFIG_HOME pointing at
 *  a temp directory it then deletes hands every later file a settings path that
 *  is not there — the same trap config-root.test.ts guards against. */
const XDG0 = process.env.XDG_CONFIG_HOME;
afterAll(() => {
  if (XDG0 === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = XDG0;
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-hidden-"));
  process.env.XDG_CONFIG_HOME = dir;
  cfg = join(dir, "agentglass", "config.json");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Imported fresh per test: config.ts caches the parsed file, and these tests
 *  are about what a *reload* sees. */
const load = async () => await import("../src/config.ts?" + Math.random().toString(36).slice(2));

describe("hiding a project", () => {
  test("remembers the path, and says so on the next read", async () => {
    const { setProjectHidden, hiddenProjects } = await load();
    expect(hiddenProjects()).toEqual([]);
    const r = setProjectHidden("/home/dev/code/scratch", true);
    expect(r.ok).toBe(true);
    expect(r.persisted).toBe(true);
    expect(hiddenProjects()).toEqual(["/home/dev/code/scratch"]);
  });

  test("and it survives a restart, because it is in the config file", async () => {
    (await load()).setProjectHidden("/home/dev/code/scratch", true);
    const saved = JSON.parse(readFileSync(cfg, "utf8"));
    expect(saved.hiddenProjects).toEqual(["/home/dev/code/scratch"]);
    // A second process reading that file agrees.
    const { hiddenProjects } = await load();
    expect(hiddenProjects()).toEqual(["/home/dev/code/scratch"]);
  });

  test("nothing on disk is touched — it is a list, not a delete", async () => {
    const project = join(dir, "a-real-project");
    mkdirSync(project);
    writeFileSync(join(project, "file.txt"), "work nobody wants deleted");
    (await load()).setProjectHidden(project, true);
    expect(existsSync(join(project, "file.txt"))).toBe(true);
  });

  test("putting it back leaves no trace of the key", async () => {
    const { setProjectHidden, hiddenProjects } = await load();
    setProjectHidden("/home/dev/code/scratch", true);
    const r = setProjectHidden("/home/dev/code/scratch", false);
    expect(r.ok).toBe(true);
    expect(hiddenProjects()).toEqual([]);
    // Removed rather than left as an empty array: this file is hand-edited, and
    // a key that means nothing is a key somebody has to work out.
    expect(JSON.parse(readFileSync(cfg, "utf8")).hiddenProjects).toBeUndefined();
  });

  test("hiding the same one twice does not list it twice", async () => {
    const { setProjectHidden, hiddenProjects } = await load();
    setProjectHidden("/home/dev/code/scratch", true);
    setProjectHidden("/home/dev/code/scratch/", true);
    expect(hiddenProjects()).toEqual(["/home/dev/code/scratch"]);
  });

  test("keeps the rest of the settings file", async () => {
    mkdirSync(join(dir, "agentglass"), { recursive: true });
    writeFileSync(cfg, JSON.stringify({ root: "/home/dev/code/app", chatBypass: true }) + "\n");
    (await load()).setProjectHidden("/home/dev/code/scratch", true);
    const saved = JSON.parse(readFileSync(cfg, "utf8"));
    expect(saved.root).toBe("/home/dev/code/app");
    expect(saved.chatBypass).toBe(true);
  });

  test("refuses a path that is not one", async () => {
    const { setProjectHidden } = await load();
    expect(setProjectHidden("", true).ok).toBe(false);
    expect(setProjectHidden(null, true).ok).toBe(false);
    expect(setProjectHidden("/a/\0/b", true).ok).toBe(false);
  });

  test("a settings file it cannot parse is never overwritten", async () => {
    mkdirSync(join(dir, "agentglass"), { recursive: true });
    writeFileSync(cfg, "{ this is not json");
    const r = (await load()).setProjectHidden("/home/dev/code/scratch", true);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("malformed");
    expect(readFileSync(cfg, "utf8")).toBe("{ this is not json");
  });

  test("a hand-written list of the wrong shape is ignored, not obeyed", async () => {
    mkdirSync(join(dir, "agentglass"), { recursive: true });
    writeFileSync(cfg, JSON.stringify({ hiddenProjects: "everything" }) + "\n");
    expect((await load()).hiddenProjects()).toEqual([]);
  });
});

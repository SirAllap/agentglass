/*
 * A project removed from the list stays removed in the panels.
 *
 * Hiding only ever reached the project picker. The three projects taken off
 * "Open a project" were still grouped in the unscoped Diff view, still in the
 * checkout dropdown of pull requests, and still in every other list that asks
 * discoverRepos who is on this machine — a remove button that removed the row
 * it was on and nothing else.
 *
 * Both halves are asserted, because the fix is only correct with both: the
 * panels' list (`{}`) leaves them out, and the picker's (`ignoreScope`) still
 * has them, since it is the one surface that can put one back.
 *
 * Settings go in a scratch XDG_CONFIG_HOME, which is also what the config
 * writer enforces on itself under test.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { story } from "./story.ts";

let dir = "", cfg = "", gw: typeof import("../src/gitwork.ts"), cf: typeof import("../src/config.ts");
const ENV0 = { xdg: process.env.XDG_CONFIG_HOME, root: process.env.AGENTGLASS_ROOT, dirs: process.env.AGENTGLASS_REPO_DIRS };

const run = (cwd: string, ...args: string[]) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

function repoAt(name: string): string {
  const at = join(dir, name);
  spawnSync("git", ["init", "-q", "-b", "main", at], { encoding: "utf8" });
  run(at, "config", "user.email", "t@example.com");
  run(at, "config", "user.name", "t");
  writeFileSync(join(at, "a.txt"), "a\n");
  run(at, "add", "-A");
  run(at, "commit", "-qm", "first");
  return at;
}

/** Through the writer the ✕ uses, not straight to the file: config.ts parses
 *  the settings once per path and keeps them, and only the writer knows to drop
 *  that copy. A test that edited the JSON behind it asserted against the list
 *  the process read at boot. */
function hide(...roots: string[]) {
  for (const p of cf.hiddenProjects()) cf.setProjectHidden(p, false);
  for (const r of roots) cf.setProjectHidden(r, true);
  gw.invalidateRepos();
}

const names = async (opts: { ignoreScope?: boolean } = {}) =>
  (await gw.discoverRepos([], [], opts)).map((r) => r.name).sort();

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-hidden-everywhere-")));
  process.env.XDG_CONFIG_HOME = join(dir, "xdg");
  cfg = join(dir, "xdg", "agentglass", "config.json");
  mkdirSync(join(dir, "xdg", "agentglass"), { recursive: true });
  // Written before anything reads it, so the first parse already has it.
  writeFileSync(cfg, JSON.stringify({ repoDirs: [dir] }, null, 2) + "\n");
  // Whole-machine, and bounded to the fixture: `repoDirs` is the one thing that
  // still invites a directory walk, so it is also the cheapest way to hand this
  // sweep a known set instead of the machine's.
  delete process.env.AGENTGLASS_ROOT;
  delete process.env.AGENTGLASS_REPO_DIRS;

  repoAt("orbit");
  const scratch = repoAt("scratch");
  run(scratch, "worktree", "add", "-q", "-b", "ORBIT-1042", join(dir, "scratch-ORBIT-1042"));

  gw = await import("../src/gitwork.ts");
  cf = await import("../src/config.ts");
  hide();
});

afterAll(() => {
  for (const [k, v] of [["XDG_CONFIG_HOME", ENV0.xdg], ["AGENTGLASS_ROOT", ENV0.root], ["AGENTGLASS_REPO_DIRS", ENV0.dirs]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  gw?.invalidateRepos();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

const step = story();

describe("a removed project", () => {
  step("is on the panels' list until it is removed", async () => {
    expect(await names()).toEqual(["orbit", "scratch", "scratch-ORBIT-1042"]);
  });

  step("is gone from the panels' list, and takes its checkouts with it", async () => {
    // A worktree of a removed project is the removed project on another branch.
    hide(join(dir, "scratch"));
    expect(await names()).toEqual(["orbit"]);
  });

  step("is still on the picker's list, which is where it can be put back", async () => {
    hide(join(dir, "scratch"));
    expect(await names({ ignoreScope: true })).toContain("scratch");
  });

  step("comes back the moment it is put back, not when a cache expires", async () => {
    hide(join(dir, "scratch"));
    expect(await names()).toEqual(["orbit"]);
    hide();
    expect(await names()).toContain("scratch");
  });

  step("is still shown when it is the open project — asking for it by name wins", async () => {
    hide(join(dir, "scratch"));
    process.env.AGENTGLASS_ROOT = join(dir, "scratch");
    try {
      gw.invalidateRepos();
      // Scoped to it: answering with nothing would be a blank app on a folder
      // the user opened on purpose.
      expect(await names()).toContain("scratch");
    } finally {
      delete process.env.AGENTGLASS_ROOT;
      gw.invalidateRepos();
    }
  });
});

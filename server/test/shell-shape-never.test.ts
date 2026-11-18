/*
 * The base never rules read what a line does. A push to main or master is
 * refused in every spelling and on any remote; `gh api` merges and releases
 * are refused; `rm` of / or ~ is refused whatever the flag order. Ordinary
 * pushes and removes still run.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-shape-")));
const saved = { cfg: process.env.XDG_CONFIG_HOME, data: process.env.XDG_DATA_HOME, state: process.env.AGENTGLASS_STATE_DIR };
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
const store = await import("../src/agentRulesStore.ts");
const ROOT = join(dir, "acme", "orbit");
mkdirSync(ROOT, { recursive: true });
Bun.spawnSync(["git", "init", "-q", ROOT]);
afterAll(() => {
  if (saved.cfg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved.cfg;
  if (saved.data === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = saved.data;
  if (saved.state === undefined) delete process.env.AGENTGLASS_STATE_DIR; else process.env.AGENTGLASS_STATE_DIR = saved.state;
  rmSync(dir, { recursive: true, force: true });
});
const verdict = (cmd: string) => store.check(ROOT, "Bash", { command: cmd }).decision;

describe("never, by what the line does", () => {
  test.each([
    "git push origin +main", "git push --force origin main", "git push origin feature:main", "git push origin HEAD:refs/heads/main",
    "git push origin :main", "git push upstream main", "git -C x push origin main", "git push origin +feature:refs/heads/master", "git push --all", "git push origin --mirror", "git push -f --all upstream",
    "git push -u origin master",
  ])("push: %s", (c) => expect(verdict(c)).toBe("never"));
  test.each([
    "gh api repos/acme/orbit/pulls/12/merge -X PUT", "gh api -X POST repos/acme/orbit/releases", "gh api repos/acme/orbit/releases -f tag_name=v1",
  ])("gh api: %s", (c) => expect(verdict(c)).toBe("never"));
  test.each([
    "rm -rf /*", "rm -rf ~/", "rm -fr /", "rm -r -f /", "rm -rf $HOME", 'rm -rf "$HOME"', "rm -rf //", "rm -rf ~/*", "rm -rf /",
  ])("rm: %s", (c) => expect(verdict(c)).toBe("never"));
  test.each([
    "git push origin feature", "git push origin HEAD:feature", "git push -u origin my-main-fix", "git push",
    "gh api repos/acme/orbit/pulls/12", "gh api repos/acme/orbit/releases", "rm -rf /tmp/x", "rm -rf ./build", "rm -f /tmp/a",
  ])("still runs: %s", (c) => expect(verdict(c)).not.toBe("never"));
});

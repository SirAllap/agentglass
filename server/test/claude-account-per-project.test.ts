/*
 * A project may name the Claude Code account (config folder) its agents use.
 * One project's choice must not reach another, and a bad value is never passed
 * on to the CLI. Only the path is checked: nothing inside the folder is read.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-acct-")));
const saved = { cfg: process.env.XDG_CONFIG_HOME, data: process.env.XDG_DATA_HOME, state: process.env.AGENTGLASS_STATE_DIR, root: process.env.AGENTGLASS_ROOT, home: process.env.AGENTGLASS_CLAUDE_HOME };
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");

const { APP, putSetting } = await import("../src/preflightStore.ts");
const { checkAccountDir, claudeAccountDir, claudeAccountDirs } = await import("../src/claudeAccount.ts");

afterAll(() => {
  for (const [k, v] of [["XDG_CONFIG_HOME", saved.cfg], ["XDG_DATA_HOME", saved.data], ["AGENTGLASS_STATE_DIR", saved.state], ["AGENTGLASS_ROOT", saved.root], ["AGENTGLASS_CLAUDE_HOME", saved.home]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("Claude account per project", () => {
  const orbit = "/home/acme/code/orbit";
  const other = "/home/acme/code/acme-v2";
  const work = join(dir, "claude-work");

  test("one project's account leaves another on the default", () => {
    mkdirSync(work);
    putSetting(APP, "workers.claudeConfigDir", "");
    putSetting(orbit, "workers.claudeConfigDir", work);
    expect(claudeAccountDir(orbit)).toBe(work);
    expect(claudeAccountDir(other)).toBeNull();
  });

  test("a hand-edited bad value reads as no account", () => {
    putSetting(orbit, "workers.claudeConfigDir", "relative/dir");
    expect(claudeAccountDir(orbit)).toBeNull();
  });

  test("validation refuses a file, a relative path and a .. step; allows empty and a new folder", () => {
    const file = join(dir, "a-file");
    writeFileSync(file, "x");
    expect(checkAccountDir(file)).toHaveProperty("error");
    expect(checkAccountDir("claude")).toHaveProperty("error");
    expect(checkAccountDir(`${dir}/../etc`)).toHaveProperty("error");
    expect(checkAccountDir(`${dir}/x\ny`)).toHaveProperty("error");
    expect(checkAccountDir("")).toEqual({ value: "" });
    expect(checkAccountDir(join(dir, "not-yet"))).toEqual({ value: join(dir, "not-yet") });
  });

  test("the chat reads the chosen folder and the default one; the scanner reads both", async () => {
    const repo = join(dir, "orbit-repo");
    mkdirSync(repo);
    spawnSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
    process.env.AGENTGLASS_ROOT = dir;
    const { projectSlug } = await import("../src/agents/claudecode.ts");
    const mine = join(dir, "claude-acct");
    const fallback = join(dir, "claude-default");
    process.env.AGENTGLASS_CLAUDE_HOME = fallback;
    for (const [home, id] of [[mine, "aaaa"], [fallback, "bbbb"]] as const) {
      const d = join(home, "projects", projectSlug(repo));
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, `${id}.jsonl`), JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
    }
    const { sessionsForProject } = await import("../src/agentsessions.ts");
    putSetting(repo, "workers.claudeConfigDir", "");
    expect((await sessionsForProject(repo)).map((r) => r.id)).toEqual(["bbbb"]);
    putSetting(repo, "workers.claudeConfigDir", mine);
    // The old account's sessions stay in the list after the switch.
    expect((await sessionsForProject(repo)).map((r) => r.id).sort()).toEqual(["aaaa", "bbbb"]);
    expect(claudeAccountDirs()).toContain(mine);
  });

  test("the same session id in both account folders is one row, the newest copy", async () => {
    const repo = join(dir, "orbit-dup");
    mkdirSync(repo);
    spawnSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
    process.env.AGENTGLASS_ROOT = dir;
    const { projectSlug } = await import("../src/agents/claudecode.ts");
    const mine = join(dir, "dup-acct");
    const fallback = join(dir, "dup-default");
    process.env.AGENTGLASS_CLAUDE_HOME = fallback;
    for (const [home, ms] of [[mine, 1_000], [fallback, 2_000]] as const) {
      const d = join(home, "projects", projectSlug(repo));
      mkdirSync(d, { recursive: true });
      const f = join(d, "same-id.jsonl");
      writeFileSync(f, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
      utimesSync(f, ms / 1000, ms / 1000);
    }
    const { sessionsForProject } = await import("../src/agentsessions.ts");
    putSetting(repo, "workers.claudeConfigDir", mine);
    const rows = await sessionsForProject(repo);
    expect(rows.map((r) => r.id)).toEqual(["same-id"]);
    expect(rows[0]!.at).toBe(2_000);
  });
});

describe("a resume after an account switch", () => {
  test("keeps the default folder when only it holds the session", async () => {
    const { accountForResume } = await import("../src/agentops.ts");
    const { projectSlug } = await import("../src/agents/claudecode.ts");
    const cwd = "/home/acme/code/orbit";
    const home = join(dir, "resume-default");
    const acct = join(dir, "resume-acct");
    mkdirSync(join(home, "projects", projectSlug(cwd)), { recursive: true });
    writeFileSync(join(home, "projects", projectSlug(cwd), "old1.jsonl"), "{}\n");
    expect(accountForResume(acct, cwd, "old1", home)).toBeNull();
    expect(accountForResume(acct, cwd, "new1", home)).toBe(acct);
    expect(accountForResume(acct, cwd, null, home)).toBe(acct);
  });
});

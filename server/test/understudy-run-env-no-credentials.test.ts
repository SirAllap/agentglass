/*
 * A RUN CANNOT PUBLISH, and this is the test that says so by trying.
 *
 * Everything else about the understudy is arranged so a bad run costs a
 * directory: its own worktree, nothing reused, the failure left on disk as
 * evidence. All of that assumes the run stayed on this machine. Until this
 * fence existed, the only thing keeping it here was a line in the brief —
 * against an agent started with permissions skipped, unattended, inheriting a
 * logged-in `gh` and an ssh agent with a key in it.
 *
 * So the assertions below RUN the commands rather than reading the source.
 * A source-read lock would have passed against an env that git silently
 * ignored, which is the failure mode that matters here: `GIT_CONFIG_COUNT`
 * with a wrong count, a `pushInsteadOf` that does not match the url shape in
 * use, a variable git stopped honouring. The only proof that a fence holds is
 * a push that does not.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { understudyRunEnv, secretsBlanked, SECRET_NAME } from "../src/understudy-runenv.ts";

let dir = "";
let env: Record<string, string> = {};

/** The run's environment on top of a normal one, exactly as a ladder builds it. */
function runEnv(): Record<string, string> {
  return { ...process.env as Record<string, string>, ...env, HOME: process.env.HOME || "" };
}

function git(args: string[]) {
  return spawnSync("git", args, { cwd: dir, env: runEnv(), encoding: "utf8" });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-fence-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  /* A remote of the shape this project actually uses. Nothing is ever sent to
     it: every assertion below is about the request never leaving. */
  execFileSync("git", ["remote", "add", "origin", "https://github.com/example/widget.git"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "one\n");
  execFileSync("git", ["-c", "user.name=Probe", "-c", "user.email=probe@example.invalid", "add", "a.txt"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Probe", "-c", "user.email=probe@example.invalid", "commit", "-qm", "one"], { cwd: dir });
  env = understudyRunEnv(dir);
});

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("a run has no way to publish", () => {
  test("`git push` over https does not reach github", () => {
    const r = git(["push", "--dry-run", "origin", "HEAD"]);
    expect(r.status, "a run pushed to the real remote").not.toBe(0);
    /* And it failed at the ADDRESS, not at a password prompt that a future
       credential helper might answer. */
    expect(`${r.stderr}`).toContain("refused.invalid");
  });

  test("and neither does a remote added by hand inside the run, in either ssh form", () => {
    for (const [name, url] of [["scp", "git@github.com:example/widget.git"], ["ssh", "ssh://git@github.com/example/widget.git"]]) {
      execFileSync("git", ["remote", "add", name!, url!], { cwd: dir });
      const r = git(["push", "--dry-run", name!, "HEAD"]);
      expect(r.status, `${name} push left the machine`).not.toBe(0);
      expect(`${r.stderr}`, `${name} was not rewritten`).toContain("refused.invalid");
    }
  });

  test("no credential helper can mint a token", () => {
    /*
     * BOTH HALVES, because the second one alone cannot fail on this machine.
     * There is no helper configured here today, so `--get-all` returns empty
     * whether or not the fence is doing anything — a lock that cannot go red
     * is not a lock. So the override is asserted where it lives, in the env,
     * and the resolved value is checked underneath it for the machine that
     * does have one.
     */
    const keys: string[] = [];
    for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i++) {
      if (env[`GIT_CONFIG_KEY_${i}`] === "credential.helper") keys.push(env[`GIT_CONFIG_VALUE_${i}`]!);
    }
    expect(keys, "the fence stopped emptying credential.helper").toEqual([""]);
    expect(`${git(["config", "--get-all", "credential.helper"]).stdout}`.trim()).toBe("");
  });

  test("the ssh agent is gone, so a key already loaded is not reachable", () => {
    expect(env.SSH_AUTH_SOCK).toBe("");
  });

  test("`gh` has no login: its config directory is an empty one inside the run", () => {
    expect(env.GH_CONFIG_DIR).toBe(join(dir, "gh"));
    expect(existsSync(env.GH_CONFIG_DIR!)).toBe(true);
    expect(existsSync(join(env.GH_CONFIG_DIR!, "hosts.yml"))).toBe(false);
    for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"]) expect(env[k]).toBe("");
  });
});

describe("a run inherits none of the operator's other secrets", () => {
  /*
   * The first fence took `gh` and ssh and left everything else. Measured on
   * the shell this server starts from (names only): a run with permissions
   * skipped still carried the tracker's API key, the desktop app's own machine
   * token and the operator's agent-session token. A shell of invented names
   * stands in for it here, so the test reads the same whatever this machine
   * happens to export.
   */
  const shell: Record<string, string> = {
    HOME: "/home/someone", PATH: "/usr/bin", LANG: "C.UTF-8", TERM: "xterm",
    AGENTGLASS_SERVER: "http://127.0.0.1:4317",
    AGENTGLASS_TOKEN: "machine-token",
    AGENTGLASS_WEBHOOK: "https://hooks.example.invalid/T000/B000/xyz",
    CLICKUP_API_KEY: "pk_000", CLICKUP_TEAM_ID: "9000001",
    Github_Token: "ghp_mixedcase", NPM_TOKEN: "npm_000", PYPI_PASSWORD: "p",
    AWS_ACCESS_KEY_ID: "AKIA", AWS_SECRET_ACCESS_KEY: "s", AWS_SESSION_TOKEN: "t",
    AZURE_CLIENT_SECRET: "z", GOOGLE_APPLICATION_CREDENTIALS: "/tmp/sa.json",
    OPENAI_API_KEY: "sk-000", SLACK_BOT_TOKEN: "xoxb", DISCORD_TOKEN: "d", DOCKER_PASSWORD: "dp",
    DATABASE_PASSWORD: "db", SOME_SERVICE_PASS: "sp", MY_CREDENTIALS: "c", MY_CREDENTIAL: "c1",
    ANTHROPIC_API_KEY: "sk-ant-000",
    CLAUDE_CONFIG_DIR: "/home/someone/.local/state/agentglass/clone-claude",
    MY_CONFIG: "hunter2",
  };

  test("every credential-shaped name is blanked, whatever its case", () => {
    const fence = understudyRunEnv(dir, shell);
    const run = { ...shell, ...fence };
    for (const k of ["AGENTGLASS_TOKEN", "AGENTGLASS_WEBHOOK", "CLICKUP_API_KEY", "CLICKUP_TEAM_ID", "Github_Token", "NPM_TOKEN",
      "PYPI_PASSWORD", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AZURE_CLIENT_SECRET",
      "GOOGLE_APPLICATION_CREDENTIALS", "OPENAI_API_KEY", "SLACK_BOT_TOKEN", "DISCORD_TOKEN", "DOCKER_PASSWORD",
      "DATABASE_PASSWORD", "SOME_SERVICE_PASS", "MY_CREDENTIALS", "MY_CREDENTIAL"]) {
      expect(run[k], `${k} reached the run`).toBe("");
    }
  });

  test("and the webhook goes by name even when the shell has no such variable to blank", () => {
    /* `{...shell, ...fence}` is how index.ts builds the env; a webhook that is
       set in the server's environment but happened not to be in `from` would
       otherwise ride through. Blanked unconditionally. */
    expect(secretsBlanked({ HOME: "/h" }).AGENTGLASS_WEBHOOK).toBe("");
  });

  test("what the run needs to start survives: its server, its config home, the CLI's own key", () => {
    const run = { ...shell, ...understudyRunEnv(dir, shell) };
    expect(run.AGENTGLASS_SERVER).toBe(shell.AGENTGLASS_SERVER);
    expect(run.CLAUDE_CONFIG_DIR).toBe(shell.CLAUDE_CONFIG_DIR);
    expect(run.HOME).toBe(shell.HOME);
    expect(run.PATH).toBe(shell.PATH);
    /* The one credential-shaped name kept, and why: it is the key the agent
       CLI spends. Blanked, an install that authenticates with a key has no run
       at all — that is not containment. */
    expect(run.ANTHROPIC_API_KEY).toBe(shell.ANTHROPIC_API_KEY);
  });

  test("the machine token is blanked so the read token written after the fence is the only one the run holds", () => {
    /* index.ts: `{ ...process.env, ...understudyRunEnv(cwd), AGENTGLASS_TOKEN: readToken, AGENTGLASS_READ_TOKEN: readToken }`.
       The fence must blank it, not keep it, or a caller that forgot the
       override would hand the run the whole machine. */
    const fence = understudyRunEnv(dir, shell);
    expect(fence.AGENTGLASS_TOKEN).toBe("");
    const run = { ...shell, ...fence, AGENTGLASS_TOKEN: "us_read", AGENTGLASS_READ_TOKEN: "us_read" };
    expect(run.AGENTGLASS_TOKEN).toBe("us_read");
  });

  test("a secret whose name does not say so is not this fence's to find", () => {
    /* Written down so the limit is a decision rather than a surprise. */
    expect(SECRET_NAME.test("MY_CONFIG")).toBe(false);
    expect({ ...shell, ...understudyRunEnv(dir, shell) }.MY_CONFIG).toBe("hunter2");
  });

  test("the fence reads the environment the spawn will copy: by default, this process's", () => {
    const k = "AGX_FENCE_PROBE_TOKEN";
    process.env[k] = "leak";
    try {
      expect(understudyRunEnv(dir)[k]).toBe("");
    } finally {
      delete process.env[k];
    }
  });
});

describe("and what a run still needs, it keeps", () => {
  test("it can still commit as the person: the global config is overridden, never replaced", () => {
    /*
     * The reason this is `GIT_CONFIG_COUNT` and not `GIT_CONFIG_GLOBAL`. The
     * global file also holds `user.name` and `core.hooksPath` — the second one
     * being the private-terms hook. Replacing it would fence the run out of
     * pushing and, in the same move, let it commit as nobody with the hook
     * that guards a public repository switched off.
     */
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(env.GIT_CONFIG_NOSYSTEM).toBeUndefined();
    writeFileSync(join(dir, "b.txt"), "two\n");
    expect(git(["add", "b.txt"]).status).toBe(0);
    const c = git(["-c", "user.name=Probe", "-c", "user.email=probe@example.invalid", "commit", "-qm", "two"]);
    expect(c.status, `${c.stderr}`).toBe(0);
  });

  test("reading the remote is untouched — a run that cannot fetch cannot rebase", () => {
    /* Offline here, so this asserts the SHAPE: nothing rewrites a fetch url,
       and `insteadOf` (which would) is never set. */
    const keys: string[] = [];
    for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i++) keys.push(env[`GIT_CONFIG_KEY_${i}`]!);
    expect(keys.some((k) => /\.insteadOf$/.test(k))).toBe(false);
    expect(keys.filter((k) => /\.pushInsteadOf$/.test(k))).toHaveLength(3);
    expect(Number(env.GIT_CONFIG_COUNT)).toBe(keys.length);
  });

  test("two runs never share the empty gh config", () => {
    const other = mkdtempSync(join(tmpdir(), "agx-fence-2-"));
    try {
      expect(understudyRunEnv(other).GH_CONFIG_DIR).not.toBe(env.GH_CONFIG_DIR);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

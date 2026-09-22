/*
 * A worker role names a CLI and a model, and brings a lock with it.
 *
 * The lock is the part that has to hold: a role moves a worker off Claude and
 * onto a CLI whose own config may allow everything, so every role's deny list
 * is rendered into the layer of that CLI a person's or a project's file
 * cannot loosen, and a CLI with no such layer is refused rather than run
 * without it. These pin the rendering per CLI, the refusal, and the setting.
 *
 * Under a scratch XDG_CONFIG_HOME: config.ts refuses to write a real one from
 * a test.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentProvider } from "../../shared/agentKinds.ts";
import { DENIED_COMMANDS, WORKER_ROLES, roleLaunch, workerRole } from "../../shared/workerRoles.ts";

const REAL_XDG = process.env.XDG_CONFIG_HOME;
const HOME = join(tmpdir(), `agx-worker-roles-${process.pid}`);
process.env.XDG_CONFIG_HOME = HOME;

let cfg: typeof import("../src/config.ts");
let ops: typeof import("../src/agentops.ts");
beforeAll(async () => {
  mkdirSync(join(HOME, "agentglass"), { recursive: true });
  cfg = await import("../src/config.ts");
  ops = await import("../src/agentops.ts");
});
afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  if (REAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = REAL_XDG;
});

const scout = workerRole("scout")!;
const builder = workerRole("builder")!;
const row = (id: string) => agentProvider(id)!;

describe("the lock, as each CLI is told it", () => {
  test("Claude Code: one --settings flag, every command as a prefix rule, and the model", () => {
    const l = roleLaunch(row("claude"), scout, "haiku")!;
    expect(l.env).toEqual({});
    expect(l.file).toBeUndefined();
    expect(l.args[0]).toBe("--settings");
    expect(l.args.slice(2)).toEqual(["--model", "haiku"]);
    const deny = (JSON.parse(l.args[1]!) as { permissions: { deny: string[] } }).permissions.deny;
    for (const c of DENIED_COMMANDS) expect(deny, c).toContain(`Bash(${c}:*)`);
    expect(deny).toContain("Edit");
    expect(deny).toContain("Write");
  });

  test("OpenCode: the rules in OPENCODE_CONFIG_CONTENT, on the build agent as well, which is pinned as the default", () => {
    // OpenCode takes the last matching rule and an agent's rules come after the
    // top-level ones, so a project allowing push on its own `build` agent, or
    // naming a permissive default agent, would undo a top-level-only lock.
    const l = roleLaunch(row("opencode"), scout, "")!;
    expect(l.args).toEqual([]);
    type Perm = { bash: Record<string, string>; edit?: string; task?: string };
    const cfg = JSON.parse(l.env.OPENCODE_CONFIG_CONTENT!) as { default_agent: string; permission: Perm; agent: { build: { permission: Perm } } };
    expect(cfg.default_agent).toBe("build");
    for (const perm of [cfg.permission, cfg.agent.build.permission]) {
      for (const c of DENIED_COMMANDS) {
        expect(perm.bash[c], c).toBe("deny");
        expect(perm.bash[`${c} *`], c).toBe("deny");
      }
      expect(perm.edit).toBe("deny");
      expect(perm.task).toBe("deny");
    }
  });

  test("Qwen Code: a system settings file with the rules, named by its variable", () => {
    const l = roleLaunch(row("qwen"), builder, "qwen3-coder-plus")!;
    expect(l.args).toEqual(["--model", "qwen3-coder-plus"]);
    expect(l.file!.env).toBe("QWEN_CODE_SYSTEM_SETTINGS_PATH");
    const deny = (JSON.parse(l.file!.content) as { permissions: { deny: string[] } }).permissions.deny;
    for (const c of DENIED_COMMANDS) {
      expect(deny, c).toContain(`Bash(${c})`);
      expect(deny, c).toContain(`Bash(${c} *)`);
    }
  });

  test("a builder may edit its worktree; a scout and a verifier may not", () => {
    const claudeDeny = (role: typeof scout) =>
      (JSON.parse(roleLaunch(row("claude"), role, "")!.args[1]!) as { permissions: { deny: string[] } }).permissions.deny;
    expect(claudeDeny(builder)).not.toContain("Edit");
    expect(claudeDeny(workerRole("verifier")!)).toContain("Edit");
    const oc = JSON.parse(roleLaunch(row("opencode"), builder, "")!.env.OPENCODE_CONFIG_CONTENT!) as { permission: { edit?: string } };
    expect(oc.permission.edit).toBeUndefined();
  });

  test("a CLI with no lock this app can apply has no launch at all", () => {
    // Codex has a sandbox but no per-command deny; the Gemini CLI has one that
    // has not been run here. Neither may take a role.
    expect(roleLaunch(row("codex"), scout, "")).toBeNull();
    expect(roleLaunch(row("gemini"), scout, "")).toBeNull();
  });
});

describe("starting a role", () => {
  const roles = (scoutOn: string) => ({
    scout: { provider: scoutOn, model: "" },
    builder: { provider: "claude", model: "sonnet" },
    verifier: { provider: "claude", model: "haiku" },
  });

  test("Qwen Code's lock file is written owner-only, and its variable names it", () => {
    const dir = mkdtempSync(join(tmpdir(), "agx-locks-"));
    const r = ops.roleStart("scout", roles("qwen"), dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("qwen");
    const path = r.env.QWEN_CODE_SYSTEM_SETTINGS_PATH!;
    expect(path.startsWith(dir)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain("Bash(git push)");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a role set to a CLI without a lock is refused, never started unlocked", () => {
    expect(ops.roleStart("scout", roles("codex"), tmpdir())).toEqual({ ok: false, error: "no-lock" });
  });

  test("an unknown role is refused", () => {
    expect(ops.roleStart("reviewer", roles("claude"), tmpdir())).toEqual({ ok: false, error: "no-role" });
  });

  test("the lock and the model ride ahead of the caller's flags, and the prompt stays last", () => {
    const r = ops.roleStart("scout", { ...roles("claude"), scout: { provider: "claude", model: "haiku" } }, tmpdir());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const argv = ops.namedAgentArgv("/usr/bin/claude", r.kind, { name: "w", prompt: "map it", serverArgs: r.args, args: ["--verbose"] }, false);
    expect(argv[0]).toBe("/usr/bin/claude");
    expect(argv[1]).toBe("--settings");
    expect(argv.slice(3)).toEqual(["--model", "haiku", "--verbose", "map it"]);
  });

  test("a role refuses yolo, even when Settings allow it", async () => {
    /* A locked worker gains nothing from skipping its prompts, and whether
       Claude still applies a --settings deny list under
       --dangerously-skip-permissions is not something this app has measured.
       Refused, so the lock never depends on it. */
    const r = await ops.startAgent({ root: tmpdir(), cwd: tmpdir(), kind: "claude", name: "w", lockedRole: true, yolo: true, yoloAllowed: true });
    expect(r).toEqual({ ok: false, error: "yolo-role" });
  });

  test("a role refuses caller flags that would pick another model or another OpenCode agent", async () => {
    const base = { root: tmpdir(), cwd: tmpdir(), yoloAllowed: false, kind: "opencode", lockedRole: true } as const;
    for (const args of [["--agent", "loose"], ["--model", "opus"], ["-m", "opus"], ["--model=opus"]]) {
      expect(await ops.startAgent({ ...base, name: "w", args }), JSON.stringify(args))
        .toEqual({ ok: false, error: "arg-refused", flag: args[0]! });
    }
  });
});

describe("the setting", () => {
  const file = () => join(HOME, "agentglass", "config.json");

  test("each role starts where context-diet's own agent files pin it", () => {
    process.env.XDG_CONFIG_HOME = HOME;
    rmSync(file(), { force: true });
    const r = cfg.workerRoles();
    for (const role of WORKER_ROLES) expect(r[role.id]).toEqual(role.default);
  });

  test("saves a CLI with a lock and a model, and keeps the other roles", () => {
    process.env.XDG_CONFIG_HOME = HOME;
    rmSync(file(), { force: true });
    expect(cfg.writeWorkerRole("scout", { provider: "opencode", model: "opencode/big-pickle" }).ok).toBe(true);
    expect(cfg.writeWorkerRole("verifier", { provider: "qwen", model: "" }).ok).toBe(true);
    const r = cfg.workerRoles();
    expect(r.scout).toEqual({ provider: "opencode", model: "opencode/big-pickle" });
    expect(r.verifier).toEqual({ provider: "qwen", model: "" });
    expect(r.builder).toEqual(builder.default);
  });

  test("refuses a CLI with no lock, a model that is not one word, and a role that does not exist", () => {
    process.env.XDG_CONFIG_HOME = HOME;
    expect(cfg.writeWorkerRole("scout", { provider: "codex", model: "" }).ok).toBe(false);
    expect(cfg.writeWorkerRole("scout", { provider: "claude", model: "haiku --dangerously-skip-permissions" }).ok).toBe(false);
    expect(cfg.writeWorkerRole("scout", { provider: "claude", model: "-p" }).ok).toBe(false);
    expect(cfg.writeWorkerRole("reviewer", { provider: "claude", model: "" }).ok).toBe(false);
  });

  test("a hand-edited role naming a CLI with no lock reads as the default", async () => {
    process.env.XDG_CONFIG_HOME = HOME;
    await Bun.write(file(), JSON.stringify({ workerRoles: { scout: { provider: "codex", model: "" }, builder: { provider: "qwen", model: "" } } }));
    cfg.writeSeatSettings({}); // a no-op write, to drop the cached read
    expect(cfg.workerRoles().builder).toEqual({ provider: "qwen", model: "" });
    expect(cfg.workerRoles().scout).toEqual(scout.default);
  });
});

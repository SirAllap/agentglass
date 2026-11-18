/*
 * `prepareRun` used to empty the whole run folder, every file in it, no
 * matter who wrote it. Two things lived in that folder before `prepareRun`
 * ran: `mcp-config.json` and a staged `project-skills-plugin/`, both written
 * by `headlessTurn` while it builds the argv (agents/headless.ts,
 * `mcpConfigArg`/`stageProjectSkills`), at every real call site before
 * `prepareRun` (policystart.ts: startNow, resumeTurn, switchEngine). The CLI
 * saw no `mcp-config.json` and died at once. `prepareRun` now resets only its
 * own files (in, prompt, out, err, rc, part/, view.py); anything else in the
 * folder — the argv build's files, or a file the worker itself wrote — stays.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerRole } from "../../shared/workerRoles.ts";
import { headlessTurn, prepareRun, wrapped } from "../src/agents/headless.ts";

const scratch = mkdtempSync(join(tmpdir(), "agx-workerrun-reset-"));
const withStateDir = <T>(f: () => T): T => {
  const was = process.env.AGENTGLASS_STATE_DIR;
  process.env.AGENTGLASS_STATE_DIR = join(scratch, "state");
  try { return f(); } finally {
    if (was === undefined) delete process.env.AGENTGLASS_STATE_DIR;
    else process.env.AGENTGLASS_STATE_DIR = was;
  }
};
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const builder = workerRole("builder")!;
const NARROW = { write: "worktree" as const, network: false, commit: false, docker: false, deny: [] };

describe("prepareRun after the argv build (the real order at every call site)", () => {
  test("a chosen MCP server's mcp-config.json is still there when the CLI starts", () => {
    const project = mkdtempSync(join(scratch, "proj-"));
    const name = "w-mcp-order";
    const t = withStateDir(() => headlessTurn({
      engine: "claude", bin: "/x/claude", model: "sonnet", role: builder, envelope: NARROW,
      limits: { maxWorkers: 3, turnMinutes: 30, maxRetries: 1 }, prompt: "go",
      cwd: project, skillsRoot: project, runDir: join(scratch, "state", "worker-runs", name),
      mcpServers: [{ name: "atlassian", config: { type: "http", url: "https://mcp.example.test/v2/mcp" } }],
    }));
    if (!t.ok) throw new Error(t.error);
    const mcpArg = t.argv[t.argv.indexOf("--mcp-config") + 1]!;
    expect(existsSync(mcpArg)).toBe(true);
    // `prepareRun` runs AFTER the argv build at every real call site.
    withStateDir(() => prepareRun(name, "go", t.stdin));
    expect(existsSync(mcpArg)).toBe(true);
    expect(JSON.parse(readFileSync(mcpArg, "utf8")).mcpServers.atlassian).toBeDefined();
  });

  test("a turn with no chosen server removes the file an earlier turn wrote, token and all", () => {
    const project = mkdtempSync(join(scratch, "proj-"));
    const name = "w-mcp-stale";
    const runDir = join(scratch, "state", "worker-runs", name);
    const turn = (mcpServers: { name: string; config: Record<string, unknown> }[]) => withStateDir(() => headlessTurn({
      engine: "claude", bin: "/x/claude", model: "sonnet", role: builder, envelope: NARROW,
      limits: { maxWorkers: 3, turnMinutes: 30, maxRetries: 1 }, prompt: "go",
      cwd: project, skillsRoot: project, runDir, mcpServers,
    }));
    const first = turn([{ name: "orbit", config: { command: "orbit-mcp", env: { ORBIT_TOKEN: "t0ken" } } }]);
    if (!first.ok) throw new Error(first.error);
    expect(existsSync(join(runDir, "mcp-config.json"))).toBe(true);
    const second = turn([]);
    if (!second.ok) throw new Error(second.error);
    // The run dir is the worker's to read: turn 2 must not find turn 1's token.
    expect(existsSync(join(runDir, "mcp-config.json"))).toBe(false);
  });

  test("a staged project-skills-plugin directory is still there when the CLI starts", () => {
    const project = mkdtempSync(join(scratch, "proj-"));
    const skillsDir = join(project, ".claude", "skills", "demo");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "SKILL.md"), "---\nname: demo\ndescription: demo\n---\nbody");
    const name = "w-plugin-order";
    const t = withStateDir(() => headlessTurn({
      engine: "claude", bin: "/x/claude", model: "sonnet", role: builder, envelope: NARROW,
      limits: { maxWorkers: 3, turnMinutes: 30, maxRetries: 1 }, prompt: "go",
      cwd: project, skillsRoot: project, runDir: join(scratch, "state", "worker-runs", name),
    }));
    if (!t.ok) throw new Error(t.error);
    const pluginDir = t.argv[t.argv.indexOf("--plugin-dir") + 1]!;
    expect(existsSync(pluginDir)).toBe(true);
    withStateDir(() => prepareRun(name, "go", t.stdin));
    expect(existsSync(pluginDir)).toBe(true);
    expect(existsSync(join(pluginDir, "skills", "demo", "SKILL.md"))).toBe(true);
  });

  test("a file the worker wrote in turn 1 is still there when turn 2 resumes", () => {
    const name = "w-resume-keeps-file";
    const files = withStateDir(() => prepareRun(name, "turn 1", "none"));
    const leftByWorker = join(files.dir, "notes.md");
    writeFileSync(leftByWorker, "progress from turn 1");
    const files2 = withStateDir(() => prepareRun(name, "turn 2", "none"));
    expect(files2.dir).toBe(files.dir);
    expect(existsSync(leftByWorker)).toBe(true);
    expect(readFileSync(leftByWorker, "utf8")).toBe("progress from turn 1");
    // The wrapper's own files are still reset for the new turn.
    expect(readFileSync(files2.prompt, "utf8")).toBe("turn 2");
  });

  test("the CLI itself, started through wrapped(), finds mcp-config.json present", () => {
    const project = mkdtempSync(join(scratch, "proj-"));
    const name = "w-mcp-cli";
    const t = withStateDir(() => headlessTurn({
      engine: "claude", bin: "/x/claude", model: "sonnet", role: builder, envelope: NARROW,
      limits: { maxWorkers: 3, turnMinutes: 30, maxRetries: 1 }, prompt: "go",
      cwd: project, skillsRoot: project, runDir: join(scratch, "state", "worker-runs", name),
      mcpServers: [{ name: "atlassian", config: { type: "http", url: "https://mcp.example.test/v2/mcp" } }],
    }));
    if (!t.ok) throw new Error(t.error);
    const mcpArg = t.argv[t.argv.indexOf("--mcp-config") + 1]!;
    const files = withStateDir(() => prepareRun(name, "go", t.stdin));
    const stub = join(scratch, "stub-sees-config.sh");
    writeFileSync(stub, `#!/bin/sh\n[ -f "${mcpArg}" ] && echo found || echo missing\n`, { mode: 0o755 });
    chmodSync(stub, 0o755);
    const r = Bun.spawnSync({ cmd: wrapped(files, [stub], "claude") });
    expect(readFileSync(files.out, "utf8").trim()).toBe("found");
  });
});

/*
 * The run dir is a worker write root (AGX_TURN_WRITE_ROOTS). A turn 1 worker
 * can plant a symlink at the exact name a turn 2 argv build writes into. The
 * write must never follow it: the secret (an MCP server's env) must never
 * land wherever the link points, and the turn must still get a fresh, real,
 * 0600 file or directory of its own.
 */
describe("a symlink a worker planted at mcp-config.json or project-skills-plugin is never followed", () => {
  test("mcp-config.json: the symlink's target is untouched, the turn gets a fresh 0600 file", () => {
    const project = mkdtempSync(join(scratch, "proj-"));
    const name = "w-mcp-symlink";
    const runDir = join(scratch, "state", "worker-runs", name);
    mkdirSync(runDir, { recursive: true });
    const outside = join(scratch, "outside-secret.json");
    writeFileSync(outside, "untouched");
    symlinkSync(outside, join(runDir, "mcp-config.json"));

    const t = withStateDir(() => headlessTurn({
      engine: "claude", bin: "/x/claude", model: "sonnet", role: builder, envelope: NARROW,
      limits: { maxWorkers: 3, turnMinutes: 30, maxRetries: 1 }, prompt: "go",
      cwd: project, skillsRoot: project, runDir,
      mcpServers: [{ name: "atlassian", config: { type: "http", url: "https://mcp.example.test/v2/mcp", env: { TOKEN: "s3cr3t" } } }],
    }));
    if (!t.ok) throw new Error(t.error);

    // The secret never rode through the link to the outside file.
    expect(readFileSync(outside, "utf8")).toBe("untouched");
    const mcpArg = t.argv[t.argv.indexOf("--mcp-config") + 1]!;
    expect(mcpArg).toBe(join(runDir, "mcp-config.json"));
    const st = lstatSync(mcpArg);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(mcpArg, "utf8")).mcpServers.atlassian.env.TOKEN).toBe("s3cr3t");
  });

  test("project-skills-plugin: the symlink's target is untouched, the turn gets a fresh real directory", () => {
    const project = mkdtempSync(join(scratch, "proj-"));
    const skillsDir = join(project, ".claude", "skills", "demo");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "SKILL.md"), "---\nname: demo\ndescription: demo\n---\nbody");
    const name = "w-plugin-symlink";
    const runDir = join(scratch, "state", "worker-runs", name);
    mkdirSync(runDir, { recursive: true });
    const outside = mkdtempSync(join(scratch, "outside-plugin-"));
    writeFileSync(join(outside, "marker.txt"), "untouched");
    symlinkSync(outside, join(runDir, "project-skills-plugin"));

    const t = withStateDir(() => headlessTurn({
      engine: "claude", bin: "/x/claude", model: "sonnet", role: builder, envelope: NARROW,
      limits: { maxWorkers: 3, turnMinutes: 30, maxRetries: 1 }, prompt: "go",
      cwd: project, skillsRoot: project, runDir,
    }));
    if (!t.ok) throw new Error(t.error);

    // Staging never wrote into the link's target.
    expect(existsSync(join(outside, "skills"))).toBe(false);
    expect(readFileSync(join(outside, "marker.txt"), "utf8")).toBe("untouched");
    const pluginDir = t.argv[t.argv.indexOf("--plugin-dir") + 1]!;
    expect(pluginDir).toBe(join(runDir, "project-skills-plugin"));
    expect(lstatSync(pluginDir).isSymbolicLink()).toBe(false);
    expect(existsSync(join(pluginDir, "skills", "demo", "SKILL.md"))).toBe(true);
  });
});

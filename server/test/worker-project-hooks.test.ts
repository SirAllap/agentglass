/*
 * A project's own PreToolUse hooks (a guard on master, a prod-DB block) keep
 * firing for its workers. Claude Code runs them. An engine that cannot
 * (OpenCode, Codex) is refused a start in such a project, and the refusal
 * names the hook file.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookRefusal, projectHookFile } from "../src/agents/hooks.ts";
import { headlessTurn } from "../src/agents/headless.ts";
import { DEFAULT_WORKER_ENVELOPE } from "../../shared/orchestration.ts";
import { workerRole } from "../../shared/workerRoles.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-hooks-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const project = (name: string, settings?: unknown) => {
  const root = join(dir, name);
  mkdirSync(join(root, ".claude"), { recursive: true });
  if (settings !== undefined) writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify(settings));
  return root;
};
const guarded = project("orbit-guarded", { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard-master.sh" }] }] } });
const plain = project("orbit-plain", { permissions: { allow: [] } });
const empty = project("orbit-empty", { hooks: { PreToolUse: [] } });

describe("a project with its own PreToolUse hooks", () => {
  test("finds the file that declares them", () => {
    expect(projectHookFile([guarded])).toBe(join(guarded, ".claude", "settings.json"));
    expect(projectHookFile([plain])).toBeNull();
    expect(projectHookFile([empty])).toBeNull();
    expect(projectHookFile([undefined, join(dir, "no-such")])).toBeNull();
  });
  test("Claude Code runs them; OpenCode and Codex are refused, naming the file", () => {
    expect(hookRefusal("claude", [guarded])).toBeNull();
    for (const engine of ["opencode", "codex"]) {
      const why = hookRefusal(engine, [guarded])!;
      expect(why).toContain(join(guarded, ".claude", "settings.json"));
      expect(why).toContain("hooks");
      expect(hookRefusal(engine, [plain])).toBeNull();
    }
  });
  test("a start is refused before anything is built", () => {
    const spec = (engine: string, root: string) => ({
      engine, bin: "/usr/bin/x", model: "m", role: workerRole("builder")!, envelope: DEFAULT_WORKER_ENVELOPE,
      limits: { maxWorkers: 3, turnMinutes: 30, maxRetries: 1 }, prompt: "do x", cwd: root, runDir: join(root, ".run"), skillsRoot: root,
    }) as never;
    const t = headlessTurn(spec("opencode", guarded));
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.error).toContain("settings.json");
  });
});

describe("a Claude worker never runs without the project's PreToolUse hooks", () => {
  const withHook = (name: string, command: string, files: string[] = []) => {
    const root = project(name, { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] } });
    mkdirSync(join(root, ".claude", "hooks"), { recursive: true });
    for (const f of files) writeFileSync(join(root, f), "#!/bin/sh\n");
    return root;
  };
  const start = (root: string, over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => headlessTurn({
    engine: "claude", bin: "/usr/bin/claude", model: "m", role: workerRole("builder")!,
    envelope: { ...DEFAULT_WORKER_ENVELOPE, ...over },
    limits: { maxWorkers: 3, turnMinutes: 30, maxRetries: 1 }, prompt: "do x", cwd: root, runDir: join(root, ".run"), skillsRoot: root, unwalledEngines: true /* network on drops the sandbox; where bubblewrap cannot run (a container) the start would be refused, and this file is not about the wall */, ...extra,
  } as never);

  test("an inline command is refused: it names the hook, why, and what to change", () => {
    const t = start(withHook("orbit-inline", "npm run guard"));
    expect(t.ok).toBe(false);
    if (!t.ok) {
      expect(t.error).toContain("npm run guard");
      expect(t.error).toContain(".claude/hooks/");
    }
  });
  test("a hook file outside .claude is refused", () => {
    mkdirSync(join(dir, "orbit-outside", "scripts"), { recursive: true });
    const t = start(withHook("orbit-outside", "bash scripts/guard.sh", ["scripts/guard.sh"]));
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.error).toContain("scripts/guard.sh");
  });
  test("a hook file in .claude/hooks plus network on starts, the hook riding with it", () => {
    /* Network on (which gh needs) has no sandbox. Refusing there left a project
       with a guard no worker that could reach GitHub. */
    const root = withHook("orbit-net", "bash .claude/hooks/x.sh", [".claude/hooks/x.sh"]);
    const t = start(root, { network: true });
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.argv.join(" ")).toContain(".claude/hooks/x.sh");
  });
  test("a .claude/hooks/x.sh hook with a sandboxed turn starts", () => {
    const root = withHook("orbit-ok", "bash .claude/hooks/x.sh", [".claude/hooks/x.sh"]);
    expect(start(root).ok).toBe(true);
  });
  test("resume and next-engine are re-stamped through the same door", () => {
    const root = withHook("orbit-resume", "npm run guard");
    const t = start(root, {}, { resume: "11111111-1111-4111-8111-111111111111" });
    expect(t.ok).toBe(false);
  });
});

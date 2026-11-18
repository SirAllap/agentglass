/*
 * The seat's powers apply only to an engine that runs the person's hooks.
 * Claude Code does, so its worker is allowed `git push` (the base never rules
 * and the hooks stand guard). OpenCode and Codex run neither, so they keep the
 * old floor exactly, with the never rules compiled on top.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileEnvelope, deniedFor } from "../src/agents/envelope.ts";
import { canRun } from "../src/agents/can.ts";
import { oldFloorNote, runsPersonHooks } from "../src/agents/hooks.ts";
import { DEFAULT_WORKER_ENVELOPE } from "../../shared/orchestration.ts";
import { LEGACY_FLOOR, workerRole } from "../../shared/workerRoles.ts";

const env = DEFAULT_WORKER_ENVELOPE;
const role = workerRole("builder")!;
const dir = mkdtempSync(join(tmpdir(), "agx-floor-"));
const config = (c: ReturnType<typeof compileEnvelope>) => JSON.parse(Object.values((c as { env: Record<string, string> }).env).find((v) => v.includes('"permission"')) ?? "{}");

describe("which engines get the seat's powers", () => {
  test("only Claude Code runs the person's hooks", () => {
    expect(runsPersonHooks("claude")).toBe(true);
    for (const e of ["opencode", "codex", "gemini"]) expect(runsPersonHooks(e)).toBe(false);
  });
  test("a Claude worker may run git push; the floor holds only the small real set", () => {
    const denied = deniedFor(env, role);
    expect(denied).not.toContain("git push");
    const c = compileEnvelope("claude", role, env, "sonnet", dir);
    expect(c.ok).toBe(true);
    if (c.ok) expect(JSON.stringify(c.args)).not.toContain("git push");
  });
  test("an OpenCode worker on a default project is still denied git push, gh, curl, rm, ssh and kill", () => {
    const c = compileEnvelope("opencode", role, env, "m", dir);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const bash = config(c).permission.bash;
    for (const cmd of ["git push", "gh", "curl", "rm", "ssh", "kill", "sudo", "aws", "git worktree add"]) expect(bash[cmd], cmd).toBe("deny");
  });
  test("a command the project opened stays open on that engine; the rest of the old floor stays", () => {
    const c = compileEnvelope("opencode", role, env, "m", dir, [], [], undefined, ["rm"]);
    if (!c.ok) throw new Error(c.error);
    const bash = config(c).permission.bash;
    expect(bash.rm).toBeUndefined();
    expect(bash["git push"]).toBe("deny");
  });
  test("the old floor is the one main had", () => {
    expect(LEGACY_FLOOR).toContain("git push");
    expect(LEGACY_FLOOR).toContain("aws");
    expect(LEGACY_FLOOR).toHaveLength(33);
  });
  test("the start answer and can say why", () => {
    expect(oldFloorNote("claude")).toBeNull();
    expect(oldFloorNote("opencode")).toMatch(/does not run your hooks \(.*settings\.json\), so this worker keeps the old floor/);
    const r = canRun("git push origin orbit-1042", { envelope: env, engine: "opencode", rules: { decision: "allow" } });
    expect(r.answer).toBe("refused");
    expect(r.text).toContain("keeps the old floor");
    expect(canRun("git push origin orbit-1042", { envelope: env, engine: "claude", rules: { decision: "allow" } }).answer).toBe("allowed");
  });
});
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

/* `agentglass-agent can`: the answer names the layer, before the worker tries. */
import { describe, expect, test } from "bun:test";
import { canRun } from "../src/agents/can.ts";
import { DEFAULT_WORKER_ENVELOPE } from "../../shared/orchestration.ts";

const free = { decision: "unknown" as const };
const env = DEFAULT_WORKER_ENVELOPE;

describe("canRun", () => {
  test("a command the seat runs is allowed", () => {
    expect(canRun("git push origin orbit-1042", { envelope: env, rules: { decision: "allow" } }).answer).toBe("allowed");
    expect(canRun("gh pr list", { envelope: env, rules: free }).answer).toBe("allowed");
  });
  test("the floor names the floor", () => {
    const r = canRun("sudo ls", { envelope: env, rules: free });
    expect([r.answer, r.layer]).toEqual(["refused", "floor"]);
    expect(r.text).toContain("sudo");
  });
  test("a narrowed flag names the envelope", () => {
    const r = canRun("docker ps", { envelope: env, rules: free });
    expect([r.answer, r.layer]).toEqual(["refused", "envelope"]);
    expect(r.rule).toContain("docker is off");
    expect(canRun("git commit -m x", { envelope: { ...env, commit: false }, rules: free }).layer).toBe("envelope");
  });
  test("a closed project command names the setting", () => {
    expect(canRun("rm x", { envelope: env, closed: ["rm"], rules: free }).rule).toContain("workers.commands.rm");
  });
  test("a never rule refuses, an ask rule asks", () => {
    const n = canRun("git push origin main", { envelope: env, rules: { decision: "never", reason: "Bash(git push origin main:*)" } });
    expect([n.answer, n.layer]).toEqual(["refused", "rule"]);
    expect(n.text).toContain("agentglass-ui rules");
    expect(canRun("sudo-less thing", { envelope: env, rules: { decision: "ask" } }).answer).toBe("ask");
  });
});

describe("canRun follows the real lock", () => {
  test("a closed app door and the envelope's own deny are refused, never allowed", () => {
    const door = canRun("agentglass-ui rules list", { envelope: env, rules: free });
    expect([door.answer, door.layer]).toEqual(["refused", "envelope"]);
    expect(door.rule).toContain("agentglass-ui");
    expect(canRun("agentglass-ui rules list", { envelope: env, opened: ["agentglass-ui"], rules: free }).answer).toBe("allowed");
    const own = canRun("make deploy", { envelope: { ...env, deny: ["make deploy"] }, rules: free });
    expect([own.answer, own.layer]).toEqual(["refused", "envelope"]);
  });
});

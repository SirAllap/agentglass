/*
 * "Check a command" on the Permissions page asks POST /seat/can with no worker
 * named. Both that route and a named worker's check go through canAnswer, so
 * the page holds no second copy of the decision. Here canAnswer is pinned to
 * canRun at the project's default level, with a closed switch and an agent rule.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-seatcan-"));
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
process.env.XDG_CONFIG_HOME = dir;
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.HOME = dir;

const { canAnswer } = await import("../src/agents/canAnswer.ts");
const { canRun } = await import("../src/agents/can.ts");
const { check: rulesCheck } = await import("../src/agentRulesStore.ts");
const { DEFAULT_WORKER_ENVELOPE } = await import("../../shared/orchestration.ts");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("canAnswer (what POST /seat/can returns)", () => {
  for (const cmd of ["git status", "sudo ls", "git worktree add ../x", "curl https://example.com", "git commit -m thing"]) {
    test(`same as canRun at the default level: ${cmd}`, () => {
      const got = canAnswer(dir, cmd, { envelope: DEFAULT_WORKER_ENVELOPE });
      const want = canRun(cmd, { envelope: DEFAULT_WORKER_ENVELOPE, closed: [], opened: [], legacyOpen: [], rules: rulesCheck(dir, "Bash", { command: cmd }) });
      expect(got.answer).toBe(want.answer);
      expect((got as { layer?: string }).layer).toBe((want as { layer?: string }).layer);
    });
  }
  test("a floor command is refused by the floor, not allowed", () => {
    const got = canAnswer(dir, "sudo ls", { envelope: DEFAULT_WORKER_ENVELOPE });
    expect(got.answer).not.toBe("allowed");
  });
});

describe("defaultWorkerWho (no worker named)", () => {
  test("checks as the builder on its engine, so the engine floor refuses what a real worker is refused", async () => {
        const { defaultWorkerWho } = await import("../src/agents/policystart.ts");
    const who = defaultWorkerWho(dir, "opencode");
    expect(who.role).toBe("builder");
    expect(who.engine).toBe("opencode");
    const got = canAnswer(dir, "git stash", who);
    expect(got.answer).toBe("refused");
    expect(canAnswer(dir, "git stash", { envelope: who.envelope }).answer).not.toBe("refused");
  });
});

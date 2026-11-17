/*
 * "No Claude in workers" holds on a flight plan's Launch too: the engine
 * Launch asks before it cuts a tree is never Claude while the switch is on,
 * so the launch takes the policy path (which swaps or refuses) and never
 * opens a Claude builder tab.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-fp-noclaude-"));
const restore = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, AGENTGLASS_DB: process.env.AGENTGLASS_DB };
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.AGENTGLASS_DB = join(dir, "fp.db");

const { builderEngineFor } = await import("../src/agents/policystart.ts");
const { putSetting } = await import("../src/preflightStore.ts");

afterAll(() => {
  for (const [k, v] of Object.entries(restore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

describe("flight plan Launch and No Claude in workers", () => {
  const root = join(dir, "orbit");
  mkdirSync(root, { recursive: true });

  test("off: the default builder chain launches on Claude", () => {
    expect(builderEngineFor(root)).toBe("claude");
  });

  test("on: Launch never asks for Claude", () => {
    putSetting(root, "workers.noClaude", true);
    const engine = builderEngineFor(root);
    expect(engine).not.toBeNull();
    expect(engine).not.toBe("claude");
  });
});

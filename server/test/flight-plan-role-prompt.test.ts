/*
 * The Builder role's prompt, set in the flow editor, opens the launch text.
 * A role that reaches no worker was a setting that did nothing.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plan } from "../src/flightPlanStore.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-fp-role-"));
const restore = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, AGENTGLASS_DB: process.env.AGENTGLASS_DB };
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.AGENTGLASS_DB = join(dir, "role.db");

const { launchPrompt, reportingBlock } = await import("../src/flightPlan.ts");
const { writeStoredFlow } = await import("../src/config.ts");
const { templateFlow } = await import("../../shared/flowTemplates.ts");
const { FLOW_PROMPT_MAX } = await import("../../shared/flow.ts");

afterAll(() => {
  for (const [k, v] of Object.entries(restore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

const plan = (root: string) => ({ id: "fp_0123456789abcdef", root, title: "Cap webhooks", request: "r", planMd: "# p", visual: false, mockups: [] }) as unknown as Plan;
const saveWith = (root: string, prompt: string) => {
  const f = templateFlow();
  f.roster = f.roster.map((r) => (r.policyRole === "builder" ? { ...r, prompt } : r));
  expect(writeStoredFlow(root, f).ok).toBe(true);
};
const shipped = templateFlow().roster.find((r) => r.policyRole === "builder")!.prompt!;

describe("launchPrompt opens with the Builder role prompt", () => {
  test("custom prompt leads and the reporting block still ends the text", () => {
    saveWith("/home/a/orbit-1", "  You are the Orbit builder. Small diffs.  ");
    const t = launchPrompt(plan("/home/a/orbit-1"), "orchestrator-orbit");
    expect(t.startsWith("You are the Orbit builder. Small diffs.\n\n")).toBe(true);
    expect(t.endsWith(reportingBlock("orchestrator-orbit"))).toBe(true);
    expect(t).toContain("Cap webhooks");
  });
  test("a saved flow with no Builder role falls back to the shipped Builder prompt", () => {
    // The flow validator refuses an empty prompt, so "no Builder prompt" reaches launch as a flow without that role.
    const f = templateFlow();
    f.roster = f.roster.filter((r) => r.policyRole !== "builder");
    f.path = f.path.filter((id) => id !== "builder");
    f.blocks = f.blocks.filter((b) => b.id !== "builder");
    f.edges = f.edges.filter((e) => e.from !== "builder" && e.to !== "builder");
    expect(writeStoredFlow("/home/a/orbit-2", f).ok).toBe(true);
    const t = launchPrompt(plan("/home/a/orbit-2"), null);
    expect(t.startsWith(`${shipped}\n\n`)).toBe(true);
  });
  test("a prompt at the flow limit goes in whole (the validator refuses longer, so the slice is only a guard)", () => {
    saveWith("/home/a/orbit-3", "x".repeat(FLOW_PROMPT_MAX));
    const t = launchPrompt(plan("/home/a/orbit-3"), null);
    expect(t.startsWith("x".repeat(FLOW_PROMPT_MAX) + "\n\n")).toBe(true);
  });
  test("no saved flow leaves the text as it was", () => {
    const t = launchPrompt(plan("/home/a/orbit-none"), null);
    expect(t).not.toContain("You are the Builder");
    expect(t.startsWith("# ") || !t.startsWith("You are")).toBe(true);
  });
});

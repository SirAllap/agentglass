/*
 * Preflight's reviewer takes the flow's Inspector prompt as house rules, ahead
 * of the fixed output format, so a project's words cannot move the format.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-pf-house-"));
const restore = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
process.env.XDG_CONFIG_HOME = join(dir, "config");

const { runPreflight } = await import("../src/preflight.ts");
const { writeStoredFlow } = await import("../src/config.ts");
const { templateFlow } = await import("../../shared/flowTemplates.ts");

const STUB = new URL("./preflightStub.ts", import.meta.url).pathname;
afterAll(() => {
  for (const [k, v] of Object.entries(restore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

const promptFor = async (root: string) => {
  const rec = join(dir, `rec-${Math.random().toString(36).slice(2)}.json`);
  await runPreflight({ files: [], root, model: "sonnet", budgetUsd: 0.5 }, { bin: [process.execPath, STUB], env: { STUB_RECORD: rec } });
  const argv = (JSON.parse(readFileSync(rec, "utf8")) as { argv: string[] }).argv;
  return argv.find((a) => a.includes("Use exactly this format"))!;
};
const mk = (name: string) => { const r = join(dir, name); mkdirSync(r, { recursive: true }); writeFileSync(join(r, "a.md"), "x"); return r; };

describe("Preflight house rules", () => {
  test("a saved Inspector prompt appears before the output format, which stays last", async () => {
    const root = mk("orbit-1");
    const f = templateFlow();
    f.roster = f.roster.map((r) => (r.policyRole === "reviewer" ? { ...r, prompt: "Orbit rule: cite the line." } : r));
    expect(writeStoredFlow(root, f).ok).toBe(true);
    const p = await promptFor(root);
    const at = p.indexOf("House rules for this reviewer:\nOrbit rule: cite the line.");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(p.indexOf("Use exactly this format"));
    expect(p.trimEnd().endsWith("No praise, no summary, no advice beyond the problem.")).toBe(true);
  });

  test("no saved flow: the prompt carries no house block", async () => {
    const p = await promptFor(mk("orbit-2"));
    expect(p).not.toContain("House rules for this reviewer:");
    expect(p).toContain("Report only problems a person about to act on this material would regret not hearing:\n");
  });
});

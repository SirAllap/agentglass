/*
 * A flow role's `mayStartSubagents`: lets its worker call the Agent tool, so a
 * team skill that spawns reviewer subagents (/adversarial-review) can run.
 * Off by default (server/test/flow-role-lock.test.ts covers the lock and the
 * Claude allow/deny lists); here: the validator, the brief's own note when the
 * switch is off, and the escalation card an agent's own flow write waits on.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-subagents-"));
const restore = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, AGENTGLASS_DB: process.env.AGENTGLASS_DB };
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.AGENTGLASS_DB = join(dir, "subagents.db");

const { withSubagentsNote, SUBAGENTS_OFF_NOTE } = await import("../src/rolePrompt.ts");
const { writeStoredFlow } = await import("../src/config.ts");
const { templateFlow } = await import("../../shared/flowTemplates.ts");
const { validateFlow } = await import("../../shared/flow.ts");

afterAll(() => {
  for (const [k, v] of Object.entries(restore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

const saveWith = (root: string, role: string, mayStartSubagents: boolean | undefined) => {
  const f = templateFlow();
  f.roster = f.roster.map((r) => (r.policyRole === role ? { ...r, mayStartSubagents } : r)) as typeof f.roster;
  expect(writeStoredFlow(root, f).ok).toBe(true);
};

describe("the flow validator takes mayStartSubagents", () => {
  test("true round-trips through validateFlow", () => {
    const f = templateFlow();
    f.roster = f.roster.map((r) => (r.policyRole === "builder" ? { ...r, mayStartSubagents: true } : r)) as typeof f.roster;
    const checked = validateFlow(f);
    expect(checked.ok).toBe(true);
    expect(checked.ok && checked.value.roster.find((r) => r.policyRole === "builder")?.mayStartSubagents).toBe(true);
  });
  test("left out: the role has none, as before", () => {
    const f = templateFlow();
    const checked = validateFlow(f);
    expect(checked.ok).toBe(true);
    expect(checked.ok && checked.value.roster.find((r) => r.policyRole === "builder")?.mayStartSubagents).toBeUndefined();
  });
  test("false is dropped rather than stored: left out means off either way", () => {
    const f = templateFlow();
    f.roster = f.roster.map((r) => (r.policyRole === "builder" ? { ...r, mayStartSubagents: false } : r)) as typeof f.roster;
    const checked = validateFlow(f);
    expect(checked.ok).toBe(true);
    expect(checked.ok && checked.value.roster.find((r) => r.policyRole === "builder")?.mayStartSubagents).toBeUndefined();
  });
  test("not a boolean is refused", () => {
    const f = templateFlow();
    f.roster = f.roster.map((r) => (r.policyRole === "builder" ? { ...r, mayStartSubagents: "yes" as unknown as boolean } : r)) as typeof f.roster;
    expect(validateFlow(f).ok).toBe(false);
  });
});

describe("withSubagentsNote", () => {
  test("off: the brief says so and names the switch", () => {
    saveWith("/home/a/orbit-sub-1", "builder", undefined);
    const out = withSubagentsNote("Do the thing.", "/home/a/orbit-sub-1", "builder");
    expect(out).toBe(`Do the thing.\n\n${SUBAGENTS_OFF_NOTE}`);
  });
  test("on: nothing is appended", () => {
    saveWith("/home/a/orbit-sub-2", "builder", true);
    expect(withSubagentsNote("Do the thing.", "/home/a/orbit-sub-2", "builder")).toBe("Do the thing.");
  });
  test("not a flow role (plain built-in start, no saved flow): nothing is appended", () => {
    expect(withSubagentsNote("Do the thing.", "/home/a/orbit-sub-none", "builder")).toBe("Do the thing.");
  });
  test("idempotent: applying it again on its own output changes nothing", () => {
    saveWith("/home/a/orbit-sub-3", "builder", undefined);
    const once = withSubagentsNote("Do the thing.", "/home/a/orbit-sub-3", "builder");
    const twice = withSubagentsNote(once, "/home/a/orbit-sub-3", "builder");
    expect(twice).toBe(once);
  });
});

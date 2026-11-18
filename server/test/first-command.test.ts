/*
 * A flow role's `firstCommand`: sent as a Claude turn's own first line, so
 * Claude Code runs it itself instead of leaving it to the model to notice in
 * prose. Measured 2026-11-05: a planner's prompt SAID to run a skill and the
 * model skipped it twice.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-first-command-"));
const restore = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, AGENTGLASS_DB: process.env.AGENTGLASS_DB };
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.AGENTGLASS_DB = join(dir, "first-command.db");

const { firstCommandFor, withFirstCommand } = await import("../src/rolePrompt.ts");
const { writeStoredFlow } = await import("../src/config.ts");
const { templateFlow } = await import("../../shared/flowTemplates.ts");
const { validateFlow, FLOW_FIRST_COMMAND_MAX } = await import("../../shared/flow.ts");

afterAll(() => {
  for (const [k, v] of Object.entries(restore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

const saveWith = (root: string, role: string, firstCommand: string | undefined) => {
  const f = templateFlow();
  f.roster = f.roster.map((r) => (r.policyRole === role ? { ...r, firstCommand } : r)) as typeof f.roster;
  expect(writeStoredFlow(root, f).ok).toBe(true);
};

describe("firstCommandFor", () => {
  test("a role with one: the saved command, {card} untouched", () => {
    saveWith("/home/a/orbit-fc-1", "builder", "/jira-fix-card {card}");
    expect(firstCommandFor("/home/a/orbit-fc-1", "builder")).toBe("/jira-fix-card {card}");
  });
  test("a role with none: empty", () => {
    saveWith("/home/a/orbit-fc-2", "builder", undefined);
    expect(firstCommandFor("/home/a/orbit-fc-2", "builder")).toBe("");
  });
  test("no saved flow: empty", () => {
    expect(firstCommandFor("/home/a/orbit-fc-none", "builder")).toBe("");
  });
});

describe("withFirstCommand", () => {
  test("the composed message starts with the expanded command, a blank line, then the rest", () => {
    saveWith("/home/a/orbit-fc-3", "builder", "/jira-fix-card {card}");
    const out = withFirstCommand("Do the thing.", "/home/a/orbit-fc-3", "builder", "claude", "ORBIT-1042");
    expect(out.startsWith("/jira-fix-card ORBIT-1042\n")).toBe(true);
    expect(out).toBe("/jira-fix-card ORBIT-1042\n\nDo the thing.");
  });
  test("a role without firstCommand composes exactly as today: unchanged", () => {
    saveWith("/home/a/orbit-fc-4", "builder", undefined);
    expect(withFirstCommand("Do the thing.", "/home/a/orbit-fc-4", "builder", "claude", "ORBIT-1042")).toBe("Do the thing.");
  });
  test("no card: {card} becomes the --prompt text itself", () => {
    saveWith("/home/a/orbit-fc-5", "builder", "/jira-fix-card {card}");
    const out = withFirstCommand("fix the login bug", "/home/a/orbit-fc-5", "builder", "claude", "fix the login bug");
    expect(out).toBe("/jira-fix-card fix the login bug\n\nfix the login bug");
  });
  test("a second turn does not repeat it: applying it again on its own output changes nothing", () => {
    saveWith("/home/a/orbit-fc-6", "builder", "/jira-fix-card {card}");
    const once = withFirstCommand("Do the thing.", "/home/a/orbit-fc-6", "builder", "claude", "ORBIT-1042");
    const twice = withFirstCommand(once, "/home/a/orbit-fc-6", "builder", "claude", "ORBIT-1042");
    expect(twice).toBe(once);
  });
  test("only Claude: another engine gets the prompt unchanged, nothing breaks", () => {
    saveWith("/home/a/orbit-fc-7", "builder", "/jira-fix-card {card}");
    expect(withFirstCommand("Do the thing.", "/home/a/orbit-fc-7", "builder", "opencode", "ORBIT-1042")).toBe("Do the thing.");
  });
});

describe("the flow validator takes firstCommand", () => {
  test("a role's firstCommand round-trips through validateFlow", () => {
    const f = templateFlow();
    f.roster = f.roster.map((r) => (r.policyRole === "builder" ? { ...r, firstCommand: "/jira-fix-card {card}" } : r)) as typeof f.roster;
    const checked = validateFlow(f);
    expect(checked.ok).toBe(true);
    expect(checked.ok && checked.value.roster.find((r) => r.policyRole === "builder")?.firstCommand).toBe("/jira-fix-card {card}");
  });
  test("left out: the role has none, as before", () => {
    const f = templateFlow();
    const checked = validateFlow(f);
    expect(checked.ok).toBe(true);
    expect(checked.ok && checked.value.roster.find((r) => r.policyRole === "builder")?.firstCommand).toBeUndefined();
  });
  test("too long is refused", () => {
    const f = templateFlow();
    f.roster = f.roster.map((r) => (r.policyRole === "builder" ? { ...r, firstCommand: "x".repeat(FLOW_FIRST_COMMAND_MAX + 1) } : r)) as typeof f.roster;
    const checked = validateFlow(f);
    expect(checked.ok).toBe(false);
  });
});

describe("both start paths compose it the same way", () => {
  test("policystart and the plain start wrap the composed brief in withFirstCommand", async () => {
    const ps = await Bun.file(join(import.meta.dir, "../src/agents/policystart.ts")).text();
    const ix = await Bun.file(join(import.meta.dir, "../src/index.ts")).text();
    // withNoBaseNote wraps outermost (policystart.ts); withFirstCommand(withDepsLine(
    // is the next layer in, same as the plain start below.
    expect(ps).toContain("const prompt = withNoBaseNote(withBrowserCliNote(withFirstCommand(withDepsLine(");
    expect(ix).toContain("? withFirstCommand(withDepsLine(withBrowserLine(withRolePrompt(brief, rolePromptFor(policyRoot, role.id))");
    // A role switch is not a fresh start: the resumed turn does not get it.
    expect(ps).not.toContain("withFirstCommand(withRole");
  });
});

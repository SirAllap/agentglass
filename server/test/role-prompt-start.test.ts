/*
 * A worker started with a built-in role opens with that role's prompt from the
 * saved flow. A project with no saved flow starts as it did.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-role-start-"));
const restore = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, AGENTGLASS_DB: process.env.AGENTGLASS_DB };
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.AGENTGLASS_DB = join(dir, "role.db");

const { RESULT_CONTRACT, roleOwesResult, rolePromptFor, withResultContract, withRolePrompt } = await import("../src/rolePrompt.ts");
const { writeStoredFlow } = await import("../src/config.ts");
const { templateFlow } = await import("../../shared/flowTemplates.ts");

afterAll(() => {
  for (const [k, v] of Object.entries(restore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

const saveWith = (root: string, role: string, prompt: string) => {
  const f = templateFlow();
  f.roster = f.roster.map((r) => (r.policyRole === role ? { ...r, prompt } : r));
  expect(writeStoredFlow(root, f).ok).toBe(true);
};

describe("rolePromptFor", () => {
  test("reviewer with a saved flow prompt: the brief starts with it", () => {
    saveWith("/home/a/orbit-r", "reviewer", "  You are the Orbit inspector.  ");
    const rp = rolePromptFor("/home/a/orbit-r", "reviewer");
    expect(rp).toBe("You are the Orbit inspector.");
    expect(withRolePrompt("Review PR 12.", rp).startsWith("You are the Orbit inspector.\n\nReview PR 12.")).toBe(true);
  });
  test("every built-in role reads its own prompt", () => {
    saveWith("/home/a/orbit-all", "scout", "S-prompt");
    expect(rolePromptFor("/home/a/orbit-all", "scout")).toBe("S-prompt");
    expect(rolePromptFor("/home/a/orbit-all", "verifier")).not.toBe("");
    expect(rolePromptFor("/home/a/orbit-all", "verifier")).not.toBe("S-prompt");
  });
  test("no saved flow: nothing, the brief is unchanged", () => {
    const rp = rolePromptFor("/home/a/orbit-none", "reviewer");
    expect(rp).toBe("");
    expect(withRolePrompt("Review PR 12.", rp)).toBe("Review PR 12.");
  });
  test("not a built-in role: nothing", () => {
    saveWith("/home/a/orbit-c", "reviewer", "x");
    expect(rolePromptFor("/home/a/orbit-c", "custom-role")).toBe("");
    expect(rolePromptFor("/home/a/orbit-c", undefined)).toBe("");
  });
});

describe("withRolePrompt", () => {
  test("seat text is kept after the role prompt", () => {
    expect(withRolePrompt("Do the thing.", "ROLE")).toBe("ROLE\n\nDo the thing.");
  });
  test("an empty seat text gives the role prompt alone", () => {
    expect(withRolePrompt("", "ROLE")).toBe("ROLE");
  });
  test("a seat that already pasted the role prompt is not duplicated", () => {
    const t = "  ROLE\n\nDo the thing.";
    expect(withRolePrompt(t, "ROLE")).toBe(t);
  });
});

describe("the result contract", () => {
  test("a builder, a reviewer and a verifier are told the last message is the result", () => {
    for (const r of ["builder", "reviewer", "verifier"]) {
      expect(withResultContract("Do the thing.", "/home/a/orbit-none", r)).toBe(`Do the thing.\n\n${RESULT_CONTRACT}`);
    }
  });
  test("a scout owes none: finding is the answer", () => {
    expect(withResultContract("Do the thing.", "/home/a/orbit-none", "scout")).toBe("Do the thing.");
  });
  test("a retried turn hands the same text, and it is not said twice", () => {
    const once = withResultContract("Do the thing.", "/home/a/orbit-none", "builder");
    expect(withResultContract(once, "/home/a/orbit-none", "builder")).toBe(once);
  });
  test("a flow role that runs as a reviewer owes one too", () => {
    expect(writeStoredFlow("/home/a/orbit-inspector", templateFlow()).ok).toBe(true);
    expect(roleOwesResult("/home/a/orbit-inspector", "inspector")).toBe(true);
    expect(roleOwesResult("/home/a/orbit-inspector", "docs")).toBe(false);
  });
});

describe("both start paths use it", () => {
  const fn = (src: string, at: string) => src.slice(src.indexOf(at), src.indexOf(at) + 6000);
  test("policystart and the plain start build the brief through withRolePrompt", async () => {
    const ps = await Bun.file(join(import.meta.dir, "../src/agents/policystart.ts")).text();
    const ix = await Bun.file(join(import.meta.dir, "../src/index.ts")).text();
    expect(fn(ps, "async function startNow(")).toContain("withRolePrompt(p.prompt, rolePromptFor(p.policyRoot, plan.role.id))");
    expect(ix).toContain("withRolePrompt(asked, rolePromptFor(policyRoot, role.id))");
  });
});

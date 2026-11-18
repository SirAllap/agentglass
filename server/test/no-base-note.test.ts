/*
 * A custom flow role with no `policyRole` has no `base`, so
 * `DOORS_FOR_ROLE[role.base ?? role.id]` (agents/envelope.ts) never matches
 * and its worker gets no browser — silently. `noBaseNoteFor`/`withNoBaseNote`
 * say so in the brief; `custom-flow-role-start.test.ts` covers the start
 * answer carrying the same note (`result.noBase`).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-no-base-"));
const restore = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, AGENTGLASS_DB: process.env.AGENTGLASS_DB };
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.AGENTGLASS_DB = join(dir, "no-base.db");

const { noBaseNoteFor, withNoBaseNote } = await import("../src/rolePrompt.ts");
const { writeStoredFlow } = await import("../src/config.ts");
const { templateFlow } = await import("../../shared/flowTemplates.ts");

afterAll(() => {
  for (const [k, v] of Object.entries(restore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

function saveDevops(root: string, patch: Record<string, unknown> = {}) {
  const f = templateFlow();
  const base = f.roster[0]!;
  f.roster = [...f.roster, { ...base, id: "devops", name: "DevOps", does: "Checks ports", prompt: "check ports", policyRole: undefined, chain: [{ engine: "codex", model: "" }], tools: [], readsOnly: true, required: false, ...patch }] as typeof f.roster;
  expect(writeStoredFlow(root, f).ok).toBe(true);
}

describe("noBaseNoteFor", () => {
  test("a custom role with no policyRole gets the note", () => {
    const root = "/home/a/no-base-1";
    saveDevops(root);
    expect(noBaseNoteFor(root, "devops")).toContain("no base role: no browser");
  });
  test("a custom role that names a base gets none", () => {
    const root = "/home/a/no-base-2";
    saveDevops(root, { policyRole: "builder", chain: [] });
    expect(noBaseNoteFor(root, "devops")).toBeNull();
  });
  test("a person's step gets none: nothing runs there", () => {
    const root = "/home/a/no-base-3";
    saveDevops(root, { actor: "person", chain: [] });
    expect(noBaseNoteFor(root, "devops")).toBeNull();
  });
  test("a built-in role id gets none", () => {
    const root = "/home/a/no-base-4";
    saveDevops(root);
    expect(noBaseNoteFor(root, "builder")).toBeNull();
  });
  test("an unknown id gets none", () => {
    const root = "/home/a/no-base-5";
    saveDevops(root);
    expect(noBaseNoteFor(root, "ghost")).toBeNull();
  });
});

describe("withNoBaseNote", () => {
  test("prepends the note to a custom role's brief, once", () => {
    const root = "/home/a/no-base-6";
    saveDevops(root);
    const once = withNoBaseNote("check the ports", root, "devops");
    expect(once.startsWith('"DevOps" has no base role: no browser.')).toBe(true);
    expect(once.endsWith("check the ports")).toBe(true);
    expect(withNoBaseNote(once, root, "devops")).toBe(once);
  });
  test("leaves a based custom role's brief untouched", () => {
    const root = "/home/a/no-base-7";
    saveDevops(root, { policyRole: "builder", chain: [] });
    expect(withNoBaseNote("check the ports", root, "devops")).toBe("check the ports");
  });
});

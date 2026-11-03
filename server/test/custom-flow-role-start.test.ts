/*
 * A role added in the flow editor (not one of the four built-in ids) can be
 * started: its id resolves to a synthetic worker role with the flow's prompt,
 * its own engine chain, and a lock that only narrows.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-custom-role-"));
const restore = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, AGENTGLASS_DB: process.env.AGENTGLASS_DB };
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.AGENTGLASS_DB = join(dir, "custom.db");

const { flowRoleFor, roleLockFor, rolePromptFor, unknownRoleError } = await import("../src/rolePrompt.ts");
const { writeStoredFlow } = await import("../src/config.ts");
const { templateFlow } = await import("../../shared/flowTemplates.ts");
const { roleFor } = await import("../src/agents/policystart.ts");
const { planWorker, nextEngine } = await import("../src/agents/workerstart.ts");
const { compileEnvelope, narrowEnvelope } = await import("../src/agents/envelope.ts");
const { composePolicy, defaultStored } = await import("../../shared/orchestration.ts");
const { agentProvider } = await import("../../shared/agentKinds.ts");
const { renderFlowForOrchestrator } = await import("../src/flow.ts");
const { withBrowserLine } = await import("../src/browseraccess.ts");
type Readiness = import("../../shared/types.ts").EngineReadiness;

afterAll(() => {
  for (const [k, v] of Object.entries(restore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

const ready = (id: string, ok = true): Readiness => ({
  id, title: agentProvider(id)?.title ?? id, found: true, path: `/x/${id}`, version: "1", min: null, versionOk: true,
  account: { signedIn: true }, answers: { state: "never" },
  roles: { worker: ok ? { ok } : { ok, why: "nope" }, orchestrator: { ok: false } }, missing: [], envelope: { via: null, enforced: "yes", note: "" },
});
const FLEET = [ready("claude"), ready("opencode"), ready("codex", false)];
const policy = composePolicy(defaultStored(), {
  orchestrator: { engine: "claude", model: "opus" },
  workers: { scout: { engine: "claude", model: "haiku" }, builder: { engine: "claude", model: "sonnet" }, reviewer: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
});
const view = { policy, scope: "global" as const };
const none = { on: () => false };

/** The template flow plus a custom `devops` role; `extra` tweaks it. */
function save(root: string, extra: Record<string, unknown> = {}, more: Record<string, unknown>[] = []) {
  const f = templateFlow();
  const base = f.roster[0]!;
  f.roster = [...f.roster,
    { ...base, id: "devops", name: "DevOps", does: "Checks ports", prompt: "check ports", policyRole: undefined, chain: [{ engine: "codex", model: "" }, { engine: "opencode", model: "orbit-1" }], tools: [], readsOnly: true, required: false, ...extra },
    ...more.map((m) => ({ ...base, policyRole: undefined, chain: [], tools: [], readsOnly: false, required: false, ...m })),
  ] as typeof f.roster;
  const w = writeStoredFlow(root, f);
  expect(w.ok).toBe(true);
}

describe("flowRoleFor / roleFor", () => {
  test("a saved custom role is found, with its own chain and readOnly", () => {
    save("/home/a/orbit-1");
    const r = roleFor("/home/a/orbit-1", "devops")!;
    expect(r).toMatchObject({ id: "devops", readOnly: true });
    expect(flowRoleFor("/home/a/orbit-1", "devops")?.chain.map((c) => c.engine)).toEqual(["codex", "opencode"]);
  });
  test("a built-in id is never custom; unknown and no-flow are null", () => {
    save("/home/a/orbit-2");
    expect(flowRoleFor("/home/a/orbit-2", "builder")).toBeNull();
    expect(roleFor("/home/a/orbit-2", "builder")?.id).toBe("builder");
    expect(roleFor("/home/a/orbit-2", "janitor")).toBeNull();
    expect(roleFor("/home/a/orbit-none", "devops")).toBeNull();
  });
  test("a custom `qa` with policyRole reviewer does not change what the built-in reviewer resolves to", () => {
    const root = "/home/a/orbit-3";
    save(root, {}, [{ id: "qa", name: "QA", prompt: "QA PROMPT", policyRole: "reviewer", readsOnly: false }]);
    expect(rolePromptFor(root, "reviewer")).not.toContain("QA PROMPT");
    expect(roleLockFor(root, "reviewer")?.readsOnly).toBe(true);
    expect(rolePromptFor(root, "qa")).toBe("QA PROMPT");
    // qa is custom, its chain comes from the policy slot of its policyRole
    expect(flowRoleFor(root, "qa")?.policyRole).toBe("reviewer");
  });
});

describe("prompt, lock and unknown-id sentence", () => {
  test("the custom role's prompt and lock come from the flow", () => {
    save("/home/a/orbit-4");
    expect(rolePromptFor("/home/a/orbit-4", "devops")).toBe("check ports");
    expect(roleLockFor("/home/a/orbit-4", "devops")).toEqual({ readsOnly: true, tools: [], allow: [] });
  });
  test("no saved flow: the old sentence, nothing appended", () => {
    expect(unknownRoleError("/home/a/orbit-none")).toBe("no such role");
  });
  test("saved flow: same prefix, the custom ids listed, built-ins not", () => {
    save("/home/a/orbit-5");
    const e = unknownRoleError("/home/a/orbit-5");
    expect(e.startsWith("no such role")).toBe(true);
    expect(e).toContain("devops");
    expect(e).not.toContain("builder");
  });
});

describe("planWorker with a custom role", () => {
  const root = "/home/a/orbit-6";
  save(root);
  const custom = () => ({ role: roleFor(root, "devops")!, chain: flowRoleFor(root, "devops")!.chain });

  test("first ready entry of its own chain wins (codex is not ready, so opencode)", () => {
    const r = planWorker({ role: "devops" }, view, none, FLEET, null, custom());
    expect(r.ok && r.choice.engine).toBe("opencode");
    expect(r.ok && r.startedBy).toMatchObject({ role: "devops", engine: "opencode", headless: true });
  });
  test("no engine ready -> the named refusal", () => {
    const r = planWorker({ role: "devops" }, view, none, [ready("codex", false)], null, custom());
    expect(!r.ok && r.error).toBe('no engine ready for role "devops"');
  });
  test("an empty chain -> the same refusal", () => {
    const r = planWorker({ role: "devops" }, view, none, FLEET, null, { role: roleFor(root, "devops")!, chain: [] });
    expect(!r.ok && r.error).toBe('no engine ready for role "devops"');
  });
  test("write is denied: the narrowed envelope's Claude lock lists Write, Edit and NotebookEdit", () => {
    const r = planWorker({ role: "devops" }, view, none, FLEET, null, custom());
    if (!r.ok) throw new Error(r.error);
    const env = narrowEnvelope(r.envelope, roleLockFor(root, "devops"));
    expect(env.write).toBe("none");
    const c = compileEnvelope("claude", r.role, env, "sonnet", dir);
    if (!c.ok) throw new Error(c.error);
    const deny = (JSON.parse(c.args[1]!) as { permissions: { deny: string[] } }).permissions.deny;
    for (const w of ["Write", "Edit", "NotebookEdit"]) expect(deny).toContain(w);
  });
  test("a custom role is never wider than the base envelope: readsOnly:false keeps it, nothing widens", () => {
    const wide = planWorker({ role: "x" }, view, none, FLEET, null, { role: { ...roleFor(root, "devops")!, readOnly: false }, chain: [{ engine: "claude", model: "sonnet" }] });
    expect(wide.ok && wide.envelope).toEqual(policy.workerDefault);
  });
  test("a built-in path is byte for byte what it was (no custom argument)", () => {
    const r = planWorker({ role: "builder" }, view, none, FLEET, null);
    expect(r.ok && r.startedBy).toMatchObject({ rule: "base", role: "builder", engine: "claude" });
    expect(planWorker({ role: "janitor" }, view, none, FLEET, null)).toEqual({ ok: false, error: "no such role" });
  });
});

describe("engine switch for a custom worker does not throw", () => {
  test("nextEngine over the role's own chain moves on, and says so when nothing is left", () => {
    const chain = [{ engine: "codex", model: "" }, { engine: "opencode", model: "orbit-1" }];
    const n = nextEngine({ chain, by: { engine: "codex", model: "" }, ask: false, usable: (c) => c.engine === "opencode" });
    expect(n.ok && n.choice.engine).toBe("opencode");
    const end = nextEngine({ chain, by: { engine: "opencode", model: "orbit-1" }, ask: false, usable: () => true });
    expect(end.ok).toBe(false);
  });
  test("a role deleted from the flow is gone: roleFor is null (resume and switch refuse on it)", () => {
    expect(roleFor("/home/a/orbit-deleted", "devops")).toBeNull();
  });
});

describe("browser and seat brief", () => {
  /** The template's roster cut to its built-in ids, plus `n` custom roles (the template itself ships more than eight). */
  const briefWith = (n: number) => {
    const f = templateFlow();
    const base = f.roster[0]!;
    f.roster = [...f.roster.filter((r) => ["scout", "builder", "reviewer", "verifier"].includes(r.id)),
      ...Array.from({ length: n }, (_, i) => ({ ...base, id: `c${i}`, name: `C${i}`, policyRole: undefined })),
    ];
    return renderFlowForOrchestrator(f);
  };
  test("a custom id gets no browser line", () => {
    expect(withBrowserLine("brief", "claude", "devops")).toBe("brief");
  });
  test("one start line per custom role; none when only built-ins", () => {
    expect(briefWith(0)).not.toContain("agentglass-agent start --role");
    const b = briefWith(2);
    expect(b).toContain("C0: agentglass-agent start --role c0");
    expect(b).toContain("C1: agentglass-agent start --role c1");
    expect(b.indexOf("start --role c0")).toBeGreaterThan(b.indexOf("A worker you start with --role"));
  });
  test("over eight custom roles one start line with every id replaces the per-role lines; eight keep theirs", () => {
    expect(briefWith(9)).toContain("agentglass-agent start --role <id>");
    expect(briefWith(9)).toContain("c8");
    expect(briefWith(9)).not.toContain(": agentglass-agent start --role c0");
    expect(briefWith(8)).toContain("start --role c7");
  });
});

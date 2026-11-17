/*
 * A role added in the flow editor (not one of the four built-in ids) can be
 * started: its id resolves to a synthetic worker role with the flow's prompt,
 * its own engine chain, and a lock that only narrows.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-custom-role-"));
const restore = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, AGENTGLASS_DB: process.env.AGENTGLASS_DB, AGENTGLASS_STATE_DIR: process.env.AGENTGLASS_STATE_DIR };
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.AGENTGLASS_DB = join(dir, "custom.db");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");

const { flowRoleFor, flowRoleInForce, roleLockFor, rolePromptFor, unknownRoleError } = await import("../src/rolePrompt.ts");
const { writeStoredFlow } = await import("../src/config.ts");
const { templateFlow } = await import("../../shared/flowTemplates.ts");
const { roleFor, promptHeadless, startThroughPolicy, endedTurn, planRoleSwitch } = await import("../src/agents/policystart.ts");
const { planWorker, nextEngine } = await import("../src/agents/workerstart.ts");
const { __seedOpencodeModels, __resetEngineModels } = await import("../src/enginemodels.ts");
const { compileEnvelope, narrowEnvelope } = await import("../src/agents/envelope.ts");
const { prepareRun, headlessTurn } = await import("../src/agents/headless.ts");
const { inboxReadout } = await import("../src/seatreport.ts");
const { composePolicy, defaultStored, DEFAULT_WORKER_ENVELOPE } = await import("../../shared/orchestration.ts");
const { agentProvider } = await import("../../shared/agentKinds.ts");
const { renderFlowForOrchestrator } = await import("../src/flow.ts");
const { unknownFlowRoleError } = await import("../src/flow.ts");
const { withBrowserLine } = await import("../src/browseraccess.ts");
const { db } = await import("../src/db.ts");
type Readiness = import("../../shared/types.ts").EngineReadiness;

// Tests share one process and another file resets the list: seed before every
// test so no start ever spawns the real CLI. Restore (empty) when done.
beforeEach(() => __seedOpencodeModels([]));
afterAll(() => {
  __resetEngineModels();
  for (const [k, v] of Object.entries(restore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

const ready = (id: string, ok = true): Readiness => ({
  id, title: agentProvider(id)?.title ?? id, found: true, path: `/x/${id}`, version: "1", min: null, versionOk: true,
  account: { signedIn: true }, answers: { state: "never" },
  roles: { worker: ok ? { ok } : { ok, why: "nope" }, orchestrator: { ok: false } }, missing: [], envelope: { via: null, enforced: "yes", note: "" },
});
const FLEET = [ready("claude"), ready("opencode"), ready("codex", false)];
const BASE = {
  orchestrator: { engine: "claude", model: "opus" },
  workers: { scout: { engine: "claude", model: "haiku" }, builder: { engine: "claude", model: "sonnet" }, reviewer: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
};
const policy = composePolicy(defaultStored(), BASE);
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

/**
 * The template's roster with one entry replaced (or added), so a test can save
 * a step the editor itself never writes.
 */
function saveWith(root: string, id: string, patch: Record<string, unknown>) {
  const f = templateFlow();
  const at = f.roster.findIndex((r) => r.id === id);
  const made = { ...(f.roster[at] ?? f.roster[0]!), ...patch } as (typeof f.roster)[number];
  f.roster = at < 0 ? [...f.roster, made] : f.roster.map((r) => (r.id === id ? made : r));
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
    expect(flowRoleFor(root, "qa")!.chain.length).toBeGreaterThan(0);
    expect(flowRoleFor(root, "qa")!.chain).toEqual(flowRoleInForce(root, "qa")!.chain);
  });
});

describe("--flow-role resolves against the flow in force; --role against the saved one", () => {
  test("a role the template ships is one for --flow-role in a project that has saved no flow", () => {
    // `--role` is unchanged: the template is not this project's choice.
    expect(flowRoleFor("/home/a/orbit-planner", "security")).toBeNull();
    const planner = flowRoleInForce("/home/a/orbit-planner", "planner")!;
    expect(planner).toMatchObject({ id: "planner", policyRole: "scout" });
    expect(planner.prompt).toStartWith("You are the Planner");
    expect(planner.chain.length).toBeGreaterThan(0);
    // The built-in role it names is a floor: a scout's flow role does not write.
    expect(roleFor("/home/a/orbit-planner", "planner")).toMatchObject({ title: "Planner", readOnly: true });
    expect(roleFor("/home/a/orbit-planner", "inspector")).toMatchObject({ title: "Inspector", readOnly: true });
  });
  test("a start with --role does not take an id only the template ships", async () => {
    const root = join(dir, "orbit-no-saved");
    mkdirSync(root, { recursive: true });
    const r = await startThroughPolicy({
      root, policyRoot: root, name: "w-template-role", cwd: root, prompt: "x",
      body: { role: "security" }, seatRoot: null, probe: async () => FLEET,
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("no such role");
  });
  test("a project that saved a flow answers with its own roster, not the template's", () => {
    const root = "/home/a/orbit-own";
    const f = templateFlow();
    f.roster = f.roster.filter((r) => r.id !== "security");
    expect(writeStoredFlow(root, f).ok).toBe(true);
    expect(flowRoleFor(root, "security")).toBeNull();
    expect(flowRoleInForce(root, "security")).toBeNull();
    expect(flowRoleInForce("/home/a/orbit-template", "security")).not.toBeNull();
  });
  test("the refusal names the id asked for and every id the flow does have", () => {
    const root = "/home/a/orbit-ids";
    save(root, { prompt: "BUILD ORBIT" }, [{ id: "builder-orbit", name: "Builder orbit", prompt: "BUILD ORBIT", policyRole: "builder" }]);
    const e = unknownFlowRoleError(root, "builder-jupiter");
    expect(e).toStartWith('no such flow role: "builder-jupiter"');
    expect(e).toContain("builder-orbit");
    // The template's own ids are there too: this project saved a flow from it.
    expect(e).toContain("inspector");
  });
});

describe("prompt, lock and unknown-id sentence", () => {
  test("the custom role's prompt and lock come from the flow", () => {
    save("/home/a/orbit-4");
    expect(rolePromptFor("/home/a/orbit-4", "devops")).toBe("check ports");
    expect(roleLockFor("/home/a/orbit-4", "devops")).toEqual({ readsOnly: true, tools: [], allow: [], mayStartSubagents: false });
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

describe("a flow role is never wider than the built-in role it names nor the ceiling", () => {
  test("a role mapped to a read-only built-in cannot write, whatever its own readsOnly says", () => {
    const root = "/home/a/orbit-floor";
    save(root, {}, [{ id: "check-orbit", name: "Check orbit", prompt: "CHECK ORBIT", policyRole: "reviewer", readsOnly: false, chain: [] }]);
    const role = roleFor(root, "check-orbit")!;
    expect(role.readOnly).toBe(true);
    const planned = planWorker({ role: "check-orbit" }, view, none, FLEET, null, { role, chain: flowRoleInForce(root, "check-orbit")!.chain, policyRole: "reviewer" });
    if (!planned.ok) throw new Error(planned.error);
    expect(planned.envelope.write).toBe("worktree");
    // The lock `narrowEnvelope` reads carries the floor, so the stamp and the answer say "none".
    expect(narrowEnvelope(planned.envelope, roleLockFor(root, "check-orbit")).write).toBe("none");
    const c = compileEnvelope("claude", role, narrowEnvelope(planned.envelope, roleLockFor(root, "check-orbit")), "sonnet", dir);
    if (!c.ok) throw new Error(c.error);
    const deny = (JSON.parse(c.args[1]!) as { permissions: { deny: string[] } }).permissions.deny;
    for (const w of ["Write", "Edit", "NotebookEdit"]) expect(deny).toContain(w);
  });
  test("a role with no policyRole is as wide as a builder, and can still write", () => {
    save("/home/a/orbit-builder-floor", { readsOnly: false });
    expect(roleFor("/home/a/orbit-builder-floor", "devops")).toMatchObject({ readOnly: false });
    expect(roleLockFor("/home/a/orbit-builder-floor", "devops")?.readsOnly).toBe(false);
  });
  test("a role with a policyRole obeys that role's ask", () => {
    const root = "/home/a/orbit-ask";
    save(root, {}, [{ id: "ask-orbit", name: "Ask orbit", prompt: "ASK", policyRole: "scout" }]);
    const askScout = composePolicy(
      { ...defaultStored(), ask: { orchestrator: false, workers: { scout: true, builder: false, reviewer: false, verifier: false } } },
      BASE,
    );
    const r = planWorker(
      { role: "ask-orbit" }, { policy: askScout, scope: "global" }, none, FLEET, null,
      { role: roleFor(root, "ask-orbit")!, chain: flowRoleInForce(root, "ask-orbit")!.chain, policyRole: "scout" },
    );
    expect(!r.ok && r.error).toStartWith("this role is set to ask which engine to use");
    // The same role with "ask" off picks the first ready one.
    expect(planWorker({ role: "ask-orbit" }, view, none, FLEET, null, { role: roleFor(root, "ask-orbit")!, chain: flowRoleInForce(root, "ask-orbit")!.chain, policyRole: "scout" }).ok).toBe(true);
  });
});

describe("a step that became the person's runs nothing", () => {
  test("a role made a person's step is not resumed", async () => {
    const root = join(dir, "orbit-person");
    mkdirSync(root, { recursive: true });
    save(root, {}, [{ id: "build-orbit", name: "Build orbit", prompt: "BUILD ORBIT", actor: "person", chain: [] }]);
    db.run(
      "INSERT OR REPLACE INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at, seat_root, started_by) VALUES (?, 'claude', ?, '%9999', '@9999', ?, NULL, ?, ?)",
      ["w-person-step", root, Date.now(), root, JSON.stringify({ headless: true, role: "build-orbit", engine: "claude", model: "sonnet", turn: 1 })],
    );
    const r = await promptHeadless({ name: "w-person-step", seatRoot: root, cwd: root } as never, "go on");
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('"build-orbit" is a person\'s step in the flow now');
  });

  test("a built-in id made the person's step is not resumed either", async () => {
    const root = join(dir, "orbit-person-built-in");
    mkdirSync(root, { recursive: true });
    saveWith(root, "builder", { actor: "person", policyRole: undefined, chain: [] });
    db.run(
      "INSERT OR REPLACE INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at, seat_root, started_by) VALUES (?, 'claude', ?, '%9997', '@9997', ?, NULL, ?, ?)",
      ["w-person-builder", root, Date.now(), root, JSON.stringify({ headless: true, role: "builder", engine: "claude", model: "sonnet", turn: 1 })],
    );
    const r = await promptHeadless({ name: "w-person-builder", seatRoot: root, cwd: root } as never, "go on");
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('"builder" is a person\'s step in the flow now');
  });

  test("a start in a person's step refuses before any engine is probed: --flow-role, built-in id", async () => {
    const root = join(dir, "orbit-person-start-flow");
    mkdirSync(root, { recursive: true });
    saveWith(root, "builder", { actor: "person", policyRole: undefined, chain: [] });
    let probed = false;
    const r = await startThroughPolicy({
      root, policyRoot: root, name: "w-person-start-flow", cwd: root, prompt: "x",
      body: { flowRole: "builder" }, seatRoot: null,
      probe: async () => { probed = true; throw new Error("a person's step never reaches an engine"); },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('"builder" is a person\'s step in the flow: nothing runs there, so no worker starts in it');
    expect(probed).toBe(false);
  });

  test("the same through --role, for an id equal to a built-in's", async () => {
    const root = join(dir, "orbit-person-start-role");
    mkdirSync(root, { recursive: true });
    saveWith(root, "builder", { actor: "person", policyRole: undefined, chain: [] });
    const r = await startThroughPolicy({
      root, policyRoot: root, name: "w-person-start-role", cwd: root, prompt: "x",
      body: { role: "builder" }, seatRoot: null,
      probe: async () => { throw new Error("a person's step never reaches an engine"); },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('"builder" is a person\'s step in the flow: nothing runs there, so no worker starts in it');
  });

  test("the same through --role, for a custom id", async () => {
    const root = join(dir, "orbit-person-start-custom");
    mkdirSync(root, { recursive: true });
    save(root, { actor: "person", chain: [] });
    const r = await startThroughPolicy({
      root, policyRoot: root, name: "w-person-start-custom", cwd: root, prompt: "x",
      body: { role: "devops" }, seatRoot: null,
      probe: async () => { throw new Error("a person's step never reaches an engine"); },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('"devops" is a person\'s step in the flow: nothing runs there, so no worker starts in it');
  });

  test("the engine switch refuses it, through the turn that ends a worker", async () => {
    const root = realpathSync(mkdtempSync(join(dir, "orbit-person-switch-")));
    saveWith(root, "builder", { actor: "person", policyRole: undefined, chain: [] });
    const name = "w-switch-person-builder";
    db.run(
      "INSERT OR REPLACE INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at, seat_root, started_by, exit_code, exit_line) VALUES (?, 'claude', ?, '%9996', '@9996', ?, NULL, ?, ?, 2, '')",
      [name, root, Date.now() - 60_000, root, JSON.stringify({ headless: true, role: "builder", engine: "claude", model: "sonnet", turn: 1, position: 0, retries: 0 })],
    );
    const files = prepareRun(name, "build the thing", "none");
    // Its first turn never got to work: the one case that would move it on.
    writeFileSync(files.out, `${JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "Claude usage limit reached" })}\n`);
    const sent: string[] = [];
    await endedTurn(name, { send: async (_root: string, text: string) => { sent.push(text); } });
    expect(inboxReadout(root)).toContain('"builder" is a person\'s step in the flow now, so the turn was not moved to another engine');
    // It ended where it was: no second engine took the turn.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("ended: failed (exit 2)");
  }, 40_000);
});

describe("an OpenCode chain that stores the bare model name", () => {
  const LIST = [{ id: "opencode/orbit-pickle", label: "opencode/orbit-pickle" }, { id: "acme/orbit-glm", label: "acme/orbit-glm" }];
  const root = join(dir, "orbit-bare-chain");
  mkdirSync(root, { recursive: true });
  save(root, { chain: [{ engine: "opencode", model: "orbit-glm" }, { engine: "opencode", model: "orbit-pickle" }], readsOnly: false });
  beforeEach(() => __seedOpencodeModels(LIST));
  /* The brief is asked only after every refusal the plan makes, and before the
     first spawn (the private OpenCode server, tmux). So a prompt that throws
     stops the start exactly where a real one would begin to run: `reached` is
     true when nothing turned it away, and no real CLI is ever started. */
  const STOP = new Error("stub: the start reached its brief");
  const stubBin = join(dir, "stub-bin");
  const spawned = join(dir, "real-opencode-spawned");
  mkdirSync(stubBin, { recursive: true });
  writeFileSync(join(stubBin, "opencode"), `#!/bin/sh\necho "$@" >> ${spawned}\nexit 1\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  beforeEach(() => { process.env.PATH = `${stubBin}:${oldPath}`; });
  afterEach(() => {
    process.env.PATH = oldPath;
    // The guard: a real `opencode` run by this file is a failure, not a 20 s wait.
    if (existsSync(spawned)) { const what = readFileSync(spawned, "utf8"); rmSync(spawned); throw new Error(`a test here ran opencode: ${what}`); }
  });
  const start = async (body: Record<string, unknown>, name: string): Promise<{ reached: boolean; status?: number; body?: any }> => {
    try {
      const r = await startThroughPolicy({
        root, policyRoot: root, name, cwd: root, body, seatRoot: null,
        prompt: async () => { throw STOP; },
        probe: async () => FLEET,
      });
      return { reached: false, status: r.status, body: r.body };
    } catch (e) {
      if (e === STOP) return { reached: true };
      throw e;
    }
  };

  test("a built-in role's policy slot holding the bare name plans the qualified one", () => {
    const p = composePolicy(defaultStored(), { ...BASE, workers: { ...BASE.workers, builder: { engine: "opencode", model: "orbit-glm" } } });
    const r = planWorker({ role: "builder" }, { policy: p, scope: "global" }, none, FLEET, null);
    expect(r.ok && r.choice).toEqual({ engine: "opencode", model: "acme/orbit-glm" });
  });

  test("planRoleSwitch (the live switch) into a bare-name chain gets the qualified model", () => {
    const sw = join(dir, "orbit-bare-switch");
    mkdirSync(sw, { recursive: true });
    save(sw, { chain: [{ engine: "opencode", model: "orbit-glm" }], readsOnly: false });
    const r = planRoleSwitch(sw, "devops", view, FLEET);
    expect(r.ok && r.model).toBe("acme/orbit-glm");
  });

  test("nextEngine (the first-turn engine switch) finds a worker stamped with the bare name and moves it on", () => {
    const chain = [{ engine: "opencode", model: "orbit-glm" }, { engine: "opencode", model: "orbit-pickle" }];
    const r = nextEngine({ chain, by: { engine: "opencode", model: "orbit-glm" }, ask: false, usable: () => true });
    expect(r.ok && r.choice.model).toBe("opencode/orbit-pickle");
  });

  test("--engine opencode alone is not turned away for the stored bare name", async () => {
    const r = await start({ flowRole: "devops", engine: "opencode" }, "w-bare-engine");
    expect(r.reached).toBe(true);
  });

  test("--model provider/model matches the stored bare name in the chain", async () => {
    const r = await start({ flowRole: "devops", engine: "opencode", model: "opencode/orbit-pickle" }, "w-bare-model");
    expect(r.reached).toBe(true);
  });

  describe("a chain entry the installed engine does not offer", () => {
    const rootGone = join(dir, "orbit-gone-chain");
    mkdirSync(rootGone, { recursive: true });
    save(rootGone, { chain: [{ engine: "opencode", model: "orbit-gone" }, { engine: "opencode", model: "orbit-pickle" }], readsOnly: false });
    const rootAllGone = join(dir, "orbit-all-gone-chain");
    mkdirSync(rootAllGone, { recursive: true });
    save(rootAllGone, { chain: [{ engine: "opencode", model: "orbit-gone" }], readsOnly: false });
    const go = async (r: string, body: Record<string, unknown>, name: string): Promise<{ reached: boolean; status?: number; body?: any }> => {
      try {
        const x = await startThroughPolicy({ root: r, policyRoot: r, name, cwd: r, body, seatRoot: null, prompt: async () => { throw STOP; }, probe: async () => FLEET });
        return { reached: false, status: x.status, body: x.body };
      } catch (e) { if (e === STOP) return { reached: true }; throw e; }
    };

    test("--engine opencode alone skips it and takes the next slot", () => {
      const p = composePolicy(defaultStored(), BASE);
      const role = roleFor(rootGone, "devops")!;
      const chain = [{ engine: "opencode", model: "orbit-gone" }, { engine: "opencode", model: "orbit-pickle" }];
      const r = planWorker({ role: "devops", engine: "opencode" }, { policy: p, scope: "global" }, none, FLEET, null, { role, chain });
      expect(r.ok && r.choice.model).toBe("opencode/orbit-pickle");
      expect(r.ok && r.startedBy.position).toBe(1);
    });

    test("every slot unavailable: the refusal names the model and the engine's list", async () => {
      const r = await go(rootAllGone, { flowRole: "devops", engine: "opencode" }, "w-gone-all");
      expect(r.reached).toBe(false);
      expect(r.body.error).toContain('"orbit-gone" is not offered by the installed OpenCode');
      expect(r.body.error).toContain("opencode/orbit-pickle");
      expect(r.body.error).not.toContain("provider/model");
    });

    test("an empty list does not skip: names stay as stored", async () => {
      __seedOpencodeModels([]);
      const p = composePolicy(defaultStored(), BASE);
      const role = roleFor(rootGone, "devops")!;
      const chain = [{ engine: "opencode", model: "orbit-gone" }, { engine: "opencode", model: "orbit-pickle" }];
      const r = planWorker({ role: "devops", engine: "opencode" }, { policy: p, scope: "global" }, none, FLEET, null, { role, chain });
      expect(r.ok && r.choice.model).toBe("orbit-gone");
    });

    test("no --engine: the chain's own first ready slot skips it too", () => {
      const p = composePolicy(defaultStored(), BASE);
      const role = roleFor(rootGone, "devops")!;
      const chain = [{ engine: "opencode", model: "orbit-gone" }, { engine: "opencode", model: "orbit-pickle" }];
      const r = planWorker({ role: "devops" }, { policy: p, scope: "global" }, none, FLEET, null, { role, chain });
      expect(r.ok && r.choice.model).toBe("opencode/orbit-pickle");
    });
  });

  test("a bare name no provider (or two) has stays as it is", async () => {
    const r = await start({ flowRole: "devops", engine: "opencode", model: "orbit-unknown" }, "w-bare-unknown");
    expect(r.reached).toBe(false);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("is not in the chain");
  });
});

describe("a saved step that took a built-in id as its own", () => {
  test("keeps its own readsOnly floor, and the start asks its own chain", async () => {
    const root = join(dir, "orbit-own-builder");
    mkdirSync(root, { recursive: true });
    saveWith(root, "builder", { readsOnly: true, tools: [], policyRole: undefined, chain: [{ engine: "opencode", model: "orbit-1" }] });
    // The saved step is what the built-in id now names: its walls, not another entry's.
    expect(roleLockFor(root, "builder")).toEqual({ readsOnly: true, tools: [], allow: [], mayStartSubagents: false });
    expect(flowRoleInForce(root, "builder")).toBeNull();
    /* The floor reaches the role the turn runs as, not only the envelope: a
       hand-written step with a built-in id used to keep that id's door and run
       its shell unsandboxed, whatever its own base said. */
    const role = roleFor(root, "builder")!;
    expect(role.readOnly).toBe(true);
    const t = headlessTurn({
      engine: "claude", bin: "/x/claude", model: "sonnet", role,
      envelope: narrowEnvelope(DEFAULT_WORKER_ENVELOPE, roleLockFor(root, "builder")),
      limits: { maxWorkers: 3, turnMinutes: 30, maxRetries: 1 }, prompt: "x", cwd: root, runDir: join(dir, "run-own-builder"),
    });
    if (!t.ok) throw new Error(t.error);
    const settings = JSON.parse(t.argv[t.argv.indexOf("--settings") + 1]!) as {
      sandbox?: { enabled: boolean; filesystem: { allowWrite: string[]; denyWrite: string[] } };
      permissions: { deny: string[] };
    };
    expect(settings.sandbox).toMatchObject({ enabled: true, filesystem: { allowWrite: [join(dir, "run-own-builder")], denyWrite: [root] } });
    for (const edit of ["Edit", "Write", "NotebookEdit"]) expect(settings.permissions.deny).toContain(edit);
    /* The chain is the step's own: `opencode` is in it, so the start gets as far
       as the turn, which refuses the model. Asking the policy's builder chain
       instead would answer "opencode is not in the chain for the builder role
       here: Claude Code". */
    const r = await startThroughPolicy({
      root, policyRoot: root, name: "w-own-builder", cwd: root, prompt: "x",
      body: { flowRole: "builder", engine: "opencode" }, seatRoot: null, probe: async () => FLEET,
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("OpenCode takes a model as provider/model");
  });

  /*
   * The app's own flow editor cannot write this shape any more (`writeFlow`'s
   * "a role id keeps its kind" guard refuses a different `policyRole` under
   * an id already stored), so this is reachable only through a hand-written
   * or migrated flow (`writeStoredFlow` direct, as `saveWith` does above) —
   * exactly the case `savedStepOwningBuiltIn`'s own doc describes. Still live,
   * so `planRoleSwitch` (what a live `prompt --flow-role` switch asks) must
   * still pick the step's own chain, not the policy's.
   */
  test("planRoleSwitch (the live switch's own pick) asks the same chain a fresh start would, not the policy's", () => {
    const root = join(dir, "orbit-own-builder-switch");
    mkdirSync(root, { recursive: true });
    saveWith(root, "builder", { readsOnly: false, tools: [], policyRole: undefined, chain: [{ engine: "opencode", model: "orbit-own" }] });
    // Both engines are ready here, so if the switch asked the policy's chain
    // instead of the step's own, it would come back `claude`, not `opencode`.
    const r = planRoleSwitch(root, "builder", view, [ready("opencode"), ready("claude")]);
    expect(r.ok && r.engine).toBe("opencode");
    expect(r.ok && r.model).toBe("orbit-own");
  });

  test("the ordinary mapping still answers by its policyRole", () => {
    const root = join(dir, "orbit-own-plain");
    save(root);
    expect(roleLockFor(root, "builder")).toEqual({ readsOnly: false, tools: ["read", "run", "write", "commit"], allow: [], mayStartSubagents: false });
    expect(roleFor(root, "builder")?.id).toBe("builder");
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
  test("a custom id gets a line saying Settings ▸ Browser cannot turn it on", () => {
    const brief = withBrowserLine("brief", "claude", "devops");
    expect(brief).toContain('browser: the "devops" step is not one of the roles Settings ▸ Browser can turn on');
    expect(brief.endsWith("\n\nbrief")).toBe(true);
  });
  test("one start line per custom role; none when only built-ins", () => {
    expect(briefWith(0)).not.toContain("agentglass-agent start --flow-role");
    const b = briefWith(2);
    expect(b).toContain("C0: agentglass-agent start --flow-role c0");
    expect(b).toContain("C1: agentglass-agent start --flow-role c1");
    expect(b.indexOf("start --flow-role c0")).toBeGreaterThan(b.indexOf("A worker you start with --role"));
  });
  test("over eight custom roles one start line with every id replaces the per-role lines; eight keep theirs", () => {
    expect(briefWith(9)).toContain("agentglass-agent start --flow-role <id>");
    expect(briefWith(9)).toContain("c8");
    expect(briefWith(9)).not.toContain(": agentglass-agent start --flow-role c0");
    expect(briefWith(8)).toContain("start --flow-role c7");
  });
  test("a step a person answers gets no start line: the start would be refused", () => {
    const f = templateFlow();
    const base = f.roster[0]!;
    f.roster = [...f.roster.filter((r) => r.id === "builder"),
      { ...base, id: "land-orbit", name: "Land", policyRole: undefined, actor: "person" as const },
      { ...base, id: "c0", name: "C0", policyRole: undefined }];
    const b = renderFlowForOrchestrator(f);
    expect(b).toContain("start --flow-role c0");
    expect(b).not.toContain("start --flow-role land-orbit");
  });
});

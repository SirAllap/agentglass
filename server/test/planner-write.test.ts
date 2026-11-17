/*
 * `workers.plannerWrite`: a project may let the built-in scout (planner)
 * write its own worktree and `.agx-tmp`, off by default. `roleFor`
 * (agents/policystart.ts) is the one place that builds the role the sandbox
 * and the lock run under, and `rolePrompt.ts`'s `withPlanNote` must agree
 * with it, both ways: the line never claims a scout cannot write when it
 * really can, and never leaves it off when it really cannot.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-planner-write-"));
const restore = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, AGENTGLASS_DB: process.env.AGENTGLASS_DB, AGENTGLASS_STATE_DIR: process.env.AGENTGLASS_STATE_DIR };
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.AGENTGLASS_DB = join(dir, "planner-write.db");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");

const { roleFor } = await import("../src/agents/policystart.ts");
const { withPlanNote, PLAN_NOTE, roleLockFor } = await import("../src/rolePrompt.ts");
const { APP, putSetting } = await import("../src/preflightStore.ts");
const { agentVerdict } = await import("../../shared/settingClass.ts");
const { narrowEnvelope } = await import("../src/agents/envelope.ts");
const { writeStoredFlow } = await import("../src/config.ts");
const { templateFlow } = await import("../../shared/flowTemplates.ts");

afterAll(() => {
  for (const [k, v] of Object.entries(restore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

const ROOT = "/home/a/code/orbit-planner-write";

describe("workers.plannerWrite off (the default)", () => {
  test("roleFor keeps the built-in scout read-only", () => {
    expect(roleFor(ROOT, "scout")!.readOnly).toBe(true);
  });
  test("the brief still says a scout cannot write", () => {
    expect(withPlanNote("do the thing", ROOT, "scout")).toContain(PLAN_NOTE);
  });
});

describe("workers.plannerWrite on", () => {
  const root = join(dir, "on-project");
  putSetting(root, "workers.plannerWrite", true);

  test("roleFor hands the scout a role that writes", () => {
    expect(roleFor(root, "scout")!.readOnly).toBe(false);
  });
  test("the brief agrees: no note when the envelope really writes", () => {
    expect(withPlanNote("do the thing", root, "scout", { write: "worktree" } as never)).toBe("do the thing");
  });
  test("but an envelope that writes nothing is still read-only, whatever the setting says", () => {
    expect(withPlanNote("do the thing", root, "scout", { write: "none" } as never)).toContain(PLAN_NOTE);
  });
  test("builder is unaffected: the flag is scout's alone", () => {
    expect(roleFor(root, "builder")!.readOnly).toBe(false); // builder always writes; unchanged by this flag
  });
});

describe("a flow role mapped to scout: the same switch, same floor", () => {
  const off = join(dir, "flowscout-off");
  const on = join(dir, "flowscout-on");
  putSetting(on, "workers.plannerWrite", true);
  const flow = () => {
    const f = templateFlow();
    f.roster = [
      ...f.roster,
      { ...f.roster[0]!, id: "arch", policyRole: "scout", readsOnly: false },
      { ...f.roster[0]!, id: "survey", policyRole: "scout", readsOnly: true },
    ];
    return f;
  };
  expect(writeStoredFlow(off, flow()).ok).toBe(true);
  expect(writeStoredFlow(on, flow()).ok).toBe(true);

  test("plannerWrite off: the role's own readsOnly:false does not lift scout's floor", () => {
    const lock = roleLockFor(off, "arch")!;
    expect(lock.readsOnly).toBe(true);
    const envelope = narrowEnvelope({ write: "worktree" } as never, lock);
    expect(envelope.write).toBe("none");
    expect(withPlanNote("do it", off, "arch", envelope)).toContain(PLAN_NOTE);
  });

  test("plannerWrite on, role says it writes: the floor lifts, no PLAN_NOTE", () => {
    const lock = roleLockFor(on, "arch")!;
    expect(lock.readsOnly).toBe(false);
    const envelope = narrowEnvelope({ write: "worktree" } as never, lock);
    expect(envelope.write).toBe("worktree");
    expect(withPlanNote("do it", on, "arch", envelope)).toBe("do it");
  });

  test("plannerWrite on, but the role itself says read-only: still none", () => {
    const lock = roleLockFor(on, "survey")!;
    expect(lock.readsOnly).toBe(true);
    const envelope = narrowEnvelope({ write: "worktree" } as never, lock);
    expect(envelope.write).toBe("none");
    expect(withPlanNote("do it", on, "survey", envelope)).toContain(PLAN_NOTE);
  });
});

describe("an agent's own change to workers.plannerWrite", () => {
  const ID = "workers.plannerWrite";
  test("turning it on waits for the person unless the project trusts agents", () => {
    expect(agentVerdict(ID, false, true, false)).toBe("ask");
    expect(agentVerdict(ID, false, true, true)).toBe("apply");
  });
  test("turning it off always applies: it only narrows", () => {
    expect(agentVerdict(ID, true, false, false)).toBe("apply");
  });
});

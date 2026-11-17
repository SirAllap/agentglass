/*
 * "No Claude in workers" (`workers.noClaude`): with it on, the planner never
 * starts a worker on Claude. A built-in role or a custom flow role whose chain
 * picks Claude moves to the other ready engine; with none ready it is refused
 * with the setting's name and where to change it. Pure planner, no server.
 */
import { describe, expect, test } from "bun:test";
import { agentProvider } from "../../shared/agentKinds.ts";
import { composePolicy, defaultStored, type Policy } from "../../shared/orchestration.ts";
import type { EngineReadiness } from "../../shared/types.ts";
import { workerRole } from "../../shared/workerRoles.ts";
import { planWorker } from "../src/agents/workerstart.ts";

const ready = (id: string, ok = true): EngineReadiness => ({
  id, title: agentProvider(id)?.title ?? id, found: true, path: `/x/${id}`, version: "1", min: null, versionOk: true,
  account: { signedIn: true }, answers: { state: "never" },
  roles: { worker: ok ? { ok } : { ok, why: "not signed in" }, orchestrator: { ok: false } }, missing: [], envelope: { via: null, enforced: "yes", note: "" },
});
const FLEET = [ready("claude"), ready("opencode")];
const ONLY_CLAUDE = [ready("claude"), ready("opencode", false)];

const policy: Policy = composePolicy(defaultStored(), {
  orchestrator: { engine: "claude", model: "opus" },
  workers: {
    scout: { engine: "claude", model: "haiku" }, builder: { engine: "claude", model: "sonnet" },
    reviewer: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" },
  },
});
const view = (noClaude: boolean) => ({ policy, scope: "global" as const, noClaude });
const none = { on: () => false };
// A flow role a person made (an invented one): Claude first, OpenCode second.
const arch = { ...workerRole("builder")!, id: "arch" as never };
const archChain = [{ engine: "claude", model: "sonnet" }, { engine: "opencode", model: "opencode/big-pickle" }];

describe("No Claude in workers", () => {
  test("off (the default): a built-in role set to Claude starts on Claude", () => {
    const r = planWorker({ role: "builder" }, view(false), none, FLEET, null);
    expect(r.ok && r.choice.engine).toBe("claude");
  });

  test("on: a built-in role set to Claude starts on OpenCode, and the stamp says why", () => {
    const r = planWorker({ role: "builder" }, view(true), none, FLEET, null);
    expect(r.ok && r.choice.engine).toBe("opencode");
    expect(r.ok && r.startedBy.engine).toBe("opencode");
    expect(r.ok && r.startedBy.because.join(" ")).toContain('"No Claude in workers" is on');
  });

  test("on: an --engine claude ask is moved too", () => {
    const r = planWorker({ role: "builder", engine: "claude" }, view(true), none, FLEET, null);
    expect(r.ok && r.choice.engine).toBe("opencode");
  });

  test("on: a custom flow role's chain skips Claude for its next ready entry", () => {
    const off = planWorker({ role: "arch" }, view(false), none, FLEET, null, { role: arch, chain: archChain });
    expect(off.ok && off.choice.engine).toBe("claude");
    const r = planWorker({ role: "arch" }, view(true), none, FLEET, null, { role: arch, chain: archChain });
    expect(r.ok && r.choice).toEqual({ engine: "opencode", model: "opencode/big-pickle" });
    expect(r.ok && r.startedBy.position).toBe(1);
  });

  test("on, and no other engine ready: refused with the setting's name and where to change it", () => {
    const r = planWorker({ role: "builder" }, view(true), none, ONLY_CLAUDE, null);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('"No Claude in workers" is on');
    expect(!r.ok && r.error).toContain("Settings ▸ Advanced ▸ Worker sandbox");
    const c = planWorker({ role: "arch" }, view(true), none, ONLY_CLAUDE, null, { role: arch, chain: archChain });
    expect(!c.ok && c.error).toContain('"No Claude in workers" is on');
  });
});

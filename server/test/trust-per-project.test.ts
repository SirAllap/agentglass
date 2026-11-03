/*
 * The person's switch, held per project: what a trusted project may do through
 * the settings door, and what a project whose own value is off still may not.
 *
 * The defs are in-memory stand-ins; the switch read is a function of the root,
 * which is the contract index.ts hands the door (agentTrust.agentsTrusted).
 */
import { describe, expect, test } from "bun:test";
import { makeDoor, type ServerSettingDef } from "../src/settingsDoor.ts";
import { seatAllows } from "../src/auth.ts";
import { agentsTrusted, agentsTrustSetAt, writeAgentsTrusted } from "../src/agentTrust.ts";

const A = "/nonexistent/orbit-a";
const B = "/nonexistent/orbit-b";

function rig(trustedAt: Record<string, boolean> = {}, globalTrusted = false) {
  const store: Record<string, unknown> = {};
  const applied: string[] = [];
  const def = (id: string, scoped: boolean): ServerSettingDef => ({
    id, label: `Label of ${id}`, page: "orchestration", type: "json", ...(scoped ? { scoped: true as const } : {}),
    read: (root) => store[`${root ?? ""}\u0000${id}`] ?? (id === "orchestration.policy" ? { limits: { maxWorkers: 2 } } : "default"),
    validate: (raw) => (id === "agents.changeWithoutAsking"
      ? (typeof raw === "boolean" ? { value: raw } : { error: "true or false" })
      : raw && typeof raw === "object" ? { value: raw } : raw === "default" ? { value: raw } : { error: "an object" }),
    apply: (v, root) => { store[`${root ?? ""}\u0000${id}`] = v; applied.push(`${root ?? ""}\u0000${id}`); return { ok: true }; },
  });
  const defs = [def("orchestration.policy", true), def("launch.mode", false), def("agents.changeWithoutAsking", false)];
  const door = makeDoor({
    defs: () => defs,
    trusted: (root) => (root ? trustedAt[root] === true : globalTrusted),
    applyWindow: async () => ({ ok: true }), changed: () => {}, now: () => 1_000_000, later: () => {},
  });
  const seatA = { person: false, who: "the chair of orbit-a", root: A, confined: true };
  const agentNoRoot = { person: false, who: "worker builder-1" };
  return { door, store, applied, seatA, agentNoRoot };
}

const policy = { limits: { maxWorkers: 5 } };

describe("the switch held per project", () => {
  test("on for root A: a seat of A changes A's policy and it applies at once", async () => {
    const r = rig({ [A]: true });
    const a = await r.door.change("orchestration.policy", policy, r.seatA);
    expect(a).toMatchObject({ ok: true, applied: true });
    expect(r.store[`${A}\u0000orchestration.policy`]).toEqual(policy);
    expect(r.door.pending()).toEqual([]);
  });

  test("root B with the switch off still gets a request", async () => {
    const r = rig({ [A]: true, [B]: false });
    const a = await r.door.change("orchestration.policy", policy, { person: false, who: "the chair of orbit-b", root: B, confined: true });
    expect(a.ok && !a.applied).toBe(true);
    expect(r.applied).toEqual([]);
    expect(r.door.pending().map((p) => p.root)).toEqual([B]);
  });

  test("an agent asking to turn the switch on is refused, its own project's row included", async () => {
    const r = rig({ [A]: true });
    const on = await r.door.change("agents.changeWithoutAsking", true, r.seatA);
    expect(on).toMatchObject({ ok: false });
    expect(on.ok === false && on.status).toBe(403);
    expect(r.applied).toEqual([]);
    // Even where the project says it itself: still a widening, still the person's.
    const again = await r.door.change("agents.changeWithoutAsking", true, { person: false, who: "worker builder-1", root: A });
    expect(again).toMatchObject({ ok: false });
  });

  test("a setting with no root reads the global switch, never a project's", async () => {
    const r = rig({ [A]: true }, false);
    const a = await r.door.change("launch.mode", policy, r.agentNoRoot);
    expect(a.ok && !a.applied).toBe(true);
    expect(r.door.pending().map((p) => p.root)).toEqual([undefined]);
  });

  test("the global switch on does not make a project's policy apply anyway", async () => {
    const r = rig({ [B]: false }, true);
    const a = await r.door.change("orchestration.policy", policy, { person: false, who: "the chair of orbit-b", root: B, confined: true });
    expect(a.ok && !a.applied).toBe(true);
  });
});

describe("the chair's wall", () => {
  test("the switch of a seat's own project lets it reach POST /orchestration, and nothing else", () => {
    expect(seatAllows("speak", "POST", "/orchestration")).toBe(false);
    expect(seatAllows("speak", "POST", "/orchestration", A, (r) => r === A)).toBe(true);
    expect(seatAllows("speak", "POST", "/orchestration", B, (r) => r === A)).toBe(false);
    expect(seatAllows("speak", "POST", "/agents/named/start", A, () => true)).toBe(false);
    expect(seatAllows("speak", "POST", "/settings/door", A, () => false)).toBe(true);
  });
});

describe("the stored switch", () => {
  test("a project with no value of its own is off, whatever the global says", () => {
    const fresh = "/nonexistent/agx-trust-untouched";
    expect(agentsTrustSetAt(fresh)).toBe(false);
    expect(agentsTrusted(fresh)).toBe(false);
  });

  test("a project's own value is that project's alone", () => {
    const mine = "/nonexistent/agx-trust-mine";
    const other = "/nonexistent/agx-trust-other";
    writeAgentsTrusted(true, mine);
    expect(agentsTrusted(mine)).toBe(true);
    expect(agentsTrustSetAt(mine)).toBe(true);
    expect(agentsTrusted(other)).toBe(false);
    writeAgentsTrusted(false, mine);
    expect(agentsTrusted(mine)).toBe(false);
  });
});

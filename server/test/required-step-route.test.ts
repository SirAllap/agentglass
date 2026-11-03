/*
 * The required-step gate end to end on a booted server with fake engines:
 * a coordinator's Integrate check is refused while a required role has no
 * passing result, the person's own is not, and a custom-role worker started
 * with --plan records the pass that lets it through. A fail edge that has used
 * its rounds refuses the seat's next round and asks the person once.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { MACHINE, nights, startHarness, type Harness } from "./fixtures/workerHarness.ts";

const have = !!Bun.which("tmux") && !!Bun.which("python3");
let h: Harness;
beforeAll(async () => { if (have) h = await startHarness("req-step"); }, SERVER_BOOT_MS);
afterAll(async () => { if (have) await h.stop(); });

/** Saves the template flow plus a `devops` role whose fail edge goes back to the first role, capped at `max`. Nothing is required. */
async function saveRoundsFlow(max: number): Promise<void> {
  const q = `${h.base}/flow?root=${encodeURIComponent(h.dir)}`;
  const cur = await (await fetch(q, { headers: { Authorization: `Bearer ${MACHINE}` } })).json() as { flow: { roster: Record<string, unknown>[]; path: string[]; edges: Record<string, unknown>[] } };
  const flow = {
    ...cur.flow,
    path: [...cur.flow.path.filter((x) => x !== "devops"), "devops"],
    roster: [...cur.flow.roster.filter((r) => r.id !== "devops").map((r) => ({ ...r, required: false })), {
      ...cur.flow.roster[0]!, id: "devops", name: "DevOps", does: "Checks ports", prompt: "check ports", policyRole: undefined, required: false,
      chain: [{ engine: "opencode", model: "opencode/big-pickle" }], tools: [], readsOnly: true, resolvedChain: undefined,
    }],
    edges: [...cur.flow.edges.filter((e) => e.from !== "devops"), { from: "devops", to: cur.flow.roster[0]!.id, on: "fail", maxRounds: max }],
  };
  const res = await fetch(q, { method: "PUT", body: JSON.stringify(flow), headers: { "Content-Type": "application/json", Origin: h.base, Authorization: `Bearer ${MACHINE}` } });
  const body = await res.json() as { ok: boolean; error?: string };
  if (!body.ok) throw new Error(`flow refused: ${body.error}`);
}

/** The template flow plus a required read-only `devops` role on the path, run by the OpenCode stub. */
async function saveFlow(): Promise<void> {
  const q = `${h.base}/flow?root=${encodeURIComponent(h.dir)}`;
  const cur = await (await fetch(q, { headers: { Authorization: `Bearer ${MACHINE}` } })).json() as { flow: { roster: Record<string, unknown>[]; path: string[] } };
  const flow = {
    ...cur.flow,
    path: [...cur.flow.path, "devops"],
    roster: [...cur.flow.roster.map((r) => (r.id === "inspector" ? { ...r, required: true } : r)), {
      ...cur.flow.roster[0]!, id: "devops", name: "DevOps", does: "Checks ports", prompt: "check ports", policyRole: undefined,
      chain: [{ engine: "opencode", model: "opencode/big-pickle" }], tools: [], readsOnly: true, required: true, resolvedChain: undefined,
    }],
  };
  const res = await fetch(q, { method: "PUT", body: JSON.stringify(flow), headers: { "Content-Type": "application/json", Origin: h.base, Authorization: `Bearer ${MACHINE}` } });
  const body = await res.json() as { ok: boolean; error?: string };
  if (!body.ok) throw new Error(`flow refused: ${body.error}`);
}

describe.skipIf(!have)("integrate-check and the required step", () => {
  test("refused for the coordinator, open to the person, lifted by a recorded pass", async () => {
    await h.usePolicy({ rules: [nights()] });
    await saveFlow();
    expect((await h.asPerson("/settings/door", { id: "flightPlan.enabled", value: true, root: h.dir }, { Origin: h.base })).ok).toBe(true);
    const made = await h.asPerson("/flight-plan/plans", { root: h.dir, request: "Add thing", size: "M" });
    const id = (made as any).plan?.id as string;
    expect(id).toMatch(/^fp_/);
    const d = new Database(join(h.dir, "w.db"));
    // The server writes here too: bun's default busy handler waits ~0 ms, so its lock throws here.
    d.run("PRAGMA busy_timeout = 5000");
    try { d.query("UPDATE flight_plan SET state = 'launched' WHERE id = ?").run(id); } finally { d.close(); }
    const check = (as: "seat" | "person") => (as === "seat" ? h.asSeat : h.asPerson)(`/flight-plan/plans/${id}/integrate-check`, {});

    const refused = await check("seat");
    console.log("coordinator, before:", refused.status, JSON.stringify(refused));
    expect(refused.status).toBe(403);
    expect(refused).toMatchObject({ stopReason: "required-step", missing: ["Inspector", "DevOps"] });
    const mine = await check("person");
    console.log("person, before:", mine.status, JSON.stringify(mine));
    expect(mine.status).toBe(200);

    const r = await h.asSeat("/agents/named/start", { name: "w-devops-plan", cwd: h.wt, role: "devops", plan: id, prompt: "look at port 4000" });
    expect(r.ok).toBe(true);
    await h.exited("w-devops-plan");
    expect(((await check("seat")) as { missing?: string[] }).missing).toEqual(["Inspector"]);
    // The reviewer-type role: its final report is read off the stub engine's output (no BLOCKER line = pass).
    const v = await h.asSeat("/agents/named/start", { name: "w-inspector-plan", cwd: h.wt, role: "inspector", plan: id, prompt: "review it" });
    expect(v.ok).toBe(true);
    await h.exited("w-inspector-plan");
    await h.until(async () => (await check("seat")).status === 200);
    const ok = await check("seat");
    console.log("coordinator, after the pass:", ok.status, JSON.stringify(ok));
    expect(ok).toMatchObject({ ok: true, stopReason: null });
  }, 60_000);

  test("rounds: the third fail stops the coordinator, not the person; raising the cap clears it", async () => {
    await h.usePolicy({ rules: [nights()] });
    await saveRoundsFlow(3);
    await h.asPerson("/settings/door", { id: "flightPlan.enabled", value: true, root: h.dir }, { Origin: h.base });
    const made = await h.asPerson("/flight-plan/plans", { root: h.dir, request: "Add other thing", size: "M" });
    const id = (made as any).plan?.id as string;
    const d = new Database(join(h.dir, "w.db"));
    // The server writes here too: bun's default busy handler waits ~0 ms, so its lock throws here.
    d.run("PRAGMA busy_timeout = 5000");
    const fail = () => d.query("INSERT INTO flight_plan_step (plan_id, role_id, verdict, plan_version, head, at) VALUES (?, 'devops', 'fail', 1, NULL, ?)").run(id, Date.now());
    try {
      d.query("UPDATE flight_plan SET state = 'launched' WHERE id = ?").run(id);
      const check = (as: "seat" | "person") => (as === "seat" ? h.asSeat : h.asPerson)(`/flight-plan/plans/${id}/integrate-check`, {});
      fail(); fail();
      const two = await check("seat");
      console.log("2 fails, coordinator:", two.status, JSON.stringify(two));
      expect(two.status).toBe(200);
      fail();
      const three = await check("seat");
      console.log("3 fails, coordinator:", three.status, JSON.stringify(three));
      expect(three.status).toBe(403);
      expect(three).toMatchObject({ stopReason: "rounds-used", roles: ["DevOps"] });
      const mine = await check("person");
      console.log("3 fails, person:", mine.status, JSON.stringify(mine));
      expect(mine.status).toBe(200);
      // The loop itself is refused for the seat, and the person is told once; their own round is theirs.
      const refusedStart = await h.asSeat("/agents/named/start", { name: "w-devops-round-4", cwd: h.wt, role: "devops", plan: id, prompt: "another round" });
      console.log("4th round, coordinator:", refusedStart.status, JSON.stringify(refusedStart));
      expect(refusedStart.status).toBe(409);
      expect(String(refusedStart.error)).toContain("Another round of DevOps is the person's");
      const needs = await h.read(`/seat/needs?format=json&root=${encodeURIComponent(h.dir)}`, MACHINE);
      expect((needs.body.needs as { text: string }[]).filter((n) => n.text.includes("another round is a person's call")).length).toBe(1);
      await h.asSeat("/agents/named/start", { name: "w-devops-round-4", cwd: h.wt, role: "devops", plan: id, prompt: "another round" });
      const twice = await h.read(`/seat/needs?format=json&root=${encodeURIComponent(h.dir)}`, MACHINE);
      expect((twice.body.needs as { text: string }[]).filter((n) => n.text.includes("another round is a person's call")).length).toBe(1);
      const mineStart = await h.asPerson("/agents/named/start", { name: "w-devops-round-mine", cwd: h.wt, role: "devops", plan: id, prompt: "the person's round" });
      expect(mineStart.ok).toBe(true);
      await h.exited("w-devops-round-mine");
      await saveRoundsFlow(4);
      const raised = await check("seat");
      console.log("cap raised to 4, coordinator:", raised.status, JSON.stringify(raised));
      expect(raised).toMatchObject({ ok: true, stopReason: null });
    } finally { d.close(); }
  }, 60_000);
});

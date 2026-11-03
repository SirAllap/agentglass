/*
 * A custom flow role started for real: a booted server with its own tmux and
 * the fake engines first on PATH (fixtures/workerHarness.ts). What is asserted
 * is what the stub engine saw: its argv (the role's prompt first) and its lock
 * (write denied), and the row the app wrote.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { MACHINE, nights, startHarness, type Harness } from "./fixtures/workerHarness.ts";

const have = !!Bun.which("tmux") && !!Bun.which("python3");
let h: Harness;
beforeAll(async () => { if (have) h = await startHarness("custom-role"); }, SERVER_BOOT_MS);
afterAll(async () => { if (have) await h.stop(); });

/** Save the template flow plus a read-only `devops` role whose chain is the OpenCode stub. */
async function saveFlowWithDevops(): Promise<void> {
  const cur = await (await fetch(`${h.base}/flow?root=${encodeURIComponent(h.dir)}`, { headers: { Authorization: `Bearer ${MACHINE}` } })).json() as { flow: { roster: Record<string, unknown>[] } };
  const base = cur.flow.roster[0]!;
  const flow = {
    ...cur.flow,
    roster: [...cur.flow.roster, {
      ...base, id: "devops", name: "DevOps", does: "Checks ports", prompt: "check ports", policyRole: undefined,
      chain: [{ engine: "opencode", model: "opencode/big-pickle" }], tools: [], readsOnly: true, required: false, resolvedChain: undefined,
    }],
  };
  const res = await fetch(`${h.base}/flow?root=${encodeURIComponent(h.dir)}`, {
    method: "PUT", body: JSON.stringify(flow),
    headers: { "Content-Type": "application/json", Origin: h.base, Authorization: `Bearer ${MACHINE}` },
  });
  const body = await res.json() as { ok: boolean; error?: string };
  if (!body.ok) throw new Error(`flow refused: ${body.error}`);
}

describe.skipIf(!have)("start --role <custom flow role> through the policy", () => {
  test("an id neither built-in nor saved is a 400 with the same prefix", async () => {
    await h.usePolicy({ rules: [nights()] });
    const r = await h.asSeat("/agents/named/start", { name: "w-nobody", cwd: h.wt, role: "devops", prompt: "x" });
    expect(r.status).toBe(400);
    expect(r.error).toBe("no such role");
  });

  test("a saved custom role runs on its own chain with its prompt first and write denied", async () => {
    await saveFlowWithDevops();
    const miss = await h.asSeat("/agents/named/start", { name: "w-janitor", cwd: h.wt, role: "janitor", prompt: "x" });
    expect(miss.status).toBe(400);
    expect(miss.error).toStartWith("no such role");
    expect(miss.error).toContain("devops");

    const r = await h.asSeat("/agents/named/start", { name: "w-devops", cwd: h.wt, role: "devops", prompt: "look at port 4000" });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ engine: "opencode", model: "opencode/big-pickle", envelope: { write: "none" } });
    const done = await h.exited("w-devops");
    expect(done.startedBy).toMatchObject({ role: "devops", engine: "opencode", headless: true });

    const call = h.callsOf("opencode").at(-1)!;
    expect(call.argv.at(-1)).toBe("check ports\n\nlook at port 4000");
    const cfg = JSON.parse(call.env.OPENCODE_CONFIG_CONTENT!) as { permission: { edit?: string; bash: Record<string, string> } };
    expect(cfg.permission.edit).toBe("deny");
    expect(cfg.permission.bash["git push"]).toBe("deny");
    // No browser credential and no browser line for a custom id.
    expect(call.env.AGENTGLASS_BROWSER_AS).toBeUndefined();
    expect(call.argv.at(-1)).not.toContain("Browser access");
  }, 40_000);

  test("a custom worker takes its next instruction like a built-in one", async () => {
    const r = await h.asSeat("/agents/named/prompt", { name: "w-devops", text: "and port 4001" });
    expect(r.ok).toBe(true);
  }, 40_000);
});

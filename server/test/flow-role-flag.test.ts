/*
 * `agentglass-agent start --flow-role <id>`: a role of the project's Flow, not
 * one of the four built-in ids. No orchestration policy is stored in this file,
 * because the role's own chain is the decision: that is what makes a role the
 * flow made startable in a project that never wrote a policy.
 *
 * What is asserted is what the stub engine saw and what the row says: the flow
 * role is the one recorded, which is what the Flow view counts on that block.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { MACHINE, startHarness, type Harness } from "./fixtures/workerHarness.ts";

const have = !!Bun.which("tmux") && !!Bun.which("python3");
let h: Harness;
beforeAll(async () => { if (have) h = await startHarness("flow-role"); }, SERVER_BOOT_MS);
afterAll(async () => { if (have) await h.stop(); });

/**
 * The template flow plus two roles a person would have made: `builder-orbit`,
 * with a chain of its own, and `planner-orbit`, which is the Scout step.
 */
/* A flow role with no base role has no browser row of its own and is off by default,
   so its brief leads with the line saying why; the role's prompt follows it. */
// Measured on the m40 run: such a brief now opens with `"<name>" has no base role: no browser. ...`
// (withNoBaseNote, outermost in policystart) instead of a `browser: ...` line, so both are stripped.
const withoutBrowserLine = (brief: string) => brief.replace(/^(?:browser: |"[^"\n]*" has no base role: )[^\n]*\n\n/, "");

async function saveOrbitFlow(): Promise<void> {
  const cur = await (await fetch(`${h.base}/flow?root=${encodeURIComponent(h.dir)}`, { headers: { Authorization: `Bearer ${MACHINE}` } })).json() as { flow: { roster: Record<string, unknown>[] } };
  const base = cur.flow.roster[0]!;
  const flow = {
    ...cur.flow,
    roster: [...cur.flow.roster,
      {
        ...base, id: "builder-orbit", name: "Builder orbit", does: "Builds the orbit change", prompt: "BUILD ORBIT",
        policyRole: undefined, chain: [{ engine: "opencode", model: "opencode/big-pickle" }], tools: [], readsOnly: false,
        required: false, resolvedChain: undefined,
      },
      {
        ...base, id: "planner-orbit", name: "Planner orbit", does: "Cuts the ask into steps", prompt: "PLAN ORBIT",
        policyRole: "scout", chain: [], tools: [], readsOnly: true, required: false, resolvedChain: undefined,
      },
    ],
  };
  const res = await fetch(`${h.base}/flow?root=${encodeURIComponent(h.dir)}`, {
    method: "PUT", body: JSON.stringify(flow),
    headers: { "Content-Type": "application/json", Origin: h.base, Authorization: `Bearer ${MACHINE}` },
  });
  const body = await res.json() as { ok: boolean; error?: string };
  if (!body.ok) throw new Error(`flow refused: ${body.error}`);
}

describe.skipIf(!have)("start --flow-role", () => {
  test("an id the flow does not have is refused with every id it does", async () => {
    const r = await h.asSeat("/agents/named/start", { name: "w-nobody", cwd: h.wt, flowRole: "builder-jupiter", prompt: "x" });
    expect(r.status).toBe(400);
    expect(r.error).toStartWith('no such flow role: "builder-jupiter"');
    // The template's own ids, since this project has saved no flow yet.
    expect(r.error).toContain("planner");
    expect(r.error).toContain("builder");
  });

  test("a step a person answers runs nothing", async () => {
    // `landing` is the template's person step: nothing runs there.
    const r = await h.asSeat("/agents/named/start", { name: "w-landing", cwd: h.wt, flowRole: "landing", prompt: "x" });
    expect(r.status).toBe(400);
    expect(r.error).toContain('"landing" is a person\'s step');
  });

  test("a saved role starts on its own chain, and the row names the flow role", async () => {
    await saveOrbitFlow();
    const r = await h.asSeat("/agents/named/start", { name: "w-orbit", cwd: h.wt, flowRole: "builder-orbit", prompt: "look at the orbit route" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result).toMatchObject({ engine: "opencode", model: "opencode/big-pickle" });

    const done = await h.exited("w-orbit");
    // What `list` prints, and what the Flow counts on the block.
    expect(done.startedBy).toMatchObject({ role: "builder-orbit", engine: "opencode", headless: true });

    const call = h.callsOf("opencode").at(-1)!;
    expect(withoutBrowserLine(call.argv.at(-1)!)).toStartWith("BUILD ORBIT");
    expect(call.argv.at(-1)).toContain("look at the orbit route");
  }, 40_000);

  test("a role that maps to a built-in policy role runs the policy role's chain", async () => {
    const r = await h.asSeat("/agents/named/start", { name: "w-planner", cwd: h.wt, flowRole: "planner-orbit", prompt: "cut the ask" });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ engine: "claude" });
    const done = await h.exited("w-planner");
    expect(done.startedBy).toMatchObject({ role: "planner-orbit", engine: "claude" });
    // Claude takes its prompt on stdin, so the flow role's words are read off
    // the turn's own folder.
    const brief = readFileSync(join(h.state, "worker-runs", "w-planner", "prompt"), "utf8");
    expect(withoutBrowserLine(brief)).toStartWith("PLAN ORBIT");
    expect(brief).toContain("cut the ask");
  }, 40_000);

  test("one role per start: --role beside --flow-role is refused", async () => {
    const r = await h.asSeat("/agents/named/start", { name: "w-both", cwd: h.wt, role: "builder", flowRole: "builder-orbit", prompt: "x" });
    expect(r.status).toBe(400);
    expect(r.error).toContain("not both");
  });
});

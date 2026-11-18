/*
 * `prompt --flow-role <id>`: a headless worker's next turn switches into
 * another role of the project's Flow, same session id and checkout. What is
 * asserted is what the resumed turn carried: the new role's own prompt, chain
 * and envelope, never a union with the role it left, and the engine's own
 * `--resume` argument naming the SAME session throughout.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { MACHINE, startHarness, type Harness } from "./fixtures/workerHarness.ts";

const have = !!Bun.which("tmux") && !!Bun.which("python3");
let h: Harness;
beforeAll(async () => { if (have) h = await startHarness("flow-switch"); }, SERVER_BOOT_MS);
afterAll(async () => { if (have) await h.stop(); });

/** Two custom roles on the same (fake) engine, so the `--resume` id is the
 *  only thing to compare across the switch: `builder-x` writes, `planner-x`
 *  is read-only with a prompt of its own. */
async function saveSwitchFlow(): Promise<void> {
  const cur = await (await fetch(`${h.base}/flow?root=${encodeURIComponent(h.dir)}`, { headers: { Authorization: `Bearer ${MACHINE}` } })).json() as { flow: { roster: Record<string, unknown>[] } };
  const base = cur.flow.roster[0]!;
  const flow = {
    ...cur.flow,
    roster: [...cur.flow.roster,
      {
        ...base, id: "builder-x", name: "Builder x", does: "Builds", prompt: "BUILD X",
        policyRole: undefined, chain: [{ engine: "claude", model: "sonnet-b" }], tools: [], readsOnly: false,
        required: false, resolvedChain: undefined,
      },
      {
        // No `policyRole`: a custom role with one takes the POLICY's chain for
        // that built-in on every read (and since main, writeFlow refuses a
        // stored chain alongside one at all) — this role's own chain is the
        // point of the test, so it stays a plain custom id.
        ...base, id: "planner-x", name: "Planner x", does: "Plans", prompt: "PLAN X",
        policyRole: undefined, chain: [{ engine: "claude", model: "sonnet-p" }], tools: [], readsOnly: true,
        required: false, resolvedChain: undefined,
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

describe.skipIf(!have)("prompt --flow-role", () => {
  test("switches role, chain and envelope mid-session, same --resume id", async () => {
    await saveSwitchFlow();
    const start = await h.asSeat("/agents/named/start", { name: "w-switch", cwd: h.wt, flowRole: "builder-x", prompt: "build it" });
    expect(start.ok).toBe(true);
    const firstDone = await h.exited("w-switch");
    expect(firstDone.startedBy).toMatchObject({ role: "builder-x", engine: "claude", model: "sonnet-b", envelope: { write: "worktree" } });

    const firstCall = h.callsOf("claude").at(-1)!;
    const sid = firstCall.argv[firstCall.argv.indexOf("--session-id") + 1];
    expect(firstCall.argv.at(-1)).toContain("BUILD X");

    const r = await h.asSeat("/agents/named/prompt", { name: "w-switch", text: "now plan the rest", flowRole: "planner-x" });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ role: "planner-x", engine: "claude", model: "sonnet-p" });

    const secondDone = await h.exited("w-switch");
    expect(secondDone.startedBy).toMatchObject({ role: "planner-x", engine: "claude", model: "sonnet-p", envelope: { write: "none" } });

    const secondCall = h.callsOf("claude").at(-1)!;
    // Same session throughout the switch: the engine's own continuity, not a fresh one.
    expect(secondCall.argv[secondCall.argv.indexOf("--resume") + 1]).toBe(sid);
    // The new role's own prompt opens the switched turn, after the app's one-line browser note
    // (which says whether this worker got a browser credential).
    expect(secondCall.argv.at(-1)!.replace(/^(?:browser: |"[^"\n]*" has no base role: )[^\n]*\n\n/, "")).toStartWith("PLAN X");
    expect(secondCall.argv.at(-1)).toContain("now plan the rest");
  }, 60_000);

  test("an id the flow does not have is refused, the worker left alone", async () => {
    const r = await h.asSeat("/agents/named/prompt", { name: "w-switch", text: "x", flowRole: "builder-jupiter" });
    expect(r.status).toBe(400);
    expect(r.error).toContain("no such role");
  });

  test("a step a person answers is refused", async () => {
    // `landing` is the template's person step: nothing runs there.
    const r = await h.asSeat("/agents/named/prompt", { name: "w-switch", text: "x", flowRole: "landing" });
    expect(r.status).toBe(400);
    expect(r.error).toContain("is a person's step");
  });
});

// A gate decision is the one string in this codebase whose reader is a model.
//
// When you press Deny in the dashboard the UI sends no text — `gateDecide(id,
// decision)` has no reason argument at the call site — so the server backfills
// one, the hook puts it in `permissionDecisionReason`, and Claude Code hands it
// straight to the agent it just stopped. The old backfill was "denied from
// dashboard": true, and useless. It says nothing about *why*, so the only moves
// it leaves the agent are retrying the identical call (denied again) or
// stalling until the human comes back — and the human pressed Deny precisely to
// avoid being needed again.
//
// So these tests are about content, not plumbing: the default has to say what
// happened, that retrying is pointless, and what to do instead. The last two
// pin the cases that must NOT gain a default, because a reason there changes
// behaviour rather than wording.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "agx-gate-reason-"));
process.env.AGENTGLASS_DB = join(dir, "gate.db");
process.env.XDG_CONFIG_HOME = dir;

// Unique per run, deterministic per assertion — db.ts binds its file at import,
// so in a full `bun test` this suite may land on a database another suite chose
// and fixed ids would replay old rows. Same reasoning as gate-durability.
let seq = 0;
const newId = () => `${crypto.randomUUID().slice(0, 24)}${String(++seq).padStart(12, "0")}`;

let gate: typeof import("../src/gate.ts");
let db: typeof import("../src/db.ts");

const req = (over: Record<string, unknown> = {}) => ({
  source_app: "orbit",
  session_id: "11111111-2222-3333-4444-555555555555",
  tool_name: "Bash",
  summary: "rm -rf /",
  ...over,
});

beforeAll(async () => {
  db = await import("../src/db.ts");
  gate = await import("../src/gate.ts");
});

describe("what the agent is told when a human decides without typing", () => {
  test("a denial tells it not to retry, and what to do instead", async () => {
    const id = newId();
    const held = gate.submitGate(req({ id }), 60_000);
    gate.decideGate(id, "deny", ""); // the dashboard's Deny button: no text
    const { reason } = await held;

    // The regression itself.
    expect(reason).not.toBe("denied from dashboard");
    // A human looked at it — not a crash, not a timeout.
    expect(reason).toMatch(/human/i);
    // The two moves the old string left available are closed off, and an open
    // one is named. Without this an agent burns its next turn on a retry that
    // is guaranteed to be denied again.
    expect(reason).toMatch(/do not retry|don't retry/i);
    expect(reason).toMatch(/different approach|ask/i);
    // Long enough to actually say those things.
    expect(reason.length).toBeGreaterThan(60);
  });

  test("it is recorded with the request, not only handed to the waiter", () => {
    const id = newId();
    gate.submitGate(req({ id }), 60_000);
    gate.decideGate(id, "deny", "");
    // The hook re-attaching after a dropped connection reads the row, not the
    // promise — it has to get the same sentence.
    expect(db.getGate(id)!.reason).toBe(gate.defaultReason("deny"));
  });

  test("a reason the human typed wins, verbatim and unadorned", async () => {
    const id = newId();
    const held = gate.submitGate(req({ id }), 60_000);
    gate.decideGate(id, "deny", "wrong repo — you're in the vendored copy");
    await expect(held).resolves.toEqual({
      decision: "deny",
      reason: "wrong repo — you're in the vendored copy",
    });
  });

  test("an approval keeps a non-empty reason, because empty means something else", async () => {
    const id = newId();
    const held = gate.submitGate(req({ id }), 60_000);
    gate.decideGate(id, "allow", "");
    const { reason } = await held;
    // Not cosmetic: the hook only emits an explicit `allow` decision when the
    // reason is non-empty, and an explicit allow is what skips Claude Code's
    // own permission prompt. Blanking this would send the agent back to the
    // prompt a human just answered.
    expect(reason).not.toBe("");
    expect(reason).toMatch(/human/i);
  });
});

describe("the cases that must stay silent", () => {
  test("a fail-open timeout says nothing at all", async () => {
    const id = newId();
    await gate.submitGate(req({ id }), 1); // floored to 1s, then auto-resolves
    const row = db.getGate(id)!;
    expect(row.decision).toBe("allow");
    expect(row.resolution).toBe("timeout");
    // The inverse of the test above. Nobody looked at this call, so the hook
    // must fall through to Claude Code's normal prompt rather than force-allow;
    // giving the timeout a friendly default silently removes that prompt.
    expect(row.reason).toBe("");
  });

  test("the two human defaults stay distinct", () => {
    // Guards the tempting simplification of one sentence for both: an agent
    // that was allowed and one that was stopped need opposite next moves.
    expect(gate.defaultReason("deny")).not.toBe(gate.defaultReason("allow"));
  });
});

/*
 * End to end, through the hook.
 *
 * gate.ts writing a good sentence is only half of it: the value the agent
 * actually reads is whatever `gate_event.py` prints as
 * `permissionDecisionReason`. These run the real hook against a stub server, so
 * a change on either side that drops the reason on the floor fails here.
 */
const python = ["python3", "python", "py"].find(
  (exe) => spawnSync(exe, ["--version"], { stdio: "ignore" }).status === 0,
);

async function runHook(reply: { decision: string; reason: string }): Promise<any> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json(reply),
  });
  try {
    const proc = Bun.spawn(
      [python!, join(import.meta.dir, "..", "..", "hooks", "gate_event.py"), "--server", `http://127.0.0.1:${server.port}`],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, AGENTGLASS_INTERNAL: "" } },
    );
    proc.stdin.write(JSON.stringify({ session_id: "s1", tool_name: "Bash", tool_input: { command: "rm -rf /" } }));
    proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim() ? JSON.parse(out) : null;
  } finally {
    server.stop(true);
  }
}

describe("the hook hands the reason to Claude Code", () => {
  test.if(!!python)("the server's sentence arrives intact", async () => {
    // A sentinel rather than defaultReason(): what is under test here is that
    // the hook forwards whatever the server decided, byte for byte — including
    // the em dash — not that it agrees with gate.ts about the wording.
    const sentinel = "A human reviewed this — do not retry, try X instead.";
    const out = await runHook({ decision: "deny", reason: sentinel });
    expect(out?.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: sentinel,
    });
  });

  test.if(!!python)("and its own fallback is actionable too, for a denial with no reason", async () => {
    // An older server, or a decision recorded before this change, sends the
    // decision with an empty reason. The hook is the last thing standing
    // between that and the agent.
    const reason = (await runHook({ decision: "deny", reason: "" }))?.hookSpecificOutput?.permissionDecisionReason;
    expect(reason).not.toBe("denied from agentglass");
    expect(reason).toMatch(/do not retry|don't retry/i);
    expect(reason).toMatch(/different approach|ask/i);
  });
});

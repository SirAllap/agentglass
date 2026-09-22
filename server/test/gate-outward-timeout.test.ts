/*
 * An outward action nobody answers does not happen.
 *
 * The route holds a push, a comment or a message closed whatever the machine's
 * default is: work that has already left the machine cannot be blocked
 * afterwards. submitGate took that as a per-request `failClosed` and armed the
 * timer with it — and timeoutOutcome then read the machine-wide flag instead of
 * its own argument, so on a default install an outward action that nobody
 * answered was allowed when the hold expired.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-gate-outward-timeout-"));
const saved = { db: process.env.AGENTGLASS_DB, xdg: process.env.XDG_CONFIG_HOME };
process.env.AGENTGLASS_DB = join(dir, "gate.db");
process.env.XDG_CONFIG_HOME = dir;
afterAll(() => {
  for (const [k, v] of [["AGENTGLASS_DB", saved.db], ["XDG_CONFIG_HOME", saved.xdg]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

let gate: typeof import("../src/gate.ts");
let seq = 0;
const newId = () => `${crypto.randomUUID().slice(0, 24)}${String(++seq).padStart(12, "0")}`;
const req = (id: string) => ({ id, source_app: "orbit", session_id: "s-outward", tool_name: "Bash", summary: "git push origin main" });

beforeAll(async () => {
  gate = await import("../src/gate.ts");
});

test.skipIf(process.env.AGENTGLASS_GATE_FAILCLOSED === "1")(
  "a request held closed is denied when nobody answers, on a fail-open machine",
  async () => {
    const out = await gate.submitGate(req(newId()), 1000, undefined, true);
    expect(out.decision).toBe("deny");
    // Read by a model: it must say nobody looked, not that the call was wrong.
    expect(out.reason).toMatch(/not a judgement/i);
  },
);

test.skipIf(process.env.AGENTGLASS_GATE_FAILCLOSED === "1")(
  "and an ordinary request on the same machine still falls through when nobody answers",
  async () => {
    expect(await gate.submitGate(req(newId()), 1000)).toEqual({ decision: "allow", reason: "" });
  },
);

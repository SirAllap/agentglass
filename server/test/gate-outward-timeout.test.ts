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
let db: typeof import("../src/db.ts");
let seq = 0;
const newId = () => `${crypto.randomUUID().slice(0, 24)}${String(++seq).padStart(12, "0")}`;
const req = (id: string) => ({ id, source_app: "orbit", session_id: "s-outward", tool_name: "Bash", summary: "git push origin main" });

beforeAll(async () => {
  db = await import("../src/db.ts");
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

/*
 * Across a restart. The held-closed flag lived only on the timer, so a server
 * that restarted re-armed an outward hold under the machine's fail-open
 * default, and one whose window closed while it was down was resolved as an
 * allow. The row now carries it.
 */
test.skipIf(process.env.AGENTGLASS_GATE_FAILCLOSED === "1")(
  "a held-closed request says so in its row",
  async () => {
    const id = newId();
    void gate.submitGate(req(id), 60_000, "This pushes commits off this machine (origin main)", true);
    expect(db.getGate(id)!.fail_closed).toBe(1);
    // The line a person decides from, too: it lived only in memory.
    expect(db.getGate(id)!.note).toBe("This pushes commits off this machine (origin main)");
    const open = newId();
    void gate.submitGate(req(open), 60_000);
    expect(db.getGate(open)!.fail_closed).toBe(0);
    expect(db.getGate(open)!.note).toBeNull();
    // Leave nothing held for the next file in this process.
    gate.decideGate(id, "deny", "done");
    gate.decideGate(open, "deny", "done");
  },
);

test.skipIf(process.env.AGENTGLASS_GATE_FAILCLOSED === "1")(
  "after a restart it is still denied when nobody answers — live, or already expired",
  async () => {
    // A second module instance is a restarted process: the database is shared,
    // the in-memory queue is not. Same trick as gate-durability.test.ts.
    const restarted = "../src/gate.ts?restart-closed=1";
    const fresh = await import(restarted) as typeof import("../src/gate.ts");
    const now = Date.now();
    const live = newId(), stale = newId(), openStale = newId();
    db.recordGate({ ...req(live), created: now, expires: now + 1000, fail_closed: true, note: "This pushes commits off this machine" });
    db.recordGate({ ...req(stale), created: now - 300_000, expires: now - 60_000, fail_closed: true });
    db.recordGate({ ...req(openStale), created: now - 300_000, expires: now - 60_000 });
    fresh.restoreGates();
    // Restored with the line that says what it does, not only the summary.
    expect(fresh.pendingGates().find((g) => g.id === live)?.budget).toBe("This pushes commits off this machine");

    expect(db.getGate(stale)!.decision).toBe("deny");
    expect(db.getGate(stale)!.resolution).toBe("restart");
    // The fail-open default is untouched for everything else.
    expect(db.getGate(openStale)!.decision).toBe("allow");

    const out = await fresh.awaitGate(live);
    expect(out?.decision).toBe("deny");
  },
  10_000,
);

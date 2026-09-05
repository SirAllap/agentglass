// How long the gate waits, and who gets to say.
//
// The gate shipped waiting 60 seconds and then allowing the call anyway. That is
// the feature failing in exactly the situation it was built for: you are not at
// the desk, you do not see the phone for two minutes, and the call nobody looked
// at goes through — recorded as a timeout, which reads like a decision and isn't.
// So the default is five minutes, and a single global number is no longer the
// only thing an operator can say: a hook entry can ask for its own window, since
// a `Bash` matcher gating a destructive command deserves more patience than one
// watching file writes.
//
// The disposition is deliberately NOT changed here: a lapsed window still allows.
// Flipping that would start blocking agents on somebody's machine after an
// upgrade, and that is theirs to choose with AGENTGLASS_GATE_FAILCLOSED=1.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-gate-def-"));
process.env.AGENTGLASS_DB = join(dir, "gate.db");
process.env.XDG_CONFIG_HOME = dir; // keep the developer's own scope out of it
// The knob is read once, at import, so the shipped default is only observable
// with the operator's override out of the way.
delete process.env.AGENTGLASS_GATE_TIMEOUT;

let gate: typeof import("../src/gate.ts");
let db: typeof import("../src/db.ts");

// Same reason as gate-durability.test.ts: db.ts binds its file at import, so in
// a full run this suite can land on a database that already has yesterday's
// rows, and a fixed id would replay a recorded decision instead of taking a new
// request. Unique per run, deterministic per assertion.
let seq = 0;
const newId = () => `${crypto.randomUUID().slice(0, 24)}${String(++seq).padStart(12, "0")}`;

const req = (over: Record<string, unknown> = {}) => ({
  source_app: "orbit",
  session_id: "11111111-2222-3333-4444-555555555555",
  tool_name: "Bash",
  summary: "rm -rf build",
  ...over,
});

/** The window a held request actually got, in ms. */
const windowOf = (id: string) => {
  const row = db.getGate(id)!;
  return row.expires - row.created;
};

beforeAll(async () => {
  db = await import("../src/db.ts");
  gate = await import("../src/gate.ts");
});

describe("the default wait is long enough for a human to reach", () => {
  test("five minutes, not one", () => {
    expect(gate.GATE_DEFAULT_MS).toBe(300_000);
  });

  test("a request that names no window gets it", () => {
    const id = newId();
    // NaN stands for every caller that hands over nothing usable — a body with
    // no timeout_ms, a settings.json with a typo in it.
    gate.submitGate(req({ id }), NaN);
    expect(windowOf(id)).toBe(gate.GATE_DEFAULT_MS);
  });

  test("the ceiling never clips the default", () => {
    // A ceiling below the default would quietly shorten the patient matchers,
    // which are the ones gating something worth waiting for.
    expect(gate.GATE_MAX_MS).toBeGreaterThanOrEqual(gate.GATE_DEFAULT_MS);
  });
});

describe("patience is per matcher, not one number for the machine", () => {
  test("two hook entries can ask for two different windows", () => {
    // The `Bash` matcher on a destructive command, and the one on file writes.
    const patient = newId(), brisk = newId();
    gate.submitGate(req({ id: patient }), 240_000);
    gate.submitGate(req({ id: brisk }), 30_000);
    expect(windowOf(patient)).toBe(240_000);
    expect(windowOf(brisk)).toBe(30_000);
  });

  test("an override still cannot outrun the ceiling", () => {
    // Every held request pins a connection and a timer, so a settings.json
    // asking for a day is clamped rather than obeyed. Raising the ceiling is the
    // operator's move, through AGENTGLASS_GATE_TIMEOUT on the server.
    const id = newId();
    gate.submitGate(req({ id }), 86_400_000);
    expect(windowOf(id)).toBe(gate.GATE_MAX_MS);
  });

  test("an override still cannot become an instant auto-allow", () => {
    const id = newId();
    gate.submitGate(req({ id }), -1);
    expect(windowOf(id)).toBe(1000); // the floor, not a window of zero
  });
});

/**
 * The two halves of the gate live in different languages and neither imports the
 * other: the hook decides how long it is willing to hold, the server decides how
 * long it will hold for, and the smaller of the two wins in practice. Drift is
 * therefore silent — nothing errors, the wait somebody configured is just not the
 * wait they get — which is why the number is pinned from here rather than trusted
 * to stay in step.
 */
describe("the hook and the server agree on the default", () => {
  test("hooks/gate_event.py names the same number", () => {
    const py = readFileSync(join(import.meta.dir, "..", "..", "hooks", "gate_event.py"), "utf8");
    const m = py.match(/^DEFAULT_TIMEOUT = (\d+)$/m);
    // A rename counts as drift too: if this constant is gone, the lock is gone.
    expect(m).not.toBeNull();
    expect(Number(m![1]) * 1000).toBe(gate.GATE_DEFAULT_MS);
  });
});

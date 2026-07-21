// The gate is the one feature whose job is human oversight, and it used to keep
// its pending requests in a Map and nowhere else. A restart dropped them, the
// hook's long-poll fell into its timeout branch, and "waiting for a human"
// silently became "auto-allowed" — the worst possible failure for this feature.
//
// These tests drive the real module against a throwaway DB and simulate the
// restart by re-importing it with a fresh module registry, because the whole
// regression is "the state only existed in this process".
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-gate-"));
process.env.AGENTGLASS_DB = join(dir, "gate.db");
process.env.XDG_CONFIG_HOME = dir; // keep the developer's own scope out of it

/**
 * Ids are minted per run, not written down.
 *
 * db.ts binds its file at import, and whichever suite imports it first decides
 * that file for the whole process — so in a full `bun test` this suite can end
 * up on the developer's real database instead of the temp one above. With fixed
 * ids that made the second run fail: the rows from the first were still there,
 * and submitGate correctly replayed their recorded decisions instead of taking
 * a new request. Deterministic per assertion, unique per run.
 */
let seq = 0;
const newId = () => `${crypto.randomUUID().slice(0, 24)}${String(++seq).padStart(12, "0")}`;

let gate: typeof import("../src/gate.ts");
let db: typeof import("../src/db.ts");

const req = (over: Record<string, unknown> = {}) => ({
  source_app: "orbit",
  session_id: "11111111-2222-3333-4444-555555555555",
  tool_name: "Bash",
  summary: "rm -rf build",
  ...over,
});

beforeAll(async () => {
  db = await import("../src/db.ts");
  gate = await import("../src/gate.ts");
});

describe("a gate request outlives the process that took it", () => {
  test("it is written to the database the moment it arrives", () => {
    const id = newId();
    gate.submitGate(req({ id }), 60_000); // held: nobody decides it here
    const row = db.getGate(id);
    expect(row).not.toBeNull();
    expect(row!.decision).toBeNull(); // pending, not resolved
    expect(row!.tool_name).toBe("Bash");
    expect(row!.expires).toBeGreaterThan(Date.now());
  });

  test("a decision is recorded, with who made it", async () => {
    const id = newId();
    const held = gate.submitGate(req({ id }), 60_000);
    expect(gate.decideGate(id, "deny", "not on my watch")).toBe(true);
    await expect(held).resolves.toEqual({ decision: "deny", reason: "not on my watch" });
    const row = db.getGate(id)!;
    expect(row.decision).toBe("deny");
    expect(row.resolution).toBe("human");
    expect(row.decided_at).toBeGreaterThan(0);
  });

  test("a timeout is an outcome with a record, not a disappearance", async () => {
    const id = newId();
    // Floored to 1s by submitGate — a gate can never auto-resolve instantly.
    await gate.submitGate(req({ id }), 1);
    const row = db.getGate(id)!;
    expect(row.decision).toBe("allow"); // fail-open default
    expect(row.resolution).toBe("timeout");
    expect(gate.pendingGates().some((g) => g.id === id)).toBe(false);
  });

  test("deciding twice is refused — the first answer stands", async () => {
    const id = newId();
    const held = gate.submitGate(req({ id }), 60_000);
    expect(gate.decideGate(id, "allow", "ok")).toBe(true);
    await held;
    expect(gate.decideGate(id, "deny", "changed my mind")).toBe(false);
    expect(db.getGate(id)!.decision).toBe("allow");
  });

  test("an unknown id is not decidable", () => {
    expect(gate.decideGate(newId(), "allow", "")).toBe(false);
  });
});

describe("re-attaching after the connection drops", () => {
  test("a pending request can be waited on again, and the new waiter is the one answered", async () => {
    const id = newId();
    gate.submitGate(req({ id }), 60_000); // the original connection, now "dropped"
    const again = gate.awaitGate(id) as Promise<{ decision: string; reason: string }>;
    expect(again).toBeInstanceOf(Promise);
    gate.decideGate(id, "allow", "approved from dashboard");
    await expect(again).resolves.toEqual({ decision: "allow", reason: "approved from dashboard" });
  });

  test("a decision made while the hook was away is replayed, not lost", async () => {
    const id = newId();
    gate.submitGate(req({ id }), 60_000);
    gate.decideGate(id, "deny", "no");
    expect(gate.awaitGate(id)).toEqual({ decision: "deny", reason: "no" });
  });

  test("an id the server never saw returns null — the hook must not read that as approval", () => {
    expect(gate.awaitGate(newId())).toBeNull();
    expect(gate.awaitGate("not-a-uuid")).toBeNull();
  });

  test("re-submitting the same id re-attaches instead of raising a second prompt", async () => {
    const id = newId();
    gate.submitGate(req({ id }), 60_000);
    const before = gate.pendingGates().filter((g) => g.id === id).length;
    const retry = gate.submitGate(req({ id }), 60_000);
    expect(gate.pendingGates().filter((g) => g.id === id).length).toBe(before);
    gate.decideGate(id, "allow", "once");
    await expect(retry).resolves.toEqual({ decision: "allow", reason: "once" });
  });

  test("a client-supplied id that isn't uuid-shaped is replaced, not trusted", async () => {
    const held = gate.submitGate(req({ id: "../../etc/passwd" }), 1);
    await held;
    expect(db.getGate("../../etc/passwd")).toBeNull();
  });
});

describe("restart", () => {
  // A second module registry = a second process, sharing only the database.
  // This is the actual claim under test: the queue comes back from disk.
  test("still-live requests return to the queue; expired ones resolve and are recorded", async () => {
    const live = newId();
    const stale = newId();
    // Only gate.ts is re-imported: the database is the thing that survives, so
    // it stays shared on purpose. What comes back empty is the in-memory queue.
    // Indirected through a variable: the query string is what forces a second
    // instance, and tsc can't resolve it as a literal specifier.
    const restarted = "../src/gate.ts?restart=1";
    const fresh = await import(restarted) as typeof import("../src/gate.ts");
    expect(fresh.pendingGates()).toHaveLength(0); // the process that held them is gone

    const now = Date.now();
    db.recordGate({ ...req(), id: live, summary: "still waiting", created: now, expires: now + 120_000 });
    db.recordGate({ ...req(), id: stale, summary: "died in flight", created: now - 300_000, expires: now - 60_000 });

    // Counts are >= because the tests above left their own rows in this DB —
    // which is itself the point: a restart picks up everything still open.
    const { restored, expired } = fresh.restoreGates();
    expect(restored).toBeGreaterThanOrEqual(1);
    expect(expired).toBeGreaterThanOrEqual(1);

    // The live one is back in "what needs you", and still decidable.
    expect(fresh.pendingGates().map((g) => g.id)).toContain(live);
    expect(fresh.decideGate(live, "deny", "caught it")).toBe(true);
    expect(db.getGate(live)!.resolution).toBe("human");

    // The one whose window closed while the server was down did not vanish: it
    // has an outcome, attributed to the restart, and it shows up in history.
    const gone = db.getGate(stale)!;
    expect(gone.decision).toBe("allow"); // fail-open default
    expect(gone.resolution).toBe("restart");
    expect(gone.reason).toContain("while the server was down");
    expect(db.gateHistory(50).map((g) => g.id)).toContain(stale);
  });
});

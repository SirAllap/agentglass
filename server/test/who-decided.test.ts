/*
 * Which human, not just that one of them answered — #299.
 *
 * The action log (#389) answered "what was done through this cockpit" and
 * answered "who" with an address, which was the most a shared token could
 * honestly support. A paired device has its own credential and a name somebody
 * accepted (devices.ts), so the honest answer got better, and the gate row —
 * the one write with a stopped agent on the other end of it — now carries it.
 *
 * The two facts this file exists to keep apart:
 *
 *   - a decision somebody made, and one the clock made. An actor attached to a
 *     timeout would be a lie about the single outcome nobody chose.
 *   - two devices with the same name. "A device" is the *default* label, so a
 *     bare label is a collision waiting to happen rather than a rare one.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actorOf, deviceActor } from "../src/actions.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-whodecided-"));
process.env.AGENTGLASS_DB = join(dir, "who.db");
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");
let gate: typeof import("../src/gate.ts");
beforeAll(async () => {
  db = await import("../src/db.ts");
  gate = await import("../src/gate.ts");
});

let n = 0;
/** A gate row, held. Uuid-shaped because gate.ts refuses anything else. */
function held(): string {
  const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  db.recordGate({
    id, source_app: "claude", session_id: "s1", tool_name: "Bash",
    summary: "rm -rf build", created: Date.now(), expires: Date.now() + 60_000,
  });
  return id;
}
const row = (id: string) => db.getGate(id)!;

describe("naming a device", () => {
  test("carries its id, because the default label collides with itself", () => {
    // `issueDevice` names an unlabelled phone "A device". Two of those in a log
    // are indistinguishable, which answers "who approved that" worse than the
    // address this replaced.
    const a = deviceActor({ id: "3f9c21aa11", label: "A device" });
    const b = deviceActor({ id: "77b40e0022", label: "A device" });
    expect(a).not.toBe(b);
    expect(a).toContain("A device");
    expect(a).toContain("3f9c21");
  });

  test("and cannot be mistaken for the machine or for an address", () => {
    // The label is free text the device chose for itself. Its own id riding
    // along is what keeps a phone that calls itself "local" from producing a
    // line that reads as this machine's dashboard.
    expect(deviceActor({ id: "3f9c21aa11", label: "local" })).not.toBe("local");
    expect(deviceActor({ id: "3f9c21aa11", label: "192.168.1.9" })).not.toBe("192.168.1.9");
  });

  test("a device with no name at all still has one", () => {
    expect(deviceActor({ id: "3f9c21aa11", label: "" })).toBe("device · 3f9c21");
  });

  test("and a long one is cut rather than kept whole", () => {
    // 60 characters are allowed at pairing; a log line is not the place to
    // spend them.
    const long = deviceActor({ id: "3f9c21aa11", label: "x".repeat(200) });
    expect(long.length).toBeLessThan(60);
  });
});

describe("who the server says it was", () => {
  test("a paired device is its name, not the address it happens to be on", () => {
    // The whole point. A phone on DHCP is a different address next week and the
    // same phone, and the address was never the thing anybody wanted to know.
    const caller = { kind: "device" as const, device: { id: "3f9c21aa11", label: "iPhone" } };
    expect(actorOf("192.168.1.9", caller)).toBe("iPhone · 3f9c21");
    // Even from loopback: a device credential identifies a device wherever it is.
    expect(actorOf("127.0.0.1", caller)).toBe("iPhone · 3f9c21");
  });

  test("the machine's own token is still a place, because it is shared", () => {
    // It is one secret for the whole machine. Any name for it would be invented.
    expect(actorOf("127.0.0.1", { kind: "machine" })).toBe("local");
    expect(actorOf("192.168.1.9", { kind: "machine" })).toBe("192.168.1.9");
  });

  test("and with no caller at all it is what it always was", () => {
    expect(actorOf("127.0.0.1")).toBe("local");
    expect(actorOf("192.168.1.9")).toBe("192.168.1.9");
    expect(actorOf(null)).toBe("local");
  });
});

describe("the gate row", () => {
  test("keeps who decided it, in the same write that resolves it", () => {
    // On the row rather than only in `actions`, because the two cannot be
    // joined: an action line carries a clipped `tool · summary`, so two gates
    // on the same tool a second apart are one line each and indistinguishable.
    const id = held();
    expect(gate.decideGate(id, "deny", "not on prod", "iPhone · 3f9c21")).toBe(true);
    expect(row(id)).toMatchObject({
      decision: "deny", resolution: "human", decided_by: "iPhone · 3f9c21", reason: "not on prod",
    });
  });

  test("and nobody, when nobody decided", () => {
    // The distinction with teeth. A timeout is not an actor, and a row saying
    // "local allowed this" about a request that expired unread is the exact
    // lie an audit trail exists to prevent.
    const id = held();
    db.resolveGateRow(id, "allow", "", "timeout");
    expect(row(id)).toMatchObject({ resolution: "timeout", decided_by: null });

    const other = held();
    db.resolveGateRow(other, "allow", "", "restart", Date.now());
    expect(row(other).decided_by).toBeNull();
  });

  test("an actor handed in with a timeout is refused rather than stored", () => {
    // Defence in depth on the one field whose value is that it cannot be
    // wrong: the caller passing null is the rule, and this is what happens if
    // some future path forgets.
    const id = held();
    db.resolveGateRow(id, "allow", "", "timeout", Date.now(), "iPhone · 3f9c21");
    expect(row(id).decided_by).toBeNull();
  });

  test("a decision that lost the race writes nothing at all", () => {
    // The clock got there first. The row must keep the outcome the agent was
    // actually given, and must not acquire an actor who did not produce it.
    const id = held();
    db.resolveGateRow(id, "allow", "", "timeout");
    expect(gate.decideGate(id, "deny", "too late", "iPhone · 3f9c21")).toBe(false);
    expect(row(id)).toMatchObject({ decision: "allow", resolution: "timeout", decided_by: null });
  });

  test("and the row itself refuses the second write, not just the caller", () => {
    /*
     * `decideGate` reads the row first and returns false, so the guard in the
     * UPDATE never fires through that path — which is precisely why it is worth
     * a test of its own. The read and the write are not one transaction: a
     * timeout firing between them is a real interleaving, and the whole point
     * of an append-once record is that the winner cannot be edited afterwards
     * by anything, including this module.
     */
    const id = held();
    db.resolveGateRow(id, "deny", "a person said no", "human", Date.now(), "iPhone · 3f9c21");
    db.resolveGateRow(id, "allow", "", "timeout");
    expect(row(id)).toMatchObject({
      decision: "deny", resolution: "human", decided_by: "iPhone · 3f9c21", reason: "a person said no",
    });
  });

  test("it is in the history, which is where anybody would look", () => {
    const id = held();
    gate.decideGate(id, "allow", "", "Pixel · aa00bb");
    const found = db.gateHistory(50).find((g) => g.id === id)!;
    expect(found.decided_by).toBe("Pixel · aa00bb");
  });
});

describe("the reason, as a reader sees it", () => {
  test("what a person typed comes back", () => {
    const id = held();
    gate.decideGate(id, "deny", "we do not run migrations from here", "local");
    expect(gate.typedReason(row(id))).toBe("we do not run migrations from here");
  });

  test("and the paragraph written for the model does not", () => {
    /*
     * `decideGate` backfills an empty reason, because the string travels to a
     * model that has just been stopped and needs something it can act on. Every
     * gate anybody waved through therefore carries the same three lines, and a
     * history quoting them back is boilerplate on every row hiding the one row
     * where somebody explained themselves.
     *
     * Compared against the real function rather than a copy of its text, so
     * this cannot pass while the history quotes a default it stopped
     * recognising.
     */
    for (const d of ["allow", "deny"] as const) {
      const id = held();
      gate.decideGate(id, d, "");
      expect(row(id).reason).toBe(gate.defaultReason(d));
      expect(gate.typedReason(row(id)), d).toBe("");
    }
  });

  test("and a timeout's empty reason stays empty", () => {
    // Empty on purpose: a non-empty reason makes the hook force-allow and skip
    // Claude Code's own permission prompt, which an auto-allow must not do.
    const id = held();
    db.resolveGateRow(id, "allow", "", "timeout");
    expect(gate.typedReason(row(id))).toBe("");
  });
});

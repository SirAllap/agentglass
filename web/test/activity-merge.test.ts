/*
 * One list of what happened, from two records that overlap — #299.
 *
 * The action log holds what a *person* asked for. The gates table holds the
 * fate of every held tool call, which is not the same set: a request the
 * timeout allowed changed what an agent did and has no action row at all,
 * because nobody made a request for it.
 *
 * The two failures worth guarding are opposite. Drop too little and every gate
 * appears twice, once with the actor and once without, and a reader has to work
 * out which line to believe. Drop too much and the presses that *failed*
 * disappear — and the press that failed is the one somebody is looking for,
 * because it is the moment they thought they denied something that was already
 * allowed.
 */
import { describe, expect, test } from "bun:test";
import { mergeActivity, gateLine, actorLabel } from "../src/lib/activity.ts";
import type { ActionRecord, GateRecord } from "../../shared/types.ts";

const action = (o: Partial<ActionRecord>): ActionRecord => ({
  id: 1, at: 1_000, actor: "local", action: "/git/push", target: "repo", ok: true, detail: null, ...o,
});

const gate = (o: Partial<GateRecord>): GateRecord => ({
  id: "g1", source_app: "claude", session_id: "s", tool_name: "Bash", summary: "rm -rf build",
  created: 900, expires: 9_000, decision: "allow", reason: null,
  resolution: "human", decided_at: 1_000, decided_by: "local", ...o,
});

describe("what ends up in the list", () => {
  test("a gate the timeout decided, which exists in no action row", () => {
    // The hole this closes. Nobody made a request, so the log that records
    // requests has nothing — and the agent was allowed to run the command.
    const rows = mergeActivity([], [gate({ resolution: "timeout", decided_by: null })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("gate");
  });

  test("a successful gate press once, from the record that knows more", () => {
    // Both sources have it. The gate row carries the actor, the untruncated
    // summary and the reason; the action line carries a clipped `tool ·
    // summary`. Showing both would make a reader pick.
    const rows = mergeActivity([action({ action: "/gate/allow", target: "Bash · rm -rf build" })], [gate({})]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("gate");
  });

  test("but a gate press that FAILED is kept, because nothing else has it", () => {
    // Somebody pressed deny on a request the clock had already allowed. The
    // gates table only ever holds the press that won.
    const rows = mergeActivity(
      [action({ action: "/gate/deny", ok: false, at: 2_000 })],
      [gate({ resolution: "timeout", decided_by: null })],
    );
    expect(rows.map((r) => r.kind)).toEqual(["action", "gate"]);
  });

  test("and a gate still being held is not history yet", () => {
    expect(mergeActivity([], [gate({ decided_at: null })])).toHaveLength(0);
  });

  test("newest first, across both sources", () => {
    const rows = mergeActivity(
      [action({ id: 7, at: 3_000 }), action({ id: 8, at: 1_000 })],
      [gate({ id: "gx", decided_at: 2_000 })],
    );
    expect(rows.map((r) => r.at)).toEqual([3_000, 2_000, 1_000]);
  });

  test("with keys that cannot collide between the two", () => {
    // An action id is a number and a gate id is a uuid, so nothing collides
    // today — but a list keyed on a bare id is one schema change away from
    // React reusing a row for a different event, and the id chosen here is
    // exactly the one an un-prefixed key would land on.
    const rows = mergeActivity([action({ id: 1 })], [gate({ id: "a1" })]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });
});

describe("what a resolved gate is called", () => {
  test("a person approved it; the clock allowed it", () => {
    /*
     * The distinction this pane exists for. "allowed" for a call somebody read
     * and "allowed" for one that expired while they were at lunch are opposite
     * facts about whether anybody looked, and in a list of past-tense verbs
     * they are one glance apart.
     */
    expect(gateLine(gate({ resolution: "human" })).verb).toBe("approved");
    expect(gateLine(gate({ resolution: "timeout", decided_by: null })).verb).toBe("allowed");
  });

  test("and the one nobody saw says so out loud", () => {
    expect(gateLine(gate({ resolution: "timeout", decided_by: null })).note).toMatch(/nobody answered/);
    expect(gateLine(gate({ resolution: "restart", decided_by: null })).note).toMatch(/server was down/);
    // A human decision needs no excuse attached to it.
    expect(gateLine(gate({ resolution: "human" })).note).toBe("");
  });

  test("a denial reads as a denial either way", () => {
    expect(gateLine(gate({ decision: "deny", resolution: "human" })).verb).toBe("denied");
    // Fail-closed: the timeout blocked it, and nobody chose that either.
    expect(gateLine(gate({ decision: "deny", resolution: "timeout", decided_by: null })).verb).toBe("denied");
  });
});

describe("who it is shown against", () => {
  test("a phone is named", () => {
    expect(actorLabel({ kind: "gate", at: 1, key: "g", row: gate({ decided_by: "Pixel 9 · aa00bb" }) }))
      .toBe("Pixel 9 · aa00bb");
  });

  test("this machine's own dashboard is not, because it is most of the list", () => {
    expect(actorLabel({ kind: "gate", at: 1, key: "g", row: gate({ decided_by: "local" }) })).toBe("");
    expect(actorLabel({ kind: "action", at: 1, key: "a", row: action({ actor: "local" }) })).toBe("");
  });

  test("and nothing is claimed about an outcome nobody chose", () => {
    // Rendering "local" over a timeout would put this machine's name on a
    // decision nobody made.
    expect(actorLabel({ kind: "gate", at: 1, key: "g", row: gate({ resolution: "timeout", decided_by: null }) }))
      .toBe("");
  });
});

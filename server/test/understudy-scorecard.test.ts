/*
 * The score, and the four ways a class fails to earn a promotion.
 *
 * The pair worth reading first is 57 of 80 against 56 of 80. Both are the same
 * decision to a raw ratio — 0.7125 and 0.7000, either side of a 0.70 floor by a
 * whisker — and the Wilson lower bound calls them 0.6054 and 0.5923, one over
 * the 0.60 gate and one under it. That difference is the entire argument for
 * scoring against the bound, so both are asserted here, and the 56 case is
 * asserted down to WHICH sentence blocks it: if that class ever comes back
 * blocked on the ratio instead, the bound has stopped being the thing that
 * decides and nobody would notice from a boolean.
 *
 * The other two are not about arithmetic at all. A `key` class with a perfect
 * record is still not offered, and an agent tolerating something eighty times
 * is not eighty agreements.
 *
 * ISOLATION: `bun test` shares one module registry across files, so every
 * understudy test file owns its own classes rather than its own database — this
 * one is the only user of C2, C3, C6 and C8, and the seal counts it asserts are
 * measured as a delta across its own writes for the same reason.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wilsonLower } from "../../shared/wilson.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-understudy-score-"));
process.env.AGENTGLASS_DB = join(dir, "score.db");
process.env.XDG_CONFIG_HOME = dir;

let u: typeof import("../src/understudy.ts");

/**
 * `n` scored decisions for one class, `hits` of them agreements.
 *
 * Times are explicit and the prediction always lands a millisecond before the
 * actual, so nothing here is accidentally late — `late` is its own test, in
 * understudy-seal-order.test.ts, and a stray late row would change no number
 * on this page but would make the seal counts below wrong for a reason nobody
 * would find.
 *
 * The disagreements are the LAST rows written, which is why `bank` reads 0 for
 * the classes built with any: the bank is agreements since the most recent
 * differ, and the most recent differ is at the end.
 */
function build(cls: string, n: number, hits: number, provenance = "typed"): void {
  const t0 = Date.now() - 7 * 24 * 3600 * 1000;
  for (let i = 0; i < n; i++) {
    const subject = `${cls}-orbit-${i}`;
    const at = t0 + i * 1000;
    /*
     * The ANSWERS alternate and the PREDICTION is what varies, and both halves
     * of that are load-bearing.
     *
     * The first version of this helper had the answer be "base" for the first
     * `hits` rows and "release" for the rest. The prediction was a constant, so
     * "always answer what you answered last time" scored exactly what the model
     * scored — a fixture in which the model contributes nothing. That was
     * invisible while the gate only checked the count, the ratio and the bound;
     * the moment the gate started requiring an edge over the baseline, all four
     * of these tests failed, and they were right to.
     *
     * Alternating answers give the constant a ~50% baseline. Agreement is then
     * produced by predicting correctly `hits` times, which is what these tests
     * are actually about.
     */
    const answer = i % 2 === 0 ? "the base branch" : "the release branch";
    const guess = i < hits ? answer : (answer === "the base branch" ? "the release branch" : "the base branch");
    const id = u.sealSituation(cls, { subject, repo: "orbit", partition: "agentglass", body: `situation ${i}`, at });
    u.recordPrediction(id, { pick: guess }, at + 1);
    u.recordDecision(cls, {
      subject,
      repo: "orbit",
      actual: { pick: answer },
      provenance,
      at: at + 2,
    });
  }
}

const rowFor = (cls: string) => u.scorecard().classes.find((c) => c.id === cls)!;

let before: { sealed: number; predicted: number; late: number; unsealed: number };

beforeAll(async () => {
  u = await import("../src/understudy.ts");
  u.__setUnderstudyStorePath(join(dir, "understudy.json"));
  u.__setPrivateTermsPath(join(dir, "no-terms-here.txt"));
  u.setEnabled(true);
  before = u.scorecard().seals;

  build("C2", 80, 57);
  build("C3", 80, 56);
  build("C6", 80, 80);
  build("C8", 80, 80, "agent-tolerated");
});

describe("the threshold", () => {
  test("57 of 80 clears the bound and is offered", () => {
    const row = rowFor("C2");
    expect(row.n).toBe(80);
    expect(row.hits).toBe(57);
    expect(Number(row.raw.toFixed(4))).toBe(0.7125);
    expect(Number(row.lb.toFixed(4))).toBe(0.6054);
    expect(row.offered).toBe(true);
    expect(u.offered("C2")).toBe(true);
    expect(row.blocked).toEqual([]);
  });

  test("56 of 80 does not, and the bound is what stops it", () => {
    const row = rowFor("C3");
    expect(row.n).toBe(80);
    expect(row.hits).toBe(56);
    // Exactly the floor, to the fourth decimal. The ratio gate passes this
    // class; if it ever starts failing on the ratio instead, the two gates have
    // swapped roles and the bound is no longer the thing deciding anything.
    expect(Number(row.raw.toFixed(4))).toBe(0.7);
    expect(Number(row.lb.toFixed(4))).toBe(0.5923);
    expect(row.offered).toBe(false);
    expect(u.offered("C3")).toBe(false);
    expect(row.blocked).toHaveLength(1);
    expect(row.blocked[0]).toContain("pessimistic");
    expect(row.blocked[0]).toContain("56 out of 80");
  });

  test("the panel is handed sentences and derives nothing", () => {
    // A client that has to turn ["lb"] into a sentence owns half the policy: it
    // needs the threshold and it needs to know which bound, and the day the
    // threshold moves there are two places to change, one of them cached in
    // somebody's browser. Every entry is a finished sentence.
    for (const c of u.scorecard().classes) {
      for (const b of c.blocked) {
        expect(b.length, `${c.id} blocked entry is a code, not a sentence`).toBeGreaterThan(24);
        expect(b.endsWith("."), `${c.id}: "${b}"`).toBe(true);
      }
    }
  });

  test("an empty class says the one thing that is true about it", () => {
    // Not three sentences. With no scored decisions the ratio and the bound are
    // both 0, and reporting them as failures would bury the only fact that
    // matters, which is that nobody has watched it yet.
    const row = rowFor("C13");
    expect(row.n).toBe(0);
    expect(row.raw).toBe(0);
    expect(row.lb).toBe(0);
    expect(row.blocked).toHaveLength(1);
    expect(row.blocked[0]).toContain("0 of the 80");
  });

  test("the gate agrees with the one implementation of the bound", () => {
    // shared/wilson.ts exists so a UI ladder and a server gate cannot disagree
    // in the fourth decimal. This is that claim, checked rather than trusted.
    expect(rowFor("C2").lb).toBe(wilsonLower(57, 80));
    expect(rowFor("C3").lb).toBe(wilsonLower(56, 80));
    expect(u.OFFER_MIN_N).toBe(80);
    expect(u.OFFER_MIN_RAW).toBe(0.7);
    expect(u.OFFER_MIN_LB).toBe(0.6);
  });
});

describe("what does not count", () => {
  test("an agent tolerating something eighty times is not eighty agreements", () => {
    const row = rowFor("C8");
    // Eighty rows exist and every one of them "agreed". None of them is a
    // person, so none of them is in the denominator — counting them would let
    // the understudy grade its own homework.
    expect(row.n).toBe(0);
    expect(row.hits).toBe(0);
    expect(row.offered).toBe(false);
    expect(row.blocked[0]).toContain("typed or clicked");
  });

  test("a key class with a perfect record is still not offered", () => {
    const row = rowFor("C6");
    expect(row.n).toBe(80);
    expect(row.hits).toBe(80);
    expect(row.raw).toBe(1);
    expect(row.lb).toBeGreaterThan(u.OFFER_MIN_LB);
    expect(row.lock).toBe("key");
    expect(row.offered).toBe(false);
    expect(u.offered("C6")).toBe(false);
    // One sentence, and it is about the lock rather than about the numbers —
    // every numeric gate passes. "This one is at 1.00 and still shadow" is the
    // question the scorecard gets asked most, and the answer sits next to it.
    expect(row.blocked).toHaveLength(1);
    expect(row.blocked[0]).toContain("shadow");
    expect(row.blocked[0]).toContain("v1");
  });

  test("the sealed class says it is a decision, not a score", () => {
    const row = u.scorecard().classes.find((c) => c.id === "C12")!;
    expect(row.lock).toBe("sealed");
    expect(row.offered).toBe(false);
    expect(row.blocked[0]).toContain("for ever");
  });

  test("the bank is agreements since the last differ", () => {
    // C6 never disagreed, so its whole record is the streak. C2 and C3 both end
    // on a differ, which is the number a person actually reads: "it has been
    // right the last eighty times" lands where a bound of 0.61 does not.
    expect(rowFor("C6").bank).toBe(80);
    expect(rowFor("C2").bank).toBe(0);
    expect(rowFor("C3").bank).toBe(0);
  });
});

describe("the seal discipline, reported alongside the score", () => {
  test("every situation this file sealed got a prediction, on time", () => {
    const after = u.scorecard().seals;
    expect(after.sealed - before.sealed).toBe(320);
    expect(after.predicted - before.predicted).toBe(320);
    expect(after.late - before.late).toBe(0);
    expect(after.unsealed - before.unsealed).toBe(0);
  });
});

describe("nothing promotes itself", () => {
  test("the frame reports the ceiling, and it stops below irreversible", () => {
    /*
     * The ceiling moved from `shadow` to `auto-undo`, and what stops it there
     * is a fact rather than a preference: `auto` means acting with no way back,
     * and every action in the bridge table is reversible with its recipe
     * written out. A ceiling above the highest rung anything can reach would be
     * a promise nothing keeps.
     */
    const frame = u.scorecard();
    expect(frame.level).toBe("auto-undo");
    expect(frame.level).not.toBe("auto");
    expect(frame.classes).toHaveLength(13);
  });

  test("the mode on a row is what the class earned, not a global dial", () => {
    /*
     * THIS USED TO ASSERT THE STANCE. `mode` records what the posture WAS when
     * a row was written, and it read a global "initiative" dial — off,
     * watching, asked, offering, queued, undo, acting — that governed nothing
     * the work loop does. Its controls were removed after counting callers,
     * and reading a setting nothing can write is worse than not having it: it
     * looks like a live input and is a constant. The stored value was
     * `watching`, which fell through to `shadow` — the same answer.
     *
     * What decides a mode now is what somebody chose: what a class has EARNED,
     * what was set for it explicitly, and the ceiling.
     */
    const locked = u.scorecard().classes.find((c) => c.lock !== "earn");
    expect(locked, "there should be a class that has not earned it").toBeTruthy();
    expect(locked!.mode).toBe("shadow");

    // And a class that HAS earned it is still shadow until somebody sets it,
    // which is the strongest thing this server says about autonomy.
    const earned = u.scorecard().classes.filter((c) => c.lock === "earn");
    expect(earned.every((c) => c.mode === "shadow")).toBe(true);
  });

  test("a class that has earned it is offered and still is not on", () => {
    // The strongest statement the server makes about autonomy, and the two
    // halves of it: offered is true, mode is shadow.
    const row = rowFor("C2");
    expect(row.offered).toBe(true);
    expect(row.mode).toBe("shadow");
    expect(u.modeOf("C2")).toBe("shadow");
  });

  test("setMode cannot lift anything above the ceiling", () => {
    // `auto` is the rung that means "no way back", and it stays unreachable
    // however it is asked for — that is the part of this test that never moved.
    expect(u.setMode("C2", "auto")).toBe(false);
    // What the ceiling now allows, it allows.
    expect(u.setMode("C2", "guided")).toBe(true);
    expect(u.setMode("C2", "auto-undo")).toBe(true);
    expect(u.modeOf("C2")).toBe("auto-undo");
    expect(u.setMode("C2", "shadow")).toBe(true);
    expect(u.modeOf("C2")).toBe("shadow");
  });

  test("a locked class refuses even where the ceiling would allow it", () => {
    expect(u.setMode("C6", "guided")).toBe(false);
    expect(u.setMode("C12", "guided")).toBe(false);
    expect(u.setMode("C6", "shadow")).toBe(true);
  });

  test("an unknown class and an unknown mode are both refused", () => {
    expect(u.setMode("C99", "shadow")).toBe(false);
    expect(u.setMode("C2", "sideways" as never)).toBe(false);
  });
});

describe("halt", () => {
  // Last in the file on purpose: halting stops every writer, so anything below
  // it would silently assert on an empty table.
  test("it drops everything to shadow, says how many it caught, and stops the writes", () => {
    const dropped = u.halt();
    // Zero, because the ceiling never let anything up in the first place. The
    // count is here so that "halt did nothing because nothing was above shadow"
    // and "halt caught four classes mid-ladder" are distinguishable outcomes.
    expect(dropped).toBe(0);
    expect(u.isHalted()).toBe(true);

    const frame = u.scorecard();
    // Halted is a fact about the process; enabled is a preference the user
    // expressed. A view showing an empty scorecard has to be able to say which
    // of the two it is looking at, and one boolean cannot.
    expect(frame.halted).toBe(true);
    expect(frame.enabled).toBe(true);
    expect(u.sealSituation("C2", { subject: "halted", body: "anything" })).toBe(0);
    expect(u.openStub({ route: "/git/merge", method: "POST", actor: "local" })).toBe(0);

    // Switching it back on is the deliberate act that clears a halt. A fence
    // that expires on a timer is not a fence.
    u.setEnabled(true);
    expect(u.isHalted()).toBe(false);
    expect(u.scorecard().halted).toBe(false);
  });
});

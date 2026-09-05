/*
 * Being predictable is not the same as having been learned.
 *
 * The gate had three bars — eighty scored decisions, seventy per cent
 * agreement, and a Wilson bound over sixty — and all three are cleared by any
 * class where the person is simply consistent. C2 is the worked example on real
 * data: over 1,193 commits the model agrees 97% of the time, and "answer what
 * you answered last time" agrees 98%. Every bar cleared, and promoting it would
 * hand somebody a constant wearing a 97% badge.
 *
 * So there is a fourth bar and it is the only one about the MODEL: it has to
 * beat the dumbest possible rule by ten points. Ten is not invented here — it
 * is the criterion the backtest was pre-registered against before any of this
 * was measured, and the one C3 passed with +32.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let u: typeof import("../src/understudy.ts");

/**
 * Eighty decisions with a chosen agreement rate and a chosen baseline.
 *
 * `alternating` decides what the dumbest rule scores: alternating answers give
 * it about half, a constant answer gives it almost everything. That single
 * switch is the difference between "it learned you" and "you have a setting",
 * which is the whole subject of this file.
 */
function build(cls: string, n: number, hits: number, alternating: boolean): void {
  const t0 = Date.now() - 30 * 24 * 3600 * 1000;
  for (let i = 0; i < n; i++) {
    const answer = alternating
      ? (i % 2 === 0 ? "A" : "B")
      : (i < hits ? "A" : "B");
    const guess = i < hits ? answer : (answer === "A" ? "B" : "A");
    const at = t0 + i * 1000;
    const subject = `${cls}-${i}`;
    const id = u.sealSituation(cls, { subject, repo: "orbit", partition: "agentglass", body: `s${i}`, at });
    u.recordPrediction(id, { pick: guess }, at + 1);
    u.recordDecision(cls, { subject, repo: "orbit", actual: { pick: answer }, provenance: "typed", at: at + 2 });
  }
}

const rowFor = (cls: string) => u.scorecard().classes.find((c) => c.id === cls)!;

beforeAll(async () => {
  const d = mkdtempSync(join(tmpdir(), "agx-edge-"));
  mkdirSync(join(d, "config", "git"), { recursive: true });
  writeFileSync(join(d, "config", "git", "private-terms.txt"), "\\bnothing\\b\n");
  process.env.AGENTGLASS_DB = join(d, "t.db");
  process.env.XDG_CONFIG_HOME = join(d, "config");
  u = await import("../src/understudy.ts");
  u.__setUnderstudyStorePath(join(d, "store.json"));
  u.__setPrivateTermsPath(join(d, "none.txt"));
  u.setEnabled(true);

  /*
   * C5, C7 and C9, because `bun test` shares one module registry across files
   * and the convention here is that each file owns its own CLASSES rather than
   * its own database. The first version of this file used C1, C2 and C13, every
   * one of which belongs to another file — green on its own and red in the
   * suite, which is the most expensive way to find that out.
   */
  // C5: 90% agreement against a ~50% baseline. Forty points of its own.
  build("C5", 80, 72, true);
  // C7: the same 90% agreement, but the person was doing the same thing anyway.
  build("C7", 80, 72, false);
});

describe("the edge over the dumbest possible rule", () => {
  test("a class where it learned something is offered", () => {
    const row = rowFor("C5");
    expect(row.n).toBe(80);
    expect(row.raw).toBeGreaterThanOrEqual(0.7);
    expect(row.baseRaw).toBeLessThan(0.6);
    expect(row.offered).toBe(true);
  });

  test("the same agreement over a predictable class is NOT offered", () => {
    const row = rowFor("C7");
    // Identical agreement to C1 — this is the point. The number a person reads
    // first is the same, and only the comparison separates them.
    expect(Number(row.raw.toFixed(4))).toBe(Number(rowFor("C5").raw.toFixed(4)));
    expect(row.baseRaw).toBeGreaterThan(0.8);
    expect(row.offered).toBe(false);
  });

  test("and it says which of the two is happening, in words", () => {
    // A person looking at a 90% that is not being offered deserves to be told
    // that the reason is their own consistency, not a hidden threshold.
    const why = rowFor("C7").blocked.join(" ");
    expect(why).toMatch(/repeating your usual answer/i);
    expect(why).toMatch(/of its own/i);
  });
});

describe("the two gates cannot drift apart", () => {
  /*
   * There are two implementations of "is this offered" — the scorecard builds
   * one for the panel, `offered()` answers for anything that would act — and
   * when the gate gained this fourth bar only the scorecard got it. The panel
   * said offered and the function that matters said no, for one commit.
   */
  test("offered() agrees with the scorecard on every class", () => {
    // Only this file's own classes: another file's rows are in the same ledger
    // and asserting over all thirteen would make this test's result depend on
    // what else ran first.
    for (const id of ["C5", "C7", "C9"]) {
      const row = u.scorecard().classes.find((c) => c.id === id)!;
      expect(u.offered(id), `${id}: panel says ${row.offered}, offered() disagrees`).toBe(row.offered);
    }
  });
});

describe("an unmeasured baseline cannot promote anything", () => {
  test("a class with too little history is blocked, not waved through", () => {
    // Missing evidence is not evidence of an edge. A class nobody has data for
    // must fail closed, or the fourth bar becomes optional exactly when it
    // matters most — at the start, before anything is known.
    build("C9", 12, 12, true);
    const row = rowFor("C9");
    expect(row.raw).toBe(1);
    expect(row.offered).toBe(false);
  });
});

/*
 * The baseline, and why it is the only number that decides anything.
 *
 * An agreement figure on its own is unreadable. A class where somebody does the
 * same thing nine times in ten is a class where a CONSTANT scores ninety per
 * cent — so a predictor scoring ninety there has learned that they have a
 * setting, not who they are. The gap between the two is the model's whole
 * contribution, and these tests exist so that gap cannot quietly become
 * flattering.
 *
 * The expanding window is the part worth guarding. Each row is scored against
 * the majority of the rows BEFORE it. Computing one modal answer over the whole
 * set and scoring every row against it would let the baseline see outcomes it
 * could not have known — and since the baseline is the thing we are trying to
 * beat, that error runs in the direction that turns a real result into a fake
 * one.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let U: typeof import("../src/understudy.ts");
let P: typeof import("../src/understudy-predict.ts");

beforeAll(async () => {
  const jail = mkdtempSync(join(tmpdir(), "agx-baseline-"));
  mkdirSync(join(jail, "config", "git"), { recursive: true });
  writeFileSync(join(jail, "config", "git", "private-terms.txt"), "\\bnothing-here\\b\n");
  process.env.AGENTGLASS_DB = join(jail, "t.db");
  process.env.XDG_CONFIG_HOME = join(jail, "config");
  U = await import("../src/understudy.ts");
  P = await import("../src/understudy-predict.ts");
  U.setEnabled(true);
  wipe();
});

/*
 * Clear the ledger before and after.
 *
 * `bun test` runs every file in ONE process, so the module registry is shared:
 * the first file to import db.ts opens the database, and every later file's
 * `process.env.AGENTGLASS_DB = …` is a no-op against an already-open handle.
 * The env-before-dynamic-import idiom this suite uses protects the FIRST
 * importer and nobody else.
 *
 * Which means a test that writes ledger rows is writing into whatever database
 * is open, and the rows outlive it. This file writes 180 of them across C1, C2
 * and C3 — the same classes understudy-scorecard.test.ts counts — and left
 * alone it made four of that file's assertions fail while passing perfectly on
 * its own. Cleaning up is the fix; asserting deltas instead would hide the
 * mess rather than remove it.
 */
function wipe() {
  try {
    const { db } = require("../src/db.ts") as typeof import("../src/db.ts");
    db.run("DELETE FROM understudy_ledger");
  } catch { /* no database yet is the same as a clean one */ }
}

afterAll(() => { wipe(); });

/** One decision, sealed and guessed at before it is answered. */
function decide(cls: string, subject: string, actual: unknown) {
  const id = U.sealSituation(cls, { subject, repo: subject, partition: "agentglass", body: `probe ${subject}` });
  P.predictSealed(id, cls, subject);
  U.recordDecision(cls, { subject, repo: subject, partition: "agentglass", actual, provenance: "clicked" });
}

const row = (cls: string) => U.scorecard().classes.find((c) => c.id === cls)!;

describe("the baseline says whether the model earned anything", () => {
  test("a class where he always does the same thing gives the model nowhere to go", () => {
    for (let i = 0; i < 60; i++) decide("C1", "repo", { branch: "feat", ok: true });
    const c = row("C1");

    // The model is right essentially always — and so is a constant.
    expect(c.raw).toBeGreaterThan(0.9);
    expect(c.baseRaw).toBeGreaterThan(0.9);

    // Which is the finding, not a failure: there is nothing here to learn.
    // A panel that showed only the 100% would be telling a person their clone
    // had mastered them, when what it had mastered was an `if`.
    expect(c.raw - c.baseRaw).toBeLessThan(0.1);
  });

  test("a class where the answer depends on the situation is where a model can win", () => {
    const kinds = ["alpha", "beta", "gamma"];
    for (let i = 0; i < 60; i++) {
      const s = kinds[i % 3]!;
      decide("C2", s, { style: s === "alpha" ? "short" : s === "beta" ? "long" : "none", ok: true });
    }
    const c = row("C2");

    // A constant cannot be right more than about a third of the time here,
    // because there are three answers and it can only ever give one.
    expect(c.baseRaw).toBeLessThan(0.5);
    // The model can, because the subject tells it which.
    expect(c.raw).toBeGreaterThan(0.9);
    expect(c.raw - c.baseRaw).toBeGreaterThan(0.1);
  });

  test("the baseline never sees a row's own outcome", () => {
    // The first decision of a class has no history behind it, so the majority
    // rule has no answer and cannot score. A baseline computed over the whole
    // set at once would count this row as a hit — it knows the modal answer
    // because this row helped decide it — which is precisely the leak.
    for (let i = 0; i < 5; i++) decide("C3", "solo", { only: "one", ok: true });
    const c = row("C3");
    expect(c.baseN).toBeGreaterThan(0);
    // Every row after the first is a hit; the first cannot be.
    expect(c.baseRaw).toBeLessThan(1);
  });

  test("the model and the baseline share a denominator", () => {
    // Two accuracies computed over different rows are not comparable, and the
    // difference between them would be arithmetic rather than evidence.
    for (const id of ["C1", "C2", "C3"]) {
      const c = row(id);
      expect(c.baseN).toBe(c.n);
    }
  });
});

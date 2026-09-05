/*
 * The seal is what makes the score mean anything.
 *
 * Three orderings, and each one is a way the number could have been a lie:
 * a prediction written before the answer (the honest case), a prediction
 * written after it (kept, and marked), and an answer with no situation in front
 * of it at all (kept, and counted against trigger recall). The middle one is
 * here because dropping the late row was the original bug — a class that is
 * only ever late on the hard situations scores beautifully on the easy ones,
 * and the dropped rows are exactly the evidence of that.
 *
 * EVERY TIME IN THIS FILE IS PASSED EXPLICITLY. `late` is decided by comparing
 * `actual_at` against the prediction's timestamp, and two calls in the same
 * millisecond compare equal rather than less-than — a test that leaned on
 * Date.now() would pass on a slow machine and fail on a fast one, which is the
 * shape of flake that gets re-run rather than fixed.
 *
 * ISOLATION, and the trap behind it: `bun test` shares one module registry
 * across files, so the second file to `await import("../src/db.ts")` gets
 * whichever database the first one opened. Each understudy test file therefore
 * owns its own CLASSES rather than its own database — this one is the only user
 * of C1 — and asserts on rows it wrote itself. Both test seams are re-pointed
 * in this file's own beforeAll for the same reason: whichever file ran before
 * left them pointing somewhere else.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-understudy-seal-"));
process.env.AGENTGLASS_DB = join(dir, "seal.db");
process.env.XDG_CONFIG_HOME = dir;

let u: typeof import("../src/understudy.ts");
let store: typeof import("../src/db.ts");

/** Rows filed under one (class, subject). The count is the assertion that
 *  matters in the late case: "dropped" and "kept but not scored" look the same
 *  from the verdict alone. */
const rows = (cls: string, subject: string): number =>
  store.db
    .query<{ c: number }, [string, string]>(
      `SELECT COUNT(*) AS c FROM understudy_ledger WHERE class = ? AND subject = ?`,
    )
    .get(cls, subject)!.c;

beforeAll(async () => {
  u = await import("../src/understudy.ts");
  store = await import("../src/db.ts");
  u.__setUnderstudyStorePath(join(dir, "understudy.json"));
  // Deliberately a path that does not exist. A suite must never read the
  // developer's real private-terms file: the terms are the one thing this
  // feature promises never to hold, and a test that loaded them would put them
  // in a process whose output goes into a public repository's CI log.
  u.__setPrivateTermsPath(join(dir, "no-terms-here.txt"));
  u.setEnabled(true);
});

describe("the situation is sealed before anybody can answer it", () => {
  test("the row exists the instant seal returns", () => {
    // Not "eventually". Nothing in sealSituation awaits or schedules, because a
    // situation that is written soon is not sealed — the answer could land in
    // between, and then the ordering the whole score rests on is whatever the
    // event loop felt like.
    const id = u.sealSituation("C1", {
      subject: "feat/orbit-rail",
      repo: "orbit",
      partition: "agentglass",
      body: "two worktrees open, one of them dirty",
    });
    expect(id).toBeGreaterThan(0);
    const row = u.__ledgerRow(id)!;
    expect(row.kind).toBe("decision");
    expect(row.class).toBe("C1");
    expect(row.situation_hash).toHaveLength(64);
    expect(row.unsealed).toBe(0);
    expect(row.mode).toBe("shadow");
  });

  test("seal, predict, decide — the prediction was not late", () => {
    const t0 = Date.now();
    const subject = "feat/orbit-ontime";
    const id = u.sealSituation("C1", { subject, repo: "orbit", body: "a clean main", at: t0 });
    u.recordPrediction(id, { branch: "feat/*", cwd: "worktree" }, t0 + 1000);
    u.recordDecision("C1", {
      subject,
      repo: "orbit",
      actual: { cwd: "worktree", branch: "feat/*" },
      provenance: "typed",
      at: t0 + 2000,
    });

    const row = u.__ledgerRow(id)!;
    expect(row.late).toBe(0);
    // Key order differs between the prediction and the actual on purpose: a
    // categorical decision is the same decision however the object was built.
    expect(row.verdict).toBe("agree");
    expect(row.provenance).toBe("typed");
    expect(rows("C1", subject)).toBe(1);
  });

  test("seal, decide, predict — late is marked, and the row is still there", () => {
    const t0 = Date.now();
    const subject = "feat/orbit-late";
    const id = u.sealSituation("C1", { subject, repo: "orbit", body: "a branch behind its base", at: t0 });
    u.recordDecision("C1", { subject, actual: { branch: "fix/*" }, provenance: "clicked", at: t0 + 1000 });
    u.recordPrediction(id, { branch: "fix/*" }, t0 + 2000);

    const row = u.__ledgerRow(id)!;
    expect(row.late).toBe(1);
    // Kept AND scored. A late prediction is worthless as a prediction and is
    // not worthless as a measurement, so it is graded like any other row.
    expect(row.verdict).toBe("agree");
    expect(row.predicted_at).toBe(t0 + 2000);
    // The count is the real assertion: dropping the row was the original bug,
    // and a dropped row and a row that merely scored nothing are indis-
    // tinguishable if you only look at the verdict.
    expect(rows("C1", subject)).toBe(1);
  });

  test("a prediction that disagrees is scored as a differ, not lost", () => {
    const t0 = Date.now();
    const subject = "feat/orbit-differ";
    const id = u.sealSituation("C1", { subject, body: "a detached head", at: t0 });
    u.recordPrediction(id, { branch: "feat/*" }, t0 + 1000);
    u.recordDecision("C1", { subject, actual: { branch: "main" }, provenance: "typed", at: t0 + 2000 });
    expect(u.__ledgerRow(id)!.verdict).toBe("differ");
  });
});

describe("an answer with no situation in front of it", () => {
  test("is kept, and marked unsealed", () => {
    const subject = "feat/orbit-orphan";
    const id = u.recordDecision("C1", {
      subject,
      actual: { branch: "feat/*" },
      provenance: "typed",
      at: Date.now(),
    });
    expect(id).toBeGreaterThan(0);

    const row = u.__ledgerRow(id)!;
    // It is the denominator of trigger recall. Quietly discarding it would
    // remove the only evidence that a seam is missing decisions, and would do
    // it in the direction that flatters the score.
    expect(row.unsealed).toBe(1);
    expect(row.verdict).toBe("unscored");
    expect(row.situation_hash).toBe("");
    expect(row.predicted).toBe(null);
  });

  test("a stale seal is not attached to — a new row opens instead", () => {
    const t0 = Date.now();
    const subject = "feat/orbit-stale";
    const sealed = u.sealSituation("C1", { subject, body: "a worktree from last week", at: t0 });
    const opened = u.recordDecision("C1", {
      subject,
      actual: { branch: "feat/*" },
      provenance: "typed",
      at: t0 + 31 * 60 * 1000,
    });

    expect(opened).not.toBe(sealed);
    expect(u.__ledgerRow(opened)!.unsealed).toBe(1);
    // The seal is left open rather than back-filled. Half an hour on, the
    // situation it hashed has moved: matching to it would score a prediction
    // against an answer to a different question.
    expect(u.__ledgerRow(sealed)!.actual_at).toBe(null);
    expect(rows("C1", subject)).toBe(2);
  });

  test("inside the window it does attach", () => {
    // The other side of the same boundary. Without this, a bug that never
    // attached anything would pass the test above.
    const t0 = Date.now();
    const subject = "feat/orbit-inside";
    const sealed = u.sealSituation("C1", { subject, body: "an interrupted worktree", at: t0 });
    const same = u.recordDecision("C1", {
      subject,
      actual: { branch: "feat/*" },
      provenance: "typed",
      at: t0 + 29 * 60 * 1000,
    });
    expect(same).toBe(sealed);
    expect(u.__ledgerRow(sealed)!.unsealed).toBe(0);
    expect(rows("C1", subject)).toBe(1);
  });

  test("the newest open seal wins when there are two", () => {
    const t0 = Date.now();
    const subject = "feat/orbit-twice";
    const first = u.sealSituation("C1", { subject, body: "first look", at: t0 });
    const second = u.sealSituation("C1", { subject, body: "second look", at: t0 + 60_000 });
    const hit = u.recordDecision("C1", { subject, actual: { branch: "feat/*" }, provenance: "typed", at: t0 + 90_000 });
    expect(hit).toBe(second);
    expect(u.__ledgerRow(first)!.actual_at).toBe(null);
  });
});

describe("the universal net", () => {
  test("a stub records the write and how it answered, and nothing else", () => {
    const id = u.openStub({ route: "/git/commit-staged", method: "POST", actor: "local" });
    expect(id).toBeGreaterThan(0);
    u.settleLedger(id, 200);

    const row = u.__ledgerRow(id)!;
    expect(row.kind).toBe("stub");
    expect(row.route).toBe("/git/commit-staged");
    expect(row.status).toBe(200);
    // The signature has no parameter a body could arrive through, and the row
    // has nothing in the fields a body would land in.
    expect(row.subject).toBe("");
    expect(row.predicted).toBe(null);
    expect(row.actual).toBe(null);
  });

  test("the first answer wins", () => {
    // A route can answer twice — a retry, or an error path falling through to a
    // generic handler. The first status is the one the caller saw; a later 500
    // from a cleanup path would overwrite the 200 that actually happened.
    const id = u.openStub({ route: "/prs/merge", method: "POST", actor: "local" });
    u.settleLedger(id, 200);
    u.settleLedger(id, 500);
    expect(u.__ledgerRow(id)!.status).toBe(200);
  });

  test("settling an id that was never opened is a no-op, not a throw", () => {
    // openStub returns 0 when the understudy is off, and the call site should
    // not have to branch on that before settling.
    expect(() => u.settleLedger(0, 200)).not.toThrow();
  });

  test("a fence outlives the stub sweep, which is why it is its own kind", () => {
    const id = u.recordFence("/chat/send", "POST");
    const row = u.__ledgerRow(id)!;
    expect(row.kind).toBe("fence");
    expect(row.actor).toBe("understudy");
  });
});

describe("off means no rows", () => {
  test("nothing writes while it is switched off", () => {
    u.setEnabled(false);
    expect(u.enabled()).toBe(false);
    expect(u.openStub({ route: "/git/merge", method: "POST", actor: "local" })).toBe(0);
    expect(u.sealSituation("C1", { subject: "feat/orbit-off", body: "anything" })).toBe(0);
    expect(u.recordDecision("C1", { subject: "feat/orbit-off", actual: {}, provenance: "typed" })).toBe(0);
    expect(u.recordFence("/chat/send", "POST")).toBe(0);
    expect(rows("C1", "feat/orbit-off")).toBe(0);
    u.setEnabled(true);
  });

  test("the environment can force it off and can never force it on", () => {
    // A watcher that could be switched on by an inherited shell variable is a
    // watcher whose off state nobody can promise. The kill switch runs one way.
    process.env.AGENTGLASS_UNDERSTUDY = "0";
    expect(u.enabled()).toBe(false);
    u.setEnabled(true);
    expect(u.enabled()).toBe(false);
    delete process.env.AGENTGLASS_UNDERSTUDY;
    expect(u.enabled()).toBe(true);
  });

  test("an unknown class is refused rather than becoming a fourteenth", () => {
    expect(u.sealSituation("C99", { subject: "x", body: "y" })).toBe(0);
    expect(u.recordDecision("C99", { subject: "x", actual: {}, provenance: "typed" })).toBe(0);
    expect(u.classOf("C99")).toBe(null);
    expect(u.CLASSES).toHaveLength(13);
  });
});

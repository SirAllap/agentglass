/*
 * Standing in for a bounded while, and the limits that make that a sentence
 * somebody can actually agree to.
 *
 * "Cover for me for an hour" is not a per-decision statement, and everything
 * else in this feature is per-decision. A shift is the missing noun: what it is
 * doing, how long it has, how much it may do, and when it must stop and wait
 * rather than carry on being confidently wrong.
 *
 * The limits are written down BEFORE it starts rather than consulted as it
 * goes, and the difference is not stylistic. A policy evaluated each time is a
 * policy that can be reasoned around by whatever writes the next version of the
 * reasoning; an end time in a column cannot be.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let S: typeof import("../src/understudy-shift.ts");
let W: typeof import("../src/understudy-work.ts");

beforeAll(async () => {
  const d = mkdtempSync(join(tmpdir(), "agx-shift-"));
  mkdirSync(join(d, "config", "git"), { recursive: true });
  writeFileSync(join(d, "config", "git", "private-terms.txt"), "\\bnothing\\b\n");
  process.env.AGENTGLASS_DB = join(d, "t.db");
  process.env.XDG_CONFIG_HOME = join(d, "config");
  S = await import("../src/understudy-shift.ts");
  W = await import("../src/understudy-work.ts");
});

const endAll = () => { const c = S.current(); if (c) S.stop(c.id, "test cleanup", "done"); };

describe("handing over", () => {
  test("a shift carries a wall and a budget, both fixed at the start", () => {
    endAll();
    const r = S.start("tidy up the merged branches", 30, 5);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.shift.endsAt - r.shift.startedAt).toBe(30 * 60_000);
    expect(r.shift.maxActions).toBe(5);
    expect(r.shift.actionsLeft).toBe(5);
    endAll();
  });

  test("neither can exceed the ceiling, however it is asked for", () => {
    endAll();
    // The ceiling is short because the evidence for a longer one does not
    // exist: nothing has watched this act unsupervised for any length of time.
    const r = S.start("everything, forever", 60 * 24 * 7, 10_000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.shift.endsAt - r.shift.startedAt).toBeLessThanOrEqual(S.MAX_SHIFT_MS);
    expect(r.shift.maxActions).toBeLessThanOrEqual(S.MAX_SHIFT_ACTIONS);
    endAll();
  });

  test("two shifts cannot run at once", () => {
    endAll();
    expect(S.start("one", 10, 2).ok).toBe(true);
    // Two budgets and two walls over one queue is not a limit — it is two
    // halves of a limit that add up to more than either.
    const second = S.start("two", 10, 2);
    expect(second.ok).toBe(false);
    endAll();
  });
});

describe("when it must stop and wait", () => {
  test("one failure ends the shift — not three, not a rate", () => {
    endAll();
    const r = S.start("x", 30, 5);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const check = S.shouldStop(r.shift, { lastFailed: true, pending: 0 });
    expect(check.stop).toBe(true);
    // Because everything queued behind it was drafted against the same picture
    // of the world, and that picture has just been shown to be wrong.
    expect(check.reason).toMatch(/failed/i);
    endAll();
  });

  test("an unread queue ends it too", () => {
    endAll();
    const r = S.start("x", 30, 20);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The whole design rests on a person reading each draft. A pile of unread
    // ones means that is not happening, and drafting more is talking to an
    // empty room.
    expect(S.shouldStop(r.shift, { pending: 5 }).stop).toBe(true);
    expect(S.shouldStop(r.shift, { pending: 1 }).stop).toBe(false);
    endAll();
  });

  test("a failed row whose worktree is gone does not count — removing it IS the read", () => {
    endAll();
    const r = S.start("x", 30, 5);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Three failed rows, each backed by a worktree somebody already read and
    // removed. The old rule counted the row and never let go; it should not
    // fire here at all.
    for (let i = 0; i < 3; i++) {
      const dir = mkdtempSync(join(tmpdir(), "agx-shift-wt-"));
      const id = W.beginRun({
        shiftId: r.shift.id,
        item: { id: `read-${i}`, source: "test", title: "x", detail: "", repo: "r", weight: 1 },
        repo: "r", worktree: dir, branch: `b${i}`,
      });
      expect(id).not.toBeNull();
      W.finishRun(id!, "failed", "read and cleaned up");
      rmSync(dir, { recursive: true, force: true });
    }
    expect(S.shouldStop(r.shift, {}).stop).toBe(false);
    endAll();
  });

  test("the wall is enforced on read, not by a timer", () => {
    endAll();
    const r = S.start("x", 1, 5);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // A limit that needs a timer to fire is a limit that does not hold across a
    // restart, a sleeping laptop, or a busy event loop. Asking "is it still
    // inside its window" whenever anybody looks cannot be missed that way.
    const s = S.current()!;
    expect(s.state).toBe("running");
    expect(s.msLeft).toBeGreaterThan(0);
    endAll();
  });

  test("every ending records why", () => {
    endAll();
    const r = S.start("x", 30, 5);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    S.stop(r.shift.id, "you ended it", "done");
    const last = S.recent(1)[0]!;
    // The first question anybody asks on coming back is "what did it do and why
    // did it quit". A shift that cannot answer the second half is unauditable.
    expect(last.state).toBe("done");
    expect(last.stoppedReason).toBe("you ended it");
    expect(last.stoppedAt).toBeGreaterThan(0);
  });
});

describe("there is no way to extend a shift", () => {
  test("the module exposes no extend", () => {
    // A stand-in that can lengthen its own shift is not standing in. Adding one
    // later should feel like the change that it is, which is what this asserts.
    expect(Object.keys(S)).not.toContain("extend");
    expect(Object.keys(S)).not.toContain("renew");
  });
});

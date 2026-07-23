// The ceiling on subprocesses in flight.
//
// Making the git and docker reads concurrent fixed the freezes and created a
// different failure: nothing bounded the fan-out. Driven hard — several cold
// panels at once, each spawning dozens — the sidecar stopped answering
// entirely. Not slow: gone. These pin the two properties that prevent it.
import { beforeAll, describe, expect, it } from "bun:test";

let pool: typeof import("../src/spawnpool.ts");

beforeAll(async () => {
  process.env.AGENTGLASS_SPAWN_LIMIT = "4";
  // A short guard so the "stuck spawn" test doesn't wait five real minutes.
  process.env.AGENTGLASS_SPAWN_GUARD_MS = "80";
  pool = await import("../src/spawnpool.ts");
});

describe("spawn pool", () => {
  it("never runs more than the limit at once, however many are asked for", async () => {
    let running = 0;
    let peak = 0;
    // 60 is roughly what one cold `/git/worktrees` asks for on a real repo.
    await Promise.all(Array.from({ length: 60 }, () => pool.withSpawnSlot(async () => {
      running++;
      if (running > peak) peak = running;
      await Bun.sleep(5);
      running--;
    })));
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);      // …and it is not serialising everything
    expect(running).toBe(0);
  });

  it("runs all of them — waiting is not dropping", async () => {
    // The alternative to queueing is refusing, and a refused `git status` is a
    // dirty count that silently never arrives.
    let done = 0;
    await Promise.all(Array.from({ length: 30 }, () => pool.withSpawnSlot(async () => { await Bun.sleep(1); done++; })));
    expect(done).toBe(30);
  });

  it("gives the slot back when the work throws", async () => {
    // The failure that would be invisible until the app stopped working: a
    // spawn that throws — no such binary, a killed child, a torn-down stream —
    // leaking its slot. The pool drains to zero over a long session and git
    // stops running at all, which looks exactly like the freeze this replaced.
    for (let i = 0; i < 8; i++) {
      await expect(pool.withSpawnSlot(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    }
    expect(pool.spawnPoolStats().inflight).toBe(0);

    // And the pool still works afterwards.
    const after = await pool.withSpawnSlot(async () => "fine");
    expect(after).toBe("fine");
  });

  it("hands the slot back even when the work never settles", async () => {
    // The leak that would be invisible until the app froze: a spawn whose stdout
    // pipe never reaches EOF after its own timeout-kill leaves fn() pending, and
    // the slot with it, forever. The guard timeout releases the slot so the pool
    // keeps working; here four never-settling jobs fill the pool, and a fifth
    // must still get through once the guard fires.
    const before = pool.spawnPoolStats().inflight;
    for (let i = 0; i < 4; i++) void pool.withSpawnSlot(() => new Promise<void>(() => {})); // never resolves
    // The pool is now full of stuck work.
    expect(pool.spawnPoolStats().inflight).toBeGreaterThanOrEqual(before + 1);
    // After the guard (80ms) releases those slots, real work runs again.
    const ran = await pool.withSpawnSlot(async () => "through");
    expect(ran).toBe("through");
    // And the stuck jobs no longer count against the pool.
    await Bun.sleep(120);
    expect(pool.spawnPoolStats().inflight).toBe(0);
  });

  it("reports whether the cap is actually biting", async () => {
    // So `/api/loopwatch` can answer "is the app queueing behind its own
    // limit" without anyone having to guess.
    const s = pool.spawnPoolStats();
    expect(s.limit).toBe(4);
    expect(s.peakInflight).toBeGreaterThan(1);
    expect(s.peakWaiting).toBeGreaterThan(0);   // the 60-deep burst above queued
  });
});

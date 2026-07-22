// The watchdog that notices the terminal freezing.
//
// The terminal's PTY rides the same single thread as every git call, docker
// call and SQLite write in this process, so "the loop was busy for 900ms" and
// "the terminal was dead for 900ms" are the same sentence. This module turns
// that from something a user reports as "laggy as hell" into a line with a
// duration and a name on it.
import { beforeAll, describe, expect, it } from "bun:test";

let lw: typeof import("../src/loopwatch.ts");

beforeAll(async () => {
  // A small ring, so the trim can be proven without stalling for a minute.
  process.env.AGENTGLASS_LOOPWATCH_SIZE = "5";
  // A short pressure window, so a stall from the test above ages out before the
  // load-shedding tests below rather than after ten real seconds of waiting.
  process.env.AGENTGLASS_PRESSURE_WINDOW_MS = "400";
  lw = await import("../src/loopwatch.ts");
  lw.watchLoop();
  await Bun.sleep(150); // let the heartbeat settle
});

/** Hold the thread the way a synchronous subprocess call does. */
function block(ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* exactly what Bun.spawnSync does to us */ }
}

describe("loop watchdog", () => {
  it("notices a block, and blames whatever entered last", async () => {
    const before = lw.stalls().stalls.at(-1)?.id ?? 0;
    lw.entered("GET /git/repos");
    block(320);
    await Bun.sleep(250);

    const seen = lw.stalls(before).stalls;
    expect(seen.length).toBeGreaterThan(0);
    const worst = seen.reduce((a, b) => (b.ms > a.ms ? b : a));
    // Reported as drift past the heartbeat, not wall time — a 320ms block on a
    // 100ms tick is ~220ms of loop unavailable to anyone else.
    expect(worst.ms).toBeGreaterThanOrEqual(150);
    expect(worst.ms).toBeLessThan(1_000);
    expect(worst.what).toBe("GET /git/repos");
  });

  it("does not blame a request that finished long ago", async () => {
    // A stall arriving out of nowhere is a timer, a stream pump or GC, and
    // saying so beats pinning it on whichever endpoint happened to be last —
    // which would quietly turn background work into a bug report against an
    // innocent route.
    lw.entered("GET /something-old");
    await Bun.sleep(2_100); // past the freshness window
    const before = lw.stalls().stalls.at(-1)?.id ?? 0;
    block(300);
    await Bun.sleep(250);

    const seen = lw.stalls(before).stalls;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)!.what).toContain("background");
  });

  it("keeps running totals, so a session can be judged rather than a moment", () => {
    const s = lw.stalls();
    expect(s.worstMs).toBeGreaterThanOrEqual(150);
    expect(s.totalMs).toBeGreaterThanOrEqual(s.worstMs);
    expect(s.sinceMs).toBeGreaterThan(0);
  });

  it("is bounded — the thing that watches for growth must not grow", async () => {
    for (let i = 0; i < 8; i++) { lw.entered(`burst ${i}`); block(240); await Bun.sleep(120); }
    const s = lw.stalls();
    expect(s.stalls.length).toBeLessThanOrEqual(5);       // the ring trimmed
    expect(s.stalls.at(-1)!.id).toBeGreaterThan(5);        // …and kept the newest
  }, 15_000);
});

describe("load shedding", () => {
  // The terminal cannot ask for priority, so it is given some: while a human is
  // typing into a shell, the background sweeps hold their answers longer. The
  // multiplier is the whole mechanism — the caches it multiplies already exist.
  it("is 1 when nothing is happening", async () => {
    await Bun.sleep(4_100);            // let any earlier keystroke go cold
    expect(lw.terminalHot()).toBe(false);
    expect(lw.pressureMs()).toBe(0);
    expect(lw.backoff()).toBe(1);
  }, 10_000);

  it("stands back while the loop is already stalling", async () => {
    // The second signal, and the one that covers whatever blocks the loop next:
    // if something took 500ms out of the last window, adding an eighteen-repo
    // `git status` sweep on top of it is the wrong instinct.
    block(600);
    await Bun.sleep(150);
    expect(lw.pressureMs()).toBeGreaterThan(400);
    expect(lw.backoff()).toBeGreaterThan(1);
    await Bun.sleep(500);              // past the (shortened) window
    expect(lw.backoff()).toBe(1);
  }, 10_000);

  it("stands back while someone is typing", () => {
    lw.terminalActive();
    expect(lw.terminalHot()).toBe(true);
    expect(lw.backoff()).toBeGreaterThan(1);
  });

  it("lets go on its own once the typing stops", async () => {
    lw.terminalActive();
    expect(lw.backoff()).toBeGreaterThan(1);
    await Bun.sleep(4_100);
    // Nothing resets this and nothing can get stuck holding it — the signal is
    // a timestamp, so calm is the state it returns to by doing nothing.
    expect(lw.backoff()).toBe(1);
  }, 10_000);
});

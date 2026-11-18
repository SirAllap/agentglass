// An unlabelled stall names the kernel wait the main thread sat in.
//
// "no JS was running" was 203 of 222 stalls over 1 s in one night's log, and
// said nothing about what the thread waited on. A worker reads the main
// thread's /proc state and wchan while the heartbeat is late, so the stall line
// carries "kernel: D folio_wait_bit 4/5 (a page read from disk or swap)".
import { beforeAll, describe, expect, it } from "bun:test";

let lw: typeof import("../src/loopwatch.ts");

beforeAll(async () => {
  lw = await import("../src/loopwatch.ts");
  lw.watchLoop();
  await Bun.sleep(600); // a quiet tick first, so the watcher learns its own frame
});

describe("kernel wait in the stall name", () => {
  it("says what a known wait means, and keeps the raw name", () => {
    expect(lw.explainKernelWait("D folio_wait_bit_common 3/4, S do_wait 1/4"))
      .toBe("kernel: D folio_wait_bit_common 3/4, S do_wait 1/4 (a page read from disk or swap)");
    expect(lw.explainKernelWait("D write_all_supers 2/2")).toContain("an fsync behind a filesystem commit");
    expect(lw.explainKernelWait("S do_wait 5/5")).toContain("a child process");
    expect(lw.explainKernelWait("S futex_wait_queue 2/2")).toContain("a lock held by another thread");
  });

  it("calls a runnable thread starved of CPU, whatever its wchan", () => {
    expect(lw.explainKernelWait("R - 3/3")).toBe("kernel: R - 3/3 (runnable, waiting for a CPU)");
  });

  it("leaves an unknown wait as the kernel said it", () => {
    expect(lw.explainKernelWait("S some_new_wait 1/1")).toBe("kernel: S some_new_wait 1/1");
  });

  it.skipIf(process.platform !== "linux")("a real sleeping block on the main thread is named by its kernel wait", async () => {
    const before = lw.stalls().stalls.length;
    Bun.sleepSync(1_300); // the thread asleep in the kernel, as under an fsync or a page read
    await Bun.sleep(400);
    const s = lw.stalls().stalls.slice(before).find((x) => x.ms >= 1_000);
    /* The kernel's tally in its own field: \`what\` is the key stalls are grouped by
       (scripts/loadtest.ts, loadagents.ts), and a count in it made each stall its own group. */
    expect(s?.what).toMatch(/^unlabelled: no JS was running/);
    expect(s?.what).not.toContain("kernel:");
    expect(s?.kernel).toMatch(/^kernel: S \S+ \d+\/\d+/);
  });
});

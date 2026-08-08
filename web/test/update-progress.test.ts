import { describe, expect, it } from "bun:test";
import { readProgress, fraction, elapsed, PHASES, CLOSES_AT } from "../src/lib/updateProgress.ts";

/*
 * The progress bar reads the log the updater already writes. These are the
 * lines that script actually prints, so a reworded phase shows up here as a
 * failure rather than as a bar that quietly stops moving.
 */
const REAL = [
  "updating to v0.8.0 from https://example.invalid/acme/thing.git",
  "",
  "==> updating the update clone at /home/x/.cache/thing/src",
  "==> checking out v0.8.0",
  "==> now at 1a2b3c4 (v0.8.0)",
  "==> installing dependencies",
  "==> building and installing (this stops the running app)",
];

describe("reading the log", () => {
  it("says nothing has started before the first phase line", () => {
    const p = readProgress("updating to v0.8.0 from somewhere\n");
    expect(p.reached).toBe(0);
    expect(p.current).toBe(null);
  });

  it("walks the phases the script prints", () => {
    expect(readProgress(REAL.slice(0, 3).join("\n")).current?.id).toBe("fetch");
    expect(readProgress(REAL.slice(0, 4).join("\n")).current?.id).toBe("checkout");
    expect(readProgress(REAL.slice(0, 6).join("\n")).current?.id).toBe("deps");
    expect(readProgress(REAL.join("\n")).current?.id).toBe("build");
  });

  it("never goes backwards when a later line mentions an earlier phase", () => {
    // A build prints thousands of lines and one may contain any word at all. A
    // bar that jumps back is worse than one slightly ahead.
    const noisy = REAL.join("\n") + "\n  compiled src/checking-out-helper.ts\n  cloning submodule x\n";
    expect(readProgress(noisy).current?.id).toBe("build");
  });

  it("knows the first update from every later one", () => {
    // The first clones the whole repository and takes far longer. Saying so is
    // the difference between "slow" and "hung".
    expect(readProgress("==> cloning https://x into /y (first update only)").firstTime).toBe(true);
    expect(readProgress("==> updating the update clone at /y").firstTime).toBe(false);
  });

  it("does not call a passing build a failure", () => {
    // "error" and "failed" appear in ordinary build output — test names, lint
    // rules, dependency names. Only the script's own verdict counts.
    const chatty = REAL.join("\n") + "\n  ✓ rejects a failed token\n  0 failed\n  error-handling.test.ts\n";
    expect(readProgress(chatty).failed).toBe(false);
    expect(readProgress(REAL.join("\n") + "\nupdate failed: build error").failed).toBe(true);
  });

  it("keeps the last few lines, for a failure worth reading", () => {
    const p = readProgress(REAL.join("\n"));
    expect(p.tail.split("\n").length).toBeLessThanOrEqual(6);
    expect(p.tail).toContain("building and installing");
  });
});

describe("the bar", () => {
  it("never fills, because the app is stopped before the last step", () => {
    // A full bar would be a claim nothing on screen is in a position to make:
    // the window is gone by then.
    const atBuild = readProgress(REAL.join("\n"));
    expect(fraction(atBuild)).toBeLessThan(1);
    expect(fraction(atBuild)).toBe((CLOSES_AT + 1) / PHASES.length);
  });

  it("shows something the moment it starts, rather than an empty trough", () => {
    expect(fraction(readProgress(""))).toBeGreaterThan(0);
  });

  it("rises with each phase", () => {
    const seen = [1, 3, 4, 6, 7].map((n) => fraction(readProgress(REAL.slice(0, n).join("\n"))));
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
  });
});

describe("the clock", () => {
  it("counts up, since there is no total to count down from", () => {
    expect(elapsed(0)).toBe("0:00");
    expect(elapsed(72_000)).toBe("1:12");
    expect(elapsed(3_601_000)).toBe("60:01");
  });
});

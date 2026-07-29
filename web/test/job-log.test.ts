/*
 * A CI log, reduced to the part you came for.
 *
 * The Checks tab printed "The log itself lives on GitHub — the phone does not
 * download run logs" under every failure, while `jobLog` sat on the server and
 * `api.prJobLog` sat in the client. "CI went red" is one of the Now queue's
 * four card kinds and the one you are most likely to be woken by, and it ended
 * at a sentence telling you to go and use a browser.
 */
import { describe, expect, it } from "bun:test";
import { stripStamp, cleanLines, failureWindow, jobFor } from "../src/mobile/joblog.ts";

/** A real Actions prefix. Minutes and seconds are two digits each, so the
 *  index has to be split across them — a line-400 stamp of `00:400:00` is not
 *  one, and the code correctly declines to strip it. */
const stamp = (n: number) =>
  `2026-07-29T00:${String(Math.floor(n / 60) % 60).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}.1234567Z `;
const log = (...lines: string[]) => lines.map((l, i) => stamp(i) + l).join("\n");

describe("what is structure and what is content", () => {
  it("takes the timestamp off, because it is the same on every line", () => {
    // Twenty-eight characters of a 390px screen, carrying nothing.
    expect(stripStamp("2026-07-29T00:12:34.5678901Z bun test")).toBe("bun test");
  });

  it("leaves a line that merely looks like one alone", () => {
    expect(stripStamp("Started at 2026-07-29T00:12:34.5678901Z")).toBe("Started at 2026-07-29T00:12:34.5678901Z");
    expect(stripStamp("plain")).toBe("plain");
  });

  it("drops folding markers, which a phone cannot fold", () => {
    const out = cleanLines(log("##[group]Run tests", "1 failing", "##[endgroup]"));
    expect(out).toEqual(["1 failing"]);
  });

  it("keeps blank lines in the middle", () => {
    // They are how an assertion is separated from the stack under it, and
    // collapsing them makes a log harder to read without making it shorter in
    // any way that matters.
    expect(cleanLines(log("expected 1", "", "  at x.ts:4"))).toEqual(["expected 1", "", "  at x.ts:4"]);
  });

  it("drops trailing blanks, which are just space at the bottom", () => {
    expect(cleanLines(log("done", "", ""))).toEqual(["done"]);
  });

  it("survives carriage returns from a Windows runner", () => {
    expect(cleanLines("2026-07-29T00:00:00.0000000Z done\r")).toEqual(["done"]);
  });
});

describe("where to open the log", () => {
  it("opens at the failure, not at the top", () => {
    const w = failureWindow(log("step 1", "step 2", "##[error]Process completed with exit code 1"), 1, 0);
    expect(w.lines[w.at]).toContain("exit code 1");
    expect(w.why).toBe("Around the failure");
  });

  it("uses the LAST error, not the first", () => {
    // A run that fails, retries and fails again reports the earlier one too.
    // The last is the one that ended the job.
    const w = failureWindow(log("##[error]first attempt", "retrying", "##[error]second attempt"), 5, 0);
    expect(w.lines[w.at]).toContain("second attempt");
  });

  it("shows the lines leading up to it, which are the ones that explain it", () => {
    const w = failureWindow(log("a", "b", "c", "d", "##[error]boom"), 2, 0);
    expect(w.lines).toEqual(["c", "d", "##[error]boom"]);
    expect(w.hidden).toBe(2);
  });

  it("shows what came after, for a runner that keeps talking", () => {
    const w = failureWindow(log("##[error]boom", "cleaning up", "done"), 0, 2);
    expect(w.lines).toEqual(["##[error]boom", "cleaning up", "done"]);
  });

  it("falls back to the end when nothing was marked", () => {
    // A job killed by a timeout or an OOM never writes an error marker, and the
    // last thing it managed to say is exactly what you want.
    const w = failureWindow(log("a", "b", "c", "d", "e"), 2, 1);
    expect(w.lines).toEqual(["c", "d", "e"]);
    expect(w.at).toBe(-1);
    expect(w.why).toContain("end of the log");
    // The count on the tail branch too, not only on the marked one: it is what
    // the header prints, and "402 lines above" over a 25-line window is a
    // sentence nobody can check.
    expect(w.hidden).toBe(2);
  });

  it("counts what is above, not what exists, on either branch", () => {
    // The rule that ties them together: `hidden` plus what is shown can never
    // exceed the log.
    const marked = failureWindow(log("a", "b", "c", "##[error]boom"), 1, 0);
    const tail = failureWindow(log("a", "b", "c", "d"), 1, 1);
    for (const w of [marked, tail]) {
      expect(w.hidden + w.lines.length).toBeLessThanOrEqual(4);
      expect(w.hidden).toBeGreaterThanOrEqual(0);
    }
  });

  it("does not claim lines are hidden when they are not", () => {
    const w = failureWindow(log("only", "##[error]boom"), 50, 50);
    expect(w.hidden).toBe(0);
    expect(w.why).toBe("The whole log");
  });

  it("says so rather than rendering an empty box", () => {
    expect(failureWindow("").lines).toEqual([]);
    expect(failureWindow("").why).toBe("The log is empty");
    expect(failureWindow("\n\n\n").lines).toEqual([]);
  });

  it("never returns a window that does not contain its own mark", () => {
    // The rule, over a log long enough for the arithmetic to be wrong: `at` is
    // an index into `lines`, and an off-by-one here points the highlight at
    // some unrelated line with total confidence.
    const many = log(...Array.from({ length: 400 }, (_, i) => `line ${i}`), "##[error]boom");
    for (const before of [0, 1, 24, 500]) {
      const w = failureWindow(many, before, 3);
      expect(w.at).toBeGreaterThanOrEqual(0);
      expect(w.lines[w.at]).toContain("boom");
    }
  });
});

describe("which job a check belongs to", () => {
  const jobs = [{ name: "build" }, { name: "test (20.x, ubuntu-latest)" }, { name: "test (22.x, ubuntu-latest)" }];

  it("matches the plain name", () => {
    expect(jobFor("build", jobs)?.name).toBe("build");
  });

  it("matches a check named for its workflow too", () => {
    // GitHub writes `workflow / job` when a workflow has several jobs.
    expect(jobFor("CI / build", jobs)?.name).toBe("build");
  });

  it("does not fold two legs of a matrix together", () => {
    // Two legs are two jobs with two logs. Stripping the parameters would open
    // whichever one came back first, and it is a coin toss which that is.
    expect(jobFor("test (20.x, ubuntu-latest)", jobs)?.name).toBe("test (20.x, ubuntu-latest)");
    expect(jobFor("test", jobs)).toBeNull();
  });

  it("ignores casing and padding, which nobody promised", () => {
    expect(jobFor(" CI /  Build ", jobs)?.name).toBe("build");
  });

  it("opens nothing rather than a guess when the name is not an identity", () => {
    expect(jobFor("build", [{ name: "build" }, { name: "build" }])).toBeNull();
    expect(jobFor("nothing like it", jobs)).toBeNull();
    expect(jobFor("", jobs)).toBeNull();
    expect(jobFor("build", [])).toBeNull();
  });
});

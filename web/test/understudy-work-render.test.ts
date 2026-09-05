/**
 * The work tab, rendered — because "it still looks the same" is a claim about
 * the output, and reading the source cannot settle it.
 *
 * His words after the first pass: "it doesn't look much like the preferred one". He was
 * right, and the reason is that everything I had changed only appears on a
 * FIRST visit — and he has 10,580 precedents and 80 finished runs. For him the
 * screen was the same screen, minus three tab labels.
 *
 * What actually filled his screen: every run in the history carried a 140px
 * scrolling block of agent transcript. Eighty of those is what "there's so much
 * info it's overwhelming" looks like.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { firstLine, commitsSpared } from "../src/components/understudy/Work.tsx";

const OUTCOME = [
  "All server tests (136 pass) and web tests (3822 pass) pass successfully. Commit: 5286b40",
  "",
  "…tion extends the existing `settings` verb to handle:",
  "",
  "**Session-level settings (via Electron main process):**",
  "- **Proxy:** Configure via `session.setProxy` with rules and optional bypass patterns",
  "- **Extensions:** Load, list, or remove browser extensions",
].join("\n");

describe("a run in the list", () => {
  test("shows the VERDICT, which is the first line of the outcome", () => {
    expect(firstLine(OUTCOME)).toBe("All server tests (136 pass) and web tests (3822 pass) pass successfully. Commit: 5286b40");
  });

  test("a long verdict is cut, not wrapped over the whole row", () => {
    const long = `${"x".repeat(400)}\nsecond line`;
    const out = firstLine(long);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith("…")).toBe(true);
  });

  test("leading blank lines are skipped — an outcome often starts with one", () => {
    expect(firstLine("\n\n  the tests failed\nmore")).toBe("the tests failed");
  });

  test("an empty outcome is an empty string, never a crash", () => {
    expect(firstLine("")).toBe("");
    expect(firstLine("\n\n")).toBe("");
  });

  test("a bare ellipsis is not a verdict — it was four rows in ten", () => {
    /* Outcomes are stored capped, so a great many open with an ellipsis
       marking the cut. Rendered, those rows said "… · more" and nothing else:
       worse than the block they replaced, because it costs a click to find out
       there was never anything there. Seen on the real list, not imagined. */
    expect(firstLine("…\nAnalysis complete. 106 pass.")).toBe("Analysis complete. 106 pass.");
    expect(firstLine("...\n\n   \nthe tests failed")).toBe("the tests failed");
    expect(firstLine("… tion extends the existing settings verb")).toBe("tion extends the existing settings verb");
  });

  test("a line of pure punctuation is skipped too", () => {
    expect(firstLine("---\n***\nCommit: 5286b40")).toBe("Commit: 5286b40");
  });
});

describe("what the first paint does NOT carry", () => {
  /*
   * Read from the source rather than from a render: `renderToStaticMarkup`
   * stops at "Reading what it has been given to do…" because the component
   * fetches in an effect, and a static render never runs one. A render that
   * only ever produces the loading state passes every "does not contain"
   * assertion and proves nothing — which is exactly the trap this file was
   * about to fall into.
   */
  const SRC = readFileSync(new URL("../src/components/understudy/Work.tsx", import.meta.url), "utf8");

  test("the three-line explanation is folded behind a link", () => {
    expect(SRC).toContain("howOpen");
    const at = SRC.indexOf("One task, its own worktree, and the tests decide.");
    expect(at, "the one-line version is the one that ships").toBeGreaterThan(-1);
    expect(SRC.slice(at, at + 400)).toContain("Nothing is ever pushed.");
    expect(SRC.slice(at, at + 400)).toContain("how it works");
    // Folding is not deleting: the long version is still in there.
    expect(SRC).toContain("cuts its own worktree off the current tip");
  });

  test("a run's outcome is a VERDICT plus a link, not a scrolling block", () => {
    /* Every row carried a 140px scroller of agent transcript. Eighty of those
       is what made the list unreadable as a list, which is the only thing a
       list is for. */
    expect(SRC).toContain("openOutcome");
    expect(SRC).toContain("firstLine(r.outcome)");
    const at = SRC.indexOf("openOutcome === r.id && (");
    expect(at, "the full dump must be behind the toggle").toBeGreaterThan(-1);
  });

  test("the verdict is quieter than the task it belongs to", () => {
    /* As an underlined link at the row's own size it read as the headline and
       the task title read as a caption — the hierarchy upside down on every
       row, which is what looking at the rendered list showed. */
    const at = SRC.indexOf("firstLine(r.outcome)");
    const row = SRC.slice(Math.max(0, at - 600), at + 300);
    expect(row).toContain("text-[11px]");
    expect(row, "an outcome with nothing in it still needs a row that reads").toContain("no verdict recorded");
  });

  test("only one outcome is open at a time", () => {
    expect(SRC).toContain("useState<number | null>(null)");
    expect(SRC).toContain("(v === r.id ? null : r.id)");
  });
});

describe("the discard chip stops claiming there is nothing to lose", () => {
  /*
   * `sweepEmptyWorktrees` (server/src/understudy-watchdog.ts) only ever
   * SPARES a worktree because it measured commits still sitting on the
   * branch — exactly the case the chip's old, unconditional tooltip denied.
   */
  const SRC = readFileSync(new URL("../src/components/understudy/Work.tsx", import.meta.url), "utf8");

  test("reads the count back out of the line the sweep left in the outcome", () => {
    expect(commitsSpared("Left 3 commits on feat/spared that nobody has merged — the sweep kept the worktree because of them."))
      .toBe(3);
    expect(commitsSpared("Left 1 commit on feat/x that nobody has merged.")).toBe(1);
  });

  test("an outcome the sweep never touched reads as zero, not a crash", () => {
    expect(commitsSpared("tests failed: 2 of 90")).toBe(0);
    expect(commitsSpared("")).toBe(0);
  });

  test("a failed row with commits spared does not get the old blanket claim", () => {
    const at = SRC.indexOf("Throw it away");
    const chip = SRC.slice(Math.max(0, at - 700), at + 50);
    expect(chip, "the tooltip must depend on what the sweep actually found").toContain("commitsSpared(r.outcome)");
    expect(chip).toContain("that nobody has merged goes with it");
  });

  test("a row with nothing spared still gets the honest claim", () => {
    const at = SRC.indexOf('"Removes the worktree. Nothing was committed, so there is nothing else to lose."');
    expect(at, "the true case is still said, just conditionally now").toBeGreaterThan(-1);
  });
});

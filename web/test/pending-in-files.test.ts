/*
 * The review you started on GitHub, drawn on the lines it is about.
 *
 * The Review tab already listed them. Files did not, so a comment you wrote in
 * GitHub's own UI was invisible exactly where you would go looking for it — on
 * the line — and the file header counted zero while the comment existed.
 *
 * A third kind of mark, deliberately. It is not a published thread: nobody to
 * reply to, nothing to resolve. It is not one of our drafts either: those live
 * in this browser until they are sent, and can be dropped. Drawing it as either
 * would offer a control that cannot work.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();

describe("pending GitHub comments in the diff", () => {
  it("is read once by the panel, not by each tab", () => {
    /* Review lists them and Files anchors them. Two fetches would be two
       answers that can disagree about the same review. */
    expect(src.match(/api\.prPendingReview\(/g)?.length).toBe(1);
    expect(src).toContain("held: PendingLine[];");
  });

  it("anchors them by line, on the side GitHub reports", () => {
    expect(src).toContain("const heldBy = (p: string) => {");
    expect(src).toContain("const heldOnLine = newN != null ? (heldHere.get(newN) ?? []) : [];");
  });

  it("opens the inline slot for a file that has only these", () => {
    /* The row-renderer is skipped entirely unless something is anchored, so a
       file with no threads and no drafts of ours would have drawn nothing. */
    expect(src).toContain("inlineThreads.size || pendingHere.size || heldHere.size");
  });

  it("keeps one whose line the diff does not reach", () => {
    // Outdated, or in a hunk that is not shown. A comment nobody can find is
    // the same as a comment that is gone.
    expect(src).toContain("const heldBelow = held.filter(");
    expect(src).toContain("{open && heldBelow.length > 0 && (");
  });

  it("offers no Drop on them", () => {
    /* No API edits a comment inside a pending review, so the button would
       either lie or delete the whole review to reach one line. */
    const slot = src.slice(src.indexOf("{heldOnLine.map("), src.indexOf("{heldOnLine.map(") + 1200);
    expect(slot).not.toContain("Drop");
  });

  it("counts them on the file header, apart from our own", () => {
    /* Both go to the same place on submit, so a header saying "2 pending" over
       three comments disagrees with itself — but they are not the same thing,
       and one number would claim the two you can still edit are three. */
    expect(src).toContain("const heldOnFile = held.filter((h) => h.path === f.path).length;");
    expect(src).toContain("on GitHub`}");
  });

  it("says the drafts are this browser's, now that there are two kinds", () => {
    // "Queued in your review" was unambiguous while it was the only kind.
    expect(src).toContain('title="Queued in your review, in this browser"');
  });
});

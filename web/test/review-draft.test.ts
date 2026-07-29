/*
 * Reviewing a pull request from a phone.
 *
 * The screen could approve and it could merge. There was no "request changes",
 * no "comment", and no way to say anything about a specific line — even though
 * `MobileDiff` has taken an `onLine` prop since it was written, renders every
 * line as a button when you pass one, and prints "Tap a line to comment on it"
 * under the diff. Nothing ever passed it. Built, shipped, unreachable.
 *
 * The reason it could not simply be plugged in is the interesting half. A diff
 * has two coordinate systems, and `onLine` only ever handed over `(path, line)`.
 */
import { describe, expect, it } from "bun:test";
import {
  EMPTY, sideFor, setComment, commentAt, annotatedPaths, countFor, canSubmit, summarise,
  type ReviewDraft, type Verb,
} from "../src/mobile/reviewDraft.ts";

const draft = (over: Partial<ReviewDraft> = {}): ReviewDraft => ({ ...EMPTY, ...over });

describe("which file a line number belongs to", () => {
  it("addresses a deleted line on the left and everything else on the right", () => {
    // The renderer numbers a deleted line in the OLD file and an added or
    // context line in the NEW one. Sending a deleted line's number as a
    // RIGHT-side comment lands it on whatever code happens to sit at that
    // number now, or is rejected — either way the remark is not where it was
    // meant to go, and the reader has no way to tell.
    expect(sideFor("del")).toBe("LEFT");
    expect(sideFor("add")).toBe("RIGHT");
    expect(sideFor("ctx")).toBe("RIGHT");
  });
});

describe("leaving remarks while you read", () => {
  it("keeps a comment against its address", () => {
    const d = setComment(EMPTY, "src/a.ts", 12, "RIGHT", "This allocates per row");
    expect(d.comments).toEqual([{ path: "src/a.ts", line: 12, side: "RIGHT", body: "This allocates per row" }]);
    expect(commentAt(d, "src/a.ts", 12, "RIGHT")?.body).toBe("This allocates per row");
  });

  it("treats the two sides of one line number as different places", () => {
    // The same number on the left and on the right are different lines of
    // different files. Folding them together would silently overwrite one.
    let d = setComment(EMPTY, "src/a.ts", 12, "RIGHT", "the new one");
    d = setComment(d, "src/a.ts", 12, "LEFT", "the old one");
    expect(d.comments).toHaveLength(2);
    expect(commentAt(d, "src/a.ts", 12, "LEFT")?.body).toBe("the old one");
    expect(commentAt(d, "src/a.ts", 12, "RIGHT")?.body).toBe("the new one");
  });

  it("replaces rather than stacks when you come back to a line", () => {
    let d = setComment(EMPTY, "src/a.ts", 12, "RIGHT", "first thought");
    d = setComment(d, "src/a.ts", 12, "RIGHT", "better thought");
    expect(d.comments).toHaveLength(1);
    expect(d.comments[0]!.body).toBe("better thought");
  });

  it("clearing the box takes the remark back", () => {
    let d = setComment(EMPTY, "src/a.ts", 12, "RIGHT", "never mind");
    d = setComment(d, "src/a.ts", 12, "RIGHT", "   ");
    expect(d.comments).toHaveLength(0);
    expect(commentAt(d, "src/a.ts", 12, "RIGHT")).toBeNull();
  });

  it("refuses an address that is not one", () => {
    // `onLine` passes `Number(l.n) || 0`, and a hunk header has no number at
    // all — so 0 is reachable from the screen and must not become a comment
    // GitHub rejects at submit time, after the review is written.
    expect(setComment(EMPTY, "src/a.ts", 0, "RIGHT", "on nothing").comments).toHaveLength(0);
    expect(setComment(EMPTY, "", 12, "RIGHT", "nowhere").comments).toHaveLength(0);
    expect(setComment(EMPTY, "src/a.ts", 1.5, "RIGHT", "between lines").comments).toHaveLength(0);
  });

  it("trims, so an accidental newline is not a comment", () => {
    expect(setComment(EMPTY, "a.ts", 1, "RIGHT", "  said  ").comments[0]!.body).toBe("said");
  });

  it("groups by file for the list, in the order they were first written", () => {
    let d = setComment(EMPTY, "b.ts", 3, "RIGHT", "x");
    d = setComment(d, "a.ts", 9, "RIGHT", "y");
    d = setComment(d, "b.ts", 40, "RIGHT", "z");
    expect(annotatedPaths(d)).toEqual(["b.ts", "a.ts"]);
    expect(countFor(d, "b.ts")).toBe(2);
    expect(countFor(d, "a.ts")).toBe(1);
    expect(countFor(d, "never.ts")).toBe(0);
  });
});

describe("what may be submitted", () => {
  const verbs: Verb[] = ["approve", "request_changes", "comment"];

  it("needs a verb", () => {
    expect(canSubmit(draft({ body: "looks fine" }), null, false)).toEqual({
      ok: false, why: "Choose approve, request changes, or comment",
    });
  });

  it("lets an approval carry no words at all", () => {
    expect(canSubmit(EMPTY, "approve", false)).toEqual({ ok: true });
  });

  it("will not let you approve or demand changes on your own", () => {
    // GitHub refuses both. A button that always comes back red is worse than a
    // button that says why before you press it.
    expect(canSubmit(draft({ body: "ok" }), "approve", true).ok).toBe(false);
    expect(canSubmit(draft({ body: "no" }), "request_changes", true).ok).toBe(false);
    // Commenting on your own is allowed, and is how you answer a reviewer.
    expect(canSubmit(draft({ body: "answering the thread" }), "comment", true)).toEqual({ ok: true });
  });

  it("will not send a verdict with nothing said", () => {
    // The same rule the server applies, so this disables a button instead of
    // losing a review to an error toast.
    expect(canSubmit(EMPTY, "comment", false).ok).toBe(false);
    expect(canSubmit(EMPTY, "request_changes", false).ok).toBe(false);
    expect(canSubmit(draft({ body: "   " }), "comment", false).ok).toBe(false);
  });

  it("counts line comments as having said something", () => {
    const d = setComment(EMPTY, "a.ts", 4, "RIGHT", "this leaks");
    expect(canSubmit(d, "request_changes", false)).toEqual({ ok: true });
    expect(canSubmit(d, "comment", false)).toEqual({ ok: true });
  });

  it("always explains a refusal in a sentence a person can act on", () => {
    // The rule over the verbs rather than over the three cases above: any
    // refusal the screen can reach has to arrive with its reason.
    for (const v of verbs) {
      for (const mine of [true, false]) {
        const r = canSubmit(EMPTY, v, mine);
        if (r.ok) continue;
        expect(r.why.length).toBeGreaterThan(12);
        expect(r.why).not.toContain("undefined");
      }
    }
  });
});

describe("what the header says you are about to send", () => {
  it("counts the remarks and the files they are on", () => {
    let d = setComment(EMPTY, "a.ts", 1, "RIGHT", "x");
    expect(summarise(d)).toBe("1 comment on 1 file");
    d = setComment(d, "b.ts", 2, "RIGHT", "y");
    expect(summarise(d)).toBe("2 comments on 2 files");
  });

  it("counts files, not remarks, as the files", () => {
    // Three remarks all on one file is "3 comments on 1 file". With one remark
    // per file the two numbers are equal, which is how a summary that says
    // `${n} comments on ${n} files` passes every test written without this one.
    let d = setComment(EMPTY, "a.ts", 1, "RIGHT", "x");
    d = setComment(d, "a.ts", 2, "RIGHT", "y");
    d = setComment(d, "a.ts", 3, "RIGHT", "z");
    expect(summarise(d)).toBe("3 comments on 1 file");
  });

  it("distinguishes a bare note from an empty draft", () => {
    expect(summarise(EMPTY)).toBe("Nothing queued yet");
    expect(summarise(draft({ body: "one thought" }))).toBe("A note, with no line comments");
  });
});

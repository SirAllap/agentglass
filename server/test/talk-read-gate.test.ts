/*
 * Whether a "talk" note is already covered by a read mark.
 *
 * `noteTalk` only knows the newest remark it has told a listener about — it
 * has no idea whether a person has since read the pull request on another
 * device. Without this gate, a comment already read on the desk buzzes the
 * phone the next moment something re-asks the list (prWatch.ts re-asks on a
 * timer with nobody at the PRs tab to have seen the answer arrive).
 */
import { describe, expect, test } from "bun:test";
import type { MarkRow, PrTalkNote } from "../../shared/types.ts";
import { talkAlreadyRead } from "../src/marks.ts";

const note = (over: Partial<PrTalkNote> = {}): PrTalkNote => ({
  repo: "acme/orbit", number: 42, title: "Add the thing", url: "https://github.com/acme/orbit/pull/42",
  who: "ada", kind: "comment", at: "2026-09-20T10:00:00Z",
  ...over,
});

/* The key the desk and the phone actually write (shared/prUnread.ts prMarkKey):
   host, owner and name from the pull request's URL. Not the note's `repo`,
   which is `owner/name` — a gate keyed on that matched no mark ever written. */
const mark = (over: Partial<MarkRow> = {}): MarkRow => ({
  kind: "pr", key: "github.com/acme/orbit#42", seenAt: 0, state: "", updatedAt: 0,
  ...over,
});

describe("a talk note against the read marks", () => {
  test("no mark for this pull request at all — not read", () => {
    expect(talkAlreadyRead(note(), [])).toBe(false);
  });

  test("a mark older than the remark — not read", () => {
    const at = Date.parse("2026-09-20T09:00:00Z");
    expect(talkAlreadyRead(note(), [mark({ seenAt: at })])).toBe(false);
  });

  test("a mark at or after the remark — already read", () => {
    const at = Date.parse("2026-09-20T10:00:00Z");
    expect(talkAlreadyRead(note(), [mark({ seenAt: at })])).toBe(true);
    expect(talkAlreadyRead(note(), [mark({ seenAt: at + 1000 })])).toBe(true);
  });

  test("a mark for a different pull request does not cover this one", () => {
    const at = Date.parse("2026-09-20T12:00:00Z");
    expect(talkAlreadyRead(note(), [mark({ key: "github.com/acme/orbit#7", seenAt: at })])).toBe(false);
    expect(talkAlreadyRead(note({ repo: "acme/other", url: "https://github.com/acme/other/pull/42" }), [mark({ seenAt: at })])).toBe(false);
  });

  test("a non-pr mark with the same key does not count", () => {
    const at = Date.parse("2026-09-20T12:00:00Z");
    expect(talkAlreadyRead(note(), [mark({ kind: "card", seenAt: at })])).toBe(false);
  });
});

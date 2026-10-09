/*
 * The tick store behind a live `talk` frame.
 *
 * No renderer in this project, so what `noteTalk` does to the store is
 * asserted through the plain read-only accessors (`talkTickNow`,
 * `prTalkTickNow`) rather than by mounting `useTalkTick`/`usePrTalkTick` —
 * the same shape pr-detail.test.ts uses for its own store.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { noteChecks, noteTalk, prTalkTickNow, talkTickNow, __resetTalkTicks } from "../src/state/pr-talk.ts";
import type { PrTalkNote } from "../../shared/types.ts";
import { prMarkKey } from "../../shared/prUnread.ts";

const note = (over: Partial<PrTalkNote> = {}): PrTalkNote => ({
  repo: "acme/orbit", number: 42, title: "Add the thing",
  url: "https://github.com/acme/orbit/pull/42", who: "ada", kind: "comment",
  at: "2026-09-20T10:00:00Z", ...over,
});

beforeEach(() => __resetTalkTicks());

describe("noteTalk bumps both counters", () => {
  test("the global tick moves on any pull request", () => {
    expect(talkTickNow()).toBe(0);
    noteTalk(note());
    expect(talkTickNow()).toBe(1);
    noteTalk(note({ number: 7 }));
    expect(talkTickNow()).toBe(2);
  });

  test("the per-pull-request tick only moves for its own repo#number", () => {
    noteTalk(note());
    expect(prTalkTickNow("github.com/acme/orbit#42")).toBe(1);
    expect(prTalkTickNow("github.com/acme/orbit#7")).toBe(0);
    expect(prTalkTickNow("github.com/acme/other#42")).toBe(0);

    noteTalk(note());
    expect(prTalkTickNow("github.com/acme/orbit#42")).toBe(2);
  });
});

/* A `ci` or `prchecks` frame says the checks of ONE pull request moved. The open
 * detail must re-read on it — it only listened for `talk`, so a run that
 * finished with nobody commenting left the screen saying "2 failed". The list
 * is left alone: a frame per change of a run would be a list read per frame. */
describe("noteChecks", () => {
  test("moves this pull request's tick and nothing else", () => {
    noteChecks("acme/orbit", 42);
    expect(prTalkTickNow("github.com/acme/orbit#42")).toBe(1);
    expect(prTalkTickNow("github.com/acme/orbit#7")).toBe(0);
    expect(talkTickNow()).toBe(0);
  });

  test("lands on the key a screen derives from the pull request's own url", () => {
    noteChecks("acme/orbit", 42);
    expect(prTalkTickNow(prMarkKey({ number: 42, url: "https://github.com/acme/orbit/pull/42" }))).toBe(1);
  });
});

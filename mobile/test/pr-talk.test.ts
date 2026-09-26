/*
 * The tick store behind a live `talk` frame.
 *
 * No renderer in this project, so what `noteTalk` does to the store is
 * asserted through the plain read-only accessors (`talkTickNow`,
 * `prTalkTickNow`) rather than by mounting `useTalkTick`/`usePrTalkTick` —
 * the same shape pr-detail.test.ts uses for its own store.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { noteTalk, prTalkTickNow, talkTickNow, __resetTalkTicks } from "../src/state/pr-talk.ts";
import type { PrTalkNote } from "../../shared/types.ts";

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

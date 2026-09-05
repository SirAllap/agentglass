/*
 * What the bell says when a person speaks on a pull request.
 *
 * The thing that was asked for by name is the verdict: "priya reviewed
 * #669" is true of an approval and of a block, and those are opposite
 * instructions. So the wording is a suite rather than a judgement call — every
 * shape GitHub can hand over has one sentence, and only one of them is loud.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import type { PrTalkNote } from "../../shared/types.ts";

const cell = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => cell.get(k) ?? null,
  setItem: (k: string, v: string) => { cell.set(k, v); },
  removeItem: (k: string) => { cell.delete(k); },
};

const {
  talkVerb, talkSummary, talkBody, talkUrgency, talkShouldNotify,
  talkNotify, setTalkNotify, TALK_NOTIFY_DEFAULT,
} = await import("../src/lib/talkNotify.ts");

const note = (over: Partial<PrTalkNote> = {}): PrTalkNote => ({
  repo: "acme/orbit", number: 1042, title: "Remove the carryover from the upgrade",
  url: "https://github.com/acme/orbit/pull/1042",
  who: "javidoe", kind: "review", at: "2026-08-14T10:00:00Z", ...over,
});

describe("what it says", () => {
  it("names the verdict, because the verdicts are opposite instructions", () => {
    expect(talkVerb(note({ state: "APPROVED" }))).toBe("approved it");
    expect(talkVerb(note({ state: "CHANGES_REQUESTED" }))).toBe("requested changes");
    expect(talkVerb(note({ state: "DISMISSED" }))).toBe("dismissed a review");
  });

  it("reports a batch of line comments as the comments it is", () => {
    expect(talkVerb(note({ state: "COMMENTED", lines: 3 }))).toBe("left 3 line comments");
    expect(talkVerb(note({ state: "COMMENTED", lines: 1 }))).toBe("left a line comment");
  });

  it("a review with nothing on the lines has something of its own to read", () => {
    expect(talkVerb(note({ state: "COMMENTED" }))).toBe("reviewed it");
  });

  it("a conversation comment is a comment", () => {
    expect(talkVerb(note({ kind: "comment", state: undefined }))).toBe("commented");
  });

  it("reads like the CI note beside it in the same bell", () => {
    expect(talkSummary(note({ state: "CHANGES_REQUESTED" })))
      .toBe("acme/orbit#1042 — javidoe requested changes");
  });

  it("says how much came with it rather than saying it five times", () => {
    expect(talkBody(note())).toBe("Remove the carryover from the upgrade");
    expect(talkBody(note({ more: 1 }))).toContain("+1 more remark in the same conversation");
    expect(talkBody(note({ more: 4 }))).toContain("+4 more remarks");
  });

  // An approval unblocks you and a comment is somebody talking; a block is the
  // one that is an instruction, and the one worth taking the screen for.
  it("only a block is loud", () => {
    expect(talkUrgency(note({ state: "CHANGES_REQUESTED" }))).toBe(2);
    expect(talkUrgency(note({ state: "APPROVED" }))).toBe(1);
    expect(talkUrgency(note({ kind: "comment", state: undefined }))).toBe(1);
  });
});

describe("how much of it you asked for", () => {
  beforeEach(() => cell.clear());

  it("is everything until somebody says otherwise", () => {
    expect(talkNotify()).toBe(TALK_NOTIFY_DEFAULT);
    expect(TALK_NOTIFY_DEFAULT).toBe("everything");
  });

  it("survives being turned off and back on", () => {
    setTalkNotify("off");
    expect(talkNotify()).toBe("off");
    setTalkNotify("everything");
    // The bug this is written against: reading the stored value through a cast
    // makes an absent setting and a stored "off" the same fact, which puts the
    // default out of reach for ever.
    expect(talkNotify()).toBe("everything");
  });

  it("nonsense in the store reads as the default, not as off", () => {
    cell.set("agentglass.pr.talkNotify", "yes please");
    expect(talkNotify()).toBe("everything");
  });

  it("reviews only lets a review through and holds a comment back", () => {
    expect(talkShouldNotify({ kind: "review" }, "reviews")).toBe(true);
    expect(talkShouldNotify({ kind: "comment" }, "reviews")).toBe(false);
  });

  it("off is off", () => {
    expect(talkShouldNotify({ kind: "review" }, "off")).toBe(false);
  });
});

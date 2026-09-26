/*
 * Whether a fresh pull-request remark buzzes THIS phone.
 *
 * A separate gate from notify-policy.test.ts's `shouldNotify`: that one reads
 * what the server decided, this one starts from a per-device preference the
 * server never sees (talkPref.ts). Same shape of suite — each "no" is its own
 * case.
 */
import { describe, expect, test } from "bun:test";
import { remember, shouldNotifyTalk, SAME_ALERT_MS } from "../src/notifications/policy.ts";
import { talkBody, talkSummary } from "../../shared/talkWords.ts";
import type { PrTalkNote } from "../../shared/types.ts";

const note = (over: Partial<PrTalkNote> = {}): PrTalkNote => ({
  repo: "acme/orbit", number: 42, title: "Add the thing",
  url: "https://github.com/acme/orbit/pull/42", who: "ada", kind: "comment",
  at: "2026-09-20T10:00:00Z", ...over,
});

const ctx = (over: Partial<{ pref: "off" | "reviews" | "everything"; foreground: boolean; lastSeen: Map<string, number>; now: number }> = {}) => ({
  pref: "everything" as const, foreground: false, lastSeen: new Map<string, number>(), now: 1_000_000,
  ...over,
});

describe("shouldNotifyTalk", () => {
  test("off is off, no matter what the remark is", () => {
    expect(shouldNotifyTalk(note(), ctx({ pref: "off" }))).toEqual({ notify: false, because: "off" });
    expect(shouldNotifyTalk(note({ kind: "review", state: "CHANGES_REQUESTED" }), ctx({ pref: "off" })))
      .toEqual({ notify: false, because: "off" });
  });

  test("reviews-only lets a review through and holds back a plain comment", () => {
    expect(shouldNotifyTalk(note({ kind: "comment" }), ctx({ pref: "reviews" })))
      .toEqual({ notify: false, because: "pref-mismatch" });
    expect(shouldNotifyTalk(note({ kind: "review", state: "APPROVED" }), ctx({ pref: "reviews" })))
      .toEqual({ notify: true });
  });

  test("everything lets a plain comment through too", () => {
    expect(shouldNotifyTalk(note({ kind: "comment" }), ctx({ pref: "everything" }))).toEqual({ notify: true });
  });

  test("foreground — the tick still happens elsewhere, but no system notification", () => {
    expect(shouldNotifyTalk(note(), ctx({ foreground: true }))).toEqual({ notify: false, because: "foreground" });
  });

  test("the same remark inside the window does not buzz twice", () => {
    const seen = ctx();
    expect(shouldNotifyTalk(note(), seen)).toEqual({ notify: true });
    // Remembered the same way host-context.tsx does for a raised alert: by
    // the words this note would actually show.
    remember({ title: talkSummary(note()), body: talkBody(note()) }, seen);
    expect(shouldNotifyTalk(note(), seen)).toEqual({ notify: false, because: "repeat" });

    const later = ctx({ lastSeen: seen.lastSeen, now: seen.now + SAME_ALERT_MS + 1 });
    expect(shouldNotifyTalk(note(), later)).toEqual({ notify: true });
  });

  test("a different remark on the same pull request is not the repeat", () => {
    const seen = ctx();
    shouldNotifyTalk(note(), seen);
    remember({ title: talkSummary(note()), body: talkBody(note()) }, seen);
    expect(shouldNotifyTalk(note({ who: "sam" }), seen)).toEqual({ notify: true });
  });
});

/*
 * The desk's wording and the shared wording are the same function.
 *
 * web/src/lib/talkNotify.ts re-exports talkSummary/talkBody/talkUrgency from
 * shared/talkWords.ts rather than keeping its own copy, so the phone (which
 * imports shared/talkWords.ts directly, never talkNotify.ts) cannot drift
 * from what the desk says about the same event. This asserts the re-export
 * IS the shared function — byte-identical output, not merely similar.
 */
import { describe, expect, it } from "bun:test";
import type { PrTalkNote } from "../../shared/types.ts";
import * as shared from "../../shared/talkWords.ts";
import * as web from "../src/lib/talkNotify.ts";

const notes: PrTalkNote[] = [
  {
    repo: "acme/orbit", number: 1042, title: "Remove the carryover from the upgrade",
    url: "https://github.com/acme/orbit/pull/1042", who: "ada", kind: "review",
    state: "APPROVED", at: "2026-08-14T10:00:00Z",
  },
  {
    repo: "acme/orbit", number: 7, title: "Fix the flaky retry",
    url: "https://github.com/acme/orbit/pull/7", who: "ada", kind: "review",
    state: "CHANGES_REQUESTED", at: "2026-08-14T10:00:00Z",
  },
  {
    repo: "acme/orbit", number: 7, title: "Fix the flaky retry",
    url: "https://github.com/acme/orbit/pull/7", who: "ada", kind: "comment",
    at: "2026-08-14T10:00:00Z", more: 3,
  },
  {
    repo: "acme/orbit", number: 7, title: "Fix the flaky retry",
    url: "https://github.com/acme/orbit/pull/7", who: "ada", kind: "review",
    state: "COMMENTED", lines: 3, at: "2026-08-14T10:00:00Z",
  },
];

describe("web's talkNotify re-export matches shared/talkWords.ts", () => {
  it("is the same function, not a second copy that happens to agree today", () => {
    expect(web.talkSummary).toBe(shared.talkSummary);
    expect(web.talkBody).toBe(shared.talkBody);
    expect(web.talkUrgency).toBe(shared.talkUrgency);
  });

  for (const n of notes) {
    it(`${n.repo}#${n.number} ${n.kind}${n.state ? `/${n.state}` : ""}`, () => {
      expect(web.talkSummary(n)).toBe(shared.talkSummary(n));
      expect(web.talkBody(n)).toBe(shared.talkBody(n));
      expect(web.talkUrgency(n)).toBe(shared.talkUrgency(n));
    });
  }
});

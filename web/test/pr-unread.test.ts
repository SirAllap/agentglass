/*
 * The badge on a card: "somebody has said something here since you last looked".
 *
 * The rule these are written against is that the board's number and the
 * conversation's number have to be the same number. A card saying "2 new" over a
 * panel that then marks three is a card nobody believes a second time — so the
 * counting rules (a review's line comments counted individually, a bare batch not
 * counted twice, your own remarks never counted, machines never present) are
 * pinned here rather than left to agree by coincidence.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import type { PrTalk } from "../../shared/types.ts";

/* A real store, and installed before the module is imported — the same reason
   spelled out in pr-new.test.ts: `bun test` runs every suite in one process, so
   a stubbed no-op `setItem` from another file would make these silently pass. */
const cell = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => cell.get(k) ?? null,
  setItem: (k: string, v: string) => { cell.set(k, v); },
  removeItem: (k: string) => { cell.delete(k); },
};

const { unreadOf, unreadTitle, weightOf, bootstrapMark } = await import("../src/lib/prUnread.ts");
const { writeSeen, prSeenKey } = await import("../src/lib/prNew.ts");

const REPO = "acme/orbit";
const said = (at: string, who: string, over: Partial<PrTalk> = {}): PrTalk => ({ at, who, kind: "comment", ...over });
const row = (talk?: PrTalk[]) => ({ number: 42, ...(talk ? { talk } : null) });

const MON = "2026-08-10T09:00:00Z";
const TUE = "2026-08-11T09:00:00Z";
const WED = "2026-08-12T09:00:00Z";

describe("weightOf — how much there is to read in one remark", () => {
  it("a comment is one thing", () => {
    expect(weightOf(said(MON, "javidoe"))).toBe(1);
  });

  // The case that would otherwise disagree with the conversation panel: it lists
  // each line comment, and the review they arrived in is not itself a remark.
  it("a batch of line comments is its lines, and not one more", () => {
    expect(weightOf({ at: MON, who: "javidoe", kind: "review", state: "COMMENTED", lines: 3 })).toBe(3);
  });

  it("a review that says something is that, plus the lines it carries", () => {
    expect(weightOf({ at: MON, who: "javidoe", kind: "review", state: "CHANGES_REQUESTED", lines: 2, says: true })).toBe(3);
  });
});

describe("unreadOf", () => {
  beforeEach(() => cell.clear());

  it("says nothing about a row whose second pass has not landed", () => {
    expect(unreadOf(row(), REPO)).toBeNull();
  });

  // Not "eleven unread". A pull request you have never opened and never spoken
  // on is one you have not started, and announcing its whole history as news is
  // the noise this feature is supposed to cut.
  it("says nothing when you have neither looked nor spoken", () => {
    expect(unreadOf(row([said(MON, "javidoe"), said(TUE, "samlee")]), REPO)).toBeNull();
  });

  // The fallback the conversation uses. Without it the feature introduces itself
  // by doing nothing on exactly the pull requests you care about.
  it("counts from your own last word when there is no mark", () => {
    const u = unreadOf(row([said(MON, "me", { mine: true }), said(TUE, "javidoe"), said(WED, "samlee")]), REPO);
    expect(u).toMatchObject({ count: 2, who: "samlee" });
    expect(u!.people).toEqual(["samlee", "javidoe"]);
  });

  it("counts from the mark once there is one, and the mark wins", () => {
    writeSeen(prSeenKey(REPO, 42), Date.parse(TUE));
    const u = unreadOf(row([said(MON, "me", { mine: true }), said(TUE, "javidoe"), said(WED, "samlee")]), REPO);
    expect(u).toMatchObject({ count: 1, who: "samlee" });
  });

  it("goes quiet the moment the mark passes everything", () => {
    writeSeen(prSeenKey(REPO, 42), Date.parse(WED) + 1);
    expect(unreadOf(row([said(TUE, "javidoe"), said(WED, "samlee")]), REPO)).toBeNull();
  });

  // A badge that lights up because you spoke is a badge that means nothing.
  it("never counts your own remarks", () => {
    writeSeen(prSeenKey(REPO, 42), Date.parse(MON));
    expect(unreadOf(row([said(TUE, "me", { mine: true }), said(WED, "me", { mine: true })]), REPO)).toBeNull();
  });

  // Pull request numbers are per repository, so a bare number would have one
  // project's marks reading another's rows.
  it("marks belong to a repository", () => {
    writeSeen(prSeenKey(REPO, 42), Date.parse(WED) + 1);
    const talk = [said(MON, "me", { mine: true }), said(WED, "samlee")];
    // Read against the repository the mark was written for: nothing.
    expect(unreadOf(row(talk), REPO)).toBeNull();
    // The same number in another repository is another pull request, and this
    // one has never been looked at — so it falls back to your own last word.
    expect(unreadOf(row(talk), "acme/other")).toMatchObject({ count: 1 });
  });

  it("names the verdict when one of the unread things is a review", () => {
    writeSeen(prSeenKey(REPO, 42), Date.parse(MON));
    const u = unreadOf(row([
      { at: TUE, who: "javidoe", kind: "review", state: "CHANGES_REQUESTED", says: true },
      said(WED, "samlee"),
    ]), REPO);
    // The newest speaker is the comment; the verdict still travels, because
    // "somebody blocked this" is a different instruction from "somebody spoke".
    expect(u).toMatchObject({ who: "samlee", state: "CHANGES_REQUESTED", count: 2 });
    expect(unreadTitle(u!)).toBe("2 new remarks since you last looked, from samlee, javidoe — changes requested");
  });

  it("reads as one sentence for the ordinary case", () => {
    writeSeen(prSeenKey(REPO, 42), Date.parse(MON));
    const u = unreadOf(row([said(TUE, "javidoe")]), REPO);
    expect(unreadTitle(u!)).toBe("1 new remark since you last looked, from javidoe");
  });
});

describe("bootstrapMark", () => {
  it("is your latest word, not your first", () => {
    expect(bootstrapMark([said(MON, "me", { mine: true }), said(WED, "me", { mine: true })])).toBe(Date.parse(WED));
  });

  it("is zero when you have never spoken", () => {
    expect(bootstrapMark([said(MON, "javidoe")])).toBe(0);
  });
});

// The review history as one story per reviewer.
//
// The fixture is the shape of a real pull request that was reviewed three
// times over three days: one reviewer asked again and then approved, one whose
// request for changes was followed by a plain comment, one asked again who has
// not answered. Times are built from local components so the stamp under each
// chip reads the same whatever the machine's zone.
import { describe, expect, test } from "bun:test";
import { buildReviewStory, relative, span, stamp } from "../../shared/reviewStory.ts";
import type { PrEvent, PrReview } from "../../shared/types.ts";

const at = (m: number, d: number, h: number, min: number) => new Date(2026, m - 1, d, h, min).toISOString();
const NOW = new Date(2026, 8, 30, 16, 0).getTime();

const review = (author: string, state: PrReview["state"], when: string): PrReview => ({
  author, state, submittedAt: when, isBot: false, body: "", url: `https://github.com/acme/orbit/pull/7#pullrequestreview-${author}-${state}-${when}`,
  nodeId: `PRR_${author}_${state}_${when}`,
} as PrReview);
const ask = (login: string, when: string, actor = "dana-dev"): PrEvent => ({ kind: "review-requested", at: when, actor, detail: login });
const unask = (login: string, when: string): PrEvent => ({ kind: "review-request-removed", at: when, actor: "dana-dev", detail: login });

const reviews: PrReview[] = [
  review("ana-dev", "CHANGES_REQUESTED", at(9, 27, 14, 5)),
  review("cleo-dev", "CHANGES_REQUESTED", at(9, 28, 10, 20)),
  review("ben-dev", "CHANGES_REQUESTED", at(9, 29, 13, 15)),
  review("cleo-dev", "COMMENTED", at(9, 29, 19, 35)),
  review("ana-dev", "APPROVED", at(9, 30, 13, 55)),
  // The author answering their own threads is not a round.
  review("dana-dev", "COMMENTED", at(9, 28, 9, 0)),
  { ...review("orbit-bot", "COMMENTED", at(9, 27, 15, 0)), isBot: true },
];
const timeline: PrEvent[] = [
  ask("ana-dev", at(9, 27, 9, 0)), // the first request, before any review: not "asked again"
  ask("ana-dev", at(9, 28, 15, 40)),
  ask("ben-dev", at(9, 29, 19, 50)),
];
const story = () => buildReviewStory({ reviews, timeline, pending: ["ben-dev"], author: "dana-dev", you: "dana-dev" }, NOW);

describe("groups", () => {
  test("one group per reviewer, oldest story first; the author and bots are not reviewers", () => {
    expect(story().map((g) => g.login)).toEqual(["ana-dev", "cleo-dev", "ben-dev"]);
  });

  test("a reviewer's rounds and the re-requests to them run together, oldest first", () => {
    const ana = story()[0]!;
    expect(ana.entries.map((e) => e.kind === "review" ? e.state : "ask")).toEqual(["CHANGES_REQUESTED", "ask", "APPROVED"]);
    expect(ana.entries.map((e) => e.at)).toEqual([...ana.entries.map((e) => e.at)].sort());
  });

  test("the first request, before anybody reviewed, is not drawn as asked again", () => {
    expect(story()[0]!.entries.filter((e) => e.kind === "ask")).toHaveLength(1);
  });
});

describe("where they stand now", () => {
  test("approved after changes reads as resolved", () => {
    const ana = story()[0]!;
    expect(ana.standing).toBe("APPROVED");
    expect(ana.line).toBe("resolved 2h ago");
  });

  test("a comment does not clear a request for changes", () => {
    const cleo = story()[1]!;
    expect(cleo.standing).toBe("CHANGES_REQUESTED");
    expect(cleo.line).toBe("still blocking, commented since");
    expect(cleo.entries.map((e) => e.kind === "review" ? e.sentence : "")).toEqual([
      "still stands: a comment does not clear it",
      "comment only, changes above still stand",
    ]);
  });

  test("asked again and not answered: the changes still stand, and for how long", () => {
    const ben = story()[2]!;
    expect(ben.standing).toBe("ASKED_AGAIN");
    expect(ben.line).toBe("changes still stand, waiting 20h");
  });

  test("an approval that was re-requested says the approval stands", () => {
    const g = buildReviewStory({
      reviews: [review("ana-dev", "APPROVED", at(9, 28, 10, 0))],
      timeline: [ask("ana-dev", at(9, 30, 10, 0))], pending: ["ana-dev"], author: "dana-dev",
    }, NOW)[0]!;
    expect(g.line).toBe("approval stands, waiting 6h");
  });

  test("a lone approval is approved, not resolved", () => {
    const g = buildReviewStory({ reviews: [review("ana-dev", "APPROVED", at(9, 30, 13, 55))], author: "dana-dev" }, NOW)[0]!;
    expect(g.line).toBe("approved 2h ago");
  });

  test("only comments: commented", () => {
    const g = buildReviewStory({ reviews: [review("cleo-dev", "COMMENTED", at(9, 29, 19, 35))], author: "dana-dev" }, NOW)[0]!;
    expect(g.standing).toBe("COMMENTED");
    expect(g.line).toBe("commented 20h ago");
  });
});

describe("a round that was replaced", () => {
  test("a later approval replaces the earlier request for changes, and says where", () => {
    const [changes, , approved] = story()[0]!.entries;
    expect(changes).toMatchObject({ kind: "review", state: "CHANGES_REQUESTED", replaced: { by: "approval", at: at(9, 30, 13, 55) } });
    expect(changes!.kind === "review" && changes!.replaced!.nodeId).toBe(approved!.kind === "review" ? approved!.nodeId : "");
    expect(changes!.kind === "review" && changes!.sentence).toBe(`Replaced by approval · ${stamp(at(9, 30, 13, 55))}`);
    expect(approved).toMatchObject({ state: "APPROVED", sentence: "closes the round above" });
    expect((approved as { replaced?: unknown }).replaced).toBeUndefined();
  });

  test("a comment never replaces anything", () => {
    const cleo = story()[1]!;
    expect(cleo.entries.every((e) => e.kind !== "review" || !e.replaced)).toBe(true);
  });

  test("a newer request for changes replaces the older one", () => {
    const g = buildReviewStory({
      reviews: [review("ana-dev", "CHANGES_REQUESTED", at(9, 27, 14, 5)), review("ana-dev", "CHANGES_REQUESTED", at(9, 29, 9, 0))],
      author: "dana-dev",
    }, NOW)[0]!;
    expect(g.entries[0]).toMatchObject({ replaced: { by: "changes" } });
    expect(g.entries[0]!.sentence).toStartWith("Replaced by a newer request for changes");
    expect(g.entries[1]).toMatchObject({ sentence: "changes requested, still open" });
  });

  test("a round somebody was asked to look at again stays live", () => {
    const ben = story()[2]!;
    expect(ben.entries[0]).toMatchObject({ state: "CHANGES_REQUESTED", sentence: "re-requested below, no answer yet" });
    expect((ben.entries[0] as { replaced?: unknown }).replaced).toBeUndefined();
  });
});

describe("the re-requests", () => {
  test("say who asked: you when the viewer did, the login when somebody else did", () => {
    const asked = (actor: string) => buildReviewStory({
      reviews: [review("ana-dev", "CHANGES_REQUESTED", at(9, 27, 14, 5)), review("ana-dev", "APPROVED", at(9, 30, 13, 55))],
      timeline: [ask("ana-dev", at(9, 28, 15, 40), actor)], author: "dana-dev", you: "dana-dev",
    }, NOW)[0]!.entries[1]!;
    expect(asked("dana-dev")).toMatchObject({ actor: "you", sentence: "asked ana-dev to look again" });
    expect(asked("ben-dev")).toMatchObject({ actor: "ben-dev", sentence: "ben-dev asked ana-dev to look again" });
  });

  test("an unanswered ask is waiting on them", () => {
    expect(story()[2]!.entries[1]).toMatchObject({ kind: "ask", actor: "you", waiting: true, sentence: "waiting on ben-dev" });
  });

  test("a request that was withdrawn is not drawn", () => {
    const g = buildReviewStory({
      reviews: [review("ana-dev", "CHANGES_REQUESTED", at(9, 27, 14, 5))],
      timeline: [ask("ana-dev", at(9, 28, 15, 40)), unask("ana-dev", at(9, 28, 16, 0))], author: "dana-dev",
    }, NOW)[0]!;
    expect(g.entries.filter((e) => e.kind === "ask")).toHaveLength(0);
    expect(g.standing).toBe("CHANGES_REQUESTED");
  });

  test("a request withdrawn before the reviewer came back anyway is not drawn as answered", () => {
    const g = buildReviewStory({
      reviews: [review("ana-dev", "CHANGES_REQUESTED", at(9, 27, 14, 5)), review("ana-dev", "APPROVED", at(9, 30, 13, 55))],
      timeline: [ask("ana-dev", at(9, 28, 15, 40)), unask("ana-dev", at(9, 28, 16, 0))], author: "dana-dev",
    }, NOW)[0]!;
    expect(g.entries.filter((e) => e.kind === "ask")).toHaveLength(0);
  });

  test("an unanswered ask GitHub no longer lists is not drawn", () => {
    const g = buildReviewStory({
      reviews: [review("ana-dev", "CHANGES_REQUESTED", at(9, 27, 14, 5))],
      timeline: [ask("ana-dev", at(9, 28, 15, 40))], pending: [], author: "dana-dev",
    }, NOW)[0]!;
    expect(g.entries.filter((e) => e.kind === "ask")).toHaveLength(0);
  });

  test("two asks with no review between are one", () => {
    const g = buildReviewStory({
      reviews: [review("ana-dev", "CHANGES_REQUESTED", at(9, 27, 14, 5))],
      timeline: [ask("ana-dev", at(9, 28, 15, 40)), ask("ana-dev", at(9, 29, 8, 0))], pending: ["ana-dev"], author: "dana-dev",
    }, NOW)[0]!;
    const asks = g.entries.filter((e) => e.kind === "ask");
    expect(asks.map((e) => e.at)).toEqual([at(9, 29, 8, 0)]);
  });

  test("login matching ignores case, as GitHub's does", () => {
    const g = buildReviewStory({
      reviews: [review("Ana-Dev", "CHANGES_REQUESTED", at(9, 27, 14, 5))],
      timeline: [ask("ana-dev", at(9, 28, 15, 40))], pending: ["ANA-DEV"], author: "dana-dev",
    }, NOW)[0]!;
    expect(g.standing).toBe("ASKED_AGAIN");
    expect(g.entries).toHaveLength(2);
  });
});

describe("empty and odd input", () => {
  test("no reviews, no story", () => {
    expect(buildReviewStory({}, NOW)).toEqual([]);
    expect(buildReviewStory({ reviews: [review("dana-dev", "COMMENTED", at(9, 28, 9, 0))], author: "dana-dev" }, NOW)).toEqual([]);
  });

  test("a dismissed or pending review is not a round", () => {
    expect(buildReviewStory({ reviews: [review("ana-dev", "DISMISSED", at(9, 28, 9, 0)), review("ben-dev", "PENDING", at(9, 28, 9, 0))], author: "dana-dev" }, NOW)).toEqual([]);
  });
});

describe("time words", () => {
  test("the spans the mock shows", () => {
    expect(relative(at(9, 30, 13, 55), NOW)).toBe("2h ago");
    expect(relative(at(9, 29, 19, 35), NOW)).toBe("20h ago");
    expect(relative(at(9, 29, 13, 15), NOW)).toBe("1d ago");
    expect(relative(at(9, 27, 14, 5), NOW)).toBe("3d ago");
    expect(span(at(9, 30, 15, 59), NOW)).toBe("just now");
    expect(stamp(at(9, 28, 15, 40))).toBe("Sep 28 · 15:40");
    expect(stamp("not a date")).toBe("");
  });
});

// The tail of a pull request's conversation, and the latch in front of it.
//
// Two things are worth a suite here, and both have a failure mode somebody feels
// straight away rather than one a reviewer would spot:
//
//   mapTalk   what counts as somebody speaking. A bot in this list is a badge
//             that is lit on every push, which is a badge nobody reads.
//   noteTalk  one message per pull request per poll, and silence on first
//             sight. Get it wrong and opening the panel announces a week of
//             conversation, one pop-up at a time.
import { describe, test, expect, beforeEach } from "bun:test";
import * as prs from "../src/prs.ts";
import type { PrSummary, PrTalk } from "../../shared/types.ts";

const node = (over: Record<string, unknown> = {}) => ({
  comments: { nodes: [] },
  reviews: { nodes: [] },
  ...over,
});

const comment = (at: string, login: string, over: Record<string, unknown> = {}) =>
  ({ createdAt: at, author: { login }, ...over });

const review = (at: string | null, login: string, state: string, lines = 0, over: Record<string, unknown> = {}) =>
  ({ submittedAt: at, state, author: { login }, comments: { totalCount: lines }, ...over });

describe("mapTalk — who spoke, and what counts as speaking", () => {
  test("comments and reviews arrive as one list, oldest first", () => {
    const talk = prs.mapTalk(node({
      comments: { nodes: [comment("2026-08-14T10:00:00Z", "javidoe")] },
      reviews: { nodes: [review("2026-08-14T09:00:00Z", "samlee", "APPROVED")] },
    }));
    expect(talk.map((t) => `${t.who}:${t.kind}`)).toEqual(["samlee:review", "javidoe:comment"]);
  });

  // The whole reason the count is worth having. On a live pull request the
  // machines outnumber the people two to one.
  test("a machine is not somebody speaking", () => {
    const talk = prs.mapTalk(node({
      comments: { nodes: [comment("2026-08-14T10:00:00Z", "codecov[bot]"), comment("2026-08-14T11:00:00Z", "javidoe")] },
      reviews: { nodes: [review("2026-08-14T12:00:00Z", "dependabot[bot]", "COMMENTED", 3)] },
    }));
    expect(talk.map((t) => t.who)).toEqual(["javidoe"]);
  });

  // A review being written is on its author's screen, not in the conversation.
  test("a review nobody has submitted is not in the conversation", () => {
    const talk = prs.mapTalk(node({
      reviews: { nodes: [review(null, "javidoe", "PENDING", 2), review("2026-08-14T10:00:00Z", "javidoe", "APPROVED")] },
    }));
    expect(talk).toHaveLength(1);
    expect(talk[0]!.state).toBe("APPROVED");
  });

  // Both halves of the "how many is that" rule, which is what keeps this count
  // and the conversation panel's from disagreeing on screen.
  test("a batch of line comments counts its lines and not itself", () => {
    const [t] = prs.mapTalk(node({
      reviews: { nodes: [review("2026-08-14T10:00:00Z", "javidoe", "COMMENTED", 3)] },
    }));
    expect(t).toMatchObject({ kind: "review", state: "COMMENTED", lines: 3 });
    expect(t!.says).toBeUndefined();
  });

  test("a verdict speaks, whatever it is carrying", () => {
    const [t] = prs.mapTalk(node({
      reviews: { nodes: [review("2026-08-14T10:00:00Z", "javidoe", "CHANGES_REQUESTED", 4)] },
    }));
    expect(t).toMatchObject({ says: true, lines: 4, state: "CHANGES_REQUESTED" });
  });

  test("a review with no line comments at all has a body to read", () => {
    const [t] = prs.mapTalk(node({
      reviews: { nodes: [review("2026-08-14T10:00:00Z", "javidoe", "COMMENTED", 0)] },
    }));
    expect(t!.says).toBe(true);
  });

  // Yours is kept and flagged, because it is the fallback mark for a pull
  // request this browser has never opened — see PrTalk.mine.
  test("your own remarks are carried, marked as yours", () => {
    const talk = prs.mapTalk(node({
      comments: { nodes: [comment("2026-08-14T10:00:00Z", "me", { viewerDidAuthor: true })] },
    }));
    expect(talk[0]).toMatchObject({ mine: true });
  });

  test("an unknown review state is reported as a plain comment rather than invented", () => {
    const [t] = prs.mapTalk(node({
      reviews: { nodes: [review("2026-08-14T10:00:00Z", "javidoe", "SOMETHING_NEW")] },
    }));
    expect(t!.state).toBe("COMMENTED");
  });

  test("a busy conversation is capped at its newest remarks", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      comment(`2026-08-${String(i + 1).padStart(2, "0")}T10:00:00Z`, `p${i}`));
    const talk = prs.mapTalk(node({ comments: { nodes: many } }));
    expect(talk).toHaveLength(prs.TALK_MAX);
    // The tail, not the head: the question is "anything since I looked".
    expect(talk[talk.length - 1]!.who).toBe("p29");
  });

  // Measured against this repository, not assumed: GitHub's own code scanning
  // reviews as `github-advanced-security`, with no `[bot]` suffix on it, and it
  // was the only "review" on three of the five most recently discussed pull
  // requests here. Counting those as people is a badge on every alert.
  test("code scanning is a check, not a reviewer", () => {
    const talk = prs.mapTalk(node({
      reviews: { nodes: [review("2026-08-14T10:00:00Z", "github-advanced-security", "COMMENTED", 2)] },
    }));
    expect(talk).toEqual([]);
  });

  test("nothing at all is an empty list, not a throw", () => {
    expect(prs.mapTalk(undefined)).toEqual([]);
    expect(prs.mapTalk({})).toEqual([]);
  });
});

describe("noteTalk — one message per pull request per poll", () => {
  const repo = prs.parseRemote("https://github.com/o/r")!;
  const pr = (n: number, talk?: PrTalk[]) => ({
    number: n, title: `pr ${n}`, author: "me", state: "OPEN", isDraft: false,
    headRefName: "h", baseRefName: "main", url: `https://github.com/o/r/pull/${n}`,
    updatedAt: "", reviewDecision: null, additions: 0, deletions: 0, changedFiles: 0,
    labels: [], assignees: [], milestone: null, mergeable: "MERGEABLE",
    checks: { total: 0, success: 0, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [] },
    ...(talk ? { talk } : null),
  }) as unknown as PrSummary;

  const said = (at: string, who: string, over: Partial<PrTalk> = {}): PrTalk =>
    ({ at, who, kind: "comment", ...over });

  beforeEach(() => prs.__resetTalkLatch());

  // The same rule the CI latch follows, and for the same reason: what is on the
  // pull request when we arrive is the state of the world, not something that
  // happened.
  test("the conversation as we found it is not news", () => {
    const seen: string[] = [];
    const off = prs.subscribeTalk((n) => seen.push(`${n.number}:${n.who}`));
    prs.noteTalk(repo, pr(1, [said("2026-08-14T10:00:00Z", "javidoe")]));
    off();
    expect(seen).toEqual([]);
  });

  test("what arrives after that IS news, once", () => {
    const seen: string[] = [];
    const off = prs.subscribeTalk((n) => seen.push(`${n.number}:${n.who}:${n.kind}`));
    prs.noteTalk(repo, pr(1, [said("2026-08-14T10:00:00Z", "javidoe")]));
    const after = [said("2026-08-14T10:00:00Z", "javidoe"), said("2026-08-14T11:00:00Z", "samlee")];
    prs.noteTalk(repo, pr(1, after));
    prs.noteTalk(repo, pr(1, after)); // the next poll, same answer
    off();
    expect(seen).toEqual(["1:samlee:comment"]);
  });

  // A review with nine line comments is one thing that happened. Nine pop-ups
  // is how a notification feature teaches people to turn it off.
  test("a burst is one message that says how much came with it", () => {
    const notes: any[] = [];
    const off = prs.subscribeTalk((n) => notes.push(n));
    prs.noteTalk(repo, pr(2, [said("2026-08-14T09:00:00Z", "me", { mine: true })]));
    prs.noteTalk(repo, pr(2, [
      said("2026-08-14T09:00:00Z", "me", { mine: true }),
      said("2026-08-14T10:00:00Z", "javidoe"),
      said("2026-08-14T10:01:00Z", "javidoe", { kind: "review", state: "CHANGES_REQUESTED", lines: 2, says: true }),
    ]));
    off();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      number: 2, who: "javidoe", kind: "review", state: "CHANGES_REQUESTED", lines: 2, more: 1,
      repo: "o/r", url: "https://github.com/o/r/pull/2",
    });
  });

  test("your own remark is not something to be told about", () => {
    const seen: string[] = [];
    const off = prs.subscribeTalk((n) => seen.push(n.who));
    prs.noteTalk(repo, pr(3, [said("2026-08-14T10:00:00Z", "javidoe")]));
    prs.noteTalk(repo, pr(3, [
      said("2026-08-14T10:00:00Z", "javidoe"),
      said("2026-08-14T11:00:00Z", "me", { mine: true }),
    ]));
    off();
    expect(seen).toEqual([]);
  });

  // The latch is a timestamp rather than a count precisely so this is silent: a
  // deleted comment lowers the count, and a count that goes down then up
  // announces the same remark twice.
  test("a remark that is deleted says nothing", () => {
    const seen: string[] = [];
    const off = prs.subscribeTalk((n) => seen.push(n.who));
    prs.noteTalk(repo, pr(4, [said("2026-08-14T10:00:00Z", "javidoe"), said("2026-08-14T11:00:00Z", "samlee")]));
    prs.noteTalk(repo, pr(4, [said("2026-08-14T10:00:00Z", "javidoe")]));
    off();
    expect(seen).toEqual([]);
  });

  // A row from the fast pass has no opinion about the conversation, and an
  // absent answer must not read as an empty one — otherwise every refresh would
  // reset the latch to zero and re-announce the last remark.
  test("a row without its second pass leaves the latch alone", () => {
    const seen: string[] = [];
    const off = prs.subscribeTalk((n) => seen.push(n.who));
    prs.noteTalk(repo, pr(5, [said("2026-08-14T10:00:00Z", "javidoe")]));
    prs.noteTalk(repo, pr(5, undefined));
    prs.noteTalk(repo, pr(5, [said("2026-08-14T10:00:00Z", "javidoe")]));
    off();
    expect(seen).toEqual([]);
  });
});

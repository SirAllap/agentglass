/*
 * The conversation as the rail draws it: remarks, verdict lines, events and
 * pushes in one order, and what each lane keeps.
 *
 * The fixture is the shape of a live pull request: a person asks for changes
 * with a review that carries a line thread, a second person comments and is
 * thanked with a reaction, an automation account posts a report, the author
 * force-pushes and adds two commits.
 */
import { describe, expect, test } from "bun:test";
import type { PrComment, PrCommit, PrEvent, PrReview, PrThread } from "../../shared/types.ts";
import { conversation, countLanes } from "../../shared/prConversation.ts";
import { newness } from "../src/model/readMarks.ts";
import { badgeOf, dividerAt, isFresh, reactionsOf, rowsIn, talkRows } from "../src/model/talk.ts";

const comment = (id: number, author: string, at: string, over: Partial<PrComment> = {}): PrComment =>
  ({ id, author, isBot: author.endsWith("[bot]"), body: `remark ${id}`, createdAt: at, ...over });
const review = (author: string, state: PrReview["state"], body: string, at: string): PrReview =>
  ({ author, isBot: false, state, body, submittedAt: at });
const commit = (oid: string, author: string, at: string): PrCommit =>
  ({ oid, short: oid.slice(0, 7), message: `change ${oid}`, author, isMerge: false, committedAt: at });
const thread = (id: string, author: string, at: string): PrThread =>
  ({
    id, path: "src/thing.ts", line: 7, startLine: null, isResolved: false, isOutdated: false, diffHunk: "", originalLine: 7, url: "",
    comments: [{ id: `${id}-1`, author, isBot: false, body: "line remark", createdAt: at }],
  }) as PrThread;

// acme/orbit#101
const d = {
  author: "ada", headRefName: "orbit-1042-sync-retry", baseRefName: "main", createdAt: "2026-09-30T08:00:00Z",
  reviews: [review("bob", "CHANGES_REQUESTED", "Please add the sandbox run.", "2026-09-30T10:00:00Z")],
  comments: [
    comment(1, "cy", "2026-09-30T11:00:00Z", { association: "MEMBER", reactions: [{ content: "THUMBS_UP", count: 2, viewerHasReacted: true }] }),
    comment(2, "orbit-ci[bot]", "2026-09-30T11:30:00Z"),
  ],
  threads: [thread("t1", "bob", "2026-09-30T09:59:58Z")],
  commits: [commit("c021ddc1", "ada", "2026-09-30T12:00:00Z"), commit("a5e20041", "ada", "2026-09-30T12:01:00Z")],
  timeline: [
    { kind: "review-requested", at: "2026-09-30T08:05:00Z", actor: "ada", detail: "bob" },
    { kind: "force-push", at: "2026-09-30T13:00:00Z", actor: "ada", detail: "aaaaaaa → fb1f5ad" },
  ] as PrEvent[],
};

describe("talkRows", () => {
  const rows = talkRows(d);

  test("opened first, then everything in the order it happened", () => {
    expect(rows.map((r) => r.kind)).toEqual(["event", "event", "event", "bubble", "thread", "bubble", "bubble", "commits", "event"]);
    expect(rows.map((r) => r.key)[0]).toBe("opened");
    expect(rows.map((r) => r.key).slice(5)).toEqual(["c1", "c2", "kc021ddc1", "e1"]);
  });

  test("a review is a verdict line, then its words, then the thread it came with", () => {
    const line = rows[2]!;
    expect(line.kind === "event" && line.tone).toBe("bad");
    expect(line.kind === "event" && line.parts.map((p) => p.text).join("")).toBe("bob requested changes");
    const bubble = rows[3]!;
    expect(bubble.kind === "bubble" && bubble.verdict).toBe("changes");
    expect(rows[4]!.kind).toBe("thread");
  });

  test("the opening line says where it came from and has no invented time beside a real one", () => {
    const o = rows[0]!;
    expect(o.kind === "event" && o.parts.map((p) => p.text).join("")).toBe("ada opened this from orbit-1042-sync-retry into main");
  });

  test("events are worded by the shared sentence", () => {
    const e = rows.find((r) => r.key === "e0")!;
    expect(e.kind === "event" && e.parts.map((p) => p.text).join("")).toBe("ada requested a review from bob");
  });

  test("commits that land together are one row that counts them", () => {
    const k = rows.find((r) => r.kind === "commits")!;
    expect(k.kind === "commits" && k.commits.length).toBe(2);
    expect(k.kind === "commits" && k.actor).toBe("ada");
  });

  test("a remark carries its standing, its reactions and whether it is yours", () => {
    const c = rows.find((r) => r.key === "c1")!;
    expect(c.kind === "bubble" && c.bubble.badge).toBe("MEMBER");
    expect(c.kind === "bubble" && c.bubble.reactions).toEqual([{ emoji: "👍", count: 2, mine: true }]);
  });
});

describe("lanes", () => {
  const rows = talkRows(d);
  test("All shows events; Humans and Bots show only what a voice said", () => {
    expect(rowsIn(rows, "all").length).toBe(rows.length);
    expect(rowsIn(rows, "humans").some((r) => r.kind === "event" && r.key === "e1")).toBe(false);
    expect(rowsIn(rows, "bots").map((r) => r.key)).toEqual(["c2"]);
  });

  test("the counts over the split are the desk's, not the rows'", () => {
    const c = countLanes(conversation(d));
    expect(c).toEqual({ all: 4, humans: 3, bots: 1 });
    expect(rows.length).toBeGreaterThan(c.all);
  });
});

describe("new since you last looked", () => {
  const rows = talkRows(d);
  const entries = conversation(d);
  const since = Date.parse("2026-09-30T10:30:00Z");

  test("the divider goes above the first row holding the first new remark, and the row is marked", () => {
    const n = newness(entries, d as never, since);
    const at = dividerAt(rows, n.dividerBefore);
    expect(rows[at]!.key).toBe("c1");
    expect(isFresh(rows[at]!, n.keys)).toBe(true);
    expect(isFresh(rows[3]!, n.keys)).toBe(false);
  });

  test("a new review is marked on its verdict line, where the eye lands first", () => {
    const n = newness(entries, d as never, Date.parse("2026-09-30T09:00:00Z"));
    const at = dividerAt(rows, n.dividerBefore);
    expect(rows[at]!.key).toContain("-line");
    expect(isFresh(rows[at]!, n.keys)).toBe(true);
  });

  test("nothing new, no divider", () => {
    expect(dividerAt(rows, null)).toBe(-1);
  });

  test("a reply in a thread that sits under an older review is marked on that thread's row", () => {
    const late = { ...d, threads: [{ ...thread("t1", "bob", "2026-09-30T09:59:58Z"), comments: [
      ...thread("t1", "bob", "2026-09-30T09:59:58Z").comments,
      { id: "t1-2", author: "cy", isBot: false, body: "done", createdAt: "2026-09-30T14:00:00Z" },
    ] }] } as typeof d;
    const n = newness(conversation(late), late as never, since);
    const r = talkRows(late);
    expect(isFresh(r.find((x) => x.kind === "thread")!, n.keys)).toBe(true);
  });
});

test("badge: yours first, a plain account none", () => {
  expect(badgeOf("MEMBER", true)).toBe("YOU");
  expect(badgeOf("OWNER", false)).toBe("OWNER");
  expect(badgeOf("NONE", false)).toBeNull();
  expect(badgeOf(undefined, undefined)).toBeNull();
  expect(badgeOf("FIRST_TIMER", false)).toBe("FIRST TIME");
});

test("a tally with nobody in it draws nothing", () => {
  expect(reactionsOf([{ content: "HEART", count: 0, viewerHasReacted: false }])).toEqual([]);
  expect(reactionsOf(undefined)).toEqual([]);
});

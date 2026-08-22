/*
 * What the Inbox shows, and — more to the point — what it refuses to.
 *
 * The screen this replaced said "4 things want you" about four sessions that
 * had gone quiet, one of them ten hours earlier, and titled them with hex. The
 * rule that stops a repeat of that is not a rendering choice, it is these
 * functions: a row exists because somebody is blocked, and every row can be
 * acted on.
 */
import { describe, expect, test } from "bun:test";
import {
  buildInbox, epoch, inboxCounts, remember, SEEN_CAP,
  type InboxInput, type InboxPr,
} from "../src/model/inbox.ts";
import type { IssueRow, PrSummary } from "../../shared/types.ts";
import type { ProviderTask } from "../../shared/providers.ts";

const NOW = 1_700_000_000_000;
const AGO = (ms: number): string => new Date(NOW - ms).toISOString();

const rollup = (over: Partial<PrSummary["checks"]> = {}): PrSummary["checks"] => ({
  total: 5, success: 5, failure: 0, skipped: 0, pending: 0,
  allDone: true, verdict: "green", failing: [], ...over,
});

const pr = (over: Partial<PrSummary> = {}): PrSummary => ({
  number: 482, title: "Checkout total is wrong on refunds", author: "me",
  state: "OPEN", isDraft: false, headRefName: "fix/x", baseRefName: "master",
  url: "https://github.com/x/y/pull/482", updatedAt: AGO(5 * 60_000),
  reviewDecision: null, additions: 102, deletions: 16, changedFiles: 3,
  labels: [], assignees: [], milestone: null, checks: rollup(),
  mergeable: "MERGEABLE", checksLoaded: true, ...over,
});

const row = (over: Partial<InboxPr> = {}): InboxPr =>
  ({ root: "/w/shop-api", repo: "acme/shop-api", pr: pr(), scope: "mine", ...over });

const issue = (over: Partial<IssueRow> = {}): IssueRow => ({
  number: 219, title: "Terminal loses the prefix key", state: "OPEN", author: "ana",
  labels: [], assignees: ["me"], comments: 0, updatedAt: AGO(3 * 3_600_000),
  url: "https://github.com/x/y/issues/219", ...over,
});

const card = (over: Partial<ProviderTask> = {}): ProviderTask => ({
  id: "86abc", customId: "SHOP-2140", title: "Refund webhook retries", url: "",
  status: "Code Review", statusKind: "open", due: null, updated: NOW - 3_600_000,
  assignees: [], ...over,
} as ProviderTask);

const input = (over: Partial<InboxInput> = {}): InboxInput =>
  ({ prs: [], issues: [], cards: [], seen: {}, now: NOW, ...over });

describe("nothing about agents gets in", () => {
  test("the input has no way to express one", () => {
    // The lock is the type, and this is it stated out loud: `buildInbox` takes
    // pull requests, issues and cards. There is no sessions field and no gates
    // field, so the screen cannot regrow the thing it was built to remove.
    const keys = Object.keys(input()).sort();
    expect(keys).toEqual(["cards", "issues", "now", "prs", "seen"]);
  });
});

describe("pull requests", () => {
  test("somebody asking for your review is the loudest thing there is", () => {
    const [item] = buildInbox(input({ prs: [row({ scope: "review" })] }));
    expect(item?.group).toBe("needs");
    expect(item?.tone).toBe("bad");
    expect(item?.title).toContain("wants your review");
    expect(item?.open).toEqual({ screen: "pr", id: "482", root: "/w/shop-api" });
  });

  test("changes requested on yours is a job, and says the checks too", () => {
    const [item] = buildInbox(input({
      prs: [row({ pr: pr({ reviewDecision: "CHANGES_REQUESTED", checks: rollup({ failure: 3 }) }) })],
    }));
    expect(item?.group).toBe("needs");
    expect(item?.title).toContain("changes asked");
    expect(item?.title).toContain("3 failed");
  });

  test("approved and green is the one group with a one-tap action", () => {
    const [item] = buildInbox(input({
      prs: [row({ pr: pr({ reviewDecision: "APPROVED" }) })],
    }));
    expect(item?.group).toBe("ready");
    expect(item?.tone).toBe("good");
  });

  test("approved but conflicting is not ready", () => {
    // `mergeable` is on the summary precisely because a conflict is a different
    // need from a red check. Offering Merge on one is offering a button that
    // cannot work.
    const items = buildInbox(input({
      prs: [row({ pr: pr({ reviewDecision: "APPROVED", mergeable: "CONFLICTING" }) })],
    }));
    expect(items.every((i) => i.group !== "ready")).toBe(true);
  });

  test("checks that have not been asked about are never green", () => {
    // `checksLoaded: false` is the list's second pass not having landed.
    // Reading it as passing would put an unverified branch in "ready to merge".
    const items = buildInbox(input({
      prs: [row({ pr: pr({ reviewDecision: "APPROVED", checksLoaded: false }) })],
    }));
    expect(items.every((i) => i.group !== "ready")).toBe(true);
  });

  test("a repository with no checks at all is not green either", () => {
    const items = buildInbox(input({
      prs: [row({ pr: pr({ reviewDecision: "APPROVED", checks: rollup({ total: 0, success: 0 }) }) })],
    }));
    expect(items.every((i) => i.group !== "ready")).toBe(true);
  });

  test("a running check is not a failure", () => {
    const items = buildInbox(input({
      prs: [row({ pr: pr({ checks: rollup({ pending: 2, failure: 0 }) }) })],
    }));
    expect(items.every((i) => i.group !== "needs")).toBe(true);
  });

  test("a draft is nobody's problem yet", () => {
    const items = buildInbox(input({
      prs: [row({ scope: "review", pr: pr({ isDraft: true }) })],
    }));
    expect(items.every((i) => i.group !== "needs")).toBe(true);
  });

  test("one pull request in both scopes appears once, at its most urgent", () => {
    // The store asks `mine` and `review` separately and a pull request can
    // legitimately come back in both.
    const items = buildInbox(input({
      prs: [
        row({ scope: "mine", pr: pr({ reviewDecision: "APPROVED" }) }),
        row({ scope: "review" }),
      ],
    }));
    expect(items).toHaveLength(1);
    expect(items[0]?.group).toBe("needs");
  });
});

describe("issues", () => {
  test("one assigned to you is a job", () => {
    const [item] = buildInbox(input({ issues: [{ root: "/w/shop-api", issue: issue() }] }));
    expect(item?.group).toBe("needs");
    expect(item?.source).toBe("issue");
    expect(item?.open).toEqual({ screen: "issue", id: "219", root: "/w/shop-api" });
  });

  test("one nobody has been given is the backlog, and stays out", () => {
    // A backlog in an inbox is how an inbox stops being read.
    const items = buildInbox(input({
      issues: [{ root: "/w/shop-api", issue: issue({ assignees: [] }) }],
    }));
    expect(items).toHaveLength(0);
  });

  test("a closed one never appears, however recently it moved", () => {
    const items = buildInbox(input({
      issues: [{ root: "/w/shop-api", issue: issue({ state: "CLOSED", updatedAt: AGO(1000) }) }],
    }));
    expect(items).toHaveLength(0);
  });
});

describe("cards", () => {
  test("one that moved since you looked is news", () => {
    const [item] = buildInbox(input({ cards: [card()] }));
    expect(item?.group).toBe("moved");
    expect(item?.title).toContain("SHOP-2140");
    // The workspace's own word, verbatim.
    expect(item?.title).toContain("Code Review");
  });

  test("one you have already seen at that moment is not", () => {
    const items = buildInbox(input({
      cards: [card()],
      seen: { "card:86abc": NOW - 3_600_000 },
    }));
    expect(items).toHaveLength(0);
  });

  test("seeing it does not silence a later move", () => {
    const items = buildInbox(input({
      cards: [card({ updated: NOW - 60_000 })],
      seen: { "card:86abc": NOW - 3_600_000 },
    }));
    expect(items).toHaveLength(1);
  });

  test("a done card is gone whatever its timestamps say", () => {
    const items = buildInbox(input({
      cards: [card({ statusKind: "done", updated: NOW })],
    }));
    expect(items).toHaveLength(0);
  });
});

describe("the order", () => {
  test("groups come in the order the screen draws them", () => {
    const items = buildInbox(input({
      cards: [card()],
      prs: [
        row({ scope: "review", pr: pr({ number: 1 }) }),
        row({ pr: pr({ number: 2, reviewDecision: "APPROVED" }) }),
      ],
    }));
    expect(items.map((i) => i.group)).toEqual(["needs", "ready", "moved"]);
  });

  test("inside a group the one that has waited longest is first", () => {
    // A queue, not a feed. Every other list in this app is newest-first; the
    // row that has been sitting longest is the one somebody is waiting on.
    const items = buildInbox(input({
      prs: [
        row({ scope: "review", pr: pr({ number: 1, updatedAt: AGO(60_000) }) }),
        row({ scope: "review", pr: pr({ number: 2, updatedAt: AGO(6 * 3_600_000) }) }),
      ],
    }));
    expect(items.map((i) => i.open.id)).toEqual(["2", "1"]);
  });

  test("a row with no timestamp sorts last, not first", () => {
    // Zero means "the source did not say", and treating it as 1970 would put
    // the least-known row at the top of the queue.
    const items = buildInbox(input({
      prs: [
        row({ scope: "review", pr: pr({ number: 1, updatedAt: "" }) }),
        row({ scope: "review", pr: pr({ number: 2, updatedAt: AGO(60_000) }) }),
      ],
    }));
    expect(items.map((i) => i.open.id)).toEqual(["2", "1"]);
  });
});

describe("the three numbers over the list", () => {
  test("they are counted from the rows, so they cannot disagree with them", () => {
    const items = buildInbox(input({
      prs: [
        row({ scope: "review", pr: pr({ number: 1 }) }),
        row({ pr: pr({ number: 2, checks: rollup({ failure: 1, success: 4 }) }) }),
        row({ pr: pr({ number: 3, reviewDecision: "APPROVED" }) }),
      ],
    }));
    const counts = inboxCounts(items);
    expect(counts.needs).toBe(2);
    expect(counts.failing).toBe(1);
    expect(counts.ready).toBe(1);
    expect(counts.needs).toBe(items.filter((i) => i.group === "needs").length);
  });

  test("an empty inbox counts zero rather than throwing", () => {
    expect(inboxCounts([])).toEqual({ needs: 0, failing: 0, ready: 0 });
  });
});

describe("timestamps", () => {
  test("both shapes the sources send", () => {
    expect(epoch(NOW)).toBe(NOW);
    expect(epoch("2023-11-14T22:13:20.000Z")).toBe(Date.parse("2023-11-14T22:13:20.000Z"));
  });

  test("anything unusable is zero, never NaN", () => {
    // A NaN sorts to nowhere and compares false against everything, so a single
    // bad field would quietly reorder the queue.
    for (const bad of ["", "not a date", null, undefined, Number.NaN]) {
      expect(epoch(bad as never)).toBe(0);
    }
  });
});

describe("what has been looked at", () => {
  test("remembering is additive", () => {
    const seen = remember(remember({}, "a", 1), "b", 2);
    expect(seen).toEqual({ a: 1, b: 2 });
  });

  test("it drops the oldest rather than growing without end", () => {
    // It is written to a keystore, not a database.
    let seen: Record<string, number> = {};
    for (let i = 0; i < SEEN_CAP + 50; i += 1) seen = remember(seen, `id${i}`, i);
    expect(Object.keys(seen)).toHaveLength(SEEN_CAP);
    // The ones that survive are the ones looked at most recently.
    expect(seen[`id${SEEN_CAP + 49}`]).toBe(SEEN_CAP + 49);
    expect(seen.id0).toBeUndefined();
  });

  test("re-remembering moves it rather than adding a second entry", () => {
    const seen = remember(remember({}, "a", 1), "a", 9);
    expect(seen).toEqual({ a: 9 });
  });
});
